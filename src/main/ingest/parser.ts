import { MAX_TOKEN_COUNT, normalizeModel, SYNTHETIC_MODEL_KEY } from '../db/prices'

/**
 * JSONL de Claude Code → línea de uso. Tolerante por diseño (02-esquema-bd.md
 * §5.4): cualquier campo que falte se ignora y NUNCA se lanza. Una línea rara no
 * puede tumbar la ingesta de 368 MB.
 */

/** Lo que el ingestor sabe del fichero del que salió la línea. */
export interface FileContext {
  readonly path: string
  readonly projectKey: string
  readonly sessionId: string | null
  readonly isSidechain: 0 | 1
}

export interface UsageLine {
  readonly requestId: string
  readonly apiBlockIndex: number
  readonly lineUuid: string | null
  readonly ts: string
  readonly tsEpoch: number
  readonly sessionId: string | null
  readonly projectKey: string
  readonly projectPath: string | null
  readonly sourcePath: string
  readonly isSidechain: 0 | 1
  readonly modelRaw: string
  readonly modelKey: string
  readonly inputTok: number
  readonly outputTok: number
  readonly thinkingTok: number
  readonly cacheWrite5m: number
  readonly cacheWrite1h: number
  readonly cacheRead: number
}

/** Contadores de rarezas. Se acumulan y se enseñan, no se lanzan. */
export interface ParseWarnings {
  /** JSON inválido. */
  badJson: number
  /** Líneas descartadas (no assistant, sin usage, sin requestId, sin timestamp). */
  skipped: number
  /** `cache_creation_input_tokens` sin desglose `cache_creation` (formato viejo). */
  legacyCacheCreation: number
  /** Invariante I3 rota: hay un ttl de caché que no estamos contando. */
  cacheMismatch: number
  /** Peticiones con `<synthetic>`: se ingieren a coste 0. */
  synthetic: number
  /** Modelos sin tarifa propia (tiran del comodín `__default__`). */
  unknownModel: number
  /** Contadores por encima del techo de cordura: se descartan (ver `MAX_TOKEN_COUNT`). */
  absurdCounter: number
}

export function emptyWarnings(): ParseWarnings {
  return {
    badJson: 0,
    skipped: 0,
    legacyCacheCreation: 0,
    cacheMismatch: 0,
    synthetic: 0,
    unknownModel: 0,
    absurdCounter: 0
  }
}

export function mergeWarnings(a: ParseWarnings, b: ParseWarnings): ParseWarnings {
  return {
    badJson: a.badJson + b.badJson,
    skipped: a.skipped + b.skipped,
    legacyCacheCreation: a.legacyCacheCreation + b.legacyCacheCreation,
    cacheMismatch: a.cacheMismatch + b.cacheMismatch,
    synthetic: a.synthetic + b.synthetic,
    unknownModel: a.unknownModel + b.unknownModel,
    absurdCounter: a.absurdCounter + b.absurdCounter
  }
}

/** Techo de cordura por contador: ver `MAX_TOKEN_COUNT` en `db/prices.ts`. */
export { MAX_TOKEN_COUNT }

/**
 * Entero no negativo, finito y por debajo del techo de cordura. Cualquier otra
 * cosa (NaN, negativo, Infinity, texto, absurdo) vale 0.
 */
function int(x: unknown, warn?: ParseWarnings): number {
  if (typeof x !== 'number' || !Number.isFinite(x) || x < 0) return 0
  if (x > MAX_TOKEN_COUNT) {
    if (warn) warn.absurdCounter += 1
    return 0
  }
  return Math.trunc(x)
}

function obj(x: unknown): Record<string, unknown> | null {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
    ? (x as Record<string, unknown>)
    : null
}

function str(x: unknown): string | null {
  return typeof x === 'string' && x !== '' ? x : null
}

/** Parsea una línea de texto. Devuelve null y cuenta el motivo si no sirve. */
export function parseJsonlLine(
  raw: string,
  file: FileContext,
  warn: ParseWarnings = emptyWarnings()
): UsageLine | null {
  const text = raw.trim()
  if (text === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    warn.badJson += 1
    return null
  }
  return parseUsageLine(parsed, file, warn)
}

/** Parsea un objeto ya deserializado. */
export function parseUsageLine(
  input: unknown,
  file: FileContext,
  warn: ParseWarnings = emptyWarnings()
): UsageLine | null {
  const o = obj(input)
  if (!o) {
    warn.skipped += 1
    return null
  }
  if (o['type'] !== 'assistant') return null // user, summary, mode, hooks...

  const message = obj(o['message'])
  const u = obj(message?.['usage'])
  if (!u) {
    warn.skipped += 1
    return null
  }

  const modelRaw = str(message?.['model']) ?? str(o['model']) ?? '__unknown__'
  const modelKey = normalizeModel(modelRaw)
  // Se cuentan antes del filtro de requestId para que el contador refleje lo que
  // hay en el fichero: medido en 368 MB, las 8 líneas `<synthetic>` (errores de
  // API) NO traen requestId, así que se descartan por falta de identidad. La
  // rama de coste 0 sigue ahí por si algún día la traen.
  if (modelKey === SYNTHETIC_MODEL_KEY) warn.synthetic += 1
  if (modelKey === '__unknown__') warn.unknownModel += 1

  const requestId = str(o['requestId']) ?? str(o['request_id'])
  if (!requestId) {
    // sin identidad facturable no hay nada que deduplicar ni que cobrar
    warn.skipped += 1
    return null
  }

  const ts = str(o['timestamp'])
  const tsEpoch = ts === null ? NaN : Date.parse(ts)
  if (ts === null || !Number.isFinite(tsEpoch)) {
    warn.skipped += 1
    return null
  }

  const apiBlockIndexRaw = o['apiBlockIndex']
  const apiBlockIndex =
    typeof apiBlockIndexRaw === 'number' && Number.isFinite(apiBlockIndexRaw)
      ? Math.trunc(apiBlockIndexRaw)
      : 0

  // Escrituras de caché: dos ttl a tarifas distintas. `cache_creation_input_tokens`
  // es su suma y solo se usa como control de integridad (invariante I3).
  const cacheCreation = obj(u['cache_creation'])
  let cacheWrite5m = 0
  let cacheWrite1h = 0
  if (cacheCreation) {
    cacheWrite5m = int(cacheCreation['ephemeral_5m_input_tokens'], warn)
    cacheWrite1h = int(cacheCreation['ephemeral_1h_input_tokens'], warn)
    const declared = u['cache_creation_input_tokens']
    // el control de integridad no cuenta avisos: solo compara
    if (typeof declared === 'number' && int(declared) !== cacheWrite5m + cacheWrite1h) {
      warn.cacheMismatch += 1
    }
  } else if (u['cache_creation_input_tokens'] !== undefined) {
    // formato antiguo: sin desglose. El ttl por defecto es 5 m.
    cacheWrite5m = int(u['cache_creation_input_tokens'], warn)
    warn.legacyCacheCreation += 1
  }

  const details = obj(u['output_tokens_details'])
  const isSidechain: 0 | 1 = o['isSidechain'] === true ? 1 : file.isSidechain

  return {
    requestId,
    apiBlockIndex,
    lineUuid: str(o['uuid']),
    ts,
    tsEpoch,
    sessionId: str(o['sessionId']) ?? str(o['session_id']) ?? file.sessionId,
    projectKey: file.projectKey,
    projectPath: str(o['cwd']),
    sourcePath: file.path,
    isSidechain,
    modelRaw,
    modelKey,
    inputTok: int(u['input_tokens'], warn),
    outputTok: int(u['output_tokens'], warn),
    thinkingTok: int(details?.['thinking_tokens'], warn),
    cacheWrite5m,
    cacheWrite1h,
    cacheRead: int(u['cache_read_input_tokens'], warn)
  }
}
