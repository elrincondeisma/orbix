import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { mkdirSync } from 'node:fs'
import Database from 'better-sqlite3'

export type Db = Database.Database

/**
 * Ruta por defecto de la BD. No usa `app.getPath('userData')` a propósito: este
 * módulo tiene que poder abrirse desde vitest sin arrancar Electron. `main`
 * puede pasar la ruta que quiera a `openDatabase`.
 */
export function defaultDbPath(): string {
  return join(homedir(), 'Library', 'Application Support', 'miniClaudio', 'miniclaudio.db')
}

export interface OpenOptions {
  /** Solo lectura: se usa cuando la BD viene de una versión de esquema futura. */
  readonly readonly?: boolean
  /** Traza de SQL para depurar (misma firma que espera better-sqlite3). */
  readonly verbose?: (message?: unknown, ...additionalArgs: unknown[]) => void
}

/**
 * Abre la BD y aplica los PRAGMA de 02-esquema-bd.md §1, en ese orden.
 * `:memory:` se admite tal cual (tests).
 */
export function openDatabase(path: string = defaultDbPath(), options: OpenOptions = {}): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })

  const db: Db = options.verbose
    ? new Database(path, { readonly: options.readonly === true, verbose: options.verbose })
    : new Database(path, { readonly: options.readonly === true })

  applyPragmas(db, options.readonly === true)
  return db
}

/** PRAGMA de conexión. Se re-aplican en cada apertura: no son persistentes salvo WAL. */
export function applyPragmas(db: Db, readonly = false): void {
  if (!readonly) {
    // WAL es persistente en el fichero; en :memory: SQLite lo ignora sin error.
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = NORMAL')
  }
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  db.pragma('temp_store = MEMORY')
  db.pragma('mmap_size = 134217728')
}

/** Cierre limpio: checkpoint del WAL para no dejar `-wal` gordo tras salir. */
export function closeDatabase(db: Db): void {
  try {
    if (db.open && !db.readonly) db.pragma('wal_checkpoint(TRUNCATE)')
  } catch {
    // un checkpoint fallido no puede impedir cerrar la app
  }
  try {
    db.close()
  } catch {
    /* idem */
  }
}

/** `PRAGMA user_version` como número. */
export function schemaVersion(db: Db): number {
  const rows = db.pragma('user_version') as Array<{ user_version: number }>
  return rows[0]?.user_version ?? 0
}
