/**
 * Orbix — Nivel B (opt-in): lectura del token OAuth del llavero de macOS.
 *
 * Fuente de verdad: `docs/design/02-esquema-bd.md` §6.1 y punto abierto B3.
 *
 * REGLAS INNEGOCIABLES:
 *  - Se ejecuta con `execFile` (nunca `exec` con cadena): cero interpolación en un shell.
 *  - El token **jamás** se guarda en la BD, ni en preferencias, ni en logs, ni en disco.
 *    Vive en memoria y se descarta al parar el Nivel B.
 *  - Cualquier fallo (el usuario deniega, no existe la entrada, JSON inesperado) degrada
 *    en silencio al Nivel A. Nunca un diálogo modal.
 */

import { execFile } from 'node:child_process'
import { userInfo } from 'node:os'

import { KEYCHAIN_TIMEOUT_MS } from '@shared/constants'

/** Nombre del servicio en el llavero, verificado en la máquina de referencia. */
export const KEYCHAIN_SERVICE = 'Claude Code-credentials'

export type KeychainErrorCode =
  | 'NOT_FOUND'
  | 'DENIED'
  | 'TIMEOUT'
  | 'UNPARSEABLE'
  | 'UNSUPPORTED_PLATFORM'
  | 'UNKNOWN'

export interface KeychainToken {
  accessToken: string
  refreshToken: string | null
  /** Epoch ms de caducidad, si el secreto lo trae. */
  expiresAt: number | null
}

export type KeychainResult =
  | { ok: true; token: KeychainToken }
  | { ok: false; code: KeychainErrorCode; message: string }

export interface KeychainOptions {
  /** Cuenta del llavero. Por defecto, el usuario del sistema. */
  account?: string
  timeoutMs?: number
}

/**
 * Lee el secreto del llavero. La primera vez macOS pregunta y el usuario puede marcar
 * "Permitir siempre".
 */
export async function readKeychainToken(options: KeychainOptions = {}): Promise<KeychainResult> {
  if (process.platform !== 'darwin') {
    return { ok: false, code: 'UNSUPPORTED_PLATFORM', message: 'El llavero solo existe en macOS' }
  }

  const account = options.account ?? safeUsername()
  const args = ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w']
  if (account !== null) args.push('-a', account)

  let raw: string
  try {
    raw = await run('security', args, options.timeoutMs ?? KEYCHAIN_TIMEOUT_MS)
  } catch (error) {
    return { ok: false, ...classify(error) }
  }

  const parsed = parseKeychainSecret(raw)
  if (parsed === null) {
    return {
      ok: false,
      code: 'UNPARSEABLE',
      // Nunca se incluye el secreto en el mensaje.
      message: 'El secreto del llavero no tiene la forma esperada'
    }
  }
  return { ok: true, token: parsed }
}

/**
 * PUNTO ABIERTO B3: la forma exacta del secreto no está verificada. Se busca, en orden:
 * `claudeAiOauth.accessToken` → `accessToken` → `access_token`; si nada casa y la cadena
 * empieza por `sk-ant-`, se usa tal cual.
 */
export function parseKeychainSecret(raw: string): KeychainToken | null {
  const text = raw.trim()
  if (text.length === 0) return null

  let parsed: unknown = null
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = null
  }

  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const root = parsed as Record<string, unknown>
    const oauth = asObject(root['claudeAiOauth'])
    const candidates: unknown[] = [
      oauth?.['accessToken'],
      root['accessToken'],
      root['access_token']
    ]
    const accessToken = candidates.find((c) => typeof c === 'string' && c.length > 0)
    if (typeof accessToken === 'string') {
      const refresh = oauth?.['refreshToken'] ?? root['refreshToken'] ?? root['refresh_token']
      const expires = oauth?.['expiresAt'] ?? root['expiresAt'] ?? root['expires_at']
      return {
        accessToken,
        refreshToken: typeof refresh === 'string' && refresh.length > 0 ? refresh : null,
        expiresAt: typeof expires === 'number' && Number.isFinite(expires) ? expires : null
      }
    }
    return null
  }

  if (text.startsWith('sk-ant-')) {
    return { accessToken: text, refreshToken: null, expiresAt: null }
  }
  return null
}

// ---------------------------------------------------------------------------
// Auxiliares
// ---------------------------------------------------------------------------

function run(command: string, args: readonly string[], timeoutMs: number): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      command,
      [...args],
      { timeout: timeoutMs, maxBuffer: 64 * 1024, windowsHide: true },
      (error, stdout) => {
        if (error) rejectPromise(error)
        else resolvePromise(stdout)
      }
    )
  })
}

function classify(error: unknown): { code: KeychainErrorCode; message: string } {
  // `execFile` deja el código de salida en `code` como número; `ErrnoException` lo tipa
  // como string, así que aquí se mira sin ese tipo.
  const e = error as { killed?: boolean; code?: number | string }
  if (e?.killed === true) return { code: 'TIMEOUT', message: 'El llavero no respondió a tiempo' }
  // `security` devuelve 44 cuando el elemento no existe, 128 cuando el usuario cancela.
  if (e?.code === 44) return { code: 'NOT_FOUND', message: 'No hay credenciales de Claude Code en el llavero' }
  if (e?.code === 128 || e?.code === 51) {
    return { code: 'DENIED', message: 'Acceso al llavero denegado' }
  }
  return { code: 'UNKNOWN', message: 'No se pudo leer el llavero' }
}

function safeUsername(): string | null {
  try {
    const name = userInfo().username
    return name.length > 0 ? name : null
  } catch {
    return null
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}
