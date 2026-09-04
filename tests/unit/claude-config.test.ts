/**
 * Tests del lector de `~/.claude.json` (Nivel A).
 *
 * Lo que más importa aquí: **la antigüedad del dato**. El fixture reproduce la situación
 * real de la máquina de referencia, con `cachedUsageUtilization` de hace SIETE DÍAS. Un
 * porcentaje rancio nunca puede presentarse como si fuera actual.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  buildLimitsView,
  buildPlanInfo,
  emptyLimitsView,
  extractFromConfig,
  mapSeverity,
  normalizeIso,
  readClaudeConfig,
  weeklyPercent,
  type CachedUsage
} from '../../src/main/claude/config-reader'
import { parseKeychainSecret } from '../../src/main/claude/keychain'
import { extractUtilization, isConfigured, LIVE_USAGE_URL } from '../../src/main/claude/live-usage'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(HERE, '../fixtures/claude/claude-json-min.json')

function fixture(): unknown {
  return JSON.parse(readFileSync(FIXTURE, 'utf8')) as unknown
}

/** Momento de la lectura: 7 días después del `fetchedAtMs` del fixture. */
const AHORA = new Date(1787811021099 + 7 * 86_400_000)

describe('extractFromConfig', () => {
  it('extrae plan y cuenta de la forma real de ~/.claude.json', () => {
    const { meta, cache } = extractFromConfig(fixture())
    expect(meta.rateLimitTier).toBe('default_claude_max_20x')
    expect(meta.organizationType).toBe('claude_max')
    expect(meta.accountEmail).toBe('usuario@ejemplo.com')
    expect(meta.hasExtraUsageEnabled).toBe(false)
    expect(cache.fetchedAtMs).toBe(1787811021099)
    expect(cache.utilization).not.toBeNull()
  })

  it('no lanza con un fichero vacío, ajeno o corrupto', () => {
    for (const input of [null, {}, [], 42, 'texto', { oauthAccount: null }]) {
      const { meta, cache } = extractFromConfig(input)
      expect(meta.rateLimitTier).toBeNull()
      expect(cache.fetchedAtMs).toBeNull()
    }
  })
})

describe('readClaudeConfig', () => {
  it('devuelve ok:false sin lanzar si el fichero no existe', () => {
    const home = mkdtempSync(join(tmpdir(), 'orbix-cfg-'))
    try {
      const result = readClaudeConfig(home)
      expect(result.ok).toBe(false)
      expect(result.meta.rateLimitTier).toBeNull()
      expect(result.error).not.toBeNull()
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('lee un ~/.claude.json real colocado en un home temporal', () => {
    const home = mkdtempSync(join(tmpdir(), 'orbix-cfg-'))
    try {
      writeFileSync(join(home, '.claude.json'), readFileSync(FIXTURE, 'utf8'))
      const result = readClaudeConfig(home)
      expect(result.ok).toBe(true)
      expect(result.meta.rateLimitTier).toBe('default_claude_max_20x')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('devuelve ok:false con JSON corrupto en lugar de romper la app', () => {
    const home = mkdtempSync(join(tmpdir(), 'orbix-cfg-'))
    try {
      writeFileSync(join(home, '.claude.json'), '{roto')
      expect(readClaudeConfig(home).ok).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('buildLimitsView — la antigüedad es de primera clase', () => {
  it('clasifica un dato de 7 días como rancio Y muy rancio', () => {
    const { cache } = extractFromConfig(fixture())
    const view = buildLimitsView(cache, { now: AHORA })

    expect(view.source).toBe('cache')
    expect(view.fetchedAt).toBe('2026-08-27T06:10:21.099Z')
    expect(view.ageSeconds).toBeCloseTo(7 * 86_400, 0)
    expect(view.stale).toBe(true)
    expect(view.veryStale).toBe(true)
  })

  it('un dato de hace 10 minutos es fresco', () => {
    const cache: CachedUsage = {
      fetchedAtMs: AHORA.getTime() - 600_000,
      utilization: { limits: [] }
    }
    const view = buildLimitsView(cache, { now: AHORA })
    expect(view.stale).toBe(false)
    expect(view.veryStale).toBe(false)
    expect(view.ageSeconds).toBe(600)
  })

  it('sin datos devuelve source none y ninguna barra: no se inventa nada', () => {
    const view = buildLimitsView({ fetchedAtMs: null, utilization: null })
    expect(view.source).toBe('none')
    expect(view.bars).toEqual([])
    expect(view.fetchedAt).toBeNull()
    expect(view.ageSeconds).toBeNull()
    expect(emptyLimitsView().source).toBe('none')
  })

  it('construye las tres barras reales en el orden correcto', () => {
    const { cache } = extractFromConfig(fixture())
    const view = buildLimitsView(cache, { now: AHORA })

    expect(view.bars.map((b) => b.kind)).toEqual(['session', 'weekly_all', 'weekly_scoped'])
    expect(view.bars.map((b) => b.label)).toEqual([
      'Ventana 5 h',
      'Semanal total',
      'Semanal · Fable'
    ])
    expect(view.bars.map((b) => b.percent)).toEqual([0, 63, 3])
    expect(view.bars[1]?.isActive).toBe(true)
    expect(view.bars[0]?.isActive).toBe(false)
    // resets_at con offset +00:00 se normaliza a Z.
    expect(view.bars[1]?.resetsAt).toBe('2026-08-30T08:00:00.028Z')
    expect(view.bars[2]?.scopeLabel).toBe('Fable')
  })

  it('deriva la severidad del porcentaje porque el servidor manda normal al 63 %', () => {
    const { cache } = extractFromConfig(fixture())
    const view = buildLimitsView(cache, { now: AHORA })
    // El fixture trae severity 'normal' explícito: se respeta.
    expect(view.bars[1]?.severity).toBe('normal')

    expect(mapSeverity(null, 63)).toBe('warning')
    expect(mapSeverity(null, 90)).toBe('critical')
    expect(mapSeverity(null, 10)).toBe('normal')
    expect(mapSeverity('critical', 1)).toBe('critical')
    expect(mapSeverity('desconocida', 88)).toBe('critical')
  })

  it('clampa los porcentajes fuera de rango', () => {
    const view = buildLimitsView({
      fetchedAtMs: AHORA.getTime(),
      utilization: {
        limits: [
          { kind: 'session', group: 'session', percent: 250, is_active: true },
          { kind: 'weekly_all', group: 'weekly', percent: -5, is_active: true }
        ]
      }
    })
    expect(view.bars.map((b) => b.percent)).toEqual([100, 0])
  })

  it('usa five_hour/seven_day solo como respaldo si limits[] viene vacío', () => {
    const view = buildLimitsView({
      fetchedAtMs: AHORA.getTime(),
      utilization: {
        limits: [],
        five_hour: { utilization: 12, resets_at: '2026-09-03T10:00:00+00:00' },
        seven_day: { utilization: 70, resets_at: null },
        nimbus_quill: { utilization: 99 } // experimento interno: se ignora
      }
    })
    expect(view.bars.map((b) => b.label)).toEqual(['Ventana 5 h', 'Semanal total'])
    expect(view.bars.map((b) => b.percent)).toEqual([12, 70])
  })

  it('lee el gasto extra y el consumido en dólares', () => {
    const { cache } = extractFromConfig(fixture())
    const view = buildLimitsView(cache, { now: AHORA })
    expect(view.extraUsageEnabled).toBe(false)
    expect(view.spendUsedUsd).toBe(0)

    const conGasto = buildLimitsView({
      fetchedAtMs: AHORA.getTime(),
      utilization: {
        limits: [],
        extra_usage: { is_enabled: true },
        spend: { used: { amount_minor: 1234, currency: 'USD', exponent: 2 } }
      }
    })
    expect(conGasto.extraUsageEnabled).toBe(true)
    expect(conGasto.spendUsedUsd).toBe(12.34)
  })

  it('weeklyPercent devuelve el semanal total, que alimenta el aviso WORRIED', () => {
    const { cache } = extractFromConfig(fixture())
    expect(weeklyPercent(buildLimitsView(cache, { now: AHORA }))).toBe(63)
    expect(weeklyPercent(emptyLimitsView())).toBeNull()
  })

  it('descarta entradas de limits[] con kind desconocido', () => {
    const view = buildLimitsView({
      fetchedAtMs: AHORA.getTime(),
      utilization: { limits: [{ kind: 'kind_del_futuro', percent: 50 }, 'basura', null] }
    })
    expect(view.bars).toEqual([])
  })
})

describe('buildPlanInfo', () => {
  it('resuelve el plan cuando la tabla plans lo conoce', () => {
    const { meta } = extractFromConfig(fixture())
    const info = buildPlanInfo(meta, {
      tierId: 'default_claude_max_20x',
      organizationType: 'claude_max',
      displayName: 'Max 20×',
      monthlyUsd: 200
    })
    expect(info).toEqual({
      tierId: 'default_claude_max_20x',
      organizationType: 'claude_max',
      displayName: 'Max 20×',
      monthlyUsd: 200,
      accountEmail: 'usuario@ejemplo.com',
      detected: true
    })
  })

  it('degrada con honestidad si el plan no está en la tabla', () => {
    const { meta } = extractFromConfig(fixture())
    const info = buildPlanInfo(meta, null)
    expect(info.detected).toBe(false)
    expect(info.monthlyUsd).toBeNull()
    expect(info.displayName).toBe('Plan no reconocido')
  })

  it('sin tier detectado el nombre es "Plan desconocido"', () => {
    const info = buildPlanInfo(extractFromConfig({}).meta, null)
    expect(info.displayName).toBe('Plan desconocido')
  })
})

describe('normalizeIso', () => {
  it('pasa un ISO con offset a UTC con Z', () => {
    expect(normalizeIso('2026-08-30T08:00:00.028974+00:00')).toBe('2026-08-30T08:00:00.028Z')
    expect(normalizeIso('2026-08-30T10:00:00+02:00')).toBe('2026-08-30T08:00:00.000Z')
    expect(normalizeIso('no es una fecha')).toBeNull()
    expect(normalizeIso(null)).toBeNull()
  })
})

describe('Nivel B — estructura lista, sin inventar la URL (punto abierto B2)', () => {
  it('el endpoint sigue sin determinar y el Nivel B se declara no configurado', () => {
    expect(LIVE_USAGE_URL).toBe('')
    expect(isConfigured()).toBe(false)
  })

  it('extractUtilization acepta las dos formas plausibles', () => {
    expect(extractUtilization({ utilization: { limits: [] } })).toEqual({ limits: [] })
    expect(extractUtilization({ limits: [] })).toEqual({ limits: [] })
    expect(extractUtilization({ cualquier: 'cosa' })).toBeNull()
    expect(extractUtilization(null)).toBeNull()
  })

  it('parseKeychainSecret sigue el orden documentado en B3', () => {
    expect(parseKeychainSecret(JSON.stringify({ claudeAiOauth: { accessToken: 'a1' } }))?.accessToken).toBe('a1')
    expect(parseKeychainSecret(JSON.stringify({ accessToken: 'a2' }))?.accessToken).toBe('a2')
    expect(parseKeychainSecret(JSON.stringify({ access_token: 'a3' }))?.accessToken).toBe('a3')
    expect(parseKeychainSecret('sk-ant-xyz')?.accessToken).toBe('sk-ant-xyz')
    expect(parseKeychainSecret('cualquier cosa')).toBeNull()
    expect(parseKeychainSecret('')).toBeNull()
    expect(parseKeychainSecret(JSON.stringify({ otra: 'cosa' }))).toBeNull()
  })

  it('conserva refreshToken y expiresAt cuando vienen', () => {
    const parsed = parseKeychainSecret(
      JSON.stringify({
        claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: 1787811021099 }
      })
    )
    expect(parsed).toEqual({ accessToken: 'a', refreshToken: 'r', expiresAt: 1787811021099 })
  })
})
