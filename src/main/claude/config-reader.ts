/**
 * miniClaudio — lectura de `~/.claude.json`: plan y límites cacheados (Nivel A).
 *
 * Fuente de verdad: `docs/design/02-esquema-bd.md` §6.
 *
 * ⚠️ **La antigüedad del dato es de primera clase, no una nota al pie.** El bloque
 * `cachedUsageUtilization` solo se refresca cuando a Claude Code le apetece: en la máquina
 * de referencia llevaba SIETE DÍAS sin actualizarse pese a haber sesiones a diario. Por eso
 * `LimitsView` lleva SIEMPRE `fetchedAt`, `ageSeconds`, `stale` y `veryStale`, y el frontal
 * está obligado a pintarlos. Nunca se presenta un porcentaje rancio como si fuera actual.
 *
 * Todos los campos son opcionales: ausencia = `null`, nunca excepción.
 */

import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  CLAUDE_JSON_MAX_BYTES,
  CLAUDE_JSON_REL,
  LIMITS_STALE_SECONDS,
  LIMITS_VERY_STALE_SECONDS
} from '@shared/constants'
import type {
  LimitBar,
  LimitGroup,
  LimitKind,
  LimitSeverity,
  LimitsSource,
  LimitsView,
  LevelBStatus,
  PlanInfo
} from '@shared/types'

// ---------------------------------------------------------------------------
// Forma (parcial y tolerante) de `~/.claude.json`
// ---------------------------------------------------------------------------

/** Metadatos de cuenta. Todo opcional. */
export interface ClaudeAccountMeta {
  accountUuid: string | null
  accountEmail: string | null
  organizationUuid: string | null
  organizationType: string | null
  /** Ej. `default_claude_max_20x`. */
  rateLimitTier: string | null
  hasExtraUsageEnabled: boolean
}

/** El bloque `cachedUsageUtilization` tal cual, más lo derivado. */
export interface CachedUsage {
  /** Epoch en ms del momento en que Claude Code lo pidió de verdad. */
  fetchedAtMs: number | null
  /** Objeto `utilization` íntegro, para `limits_snapshots.payload_json`. */
  utilization: Record<string, unknown> | null
}

export interface ClaudeConfigRead {
  ok: boolean
  meta: ClaudeAccountMeta
  cache: CachedUsage
  /** Motivo por el que no se pudo leer, si `ok === false`. */
  error: string | null
  /** Ruta leída, para diagnóstico. */
  path: string
}

const EMPTY_META: ClaudeAccountMeta = Object.freeze({
  accountUuid: null,
  accountEmail: null,
  organizationUuid: null,
  organizationType: null,
  rateLimitTier: null,
  hasExtraUsageEnabled: false
})

const EMPTY_CACHE: CachedUsage = Object.freeze({ fetchedAtMs: null, utilization: null })

// ---------------------------------------------------------------------------
// Lectura
// ---------------------------------------------------------------------------

export function claudeJsonPath(home: string = homedir()): string {
  return join(home, CLAUDE_JSON_REL)
}

/**
 * Lee y parsea `~/.claude.json`. Nunca lanza.
 *
 * El fichero es grande (>250 KB, 7 000 líneas) y pretty-printed: el llamador debe
 * invocar esto solo cuando cambie el `mtime` (watcher con debounce de 1 s), no en cada tick.
 */
export function readClaudeConfig(home: string = homedir()): ClaudeConfigRead {
  const path = claudeJsonPath(home)

  try {
    const size = statSync(path).size
    if (size > CLAUDE_JSON_MAX_BYTES) {
      return {
        ok: false,
        meta: { ...EMPTY_META },
        cache: { ...EMPTY_CACHE },
        error: `~/.claude.json ocupa ${size} bytes: se omite el parseo`,
        path
      }
    }
  } catch (error) {
    return {
      ok: false,
      meta: { ...EMPTY_META },
      cache: { ...EMPTY_CACHE },
      error: describe(error),
      path
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    return {
      ok: false,
      meta: { ...EMPTY_META },
      cache: { ...EMPTY_CACHE },
      error: describe(error),
      path
    }
  }

  return { ok: true, ...extractFromConfig(parsed), error: null, path }
}

/** Parte pura, testeable con un objeto ya parseado. */
export function extractFromConfig(parsed: unknown): { meta: ClaudeAccountMeta; cache: CachedUsage } {
  const root = asObject(parsed)
  const oauth = asObject(root?.['oauthAccount'])
  const cached = asObject(root?.['cachedUsageUtilization'])

  const meta: ClaudeAccountMeta = {
    accountUuid: asString(oauth?.['accountUuid']),
    accountEmail: asString(oauth?.['emailAddress']),
    organizationUuid: asString(oauth?.['organizationUuid']),
    organizationType: asString(oauth?.['organizationType']),
    rateLimitTier: asString(oauth?.['organizationRateLimitTier']),
    hasExtraUsageEnabled: oauth?.['hasExtraUsageEnabled'] === true
  }

  const cache: CachedUsage = {
    fetchedAtMs: asFiniteNumber(cached?.['fetchedAtMs']),
    utilization: asObject(cached?.['utilization'])
  }

  return { meta, cache }
}

// ---------------------------------------------------------------------------
// PlanInfo
// ---------------------------------------------------------------------------

/**
 * Fila de la tabla `plans`. La resuelve `src/main/db/` con
 * `SELECT * FROM plans WHERE tier_id = :tier`.
 * DEPENDENCIA PENDIENTE (database-dev): la tabla `plans` y su semilla.
 */
export interface PlanRow {
  tierId: string
  organizationType: string | null
  displayName: string
  monthlyUsd: number | null
}

export function buildPlanInfo(meta: ClaudeAccountMeta, plan: PlanRow | null): PlanInfo {
  if (plan === null) {
    return {
      tierId: meta.rateLimitTier,
      organizationType: meta.organizationType,
      displayName: meta.rateLimitTier === null ? 'Plan desconocido' : 'Plan no reconocido',
      monthlyUsd: null,
      accountEmail: meta.accountEmail,
      detected: false
    }
  }
  return {
    tierId: plan.tierId,
    organizationType: plan.organizationType ?? meta.organizationType,
    displayName: plan.displayName,
    monthlyUsd: plan.monthlyUsd,
    accountEmail: meta.accountEmail,
    detected: true
  }
}

// ---------------------------------------------------------------------------
// LimitsView
// ---------------------------------------------------------------------------

const LEVEL_B_NEVER: LevelBStatus = Object.freeze({
  enabled: false,
  lastResult: 'never',
  lastError: null
})

export interface BuildLimitsOptions {
  /** `'cache'` para el Nivel A, `'live'` para el Nivel B. */
  source?: LimitsSource
  /** Momento actual, para calcular la antigüedad. */
  now?: Date
  levelB?: LevelBStatus
  /** Sobrescribe `extraUsageEnabled` con el dato de `oauthAccount`. */
  metaExtraUsage?: boolean
}

/** Vista vacía y honesta: sin datos no se dibujan barras ni se inventa un porcentaje. */
export function emptyLimitsView(levelB: LevelBStatus = LEVEL_B_NEVER): LimitsView {
  return {
    source: 'none',
    fetchedAt: null,
    ageSeconds: null,
    stale: false,
    veryStale: false,
    bars: [],
    extraUsageEnabled: false,
    spendUsedUsd: null,
    levelB
  }
}

/**
 * Construye la vista de límites a partir de `cachedUsageUtilization`.
 *
 * `utilization.limits[]` es la única fuente de las barras. Los campos hermanos
 * (`nimbus_quill`, `tangelo`, `iguana_necktie`, `cinder_cove`, `amber_ladder`,
 * `omelette_promotional`…) son experimentos internos de Anthropic y se ignoran, salvo
 * `five_hour`/`seven_day` como respaldo si `limits[]` viniera vacío.
 */
export function buildLimitsView(cache: CachedUsage, options: BuildLimitsOptions = {}): LimitsView {
  const levelB = options.levelB ?? LEVEL_B_NEVER
  const utilization = cache.utilization
  if (utilization === null) return emptyLimitsView(levelB)

  const now = options.now ?? new Date()
  const source: LimitsSource = options.source ?? 'cache'

  const fetchedAtMs = cache.fetchedAtMs
  const fetchedAt = fetchedAtMs === null ? null : new Date(fetchedAtMs).toISOString()
  const ageSeconds = fetchedAtMs === null ? null : Math.max(0, (now.getTime() - fetchedAtMs) / 1000)

  const bars = buildBars(utilization)

  const extraUsage = asObject(utilization['extra_usage'])
  const extraUsageEnabled =
    extraUsage?.['is_enabled'] === true || options.metaExtraUsage === true

  return {
    source: bars.length === 0 && fetchedAtMs === null ? 'none' : source,
    fetchedAt,
    ageSeconds,
    stale: ageSeconds !== null && ageSeconds > LIMITS_STALE_SECONDS,
    veryStale: ageSeconds !== null && ageSeconds > LIMITS_VERY_STALE_SECONDS,
    bars,
    extraUsageEnabled,
    spendUsedUsd: readSpendUsd(utilization),
    levelB
  }
}

const KIND_ORDER: Readonly<Record<LimitKind, number>> = Object.freeze({
  session: 0,
  weekly_all: 1,
  weekly_scoped: 2
})

export function buildBars(utilization: Record<string, unknown>): LimitBar[] {
  const raw = utilization['limits']
  const bars: LimitBar[] = []

  if (Array.isArray(raw)) {
    for (const item of raw) {
      const bar = toBar(item)
      if (bar !== null) bars.push(bar)
    }
  }

  if (bars.length === 0) {
    // Respaldo documentado: solo `five_hour` y `seven_day`.
    const fiveHour = asObject(utilization['five_hour'])
    const sevenDay = asObject(utilization['seven_day'])
    if (fiveHour !== null) {
      bars.push(fallbackBar('session', 'session', 'Ventana 5 h', fiveHour))
    }
    if (sevenDay !== null) {
      bars.push(fallbackBar('weekly_all', 'weekly', 'Semanal total', sevenDay))
    }
  }

  bars.sort((a, b) => {
    const byKind = KIND_ORDER[a.kind] - KIND_ORDER[b.kind]
    if (byKind !== 0) return byKind
    // Entre los `weekly_scoped`, por porcentaje descendente.
    return b.percent - a.percent
  })

  return bars
}

function toBar(item: unknown): LimitBar | null {
  const o = asObject(item)
  if (o === null) return null

  const kind = asString(o['kind'])
  if (kind !== 'session' && kind !== 'weekly_all' && kind !== 'weekly_scoped') return null

  const percent = clamp(asFiniteNumber(o['percent']) ?? 0, 0, 100)
  const scope = asObject(o['scope'])
  const model = asObject(scope?.['model'])
  const scopeLabel = asString(model?.['display_name'])
  const group: LimitGroup = asString(o['group']) === 'session' ? 'session' : 'weekly'

  return {
    kind,
    group: kind === 'session' ? 'session' : group,
    label: labelFor(kind, scopeLabel),
    percent,
    severity: mapSeverity(asString(o['severity']), percent),
    resetsAt: normalizeIso(asString(o['resets_at'])),
    scopeLabel,
    isActive: o['is_active'] === true
  }
}

function fallbackBar(
  kind: LimitKind,
  group: LimitGroup,
  label: string,
  raw: Record<string, unknown>
): LimitBar {
  const percent = clamp(asFiniteNumber(raw['utilization']) ?? 0, 0, 100)
  return {
    kind,
    group,
    label,
    percent,
    severity: mapSeverity(null, percent),
    resetsAt: normalizeIso(asString(raw['resets_at'])),
    scopeLabel: null,
    isActive: percent > 0
  }
}

export function labelFor(kind: LimitKind, scopeLabel: string | null): string {
  switch (kind) {
    case 'session':
      return 'Ventana 5 h'
    case 'weekly_all':
      return 'Semanal total'
    case 'weekly_scoped':
      return `Semanal · ${scopeLabel ?? 'modelo'}`
  }
}

/**
 * El servidor manda `normal` incluso al 63 %, así que si no trae una severidad
 * reconocible la derivamos del porcentaje.
 */
export function mapSeverity(severity: string | null, percent: number): LimitSeverity {
  if (severity === 'normal' || severity === 'warning' || severity === 'critical') return severity
  if (percent >= 85) return 'critical'
  if (percent >= 60) return 'warning'
  return 'normal'
}

/** `spend.used` viene en unidades menores: `{ amount_minor, currency, exponent }`. */
function readSpendUsd(utilization: Record<string, unknown>): number | null {
  const spend = asObject(utilization['spend'])
  const used = asObject(spend?.['used'])
  const minor = asFiniteNumber(used?.['amount_minor'])
  if (minor === null) return null
  const exponent = asFiniteNumber(used?.['exponent']) ?? 2
  return minor / 10 ** exponent
}

/** El porcentaje semanal total, que alimenta el aviso `WORRIED` (regla 13). */
export function weeklyPercent(view: LimitsView): number | null {
  const bar = view.bars.find((b) => b.kind === 'weekly_all')
  return bar?.percent ?? null
}

// ---------------------------------------------------------------------------
// Auxiliares
// ---------------------------------------------------------------------------

function asObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** ISO con offset (`+00:00`) → ISO UTC con `Z`. `null` si no parsea. */
export function normalizeIso(iso: string | null): string | null {
  if (iso === null) return null
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? null : new Date(ms).toISOString()
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
