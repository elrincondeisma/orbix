import type { Db } from './connection'
import { PriceCache, SYNTHETIC_MODEL_KEY, type CostCounters } from './prices'
import { dayLocal } from './time'

/**
 * `rollup_daily` es SIEMPRE derivable: se puede borrar entera y reconstruirla
 * (02-esquema-bd.md §5.6). Se alimenta de dos fuentes:
 *   1. `usage_requests` — los transcripts vivos.
 *   2. `snapshot_rollups` — el histórico que Claude Code ya borró (migración 003).
 *
 * REGLA: EL SNAPSHOT SOLO RELLENA HUECOS (decisión de producto, 2026-09-03).
 *
 * Donde hay transcripts vivos mandan ellos, siempre. El snapshot entra solo en
 * los días en los que no queda NI UN transcript vivo. El criterio es de
 * PRESENCIA, no de volumen: no se comparan tokens, no compiten, no gana el que
 * más tenga.
 *
 * El porqué es que la cifra sea REPRODUCIBLE: Ismael puede escanear él mismo
 * `~/.claude/projects` y obtener exactamente lo que ve en el menubar, más los
 * días rescatados que ya no existen en disco. La regla anterior ("gana el día
 * con más tokens") daba una cifra más alta que no cuadraba con ninguna fuente
 * —la app decía 9,2× cuando lo reproducible eran 8,8×—. Cuesta ~$53 de consumo
 * real en los días mixtos, y se acepta: "nada de mentiras" manda sobre "la
 * cifra más completa".
 *
 * Tampoco se fusionan clave a clave, y esa parte no ha cambiado: las dos
 * fuentes agrupan por proyectos distintos —el ingestor por el directorio bajo
 * `projects/` (§5.1) y el snapshot por el `cwd` de cada línea—, así que
 * mezclarlas duplicaría el consumo de los subagentes que corren en worktrees.
 */

/** De dónde salen las cifras de un día: transcripts vivos o snapshot de rescate. */
export type RollupSource = 'live' | 'snapshot'

interface Agg {
  requests: number
  input_tok: number
  output_tok: number
  thinking_tok: number
  cache_write_5m: number
  cache_write_1h: number
  cache_read: number
  cost_usd: number
}

export function markDirtyDay(db: Db, day: string, now = new Date().toISOString()): void {
  db.prepare(`INSERT OR IGNORE INTO rollup_dirty (day_local, marked_at) VALUES (?, ?)`).run(day, now)
}

export function markDirtyDays(db: Db, days: Iterable<string>, now = new Date().toISOString()): void {
  const stmt = db.prepare(`INSERT OR IGNORE INTO rollup_dirty (day_local, marked_at) VALUES (?, ?)`)
  const run = db.transaction((list: string[]) => {
    for (const d of list) stmt.run(d, now)
  })
  run([...days])
}

/** Encola TODOS los días con datos. Base de `ingest:runNow { full: true }`. */
export function markAllDaysDirty(db: Db, now = new Date().toISOString()): number {
  const a = db
    .prepare(
      `INSERT OR IGNORE INTO rollup_dirty (day_local, marked_at)
       SELECT DISTINCT day_local, ? FROM usage_requests`
    )
    .run(now).changes
  const b = db
    .prepare(
      `INSERT OR IGNORE INTO rollup_dirty (day_local, marked_at)
       SELECT DISTINCT day_local, ? FROM snapshot_rollups`
    )
    .run(now).changes
  return a + b
}

export interface RecomputeOptions {
  /** Días por tanda; el resto queda en la cola para el siguiente ciclo. */
  readonly limit?: number
  readonly now?: string
}

/**
 * Recalcula los días marcados en `rollup_dirty`, cada uno en su transacción
 * (§5.6). Devuelve cuántos días ha recalculado.
 */
export function recomputeDirtyDays(db: Db, prices: PriceCache, opts: RecomputeOptions = {}): number {
  const limit = opts.limit ?? 50
  const now = opts.now ?? new Date().toISOString()

  const days = (
    db.prepare(`SELECT day_local FROM rollup_dirty ORDER BY day_local LIMIT ?`).all(limit) as Array<{
      day_local: string
    }>
  ).map((r) => r.day_local)

  for (const day of days) recomputeDay(db, prices, day, now)
  return days.length
}

const selectRealDay = `
  SELECT project_key, model_key, COUNT(*) AS requests,
         SUM(input_tok) AS input_tok, SUM(output_tok) AS output_tok,
         SUM(thinking_tok) AS thinking_tok, SUM(cache_write_5m) AS cache_write_5m,
         SUM(cache_write_1h) AS cache_write_1h, SUM(cache_read) AS cache_read,
         SUM(cost_usd) AS cost_usd
    FROM usage_requests
   WHERE day_local = ? AND model_key <> '${SYNTHETIC_MODEL_KEY}'
   GROUP BY project_key, model_key`

/**
 * Presencia de transcripts vivos. Deliberadamente SIN filtrar `__synthetic__`:
 * si de ese día sobrevive cualquier línea de transcript, el día es "vivo" y el
 * snapshot no entra, aunque su única petición sea un error de API.
 */
const selectHasLive = `SELECT 1 FROM usage_requests WHERE day_local = ? LIMIT 1`

const selectSnapDay = `
  SELECT project_key, model_key, requests, input_tok, output_tok, thinking_tok,
         cache_write_5m, cache_write_1h, cache_read
    FROM snapshot_rollups
   WHERE day_local = ? AND model_key <> '${SYNTHETIC_MODEL_KEY}'`

/** Recalcula un día concreto y lo saca de la cola. */
export function recomputeDay(
  db: Db,
  prices: PriceCache,
  day: string,
  now = new Date().toISOString()
): void {
  const run = db.transaction(() => {
    // El snapshot SOLO rellena huecos: si queda un solo transcript vivo de este
    // día, manda él y el rescate ni se mira (ver cabecera del módulo).
    const hasLive = db.prepare(selectHasLive).get(day) !== undefined

    const live: Array<{ project_key: string; model_key: string; agg: Agg }> = []
    for (const r of db.prepare(selectRealDay).all(day) as Array<Record<string, number | string>>) {
      live.push({
        project_key: String(r['project_key']),
        model_key: String(r['model_key']),
        agg: {
          requests: Number(r['requests']),
          input_tok: Number(r['input_tok']),
          output_tok: Number(r['output_tok']),
          thinking_tok: Number(r['thinking_tok']),
          cache_write_5m: Number(r['cache_write_5m']),
          cache_write_1h: Number(r['cache_write_1h']),
          cache_read: Number(r['cache_read']),
          cost_usd: Number(r['cost_usd'])
        }
      })
    }

    // Mediodía UTC del día: instante representativo para resolver la tarifa.
    const tsForPrice = `${day}T12:00:00.000Z`
    const rescued: Array<{ project_key: string; model_key: string; agg: Agg }> = []
    const snapRows = hasLive
      ? []
      : (db.prepare(selectSnapDay).all(day) as Array<Record<string, number | string>>)
    for (const r of snapRows) {
      const modelKey = String(r['model_key'])
      const counters: CostCounters = {
        input_tok: Number(r['input_tok']),
        output_tok: Number(r['output_tok']),
        cache_write_5m: Number(r['cache_write_5m']),
        cache_write_1h: Number(r['cache_write_1h']),
        cache_read: Number(r['cache_read'])
      }
      rescued.push({
        project_key: String(r['project_key']),
        model_key: modelKey,
        agg: {
          requests: Number(r['requests']),
          thinking_tok: Number(r['thinking_tok']),
          ...counters,
          cost_usd: prices.costOf(modelKey, tsForPrice, counters).costUsd
        }
      })
    }

    // Criterio de PRESENCIA, no de volumen: nunca se comparan tokens.
    const winner = hasLive ? live : rescued
    const source: RollupSource = hasLive ? 'live' : 'snapshot'

    db.prepare(`DELETE FROM rollup_daily WHERE day_local = ?`).run(day)

    const insert = db.prepare(
      `INSERT INTO rollup_daily
         (day_local, project_key, model_key, requests, input_tok, output_tok, thinking_tok,
          cache_write_5m, cache_write_1h, cache_read, cost_usd, updated_at, source)
       VALUES (@day, @project_key, @model_key, @requests, @input_tok, @output_tok, @thinking_tok,
          @cache_write_5m, @cache_write_1h, @cache_read, @cost_usd, @now, @source)`
    )
    for (const { project_key, model_key, agg } of winner) {
      insert.run({ day, project_key, model_key, now, source, ...agg })
    }

    db.prepare(`DELETE FROM rollup_dirty WHERE day_local = ?`).run(day)
  })
  run()
}

/**
 * Días cuyas cifras vienen del snapshot de rescate porque ya no queda ningún
 * transcript vivo. El panel de estadísticas los marca y sirven para auditar la
 * cifra: todo lo que NO esté aquí se puede reproducir escaneando
 * `~/.claude/projects`.
 */
export function rescuedDays(db: Db, from?: string, to?: string): string[] {
  const sql =
    from !== undefined && to !== undefined
      ? `SELECT DISTINCT day_local FROM rollup_daily
          WHERE source = 'snapshot' AND day_local BETWEEN ? AND ? ORDER BY day_local`
      : `SELECT DISTINCT day_local FROM rollup_daily
          WHERE source = 'snapshot' ORDER BY day_local`
  const rows = (
    from !== undefined && to !== undefined
      ? db.prepare(sql).all(from, to)
      : db.prepare(sql).all()
  ) as Array<{ day_local: string }>
  return rows.map((r) => r.day_local)
}

/** Reconstrucción completa: vacía `rollup_daily` y recalcula todos los días. */
export function rebuildAllRollups(db: Db, prices: PriceCache, now?: string): number {
  const ts = now ?? new Date().toISOString()
  db.exec('DELETE FROM rollup_daily')
  markAllDaysDirty(db, ts)
  let total = 0
  let done = 0
  do {
    done = recomputeDirtyDays(db, prices, { limit: 200, now: ts })
    total += done
  } while (done > 0)
  return total
}

export interface StaleCostResult {
  readonly updated: number
  readonly batches: number
}

/**
 * Recalcula el coste de las peticiones marcadas `cost_stale` (§5.7), por lotes,
 * cada lote en su transacción para no bloquear `main`.
 */
export function recomputeStaleCosts(
  db: Db,
  prices: PriceCache,
  batchSize = 5000,
  now = new Date().toISOString()
): StaleCostResult {
  const select = db.prepare(
    `SELECT request_id, ts, day_local, model_key, input_tok, output_tok,
            cache_write_5m, cache_write_1h, cache_read
       FROM usage_requests WHERE cost_stale = 1 LIMIT ?`
  )
  const update = db.prepare(
    `UPDATE usage_requests
        SET cost_usd = @cost, price_id = @price_id, cost_stale = 0, updated_at = @now
      WHERE request_id = @rid`
  )

  let updated = 0
  let batches = 0
  const touchedDays = new Set<string>()
  for (;;) {
    const rows = select.all(batchSize) as Array<Record<string, string | number>>
    if (rows.length === 0) break
    const run = db.transaction(() => {
      for (const r of rows) {
        const modelKey = String(r['model_key'])
        touchedDays.add(String(r['day_local']))
        const ts = String(r['ts'])
        const { costUsd, priceId } = prices.costOf(modelKey, ts, {
          input_tok: Number(r['input_tok']),
          output_tok: Number(r['output_tok']),
          cache_write_5m: Number(r['cache_write_5m']),
          cache_write_1h: Number(r['cache_write_1h']),
          cache_read: Number(r['cache_read'])
        })
        update.run({ cost: costUsd, price_id: priceId, rid: String(r['request_id']), now })
      }
    })
    run()
    updated += rows.length
    batches += 1
    if (rows.length < batchSize) break
  }

  if (touchedDays.size > 0) markDirtyDays(db, touchedDays, now)
  return { updated, batches }
}

/**
 * Cambio de zona horaria (§5.7): recalcula `day_local` de todas las peticiones y
 * reconstruye los rollups. Operación explícita y con confirmación en prefs.
 */
export function recomputeDayLocal(db: Db, timezone: string, prices: PriceCache): number {
  const rows = db.prepare(`SELECT request_id, ts_epoch, day_local FROM usage_requests`).all() as
    Array<{ request_id: string; ts_epoch: number; day_local: string }>
  const update = db.prepare(`UPDATE usage_requests SET day_local = ? WHERE request_id = ?`)
  let changed = 0
  const run = db.transaction(() => {
    for (const r of rows) {
      const d = dayLocal(r.ts_epoch, timezone)
      if (d !== r.day_local) {
        update.run(d, r.request_id)
        changed += 1
      }
    }
  })
  run()
  rebuildAllRollups(db, prices)
  return changed
}
