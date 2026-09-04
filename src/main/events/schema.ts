/**
 * miniClaudio — validación y normalización de los payloads de hook.
 *
 * Fuente de verdad: `docs/design/03-contrato-eventos.md` §3 y §6.2.
 *
 * Principio: **el parser nunca falla por un campo ausente**. Solo hay dos motivos de
 * rechazo (400): que el cuerpo no sea un objeto JSON, o que no traiga un
 * `hook_event_name` utilizable. Todo lo demás se degrada a `null`.
 *
 * Nada de lo recibido se ejecuta, se interpola en un shell ni se escribe en disco fuera
 * de la columna `raw_json`.
 */

import { basename } from 'node:path'

import {
  HOOK_EVENTS_ALL,
  MAX_CWD_LEN,
  MAX_HOOK_EVENT_NAME_LEN,
  MAX_MESSAGE_LEN,
  MAX_PROMPT_LEN,
  MAX_RAW_JSON_BYTES,
  MAX_REASON_LEN,
  MAX_TOOL_NAME_LEN
} from '@shared/constants'

/** Los nueve eventos que instalamos. Cualquier otro se guarda pero no produce estado. */
export const KNOWN_HOOK_EVENTS: ReadonlySet<string> = new Set(HOOK_EVENTS_ALL)

/** Motivos de rechazo del cuerpo de `POST /event`. */
export type HookParseErrorCode = 'BAD_JSON' | 'BAD_SHAPE'

/** Evento ya validado, recortado y con los derivados calculados por el servidor. */
export interface NormalizedHookEvent {
  /** `hook_event_name`, recortado a 64 caracteres. */
  event: string
  /** false → evento futuro desconocido: se persiste con `pet_state = NULL`. */
  known: boolean

  sessionId: string | null
  transcriptPath: string | null
  permissionMode: string | null

  /** `payload.cwd`. */
  projectPath: string | null
  /** `projectPath` con las barras cambiadas por guiones. Casa con `~/.claude/projects/`. */
  projectKey: string | null
  /** `basename(projectPath)` o `'Claude'` si no hay `cwd`. */
  projectName: string

  toolName: string | null
  message: string | null
  prompt: string | null
  reason: string | null
  /** `SessionStart.source`. */
  source: string | null
  /** `PreCompact.trigger`. */
  trigger: string | null
  stopHookActive: boolean

  /** Heurística de §6.2 sobre `tool_response`. Ante la duda, `false`. */
  isError: boolean

  /** Hora de RECEPCIÓN, ISO UTC. */
  ts: string
  tsEpoch: number
  /** `JSON.stringify(payload)` recortado a 8 KiB. */
  rawJson: string
}

export type HookParseResult =
  | { ok: true; value: NormalizedHookEvent }
  | { ok: false; code: HookParseErrorCode }

// ---------------------------------------------------------------------------
// Saneado de texto
// ---------------------------------------------------------------------------

/** Caracteres de control que se eliminan. Se conservan \t (09), \n (0A) y \r (0D). */
const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g

/**
 * Limpia y recorta un valor que puede no ser una cadena.
 * Devuelve `null` si no es cadena o si queda vacío.
 */
export function sanitizeText(value: unknown, maxLen: number): string | null {
  if (typeof value !== 'string') return null
  const cleaned = value.replace(CONTROL_CHARS, '').trim()
  if (cleaned.length === 0) return null
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen) : cleaned
}

/** Recorta a un número de bytes UTF-8 sin partir un carácter por la mitad. */
export function truncateUtf8(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8')
  if (buf.length <= maxBytes) return text
  // Un corte a mitad de secuencia produce U+FFFD al decodificar; lo quitamos del final.
  return buf.subarray(0, maxBytes).toString('utf8').replace(/�+$/u, '')
}

// ---------------------------------------------------------------------------
// Detección de error en PostToolUse (§6.2)
// ---------------------------------------------------------------------------

/**
 * PUNTO ABIERTO C1: la forma exacta de `tool_response` no está verificada en Claude Code
 * 2.1.259. Heurística tolerante: un falso negativo es aceptable (la mascota no reacciona);
 * un falso positivo es peor (se pone PUZZLED sin motivo). Ante la duda, `false`.
 */
export function isToolError(toolResponse: unknown): boolean {
  const r = toolResponse
  if (r === null || r === undefined) return false

  if (typeof r === 'object' && !Array.isArray(r)) {
    const o = r as Record<string, unknown>
    if (o['is_error'] === true || o['isError'] === true) return true
    if (typeof o['error'] === 'string' && o['error'].length > 0) return true
    if (o['success'] === false) return true
    if (typeof o['exit_code'] === 'number' && o['exit_code'] !== 0) return true
    // `interrupted` no es un error: el usuario paró la herramienta a propósito.
    if (typeof o['interrupted'] === 'boolean' && o['interrupted']) return false
    return false
  }

  if (typeof r === 'string') {
    return /^(error|<tool_use_error>)/i.test(r.trim())
  }

  return false
}

// ---------------------------------------------------------------------------
// Parseo
// ---------------------------------------------------------------------------

/** Deriva `projectKey` de una ruta absoluta, igual que hace `~/.claude/projects/`. */
export function toProjectKey(projectPath: string): string {
  return projectPath.replaceAll('/', '-')
}

/** Deriva el nombre legible del proyecto. Nunca vacío: respaldo `'Claude'`. */
export function toProjectName(projectPath: string | null): string {
  if (!projectPath) return 'Claude'
  const name = basename(projectPath)
  return name.length > 0 ? name : 'Claude'
}

/**
 * Valida y normaliza el cuerpo de `POST /event`.
 *
 * @param raw Cuerpo tal cual llegó, ya decodificado como UTF-8.
 * @param now Hora de recepción (inyectable para los tests).
 */
export function parseHookBody(raw: string, now: Date = new Date()): HookParseResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, code: 'BAD_JSON' }
  }

  // 1. Debe ser un objeto JSON: ni array, ni primitivo, ni null.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, code: 'BAD_SHAPE' }
  }
  const p = parsed as Record<string, unknown>

  // 2. `hook_event_name` obligatorio, string no vacío de <= 64 caracteres.
  const rawName = p['hook_event_name']
  if (typeof rawName !== 'string' || rawName.length > MAX_HOOK_EVENT_NAME_LEN) {
    return { ok: false, code: 'BAD_SHAPE' }
  }
  const event = sanitizeText(rawName, MAX_HOOK_EVENT_NAME_LEN)
  if (event === null) return { ok: false, code: 'BAD_SHAPE' }

  const projectPath = sanitizeText(p['cwd'], MAX_CWD_LEN)

  const value: NormalizedHookEvent = {
    event,
    known: KNOWN_HOOK_EVENTS.has(event),

    sessionId: sanitizeText(p['session_id'], 128),
    transcriptPath: sanitizeText(p['transcript_path'], MAX_CWD_LEN),
    permissionMode: sanitizeText(p['permission_mode'], 32),

    projectPath,
    projectKey: projectPath ? toProjectKey(projectPath) : null,
    projectName: toProjectName(projectPath),

    toolName: sanitizeText(p['tool_name'], MAX_TOOL_NAME_LEN),
    message: sanitizeText(p['message'], MAX_MESSAGE_LEN),
    prompt: sanitizeText(p['prompt'], MAX_PROMPT_LEN),
    reason: sanitizeText(p['reason'], MAX_REASON_LEN),
    source: sanitizeText(p['source'], 32),
    trigger: sanitizeText(p['trigger'], 32),
    stopHookActive: p['stop_hook_active'] === true,

    isError: event === 'PostToolUse' ? isToolError(p['tool_response']) : false,

    ts: now.toISOString(),
    tsEpoch: now.getTime(),
    rawJson: truncateUtf8(safeStringify(parsed), MAX_RAW_JSON_BYTES)
  }

  return { ok: true, value }
}

/** `JSON.stringify` que no explota con referencias circulares o BigInt. */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '{}'
  } catch {
    return '{}'
  }
}
