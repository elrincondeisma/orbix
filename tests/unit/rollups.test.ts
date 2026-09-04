import { beforeEach, describe, expect, it } from 'vitest'
import type { Db } from '../../src/main/db/connection'
import { PriceCache, upsertPrice } from '../../src/main/db/prices'
import {
  markAllDaysDirty,
  rebuildAllRollups,
  recomputeDirtyDays,
  recomputeStaleCosts,
  rescuedDays
} from '../../src/main/db/rollups'
import { importSnapshot } from '../../src/main/db/snapshot-import'
import { Ingestor } from '../../src/main/ingest/ingestor'
import { freshDb, makeProjectsRoot, placeFixture } from '../helpers/db'

const TZ = 'Europe/Madrid'
const PROJECT = '-Users-tester-Projects-demo'

let db: Db
let prices: PriceCache
let root: string

beforeEach(async () => {
  const fresh = freshDb()
  db = fresh.db
  prices = fresh.prices
  root = makeProjectsRoot()
  placeFixture(root, 'multi-block.jsonl', `${PROJECT}/sesion.jsonl`)
  await new Ingestor({ db, prices, timezone: TZ, root }).runOnce()
})

function scalar(sql: string): number {
  const row = db.prepare(sql).get() as Record<string, number>
  return Object.values(row)[0] as number
}

describe('rollups', () => {
  it('el rollup diario se puede borrar y reconstruir sin perder nada', () => {
    const antes = scalar('SELECT ROUND(SUM(cost_usd), 9) FROM rollup_daily')
    expect(antes).toBeGreaterThan(0)

    rebuildAllRollups(db, prices)
    expect(scalar('SELECT ROUND(SUM(cost_usd), 9) FROM rollup_daily')).toBe(antes)
  })

  it('recalcula el histórico entero cuando cambia un precio', () => {
    const antes = scalar('SELECT ROUND(SUM(cost_usd), 9) FROM rollup_daily')

    const res = upsertPrice(db, {
      modelKey: 'claude-opus-5',
      inputPerMtok: 10,
      outputPerMtok: 50,
      cacheWrite5mPerMtok: 12.5,
      cacheWrite1hPerMtok: 20,
      cacheReadPerMtok: 1,
      validFrom: '2000-01-01T00:00:00Z'
    })
    expect(res.affectedRequests).toBe(1)
    expect(res.affectedDays).toBe(1)

    prices.reload()
    const stale = recomputeStaleCosts(db, prices)
    expect(stale.updated).toBe(1)
    expect(scalar('SELECT COUNT(*) FROM usage_requests WHERE cost_stale = 1')).toBe(0)

    recomputeDirtyDays(db, prices)
    // el doble de precio, el doble de coste, hasta el último decimal
    expect(scalar('SELECT ROUND(SUM(cost_usd), 9) FROM rollup_daily')).toBeCloseTo(antes * 2, 9)
  })

  it('bajar el precio también recalcula hacia abajo', () => {
    upsertPrice(db, {
      modelKey: '__default__',
      inputPerMtok: 0,
      outputPerMtok: 0,
      cacheWrite5mPerMtok: 0,
      cacheWrite1hPerMtok: 0,
      cacheReadPerMtok: 0,
      validFrom: '2000-01-01T00:00:00Z'
    })
    upsertPrice(db, {
      modelKey: 'claude-opus-5',
      inputPerMtok: 0,
      outputPerMtok: 0,
      cacheWrite5mPerMtok: 0,
      cacheWrite1hPerMtok: 0,
      cacheReadPerMtok: 0,
      validFrom: '2000-01-01T00:00:00Z'
    })
    prices.reload()
    recomputeStaleCosts(db, prices)
    recomputeDirtyDays(db, prices)
    expect(scalar('SELECT ROUND(SUM(cost_usd), 9) FROM rollup_daily')).toBe(0)
  })

  it('una tarifa con valid_from posterior no toca el pasado', () => {
    const antes = scalar('SELECT ROUND(SUM(cost_usd), 9) FROM rollup_daily')
    upsertPrice(db, {
      modelKey: 'claude-opus-5',
      inputPerMtok: 500,
      outputPerMtok: 500,
      cacheWrite5mPerMtok: 500,
      cacheWrite1hPerMtok: 500,
      cacheReadPerMtok: 500,
      validFrom: '2099-01-01T00:00:00Z'
    })
    prices.reload()
    recomputeStaleCosts(db, prices)
    recomputeDirtyDays(db, prices)
    expect(scalar('SELECT ROUND(SUM(cost_usd), 9) FROM rollup_daily')).toBe(antes)
  })
})

describe('rollups + snapshot de rescate', () => {
  const snapshot = {
    schema: 'miniclaudio.snapshot/2',
    generated_at: '2026-09-03T09:22:55Z',
    rollups: [
      {
        day: '2026-08-01',
        project: '/Users/tester/Projects/borrado',
        model: 'claude-opus-5',
        input_tokens: 100,
        output_tokens: 200_000,
        thinking_tokens: 1000,
        cache_write_5m: 0,
        cache_write_1h: 50_000,
        cache_read: 10_000_000,
        messages: 300
      }
    ]
  }

  it('importa días que ya no tienen transcript y les calcula el coste', () => {
    const res = importSnapshot(db, snapshot, 'snapshot-test.json')
    expect(res.rowsWritten).toBe(1)
    recomputeDirtyDays(db, prices)

    const row = db
      .prepare(`SELECT * FROM rollup_daily WHERE day_local = '2026-08-01'`)
      .get() as Record<string, number | string>
    expect(row['project_key']).toBe('-Users-tester-Projects-borrado')
    expect(row['requests']).toBe(300)
    // (100*5 + 200000*25 + 50000*10 + 10000000*0.5) / 1e6
    expect(row['cost_usd']).toBeCloseTo(10.5005, 9)
  })

  it('importar dos veces no duplica ni suma', () => {
    importSnapshot(db, snapshot, 'snapshot-test.json')
    importSnapshot(db, snapshot, 'snapshot-test.json')
    recomputeDirtyDays(db, prices)
    expect(scalar(`SELECT COUNT(*) FROM snapshot_rollups`)).toBe(1)
    expect(scalar(`SELECT output_tok FROM rollup_daily WHERE day_local = '2026-08-01'`)).toBe(
      200_000
    )
  })

  it('con transcript vivo del mismo día, el snapshot ni se mira (aunque traiga más)', () => {
    const day = db.prepare('SELECT day_local, project_key FROM usage_requests').get() as {
      day_local: string
      project_key: string
    }
    // snapshot MUCHO más gordo que el transcript vivo: da igual, no compite
    importSnapshot(
      db,
      {
        schema: 'miniclaudio.snapshot/2',
        rollups: [
          {
            day: day.day_local,
            project: '/Users/tester/Projects/demo',
            model: 'claude-opus-5',
            input_tokens: 500,
            output_tokens: 500_000,
            thinking_tokens: 0,
            cache_write_5m: 0,
            cache_write_1h: 0,
            cache_read: 900_000_000,
            messages: 4200
          },
          {
            // ...y con un proyecto que el transcript vivo no tiene: tampoco entra
            day: day.day_local,
            project: '/Users/tester/Projects/demo/.claude/worktrees/agent-x',
            model: 'claude-opus-5',
            input_tokens: 1,
            output_tokens: 1000,
            thinking_tokens: 0,
            cache_write_5m: 0,
            cache_write_1h: 0,
            cache_read: 1_000_000,
            messages: 364
          }
        ]
      },
      'snapshot-test.json'
    )
    markAllDaysDirty(db)
    recomputeDirtyDays(db, prices)

    const rows = db
      .prepare('SELECT * FROM rollup_daily WHERE day_local = ?')
      .all(day.day_local) as Array<Record<string, number | string>>
    expect(rows).toHaveLength(1)
    expect(rows[0]?.['cache_read']).toBe(26354) // la cifra del transcript vivo
    expect(rows[0]?.['requests']).toBe(1)
    expect(rows[0]?.['source']).toBe('live')
    // la cifra del día es exactamente la reproducible escaneando los transcripts
    expect(scalar(`SELECT ROUND(SUM(cost_usd), 9) FROM rollup_daily`)).toBeCloseTo(0.277637, 6)
  })

  it('el snapshot solo entra en los días sin ningún transcript vivo', () => {
    const dia = '2026-07-15' // Claude Code ya borró sus transcripts
    importSnapshot(
      db,
      {
        schema: 'miniclaudio.snapshot/2',
        rollups: [
          {
            day: dia,
            project: '/Users/tester/Projects/borrado',
            model: 'claude-opus-5',
            input_tokens: 500,
            output_tokens: 500_000,
            thinking_tokens: 0,
            cache_write_5m: 0,
            cache_write_1h: 0,
            cache_read: 900_000_000,
            messages: 4200
          }
        ]
      },
      'snapshot-test.json'
    )
    markAllDaysDirty(db)
    recomputeDirtyDays(db, prices)

    const row = db.prepare('SELECT * FROM rollup_daily WHERE day_local = ?').get(dia) as Record<
      string,
      number | string
    >
    expect(row['requests']).toBe(4200)
    expect(row['cache_read']).toBe(900_000_000)
    expect(row['source']).toBe('snapshot')
  })

  it('un día con una sola petición sintética sigue siendo un día vivo', () => {
    // caso límite: la única línea del día es un error de API, que no cuenta como
    // consumo, pero SÍ significa que el transcript existe. El snapshot no entra.
    const dia = '2026-07-20'
    db.prepare(
      `INSERT INTO usage_requests
         (request_id, ts, ts_epoch, day_local, session_id, project_key, project_path,
          is_sidechain, model_raw, model_key, blocks, input_tok, output_tok, thinking_tok,
          cache_write_5m, cache_write_1h, cache_read, cost_usd, cost_stale, first_seen_at, updated_at)
       VALUES ('synth', ?, ?, ?, 's', 'p', NULL, 0, '<synthetic>', '__synthetic__', 1,
          0, 0, 0, 0, 0, 0, 0, 0, ?, ?)`
    ).run(`${dia}T10:00:00.000Z`, Date.parse(`${dia}T10:00:00.000Z`), dia, dia, dia)

    importSnapshot(
      db,
      {
        schema: 'miniclaudio.snapshot/2',
        rollups: [
          {
            day: dia,
            project: '/Users/tester/Projects/borrado',
            model: 'claude-opus-5',
            output_tokens: 100_000,
            cache_read: 1_000_000,
            messages: 50
          }
        ]
      },
      'snapshot-test.json'
    )
    markAllDaysDirty(db)
    recomputeDirtyDays(db, prices)

    // el día queda vacío (la sintética no cuenta) pero NO se rellena con el snapshot
    expect(db.prepare('SELECT * FROM rollup_daily WHERE day_local = ?').all(dia)).toEqual([])
  })

  it('marca los días de rescate para poder auditar la cifra', () => {
    importSnapshot(
      db,
      {
        schema: 'miniclaudio.snapshot/2',
        rollups: [
          {
            day: '2026-07-15',
            project: '/Users/tester/Projects/borrado',
            model: 'claude-opus-5',
            output_tokens: 1000,
            cache_read: 1000,
            messages: 2
          },
          {
            day: '2026-07-16',
            project: '/Users/tester/Projects/borrado',
            model: 'claude-opus-5',
            output_tokens: 1000,
            cache_read: 1000,
            messages: 2
          }
        ]
      },
      'snapshot-test.json'
    )
    markAllDaysDirty(db)
    recomputeDirtyDays(db, prices)

    // los días vivos NO se marcan; solo los rescatados
    const vivo = db.prepare('SELECT day_local FROM usage_requests').get() as { day_local: string }
    expect(rescuedDays(db)).toEqual(['2026-07-15', '2026-07-16'])
    expect(rescuedDays(db)).not.toContain(vivo.day_local)
    expect(rescuedDays(db, '2026-07-16', '2026-07-31')).toEqual(['2026-07-16'])
  })

  it('BUG-5: un snapshot con un contador absurdo tampoco rompe el día', () => {
    const res = importSnapshot(
      db,
      {
        schema: 'miniclaudio.snapshot/2',
        rollups: [
          {
            day: '2026-08-02',
            project: '/Users/tester/Projects/corrupto',
            model: 'claude-opus-5',
            input_tokens: 10,
            output_tokens: 1000,
            thinking_tokens: 0,
            cache_write_5m: 0,
            cache_write_1h: 0,
            cache_read: 1e30,
            messages: 3
          }
        ]
      },
      'corrupto.json'
    )
    expect(res.absurdCounters).toBe(1)
    recomputeDirtyDays(db, prices)

    const row = db
      .prepare(`SELECT * FROM rollup_daily WHERE day_local = '2026-08-02'`)
      .get() as Record<string, number>
    expect(row['cache_read']).toBe(0)
    expect(row['output_tok']).toBe(1000) // lo demás se conserva
    expect(row['cost_usd']).toBeCloseTo(0.02505, 9)
  })

  it('rechaza un snapshot con schema desconocido', () => {
    expect(() =>
      importSnapshot(db, { schema: 'miniclaudio.snapshot/1', rollups: [] }, 'viejo.json')
    ).toThrow(/schema desconocido/)
  })
})
