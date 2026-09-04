import { copyFileSync, existsSync } from 'node:fs'
import type { Db } from './connection'
import { schemaVersion } from './connection'
import { LATEST_SCHEMA_VERSION, MIGRATIONS, type Migration } from './migration-files'

export class MigrationError extends Error {
  constructor(
    readonly migration: string,
    override readonly cause: unknown
  ) {
    super(`Fallo aplicando la migración ${migration}: ${String(cause)}`)
    this.name = 'MigrationError'
  }
}

export interface MigrateResult {
  /**
   * - `ok`: la BD está en la última versión (se hayan aplicado migraciones o no).
   * - `future-schema`: la BD viene de una app más nueva. NO se ha tocado nada;
   *   el llamante debe reabrir en solo lectura y emitir `app:notice` de error.
   */
  readonly status: 'ok' | 'future-schema'
  readonly from: number
  readonly to: number
  readonly applied: readonly string[]
  readonly backupPath: string | null
}

/**
 * Runner de migraciones (02-esquema-bd.md §3).
 * Cada fichero se aplica en su propia transacción y sube `user_version` en 1.
 * Antes del primer salto, si ya había esquema, se deja una copia `.bak-v<N>`
 * para que un downgrade de la app siempre tenga salida.
 */
export function migrate(db: Db, migrations: readonly Migration[] = MIGRATIONS): MigrateResult {
  const from = schemaVersion(db)
  const latest = migrations.reduce((max, m) => (m.version > max ? m.version : max), 0)

  if (from > latest) {
    return { status: 'future-schema', from, to: from, applied: [], backupPath: null }
  }

  const pending = migrations.filter((m) => m.version > from).sort((a, b) => a.version - b.version)
  if (pending.length === 0) {
    return { status: 'ok', from, to: from, applied: [], backupPath: null }
  }

  assertContiguous(from, pending)

  const backupPath = from > 0 ? backupDatabase(db, from) : null
  const applied: string[] = []

  for (const m of pending) {
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec(m.sql)
      db.pragma(`user_version = ${m.version}`)
      db.exec('COMMIT')
      applied.push(m.name)
    } catch (err) {
      try {
        db.exec('ROLLBACK')
      } catch {
        /* la transacción ya podía estar abortada */
      }
      throw new MigrationError(m.name, err)
    }
  }

  return { status: 'ok', from, to: schemaVersion(db), applied, backupPath }
}

/** Un fichero = un salto de 1. Si falta un número, la lista está mal montada. */
function assertContiguous(from: number, pending: readonly Migration[]): void {
  let expected = from + 1
  for (const m of pending) {
    if (m.version !== expected) {
      throw new MigrationError(
        m.name,
        `se esperaba la versión ${expected} y llegó la ${m.version}: falta una migración`
      )
    }
    expected += 1
  }
}

/**
 * Copia de seguridad previa a migrar. Una sola por versión de origen: se
 * sobrescribe si ya existía. Antes se hace checkpoint para que el `.db` sea
 * autosuficiente sin su `-wal`.
 */
export function backupDatabase(db: Db, version: number): string | null {
  const file = db.name
  if (!file || file === ':memory:' || !existsSync(file)) return null
  const dest = `${file}.bak-v${version}`
  try {
    db.pragma('wal_checkpoint(TRUNCATE)')
    copyFileSync(file, dest)
    return dest
  } catch {
    // Una copia fallida no debe impedir migrar: se avisa devolviendo null.
    return null
  }
}

export { LATEST_SCHEMA_VERSION, MIGRATIONS }
export type { Migration }
