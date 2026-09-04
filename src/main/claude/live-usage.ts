/**
 * Orbix — Nivel B (opt-in): refresco de límites contra la API interna de uso.
 *
 * ⚠️ **PUNTO ABIERTO B2 — la URL del endpoint NO SE INVENTA.** Está sin descubrir: hay que
 * observar el tráfico de Claude Code (mitmproxy con `NODE_EXTRA_CA_CERTS`, o `HTTPS_PROXY`
 * con certificado propio) y ver qué petición rellena `cachedUsageUtilization`.
 * Mientras `LIVE_USAGE_URL` esté vacía, el Nivel B se comporta como "no disponible
 * todavía": `isConfigured()` devuelve `false`, `refresh()` falla con `NOT_CONFIGURED` y la
 * app degrada **en silencio** al caché del Nivel A. **La app está 100 % terminada sin él.**
 *
 * Contrato que implementa esta capa cuando la URL exista:
 *   `GET <URL>` con `Authorization: Bearer <accessToken>` y las cabeceras
 *   `anthropic-beta` / `User-Agent` que use Claude Code. Respuesta JSON con **la misma
 *   forma que `cachedUsageUtilization.utilization`**, de modo que toda la normalización a
 *   `LimitBar[]` de `config-reader.ts` se reutiliza tal cual.
 */

import { LEVEL_B_RETRY_MS } from '@shared/constants'
import type { LevelBStatus, LimitsView } from '@shared/types'

import { buildLimitsView, type CachedUsage } from './config-reader'
import { readKeychainToken, type KeychainOptions } from './keychain'

/**
 * PUNTO ABIERTO B2. Cadena vacía = no configurado. NO poner aquí una URL adivinada:
 * una petición a un endpoint equivocado con el token del usuario es peor que no tener
 * Nivel B.
 */
export const LIVE_USAGE_URL = ''

/** Cabeceras que habrá que igualar a las de Claude Code cuando se cierre B2. */
export const LIVE_USAGE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  accept: 'application/json'
})

export const LIVE_USAGE_TIMEOUT_MS = 10_000

export type LiveUsageErrorCode =
  | 'NOT_CONFIGURED'
  | 'NO_TOKEN'
  | 'HTTP_ERROR'
  | 'BAD_SHAPE'
  | 'NETWORK'

export type LiveUsageResult =
  | { ok: true; utilization: Record<string, unknown>; fetchedAtMs: number }
  | { ok: false; code: LiveUsageErrorCode; message: string }

export function isConfigured(): boolean {
  return LIVE_USAGE_URL.length > 0
}

/**
 * Pide el uso real. Nunca lanza: cualquier fallo se devuelve como `{ ok: false }` para
 * que el llamador degrade al Nivel A sin ruido.
 */
export async function fetchLiveUsage(
  accessToken: string,
  signal?: AbortSignal
): Promise<LiveUsageResult> {
  if (!isConfigured()) {
    return {
      ok: false,
      code: 'NOT_CONFIGURED',
      message: 'El endpoint de uso en vivo todavía no está determinado (punto abierto B2)'
    }
  }

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), LIVE_USAGE_TIMEOUT_MS)
    signal?.addEventListener('abort', () => controller.abort(), { once: true })

    let response: Response
    try {
      response = await fetch(LIVE_USAGE_URL, {
        method: 'GET',
        headers: { ...LIVE_USAGE_HEADERS, authorization: `Bearer ${accessToken}` },
        signal: controller.signal
      })
    } finally {
      clearTimeout(timer)
    }

    if (!response.ok) {
      return { ok: false, code: 'HTTP_ERROR', message: `HTTP ${response.status}` }
    }

    const body: unknown = await response.json()
    const utilization = extractUtilization(body)
    if (utilization === null) {
      return { ok: false, code: 'BAD_SHAPE', message: 'La respuesta no tiene la forma esperada' }
    }
    return { ok: true, utilization, fetchedAtMs: Date.now() }
  } catch (error) {
    return {
      ok: false,
      code: 'NETWORK',
      message: error instanceof Error ? error.message : 'Fallo de red'
    }
  }
}

/**
 * Acepta tanto el objeto `utilization` directo como uno envuelto en `{ utilization: … }`,
 * porque la forma real está sin verificar.
 */
export function extractUtilization(body: unknown): Record<string, unknown> | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null
  const root = body as Record<string, unknown>
  const nested = root['utilization']
  if (nested !== null && typeof nested === 'object' && !Array.isArray(nested)) {
    return nested as Record<string, unknown>
  }
  // Si trae `limits`, ya es el propio objeto `utilization`.
  return 'limits' in root || 'five_hour' in root ? root : null
}

// ---------------------------------------------------------------------------
// Controlador
// ---------------------------------------------------------------------------

export interface LiveUsageOptions {
  keychain?: KeychainOptions
  /** Inyectable en tests. */
  fetchUsage?: (accessToken: string) => Promise<LiveUsageResult>
  now?: () => number
}

/**
 * Estado y orquestación del Nivel B. NO programa temporizadores: quien decide cada cuánto
 * refrescar es `main/index.ts` con `prefs.levelBIntervalMs`. Aquí solo se garantiza que un
 * fallo no se reintenta antes de 30 minutos y que el token no sobrevive al apagado.
 */
export class LiveUsage {
  private enabled = false
  private lastResult: LevelBStatus['lastResult'] = 'never'
  private lastError: string | null = null
  private lastFailureAt: number | null = null
  /** El token vive solo en memoria y se descarta al parar. */
  private token: string | null = null

  private readonly options: LiveUsageOptions
  private readonly now: () => number

  constructor(options: LiveUsageOptions = {}) {
    this.options = options
    this.now = options.now ?? ((): number => Date.now())
  }

  get status(): LevelBStatus {
    return { enabled: this.enabled, lastResult: this.lastResult, lastError: this.lastError }
  }

  /** Devuelve `verified: true` solo si se pudo leer el llavero y el endpoint existe. */
  async setEnabled(enabled: boolean): Promise<{ enabled: boolean; verified: boolean }> {
    this.enabled = enabled
    if (!enabled) {
      this.stop()
      return { enabled: false, verified: false }
    }
    const token = await this.ensureToken()
    return { enabled: true, verified: token !== null && isConfigured() }
  }

  /** Borra el token de memoria. Se llama al desactivar y en `before-quit`. */
  stop(): void {
    this.token = null
  }

  /**
   * Intenta refrescar. Devuelve `null` si no procede (desactivado, en periodo de espera
   * tras un fallo, o Nivel B no configurado): el llamador se queda con el Nivel A.
   */
  async refresh(options: { levelB?: LevelBStatus } = {}): Promise<LimitsView | null> {
    if (!this.enabled || !isConfigured()) return null

    // Tras un fallo no se reintenta antes de 30 min.
    if (
      this.lastResult === 'failed' &&
      this.lastFailureAt !== null &&
      this.now() - this.lastFailureAt < LEVEL_B_RETRY_MS
    ) {
      return null
    }

    const token = await this.ensureToken()
    if (token === null) {
      this.fail('No se pudo leer el token del llavero')
      return null
    }

    const doFetch = this.options.fetchUsage ?? ((t: string) => fetchLiveUsage(t))
    const result = await doFetch(token)
    if (!result.ok) {
      this.fail(result.message)
      return null
    }

    this.lastResult = 'ok'
    this.lastError = null
    this.lastFailureAt = null

    const cache: CachedUsage = {
      fetchedAtMs: result.fetchedAtMs,
      utilization: result.utilization
    }
    return buildLimitsView(cache, {
      source: 'live',
      levelB: options.levelB ?? this.status
    })
  }

  private async ensureToken(): Promise<string | null> {
    if (this.token !== null) return this.token
    const result = await readKeychainToken(this.options.keychain ?? {})
    if (!result.ok) {
      this.fail(result.message)
      return null
    }
    this.token = result.token.accessToken
    return this.token
  }

  private fail(message: string): void {
    this.lastResult = 'failed'
    this.lastError = message
    this.lastFailureAt = this.now()
    // Degradación silenciosa: el fallo solo se ve en Preferencias, nunca en el menubar.
  }
}
