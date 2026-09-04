import { basename } from 'node:path'
import type {
  Breakdown,
  BreakdownRow,
  IngestStatus,
  Multiplier,
  PeriodKey,
  PeriodStats,
  PlanInfo,
  Series,
  SeriesPoint,
  SessionStats,
  StatsSnapshot,
  TokenTotals
} from '@shared/types'
import type Database from 'better-sqlite3'
import { SESSION_ACTIVE_WINDOW_MS } from '@shared/constants'
import type { Db } from './connection'
import { SYNTHETIC_MODEL_KEY } from './prices'
import { daysBetween, periodBounds, systemTimezone } from './time'

/**
 * Consultas que alimentan el menubar (02-esquema-bd.md §7).
 *
 * Todo sale de `rollup_daily` salvo la sesión actual, que necesita grano fino.
 * Ninguna consulta usa `date('now')` de SQLite: las fechas de calendario las
 * calcula `main` con la zona del usuario y llegan como parámetro.
 */

/** Ventana para considerar una sesión "viva" (§7 Q2). Vive en `@shared/constants`. */
export { SESSION_ACTIVE_WINDOW_MS }

interface TotalsRow {
  requests: number
  input_tok: number
  output_tok: number
  thinking_tok: number
  cache_write_5m: number
  cache_write_1h: number
  cache_read: number
  cost_usd: number
}

const TOTALS_SELECT = `
  COALESCE(SUM(requests),0)       AS requests,
  COALESCE(SUM(input_tok),0)      AS input_tok,
  COALESCE(SUM(output_tok),0)     AS output_tok,
  COALESCE(SUM(thinking_tok),0)   AS thinking_tok,
  COALESCE(SUM(cache_write_5m),0) AS cache_write_5m,
  COALESCE(SUM(cache_write_1h),0) AS cache_write_1h,
  COALESCE(SUM(cache_read),0)     AS cache_read,
  COALESCE(SUM(cost_usd),0.0)     AS cost_usd`

function tokensOf(r: TotalsRow): TokenTotals {
  return {
    input: r.input_tok,
    output: r.output_tok,
    thinking: r.thinking_tok,
    cacheWrite5m: r.cache_write_5m,
    cacheWrite1h: r.cache_write_1h,
    cacheRead: r.cache_read
  }
}

/**
 * `totalTokens` = input + output + cw5m + cw1h + cacheRead.
 * `thinking` NUNCA se suma: ya está dentro de `output` (§7 Q7). Se calcula aquí,
 * en `main`, para que frontend y backend no puedan divergir.
 */
export function totalTokensOf(t: TokenTotals): number {
  return t.input + t.output + t.cacheWrite5m + t.cacheWrite1h + t.cacheRead
}

function statsOf(r: TotalsRow): PeriodStats {
  const tokens = tokensOf(r)
  return {
    tokens,
    totalTokens: totalTokensOf(tokens),
    costUsd: r.cost_usd,
    requests: r.requests
  }
}

const EMPTY_ROW: TotalsRow = {
  requests: 0,
  input_tok: 0,
  output_tok: 0,
  thinking_tok: 0,
  cache_write_5m: 0,
  cache_write_1h: 0,
  cache_read: 0,
  cost_usd: 0
}

export interface SnapshotInput {
  readonly plan: PlanInfo
  readonly ingest: IngestStatus
  readonly now?: number
}

/**
 * Sentencia preparada. Se declara con el parámetro de tipo explícito porque
 * `ReturnType<Db['prepare']>` instancia el genérico con `unknown` y acaba
 * exigiendo un argumento incluso en las consultas que no llevan parámetros.
 */
type Stmt = Database.Statement<unknown[]>

export class Queries {
  private readonly db: Db
  private timezone: string

  private readonly qPeriod: Stmt
  private readonly qAllTime: Stmt
  private readonly qHookCandidate: Stmt
  private readonly qUsageCandidate: Stmt
  private readonly qSessionTotals: Stmt
  private readonly qSessionMeta: Stmt
  private readonly qSeries: Stmt
  private readonly qCoveredDays: Stmt
  private readonly qProjectPaths: Stmt

  constructor(db: Db, timezone: string = systemTimezone()) {
    this.db = db
    this.timezone = timezone

    // Q1 · totales de un periodo
    this.qPeriod = db.prepare(
      `SELECT ${TOTALS_SELECT} FROM rollup_daily WHERE day_local BETWEEN @from AND @to`
    )
    this.qAllTime = db.prepare(`SELECT ${TOTALS_SELECT} FROM rollup_daily`)

    // Q2 · sesión actual
    this.qHookCandidate = db.prepare(
      `SELECT session_id, project_key, project_path, MAX(ts_epoch) AS last_epoch
         FROM hook_events
        WHERE session_id IS NOT NULL AND event <> 'SessionEnd'
        GROUP BY session_id ORDER BY last_epoch DESC LIMIT 1`
    )
    this.qUsageCandidate = db.prepare(
      `SELECT session_id, project_key, project_path, MAX(ts_epoch) AS last_epoch
         FROM usage_requests
        WHERE session_id IS NOT NULL
        GROUP BY session_id ORDER BY last_epoch DESC LIMIT 1`
    )
    this.qSessionTotals = db.prepare(
      `SELECT COUNT(*) AS requests,
              COALESCE(SUM(input_tok),0)      AS input_tok,
              COALESCE(SUM(output_tok),0)     AS output_tok,
              COALESCE(SUM(thinking_tok),0)   AS thinking_tok,
              COALESCE(SUM(cache_write_5m),0) AS cache_write_5m,
              COALESCE(SUM(cache_write_1h),0) AS cache_write_1h,
              COALESCE(SUM(cache_read),0)     AS cache_read,
              COALESCE(SUM(cost_usd),0.0)     AS cost_usd,
              MIN(ts) AS started_at, MAX(ts) AS last_activity_at,
              MAX(ts_epoch) AS last_epoch
         FROM usage_requests
        WHERE session_id = @sid AND model_key <> '${SYNTHETIC_MODEL_KEY}'`
    )
    this.qSessionMeta = db.prepare(
      `SELECT project_key, project_path FROM usage_requests
        WHERE session_id = @sid AND project_path IS NOT NULL
        ORDER BY ts_epoch DESC LIMIT 1`
    )

    // Q5 · serie diaria
    this.qSeries = db.prepare(
      `SELECT day_local, SUM(cost_usd) AS cost_usd,
              SUM(input_tok + output_tok + cache_write_5m + cache_write_1h + cache_read)
                AS total_tokens
         FROM rollup_daily
        WHERE day_local BETWEEN @from AND @to
        GROUP BY day_local ORDER BY day_local`
    )

    // Q6 · días con datos dentro de la ventana
    this.qCoveredDays = db.prepare(
      `SELECT COUNT(DISTINCT day_local) AS n FROM rollup_daily
        WHERE day_local BETWEEN @from AND @to`
    )

    // Incluye los proyectos rescatados del snapshot: si no, los días de histórico
    // importado se quedarían sin etiqueta legible.
    this.qProjectPaths = db.prepare(
      `SELECT project_key, MAX(project_path) AS project_path FROM (
         SELECT project_key, project_path FROM usage_requests WHERE project_path IS NOT NULL
         UNION ALL
         SELECT project_key, project_path FROM snapshot_rollups WHERE project_path IS NOT NULL
       ) GROUP BY project_key`
    )
  }

  setTimezone(tz: string): void {
    this.timezone = tz
  }

  getTimezone(): string {
    return this.timezone
  }

  bounds(now = Date.now()): ReturnType<typeof periodBounds> {
    return periodBounds(this.timezone, now)
  }

  /** Rango [from, to] de un `PeriodKey`. `all` → from null. */
  rangeFor(period: PeriodKey, now = Date.now()): { from: string | null; to: string } {
    const b = this.bounds(now)
    switch (period) {
      case 'today':
        return { from: b.today, to: b.today }
      case '7d':
        return { from: b.d7from, to: b.today }
      case '30d':
        return { from: b.d30from, to: b.today }
      case 'mtd':
        return { from: b.mtdFrom, to: b.today }
      case 'all':
        return { from: null, to: b.today }
    }
  }

  /** Q1 */
  periodTotals(from: string | null, to: string): PeriodStats {
    const row =
      from === null
        ? (this.qAllTime.get() as TotalsRow | undefined)
        : (this.qPeriod.get({ from, to }) as TotalsRow | undefined)
    return statsOf(row ?? EMPTY_ROW)
  }

  periodStats(period: PeriodKey, now = Date.now()): PeriodStats {
    const { from, to } = this.rangeFor(period, now)
    return this.periodTotals(from, to)
  }

  /** Etiqueta legible de un proyecto: nunca se resuelve en SQL. */
  projectLabels(): Map<string, { path: string | null; label: string }> {
    const rows = this.qProjectPaths.all() as Array<{
      project_key: string
      project_path: string | null
    }>
    const map = new Map<string, { path: string | null; label: string }>()
    for (const r of rows) {
      map.set(r.project_key, {
        path: r.project_path,
        label: labelForProject(r.project_key, r.project_path)
      })
    }
    return map
  }

  /** Q2 · sesión actual (o la última conocida, en gris, si ya no está viva). */
  currentSession(now = Date.now()): SessionStats {
    const hook = this.qHookCandidate.get() as SessionCandidate | undefined
    const usage = this.qUsageCandidate.get() as SessionCandidate | undefined

    const best =
      hook && usage ? (hook.last_epoch >= usage.last_epoch ? hook : usage) : (hook ?? usage)

    if (!best || best.session_id === null) return emptySession()

    const sid = best.session_id
    const row = this.qSessionTotals.get({ sid }) as
      | (TotalsRow & {
          started_at: string | null
          last_activity_at: string | null
          last_epoch: number | null
        })
      | undefined

    const meta = this.qSessionMeta.get({ sid }) as
      | { project_key: string; project_path: string | null }
      | undefined

    const projectKey = meta?.project_key ?? best.project_key ?? null
    const projectPath = meta?.project_path ?? best.project_path ?? null
    const lastEpoch = Math.max(row?.last_epoch ?? 0, best.last_epoch)
    const stats = statsOf(row ?? EMPTY_ROW)

    return {
      ...stats,
      sessionId: sid,
      projectKey,
      projectName: projectKey === null ? null : labelForProject(projectKey, projectPath),
      projectPath,
      startedAt: row?.started_at ?? null,
      lastActivityAt: row?.last_activity_at ?? null,
      isActive: lastEpoch > 0 && now - lastEpoch < SESSION_ACTIVE_WINDOW_MS
    }
  }

  /** Q3 / Q4 · desglose por proyecto o por modelo. */
  breakdown(
    by: 'project' | 'model',
    period: PeriodKey,
    limit = 10,
    now = Date.now()
  ): Breakdown {
    const { from, to } = this.rangeFor(period, now)
    const column = by === 'project' ? 'project_key' : 'model_key'
    const where = from === null ? '' : 'WHERE day_local BETWEEN @from AND @to'
    const rows = this.db
      .prepare(
        `SELECT ${column} AS key,
                SUM(requests) AS requests,
                SUM(input_tok) AS input_tok, SUM(output_tok) AS output_tok,
                SUM(thinking_tok) AS thinking_tok, SUM(cache_write_5m) AS cache_write_5m,
                SUM(cache_write_1h) AS cache_write_1h, SUM(cache_read) AS cache_read,
                SUM(cost_usd) AS cost_usd
           FROM rollup_daily ${where}
          GROUP BY ${column}
          ORDER BY cost_usd DESC
          LIMIT @limit`
      )
      // better-sqlite3 rechaza parámetros que la sentencia no usa
      .all(from === null ? { limit } : { from, to, limit }) as Array<TotalsRow & { key: string }>

    const totalRow = from === null ? this.periodTotals(null, to) : this.periodTotals(from, to)
    const totalCostUsd = totalRow.costUsd
    const labels = by === 'project' ? this.projectLabels() : null

    const out: BreakdownRow[] = rows.map((r) => {
      const stats = statsOf(r)
      return {
        key: r.key,
        label: labels ? (labels.get(r.key)?.label ?? labelForProject(r.key, null)) : r.key,
        tokens: stats.tokens,
        totalTokens: stats.totalTokens,
        costUsd: stats.costUsd,
        requests: stats.requests,
        share: totalCostUsd > 0 ? stats.costUsd / totalCostUsd : 0
      }
    })

    return { by, period, rows: out, totalCostUsd }
  }

  /** Q5 · serie diaria. Los días sin datos se rellenan aquí, no en SQL. */
  series(period: PeriodKey, now = Date.now()): Series {
    const { from, to } = this.rangeFor(period, now)
    const start = from ?? (this.firstDay() ?? to)
    const rows = this.qSeries.all({ from: start, to }) as Array<{
      day_local: string
      cost_usd: number
      total_tokens: number
    }>
    const byDay = new Map(rows.map((r) => [r.day_local, r]))
    const points: SeriesPoint[] = []
    const total = Math.max(daysBetween(start, to), 1)
    for (let i = 0; i < total; i += 1) {
      const day = addDays(start, i)
      const r = byDay.get(day)
      points.push({ day, costUsd: r?.cost_usd ?? 0, totalTokens: r?.total_tokens ?? 0 })
    }
    return { period, by: null, points }
  }

  firstDay(): string | null {
    const row = this.db.prepare(`SELECT MIN(day_local) AS d FROM rollup_daily`).get() as
      | { d: string | null }
      | undefined
    return row?.d ?? null
  }

  /** Q6 · multiplicador contra el precio del plan. */
  multiplier(plan: PlanInfo, now = Date.now()): Multiplier {
    const b = this.bounds(now)
    const cost30 = this.periodTotals(b.d30from, b.today).costUsd
    const covered = (this.qCoveredDays.get({ from: b.d30from, to: b.today }) as { n: number }).n
    const monthly = plan.monthlyUsd
    return {
      value: monthly !== null && monthly > 0 ? cost30 / monthly : null,
      basis: 'last30d',
      planMonthlyUsd: monthly,
      costUsd: cost30,
      // con menos de 30 días de histórico el multiplicador es un SUELO, no la cifra
      isFloor: covered < 30,
      coveredDays: covered
    }
  }

  /** El `StatsSnapshot` completo que consume el menubar. */
  snapshot(input: SnapshotInput): StatsSnapshot {
    const now = input.now ?? Date.now()
    const b = this.bounds(now)
    return {
      generatedAt: new Date(now).toISOString(),
      session: this.currentSession(now),
      today: this.periodTotals(b.today, b.today),
      last7d: this.periodTotals(b.d7from, b.today),
      last30d: this.periodTotals(b.d30from, b.today),
      monthToDate: this.periodTotals(b.mtdFrom, b.today),
      allTime: this.periodTotals(null, b.today),
      plan: input.plan,
      multiplier: this.multiplier(input.plan, now),
      ingest: input.ingest
    }
  }
}

interface SessionCandidate {
  session_id: string | null
  project_key: string | null
  project_path: string | null
  last_epoch: number
}

function emptySession(): SessionStats {
  const stats = statsOf(EMPTY_ROW)
  return {
    ...stats,
    sessionId: null,
    projectKey: null,
    projectName: null,
    projectPath: null,
    startedAt: null,
    lastActivityAt: null,
    isActive: false
  }
}

/**
 * Etiqueta de proyecto. Con `project_path` es trivial; sin él hay que adivinar
 * del `project_key`, cuyos guiones son ambiguos ('/Users/a/b-c' y '/Users/a/b/c'
 * producen el mismo nombre de directorio).
 */
export function labelForProject(projectKey: string, projectPath: string | null): string {
  if (projectPath !== null && projectPath !== '') {
    const base = basename(projectPath)
    if (base !== '') return base
  }
  const segments = projectKey.split('-').filter((s) => s !== '')
  return segments.length > 0 ? (segments[segments.length - 1] as string) : projectKey
}

function addDays(day: string, delta: number): string {
  const ms = Date.parse(`${day}T00:00:00Z`)
  if (!Number.isFinite(ms)) return day
  return new Date(ms + delta * 86_400_000).toISOString().slice(0, 10)
}
