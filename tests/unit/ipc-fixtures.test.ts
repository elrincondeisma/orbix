import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Queries } from '../../src/main/db/queries'
import { markAllDaysDirty, recomputeDirtyDays } from '../../src/main/db/rollups'
import { importSnapshot } from '../../src/main/db/snapshot-import'
import { FIXTURES, freshDb } from '../helpers/db'

/**
 * Los fixtures de `tests/fixtures/ipc/` son el contrato con el que el frontal
 * maqueta el menubar sin esperar al backend. Este test garantiza que su forma
 * es EXACTAMENTE la que produce la capa de datos: si alguien cambia un campo,
 * salta aquí y no en la demo.
 */

function readFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, 'ipc', name), 'utf8'))
}

/**
 * Firma estructural: el conjunto de rutas de claves, ordenado. No compara tipos
 * de hoja a propósito: casi todos los campos del contrato son anulables y un
 * fixture con `null` describe el mismo contrato que uno con valor.
 */
function normalize(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value)) {
    return value.length > 0 ? normalize(value[0], `${prefix}[]`) : [`${prefix}[]`]
  }
  if (value !== null && typeof value === 'object') {
    const out: string[] = []
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out.push(...normalize((value as Record<string, unknown>)[key], `${prefix}.${key}`))
    }
    return out
  }
  return [prefix]
}

describe('fixtures de IPC', () => {
  const { db, prices } = freshDb()
  importSnapshot(
    db,
    {
      schema: 'miniclaudio.snapshot/2',
      generated_at: '2026-09-03T09:22:55Z',
      rollups: [
        {
          day: '2026-09-03',
          project: '/Users/tester/Projects/demo',
          model: 'claude-opus-5',
          input_tokens: 10,
          output_tokens: 1000,
          thinking_tokens: 100,
          cache_write_5m: 0,
          cache_write_1h: 500,
          cache_read: 100_000,
          messages: 5
        }
      ]
    },
    'fixture.json'
  )
  markAllDaysDirty(db)
  recomputeDirtyDays(db, prices)
  const q = new Queries(db, 'Europe/Madrid')
  const now = Date.parse('2026-09-03T09:40:00.000Z')

  const plan = {
    tierId: 'default_claude_max_20x',
    organizationType: 'claude_max',
    displayName: 'Max 20×',
    monthlyUsd: 200,
    accountEmail: 'tester@example.com',
    detected: true
  }
  const ingest = {
    state: 'idle' as const,
    filesTracked: 1,
    lastRunAt: null,
    lastDurationMs: null,
    backfillProgress: null,
    linesIngestedTotal: 0,
    lastError: null
  }

  it('stats-snapshot.json tiene la forma que emite Queries.snapshot()', () => {
    const real = q.snapshot({ plan, ingest, now })
    expect(normalize(readFixture('stats-snapshot.json'))).toEqual(normalize(real))
  })

  it('breakdown-*.json tienen la forma que emite Queries.breakdown()', () => {
    const porProyecto = q.breakdown('project', '30d', 10, now)
    expect(normalize(readFixture('breakdown-project-30d.json'))).toEqual(normalize(porProyecto))
    const porModelo = q.breakdown('model', '30d', 10, now)
    expect(normalize(readFixture('breakdown-model-30d.json'))).toEqual(normalize(porModelo))
  })

  it('los LimitsView traen los campos del contrato', () => {
    for (const name of ['limits-view-fresh.json', 'limits-view-very-stale.json']) {
      const view = readFixture(name) as Record<string, unknown>
      expect(Object.keys(view).sort()).toEqual([
        'ageSeconds',
        'bars',
        'extraUsageEnabled',
        'fetchedAt',
        'levelB',
        'source',
        'spendUsedUsd',
        'stale',
        'veryStale'
      ])
      const bars = view['bars'] as Array<Record<string, unknown>>
      expect(bars.length).toBeGreaterThan(0)
      for (const bar of bars) {
        expect(Object.keys(bar).sort()).toEqual([
          'group',
          'isActive',
          'kind',
          'label',
          'percent',
          'resetsAt',
          'scopeLabel',
          'severity'
        ])
        expect(bar['percent']).toBeGreaterThanOrEqual(0)
        expect(bar['percent']).toBeLessThanOrEqual(100)
        expect(['session', 'weekly']).toContain(bar['group'])
      }
    }
    const stale = readFixture('limits-view-very-stale.json') as Record<string, unknown>
    expect(stale['stale']).toBe(true)
    expect(stale['veryStale']).toBe(true)
    const fresh = readFixture('limits-view-fresh.json') as Record<string, unknown>
    expect(fresh['stale']).toBe(false)
    expect(fresh['veryStale']).toBe(false)
  })

  it('las cifras del snapshot son coherentes entre sí', () => {
    const snap = readFixture('stats-snapshot.json') as {
      today: { tokens: Record<string, number>; totalTokens: number; costUsd: number }
      last30d: { costUsd: number }
      multiplier: { value: number; planMonthlyUsd: number; costUsd: number; coveredDays: number }
      allTime: { costUsd: number }
    }
    const t = snap.today.tokens
    // thinking NUNCA entra en totalTokens
    expect(snap.today.totalTokens).toBe(
      (t['input'] as number) +
        (t['output'] as number) +
        (t['cacheWrite5m'] as number) +
        (t['cacheWrite1h'] as number) +
        (t['cacheRead'] as number)
    )
    expect(snap.multiplier.costUsd).toBeCloseTo(snap.last30d.costUsd, 6)
    expect(snap.multiplier.value).toBeCloseTo(snap.last30d.costUsd / snap.multiplier.planMonthlyUsd, 6)
    expect(snap.allTime.costUsd).toBeGreaterThanOrEqual(snap.last30d.costUsd)
  })

  it('el breakdown suma el 100 % del coste del periodo', () => {
    const b = readFixture('breakdown-model-30d.json') as {
      rows: Array<{ costUsd: number; share: number }>
      totalCostUsd: number
    }
    const suma = b.rows.reduce((n, r) => n + r.costUsd, 0)
    expect(suma).toBeCloseTo(b.totalCostUsd, 4)
    expect(b.rows.reduce((n, r) => n + r.share, 0)).toBeCloseTo(1, 4)
  })
})
