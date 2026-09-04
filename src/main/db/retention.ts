import type { Db } from './connection'

/**
 * Retención (02-esquema-bd.md §5.8).
 *
 * `usage_requests`, `usage_lines`, `rollup_daily` y `snapshot_rollups` NO se
 * purgan nunca: son el activo de la app, justo lo que Claude Code destruye a los
 * 30 días. Solo se limpian los datos accesorios.
 */

export const HOOK_EVENTS_DAYS = 90
export const LIMITS_SNAPSHOTS_DAYS = 180
export const GONE_FILES_DAYS = 365

export interface PurgeResult {
  readonly hookEvents: number
  readonly limitsSnapshots: number
  readonly goneFiles: number
}

/** Se llama una vez al día, al arrancar. Nunca borra consumo. */
export function purgeOldData(db: Db, now: number = Date.now()): PurgeResult {
  const hookCutoff = now - HOOK_EVENTS_DAYS * 86_400_000
  const limitsCutoff = new Date(now - LIMITS_SNAPSHOTS_DAYS * 86_400_000).toISOString()
  const goneCutoff = new Date(now - GONE_FILES_DAYS * 86_400_000).toISOString()

  const run = db.transaction((): PurgeResult => {
    const hookEvents = db.prepare(`DELETE FROM hook_events WHERE ts_epoch < ?`).run(hookCutoff)
      .changes
    const limitsSnapshots = db
      .prepare(`DELETE FROM limits_snapshots WHERE captured_at < ?`)
      .run(limitsCutoff).changes
    // Las filas 'gone' se conservan un año: si el fichero reaparece (restauración
    // de un backup) ya sabemos que estaba leído y no se reprocesa entero.
    const goneFiles = db
      .prepare(`DELETE FROM ingest_files WHERE state = 'gone' AND COALESCE(last_seen_at,'') < ?`)
      .run(goneCutoff).changes
    return { hookEvents, limitsSnapshots, goneFiles }
  })

  return run()
}

/** `VACUUM` manual desde preferencias. Nunca automático: bloquea la BD. */
export function vacuum(db: Db): void {
  db.exec('VACUUM')
}

export interface DbStats {
  readonly sizeBytes: number
  readonly usageRequests: number
  readonly usageLines: number
  readonly rollupRows: number
  readonly snapshotRows: number
  readonly hookEvents: number
  readonly filesTracked: number
}

/** Cifras para el panel de preferencias (`app:getInfo`). */
export function dbStats(db: Db): DbStats {
  const count = (table: string): number =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
  const pageCount = (db.pragma('page_count') as Array<{ page_count: number }>)[0]?.page_count ?? 0
  const pageSize = (db.pragma('page_size') as Array<{ page_size: number }>)[0]?.page_size ?? 0

  return {
    sizeBytes: pageCount * pageSize,
    usageRequests: count('usage_requests'),
    usageLines: count('usage_lines'),
    rollupRows: count('rollup_daily'),
    snapshotRows: count('snapshot_rollups'),
    hookEvents: count('hook_events'),
    filesTracked: count('ingest_files')
  }
}
