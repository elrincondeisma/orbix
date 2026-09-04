import { describe, expect, it } from 'vitest'
import { PriceCache } from '../../src/main/db/prices'
import { dbStats, purgeOldData } from '../../src/main/db/retention'
import { recomputeDayLocal } from '../../src/main/db/rollups'
import { importSnapshot } from '../../src/main/db/snapshot-import'
import { dayLocal } from '../../src/main/db/time'
import { freshDb } from '../helpers/db'

const NOW = Date.parse('2026-09-03T09:00:00.000Z')

function insertHook(db: ReturnType<typeof freshDb>['db'], iso: string): void {
  db.prepare(
    `INSERT INTO hook_events (ts, ts_epoch, event, session_id, is_error)
     VALUES (?, ?, 'Stop', 's', 0)`
  ).run(iso, Date.parse(iso))
}

describe('retención', () => {
  it('purga hooks viejos y conserva el consumo', () => {
    const { db, prices } = freshDb()
    insertHook(db, '2026-09-01T10:00:00.000Z') // reciente
    insertHook(db, '2026-01-01T10:00:00.000Z') // > 90 días

    db.prepare(
      `INSERT INTO limits_snapshots (captured_at, fetched_at_ms, source, payload_json)
       VALUES ('2026-01-01T00:00:00Z', 1, 'cache', '{}')`
    ).run()
    db.prepare(
      `INSERT INTO limits_snapshots (captured_at, fetched_at_ms, source, payload_json)
       VALUES ('2026-09-01T00:00:00Z', 2, 'cache', '{}')`
    ).run()

    importSnapshot(
      db,
      {
        schema: 'miniclaudio.snapshot/2',
        rollups: [
          {
            day: '2025-01-01',
            project: '/Users/tester/Projects/viejo',
            model: 'claude-opus-5',
            output_tokens: 10,
            cache_read: 10,
            messages: 1
          }
        ]
      },
      'x.json'
    )

    const res = purgeOldData(db, NOW)
    expect(res.hookEvents).toBe(1)
    expect(res.limitsSnapshots).toBe(1)

    const stats = dbStats(db)
    expect(stats.hookEvents).toBe(1)
    // el histórico rescatado, por antiguo que sea, jamás se toca
    expect(stats.snapshotRows).toBe(1)
    expect(prices).toBeDefined()
  })

  it('un fichero desaparecido hace más de un año se olvida', () => {
    const { db } = freshDb()
    db.prepare(
      `INSERT INTO ingest_files (path, project_key, state, last_seen_at)
       VALUES ('/viejo.jsonl', 'p', 'gone', '2024-01-01T00:00:00Z')`
    ).run()
    db.prepare(
      `INSERT INTO ingest_files (path, project_key, state, last_seen_at)
       VALUES ('/nuevo.jsonl', 'p', 'gone', '2026-09-01T00:00:00Z')`
    ).run()
    expect(purgeOldData(db, NOW).goneFiles).toBe(1)
    expect(dbStats(db).filesTracked).toBe(1)
  })
})

describe('cambio de zona horaria', () => {
  it('recalcula day_local y reconstruye los rollups', () => {
    const { db, prices } = freshDb()
    // 2026-09-03 00:30 UTC = 2026-09-03 en UTC, pero 2026-09-02 en Los Ángeles
    const ts = '2026-09-03T00:30:00.000Z'
    db.prepare(
      `INSERT INTO usage_requests
         (request_id, ts, ts_epoch, day_local, session_id, project_key, project_path,
          is_sidechain, model_raw, model_key, blocks, input_tok, output_tok, thinking_tok,
          cache_write_5m, cache_write_1h, cache_read, cost_usd, cost_stale, first_seen_at, updated_at)
       VALUES ('r1', @ts, @epoch, @day, 's', 'p', NULL, 0, 'claude-opus-5', 'claude-opus-5', 1,
          0, 1000, 0, 0, 0, 0, 0.025, 0, @ts, @ts)`
    ).run({ ts, epoch: Date.parse(ts), day: dayLocal(Date.parse(ts), 'Europe/Madrid') })

    expect(
      (db.prepare('SELECT day_local FROM usage_requests').get() as { day_local: string }).day_local
    ).toBe('2026-09-03')

    const cambiadas = recomputeDayLocal(db, 'America/Los_Angeles', new PriceCache(db))
    expect(cambiadas).toBe(1)
    expect(
      (db.prepare('SELECT day_local FROM usage_requests').get() as { day_local: string }).day_local
    ).toBe('2026-09-02')
    // y el rollup se ha reconstruido en el día nuevo, sin dejar el viejo
    const dias = db.prepare('SELECT day_local FROM rollup_daily').all() as Array<{
      day_local: string
    }>
    expect(dias.map((d) => d.day_local)).toEqual(['2026-09-02'])
  })
})
