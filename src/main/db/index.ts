import { closeDatabase, defaultDbPath, openDatabase, schemaVersion, type Db } from './connection'
import { getMeta, setMeta } from './meta'
import { migrate, type MigrateResult } from './migrate'
import { PriceCache } from './prices'
import { Queries } from './queries'
import { systemTimezone } from './time'

export interface DataLayer {
  readonly db: Db
  readonly prices: PriceCache
  readonly queries: Queries
  readonly migration: MigrateResult
  readonly schemaVersion: number
  readonly timezone: string
  close(): void
}

export interface InitOptions {
  readonly path?: string
  /** IANA; por defecto la del sistema. */
  readonly timezone?: string
}

/**
 * Punto de entrada de la capa de datos: abre, migra y deja lista la caché de
 * precios y las consultas. Si la BD viene de una versión de esquema futura, se
 * reabre en SOLO LECTURA y `migration.status` lo dice: `main` debe emitir
 * `app:notice` de nivel `error` (02-esquema-bd.md §3).
 */
export function initDataLayer(options: InitOptions = {}): DataLayer {
  const path = options.path ?? defaultDbPath()
  const timezone = options.timezone ?? systemTimezone()

  let db = openDatabase(path)
  let migration = migrate(db)

  if (migration.status === 'future-schema') {
    closeDatabase(db)
    db = openDatabase(path, { readonly: true })
  } else {
    const now = new Date().toISOString()
    if (getMeta(db, 'schema_created_at') === null) setMeta(db, 'schema_created_at', now, now)
    // Deja constancia de con qué zona se calculó `day_local`: cambiarla obliga a
    // recalcular el histórico (rollups.recomputeDayLocal).
    if (getMeta(db, 'timezone') === null) setMeta(db, 'timezone', timezone, now)
  }

  const prices = new PriceCache(db)
  const queries = new Queries(db, timezone)

  return {
    db,
    prices,
    queries,
    migration,
    schemaVersion: schemaVersion(db),
    timezone,
    close: () => closeDatabase(db)
  }
}

export { closeDatabase, defaultDbPath, openDatabase, schemaVersion } from './connection'
export { getMeta, setMeta } from './meta'
export { migrate, MigrationError, LATEST_SCHEMA_VERSION } from './migrate'
export {
  computeCost,
  listPrices,
  normalizeModel,
  PriceCache,
  upsertPrice,
  DEFAULT_MODEL_KEY,
  SYNTHETIC_MODEL_KEY,
  UNKNOWN_MODEL_KEY,
  type ModelPrice,
  type ModelPriceInput,
  type PriceUpsertInput
} from './prices'
export { Queries, labelForProject, totalTokensOf } from './queries'
export {
  markAllDaysDirty,
  markDirtyDays,
  rebuildAllRollups,
  recomputeDay,
  recomputeDayLocal,
  recomputeDirtyDays,
  recomputeStaleCosts,
  rescuedDays,
  type RollupSource
} from './rollups'
export {
  importSnapshot,
  importSnapshotAndRecompute,
  importSnapshotFile,
  projectKeyFromPath,
  SNAPSHOT_SCHEMA
} from './snapshot-import'
export { dbStats, purgeOldData, vacuum, type DbStats, type PurgeResult } from './retention'
export { dayLocal, periodBounds, systemTimezone, toUtcIso } from './time'
export type { Db } from './connection'
