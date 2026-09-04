import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { closeDatabase, openDatabase, schemaVersion } from '../../src/main/db/connection'
import { LATEST_SCHEMA_VERSION, MIGRATIONS, migrate, MigrationError } from '../../src/main/db/migrate'
import { PriceCache } from '../../src/main/db/prices'
import { recomputeDirtyDays } from '../../src/main/db/rollups'

function tables(db: ReturnType<typeof openDatabase>): string[] {
  return (
    db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as Array<{
      name: string
    }>
  ).map((r) => r.name)
}

describe('migraciones', () => {
  it('deja el esquema en la última versión con todas las tablas', () => {
    const db = openDatabase(':memory:')
    const result = migrate(db)

    expect(result.status).toBe('ok')
    expect(result.from).toBe(0)
    expect(result.to).toBe(LATEST_SCHEMA_VERSION)
    expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION)
    expect(tables(db)).toEqual([
      'hook_events',
      'ingest_files',
      'limits_snapshots',
      'meta',
      'model_prices',
      'plans',
      'rollup_daily',
      'rollup_dirty',
      'snapshot_rollups',
      'usage_lines',
      'usage_requests'
    ])
  })

  it('es idempotente: ejecutarla dos veces no aplica nada nuevo', () => {
    const db = openDatabase(':memory:')
    migrate(db)
    const segunda = migrate(db)
    expect(segunda.applied).toEqual([])
    expect(segunda.to).toBe(LATEST_SCHEMA_VERSION)
    // y la semilla no se duplica
    const n = db.prepare('SELECT COUNT(*) AS n FROM model_prices').get() as { n: number }
    expect(n.n).toBe(5)
  })

  it('los índices declarados en el diseño existen', () => {
    const db = openDatabase(':memory:')
    migrate(db)
    const idx = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all() as Array<{
        name: string
      }>
    ).map((r) => r.name)
    for (const name of [
      'idx_ur_day',
      'idx_ur_epoch',
      'idx_ur_session',
      'idx_ur_proj_day',
      'idx_ur_model_day',
      'idx_ur_stale',
      'idx_rollup_day',
      'idx_usage_lines_req',
      'idx_prices_lookup',
      'idx_hook_epoch',
      'idx_ingest_files_ident'
    ]) {
      expect(idx).toContain(name)
    }
  })

  it('una BD de una versión futura no se toca y se avisa', () => {
    const db = openDatabase(':memory:')
    migrate(db)
    db.pragma(`user_version = ${LATEST_SCHEMA_VERSION + 5}`)

    const result = migrate(db)
    expect(result.status).toBe('future-schema')
    expect(result.applied).toEqual([])
    expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION + 5)
  })

  it('una migración rota revierte y deja la versión intacta', () => {
    const db = openDatabase(':memory:')
    migrate(db)
    const antes = schemaVersion(db)

    expect(() =>
      migrate(db, [
        ...MIGRATIONS,
        { version: LATEST_SCHEMA_VERSION + 1, name: '999_rota', sql: 'ESTO NO ES SQL;' }
      ])
    ).toThrow(MigrationError)

    expect(schemaVersion(db)).toBe(antes)
  })

  it('detecta un salto de versión ausente', () => {
    const db = openDatabase(':memory:')
    expect(() =>
      migrate(db, [{ version: 2, name: '002_sin_001', sql: 'CREATE TABLE x (a);' }])
    ).toThrow(/falta una migración/)
  })

  it('hace copia de seguridad antes de migrar una BD existente', () => {
    const dir = mkdtempSync(join(tmpdir(), 'miniclaudio-db-'))
    const file = join(dir, 'miniclaudio.db')

    let db = openDatabase(file)
    migrate(db, MIGRATIONS.slice(0, 1)) // solo hasta la v1
    closeDatabase(db)

    db = openDatabase(file)
    const result = migrate(db)
    expect(result.from).toBe(1)
    expect(result.backupPath).toBe(`${file}.bak-v1`)
    expect(existsSync(`${file}.bak-v1`)).toBe(true)
    closeDatabase(db)
  })

  it('la v4 recalcula el histórico ya guardado con la regla nueva', () => {
    const db = openDatabase(':memory:')
    // BD que se quedó en la v3, con rollups calculados con la regla vieja
    migrate(db, MIGRATIONS.slice(0, 3))
    expect(schemaVersion(db)).toBe(3)

    db.prepare(
      `INSERT INTO usage_requests
         (request_id, ts, ts_epoch, day_local, project_key, is_sidechain, model_raw, model_key,
          blocks, cost_usd, cost_stale, first_seen_at, updated_at)
       VALUES ('r1', '2026-08-25T10:00:00Z', 1, '2026-08-25', 'p', 0, 'claude-opus-5',
          'claude-opus-5', 1, 336.32, 0, 'x', 'x')`
    ).run()
    db.prepare(
      `INSERT INTO snapshot_rollups
         (day_local, project_key, model_key, requests, output_tok, source_file, imported_at)
       VALUES ('2026-08-25', 'p', 'claude-opus-5', 9, 99, 'x.json', 'x')`
    ).run()
    // rollup viejo: el snapshot le había ganado el día por tener más tokens
    db.prepare(
      `INSERT INTO rollup_daily
         (day_local, project_key, model_key, requests, cost_usd, updated_at)
       VALUES ('2026-08-25', 'p', 'claude-opus-5', 9, 337.91, 'x')`
    ).run()

    migrate(db)
    expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION)

    // la cifra vieja se tira y el día queda encolado para recalcularse solo
    expect(db.prepare('SELECT COUNT(*) AS n FROM rollup_daily').get()).toEqual({ n: 0 })
    expect(db.prepare('SELECT day_local FROM rollup_dirty').all()).toEqual([
      { day_local: '2026-08-25' }
    ])

    // y al recalcular gana el transcript vivo, no el snapshot
    const prices = new PriceCache(db)
    recomputeDirtyDays(db, prices)
    const row = db.prepare('SELECT * FROM rollup_daily').get() as Record<string, number | string>
    expect(row['cost_usd']).toBeCloseTo(336.32, 6)
    expect(row['source']).toBe('live')
  })

  it('aplica los PRAGMA de conexión', () => {
    const dir = mkdtempSync(join(tmpdir(), 'miniclaudio-db-'))
    const db = openDatabase(join(dir, 'p.db'))
    expect((db.pragma('journal_mode') as Array<{ journal_mode: string }>)[0]?.journal_mode).toBe(
      'wal'
    )
    expect((db.pragma('foreign_keys') as Array<{ foreign_keys: number }>)[0]?.foreign_keys).toBe(1)
    closeDatabase(db)
  })
})
