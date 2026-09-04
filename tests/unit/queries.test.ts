import { beforeEach, describe, expect, it } from 'vitest'
import type { Db } from '../../src/main/db/connection'
import type { PriceCache } from '../../src/main/db/prices'
import { labelForProject, Queries } from '../../src/main/db/queries'
import { markAllDaysDirty, recomputeDirtyDays } from '../../src/main/db/rollups'
import { dayLocal } from '../../src/main/db/time'
import { freshDb } from '../helpers/db'

const TZ = 'Europe/Madrid'
// 2026-09-03 11:00 en Madrid
const NOW = Date.parse('2026-09-03T09:00:00.000Z')

const PLAN = {
  tierId: 'default_claude_max_20x',
  organizationType: 'claude_max',
  displayName: 'Max 20×',
  monthlyUsd: 200,
  accountEmail: 'tester@example.com',
  detected: true
}

let db: Db
let prices: PriceCache
let q: Queries

interface FakeRequest {
  id: string
  ts: string
  project: string
  path: string | null
  model: string
  session: string
  output: number
  cacheRead: number
  cost: number
}

function insert(r: FakeRequest): void {
  const epoch = Date.parse(r.ts)
  db.prepare(
    `INSERT INTO usage_requests
       (request_id, ts, ts_epoch, day_local, session_id, project_key, project_path, is_sidechain,
        model_raw, model_key, blocks, input_tok, output_tok, thinking_tok,
        cache_write_5m, cache_write_1h, cache_read, cost_usd, price_id, cost_stale,
        first_seen_at, updated_at)
     VALUES (@id, @ts, @epoch, @day, @session, @project, @path, 0,
        @model, @model, 1, 0, @output, 0, 0, 0, @cacheRead, @cost, NULL, 0, @ts, @ts)`
  ).run({
    id: r.id,
    ts: r.ts,
    epoch,
    day: dayLocal(epoch, TZ),
    session: r.session,
    project: r.project,
    path: r.path,
    model: r.model,
    output: r.output,
    cacheRead: r.cacheRead,
    cost: r.cost
  })
}

beforeEach(() => {
  const fresh = freshDb()
  db = fresh.db
  prices = fresh.prices
  q = new Queries(db, TZ)

  // hoy
  insert({
    id: 'r-hoy-1',
    ts: '2026-09-03T08:45:38.055Z',
    project: '-Users-tester-Projects-demo',
    path: '/Users/tester/Projects/demo',
    model: 'claude-opus-5',
    session: 'sesion-hoy',
    output: 1000,
    cacheRead: 1_000_000,
    cost: 10
  })
  insert({
    id: 'r-hoy-2',
    ts: '2026-09-03T08:50:00.000Z',
    project: '-Users-tester-Projects-otro',
    path: null,
    model: 'claude-sonnet-5',
    session: 'sesion-hoy',
    output: 500,
    cacheRead: 200_000,
    cost: 2
  })
  // hace 3 días (dentro de 7d y 30d)
  insert({
    id: 'r-3d',
    ts: '2026-08-31T10:00:00.000Z',
    project: '-Users-tester-Projects-demo',
    path: '/Users/tester/Projects/demo',
    model: 'claude-opus-5',
    session: 'sesion-vieja',
    output: 300,
    cacheRead: 500_000,
    cost: 5
  })
  // hace 20 días (solo 30d, y fuera del mes en curso)
  insert({
    id: 'r-20d',
    ts: '2026-08-14T10:00:00.000Z',
    project: '-Users-tester-Projects-demo',
    path: '/Users/tester/Projects/demo',
    model: 'claude-opus-5',
    session: 'sesion-antigua',
    output: 100,
    cacheRead: 100_000,
    cost: 3
  })
  // hace 100 días (solo allTime)
  insert({
    id: 'r-100d',
    ts: '2026-05-26T10:00:00.000Z',
    project: '-Users-tester-Projects-demo',
    path: '/Users/tester/Projects/demo',
    model: 'claude-opus-5',
    session: 'sesion-prehistorica',
    output: 50,
    cacheRead: 50_000,
    cost: 1
  })

  markAllDaysDirty(db)
  recomputeDirtyDays(db, prices, { limit: 500 })
})

describe('consultas del menubar', () => {
  it('Q1 · totales por periodo', () => {
    expect(q.periodStats('today', NOW).costUsd).toBeCloseTo(12, 9)
    expect(q.periodStats('7d', NOW).costUsd).toBeCloseTo(17, 9)
    expect(q.periodStats('30d', NOW).costUsd).toBeCloseTo(20, 9)
    expect(q.periodStats('mtd', NOW).costUsd).toBeCloseTo(12, 9)
    expect(q.periodStats('all', NOW).costUsd).toBeCloseTo(21, 9)
  })

  it('la ventana de 7 días incluye hoy (hoy − 6)', () => {
    const b = q.bounds(NOW)
    expect(b.today).toBe('2026-09-03')
    expect(b.d7from).toBe('2026-08-28')
    expect(b.d30from).toBe('2026-08-05')
    expect(b.mtdFrom).toBe('2026-09-01')
  })

  it('Q7 · totalTokens no incluye thinking', () => {
    const hoy = q.periodStats('today', NOW)
    expect(hoy.tokens.output).toBe(1500)
    expect(hoy.tokens.cacheRead).toBe(1_200_000)
    expect(hoy.totalTokens).toBe(1500 + 1_200_000)
  })

  it('Q2 · sesión actual con actividad reciente', () => {
    const s = q.currentSession(Date.parse('2026-09-03T09:00:00.000Z'))
    expect(s.sessionId).toBe('sesion-hoy')
    expect(s.requests).toBe(2)
    expect(s.costUsd).toBeCloseTo(12, 9)
    expect(s.isActive).toBe(true)
    expect(s.startedAt).toBe('2026-09-03T08:45:38.055Z')
  })

  it('Q2 · una sesión de hace horas ya no está activa, pero sigue visible', () => {
    const s = q.currentSession(Date.parse('2026-09-03T20:00:00.000Z'))
    expect(s.sessionId).toBe('sesion-hoy')
    expect(s.isActive).toBe(false)
  })

  it('Q2 · un hook más reciente que el consumo gana como sesión actual', () => {
    const ts = '2026-09-03T08:59:00.000Z'
    db.prepare(
      `INSERT INTO hook_events (ts, ts_epoch, event, project_key, project_path, session_id, is_error)
       VALUES (?, ?, 'UserPromptSubmit', '-Users-tester-Projects-nuevo', '/Users/tester/Projects/nuevo', 'sesion-nueva', 0)`
    ).run(ts, Date.parse(ts))

    const s = q.currentSession(NOW)
    expect(s.sessionId).toBe('sesion-nueva')
    expect(s.requests).toBe(0) // aún no ha consumido nada
    expect(s.isActive).toBe(true)
  })

  it('Q3 · desglose por proyecto ordenado por coste con su share', () => {
    const b = q.breakdown('project', '30d', 10, NOW)
    expect(b.rows.map((r) => r.key)).toEqual([
      '-Users-tester-Projects-demo',
      '-Users-tester-Projects-otro'
    ])
    expect(b.rows[0]?.costUsd).toBeCloseTo(18, 9)
    expect(b.totalCostUsd).toBeCloseTo(20, 9)
    expect(b.rows[0]?.share).toBeCloseTo(0.9, 9)
    expect(b.rows[0]?.label).toBe('demo')
    // sin project_path se cae al último segmento del project_key
    expect(b.rows[1]?.label).toBe('otro')
  })

  it('Q4 · desglose por modelo', () => {
    const b = q.breakdown('model', 'today', 10, NOW)
    expect(b.rows.map((r) => r.key)).toEqual(['claude-opus-5', 'claude-sonnet-5'])
    expect(b.rows[1]?.costUsd).toBeCloseTo(2, 9)
  })

  it('Q5 · serie diaria rellena los días sin datos', () => {
    const s = q.series('7d', NOW)
    expect(s.points).toHaveLength(7)
    expect(s.points[0]?.day).toBe('2026-08-28')
    expect(s.points[6]?.day).toBe('2026-09-03')
    expect(s.points[6]?.costUsd).toBeCloseTo(12, 9)
    expect(s.points[1]?.costUsd).toBe(0)
  })

  it('Q6 · multiplicador y suelo cuando falta histórico', () => {
    const m = q.multiplier(PLAN, NOW)
    expect(m.costUsd).toBeCloseTo(20, 9)
    expect(m.value).toBeCloseTo(0.1, 9)
    expect(m.coveredDays).toBe(3)
    expect(m.isFloor).toBe(true)
  })

  it('Q6 · sin precio de plan no se inventa multiplicador', () => {
    const m = q.multiplier({ ...PLAN, monthlyUsd: null, detected: false }, NOW)
    expect(m.value).toBeNull()
    expect(m.planMonthlyUsd).toBeNull()
  })

  it('el snapshot completo cuadra con las consultas sueltas', () => {
    const snap = q.snapshot({
      plan: PLAN,
      ingest: {
        state: 'idle',
        filesTracked: 1,
        lastRunAt: null,
        lastDurationMs: null,
        backfillProgress: null,
        linesIngestedTotal: 0,
        lastError: null
      },
      now: NOW
    })
    expect(snap.today.costUsd).toBeCloseTo(12, 9)
    expect(snap.last7d.costUsd).toBeCloseTo(17, 9)
    expect(snap.last30d.costUsd).toBeCloseTo(20, 9)
    expect(snap.allTime.costUsd).toBeCloseTo(21, 9)
    expect(snap.multiplier.value).toBeCloseTo(0.1, 9)
    expect(snap.session.sessionId).toBe('sesion-hoy')
    expect(snap.generatedAt).toBe('2026-09-03T09:00:00.000Z')
  })

  it('etiqueta de proyecto: la ruta manda sobre el project_key ambiguo', () => {
    expect(labelForProject('-Users-a-b-c', '/Users/a/b-c')).toBe('b-c')
    expect(labelForProject('-Users-a-b-c', null)).toBe('c')
  })
})
