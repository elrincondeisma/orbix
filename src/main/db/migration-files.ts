import sql001 from './migrations/001_init.sql?raw'
import sql002 from './migrations/002_seed.sql?raw'
import sql003 from './migrations/003_snapshot_rollups.sql?raw'
import sql004 from './migrations/004_rollup_source.sql?raw'

/** Una migración = un fichero = un salto de versión de 1 (02-esquema-bd.md §3). */
export interface Migration {
  readonly version: number
  readonly name: string
  readonly sql: string
}

/**
 * Lista ordenada de migraciones. Añadir siempre al final, nunca reordenar ni
 * editar una ya publicada: `PRAGMA user_version` de las BD existentes ya la dio
 * por aplicada.
 */
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: '001_init', sql: sql001 },
  { version: 2, name: '002_seed', sql: sql002 },
  { version: 3, name: '003_snapshot_rollups', sql: sql003 },
  { version: 4, name: '004_rollup_source', sql: sql004 }
]

/** Versión de esquema que conoce este binario. */
export const LATEST_SCHEMA_VERSION: number = MIGRATIONS.reduce(
  (max, m) => (m.version > max ? m.version : max),
  0
)
