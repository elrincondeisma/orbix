import { beforeEach, describe, expect, it } from 'vitest'
import type { Db } from '../../src/main/db/connection'
import {
  computeCost,
  listPrices,
  normalizeModel,
  PriceCache,
  upsertPrice,
  type PriceRow
} from '../../src/main/db/prices'
import { freshDb } from '../helpers/db'

let db: Db
let prices: PriceCache

beforeEach(() => {
  const fresh = freshDb()
  db = fresh.db
  prices = fresh.prices
})

describe('normalización de modelo', () => {
  it('quita el sufijo de fecha y el prefijo de proveedor', () => {
    expect(normalizeModel('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5')
    expect(normalizeModel('anthropic.claude-opus-5')).toBe('claude-opus-5')
    expect(normalizeModel('  Claude-Opus-5 ')).toBe('claude-opus-5')
  })

  it('es idempotente', () => {
    const once = normalizeModel('claude-haiku-4-5-20251001')
    expect(normalizeModel(once)).toBe(once)
  })

  it('trata los casos raros sin lanzar', () => {
    expect(normalizeModel('<synthetic>')).toBe('__synthetic__')
    expect(normalizeModel('')).toBe('__unknown__')
    expect(normalizeModel(null)).toBe('__unknown__')
    expect(normalizeModel(undefined)).toBe('__unknown__')
  })
})

describe('cálculo de coste', () => {
  const opus: PriceRow = {
    id: 1,
    model_key: 'claude-opus-5',
    input_per_mtok: 5,
    output_per_mtok: 25,
    cache_write_5m_per_mtok: 6.25,
    cache_write_1h_per_mtok: 10,
    cache_read_per_mtok: 0.5,
    valid_from: '2000-01-01T00:00:00Z'
  }

  it('aplica la fórmula de §4.1', () => {
    const cost = computeCost(
      {
        input_tok: 2,
        output_tok: 1388,
        cache_write_5m: 0,
        cache_write_1h: 22975,
        cache_read: 26354
      },
      opus
    )
    expect(cost).toBeCloseTo(0.277637, 9)
  })

  it('el thinking no se cobra aparte: ya está dentro de output', () => {
    const counters = {
      input_tok: 0,
      output_tok: 1000,
      cache_write_5m: 0,
      cache_write_1h: 0,
      cache_read: 0
    }
    // el tipo no admite thinking porque no entra en la fórmula, y esa es la garantía
    expect(computeCost(counters, opus)).toBeCloseTo(0.025, 9)
  })

  it('la semilla trae las cinco tarifas y el comodín', () => {
    const list = listPrices(db)
    expect(list.map((p) => p.modelKey).sort()).toEqual([
      '__default__',
      'claude-haiku-4-5',
      'claude-opus-4-8',
      'claude-opus-5',
      'claude-sonnet-5'
    ])
  })

  it('un modelo sin tarifa cae en __default__ (la más cara, para no infravalorar)', () => {
    const resolved = prices.resolve('claude-fable-1', '2026-09-03T00:00:00Z')
    expect(resolved?.model_key).toBe('__default__')
    expect(prices.usesDefault('claude-fable-1', '2026-09-03T00:00:00Z')).toBe(true)
    expect(prices.usesDefault('claude-opus-5', '2026-09-03T00:00:00Z')).toBe(false)
  })

  it('las peticiones sintéticas valen 0 y no buscan tarifa', () => {
    const r = prices.costOf('__synthetic__', '2026-09-03T00:00:00Z', {
      input_tok: 999,
      output_tok: 999,
      cache_write_5m: 999,
      cache_write_1h: 999,
      cache_read: 999
    })
    expect(r).toEqual({ costUsd: 0, priceId: null })
  })

  it('resuelve la tarifa vigente según valid_from', () => {
    upsertPrice(db, {
      modelKey: 'claude-opus-5',
      inputPerMtok: 6,
      outputPerMtok: 30,
      cacheWrite5mPerMtok: 7.5,
      cacheWrite1hPerMtok: 12,
      cacheReadPerMtok: 0.6,
      validFrom: '2026-09-01T00:00:00Z',
      note: 'subida de precios'
    })
    prices.reload()

    expect(prices.resolve('claude-opus-5', '2026-08-31T23:59:59Z')?.output_per_mtok).toBe(25)
    expect(prices.resolve('claude-opus-5', '2026-09-02T10:00:00Z')?.output_per_mtok).toBe(30)
  })
})
