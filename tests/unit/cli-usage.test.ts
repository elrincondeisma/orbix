/**
 * Tests de `src/main/claude/cli-usage.ts` — el motor real del Nivel B (2026-09-04):
 * `claude -p "/usage"` en vez del endpoint HTTP no documentado del punto abierto B2.
 *
 * `parseUsageOutput` se prueba contra la salida REAL capturada en la máquina de
 * Ismael, contrastada campo a campo contra `cachedUsageUtilization` en crudo (la
 * misma petición, medida por dos caminos). Ningún test de este fichero lanza un
 * proceso de verdad: `CliUsage` siempre recibe `fetchUsage`/`isConfigured` inyectados.
 */

import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  CliUsage,
  USAGE_ARGS,
  levelBWorkdir,
  parseUsageOutput,
  type CliUsageResult
} from '../../src/main/claude/cli-usage'

// Salida literal de `claude -p "/usage"`, 2026-09-04 08:36 UTC. El `cachedUsageUtilization`
// crudo de ese mismo instante decía: session 38 % / resets 2026-09-04T10:20:00Z,
// weekly_all 78 % / resets 2026-09-06T08:00:00Z, weekly_scoped(Fable) 10 % / mismo reset.
// El 39 % de aquí (un punto más que el JSON) es real: el uso siguió subiendo entre una
// lectura y otra, segundos después — no una discrepancia del analizador.
const REAL_OUTPUT = `You are currently using your subscription to power your Claude Code usage

Current session: 39% used · resets Sep 4 at 12:20pm (Europe/Madrid)
Current week (all models): 78% used · resets Sep 6 at 10am (Europe/Madrid)
Current week (Fable): 10% used · resets Sep 6 at 10am (Europe/Madrid)

What's contributing to your limits usage?
Approximate, based on local sessions on this machine — does not include other devices or claude.ai.

Last 24h · 4698 requests · 6 sessions
  99% of your usage came from subagent-heavy sessions
  Top subagents: sl-frontend 20%, sl-backend 14%`

const NOW = new Date('2026-09-04T08:37:00Z')

describe('parseUsageOutput', () => {
  it('interpreta la salida real: 3 barras, en el mismo orden que trae el texto', () => {
    const limits = parseUsageOutput(REAL_OUTPUT, NOW)
    expect(limits.map((l) => l['kind'])).toEqual(['session', 'weekly_all', 'weekly_scoped'])
  })

  it('sesión: porcentaje y hora de reinicio, convertida de Europe/Madrid a UTC', () => {
    const [session] = parseUsageOutput(REAL_OUTPUT, NOW)
    expect(session).toMatchObject({
      kind: 'session',
      group: 'session',
      percent: 39,
      resets_at: '2026-09-04T10:20:00.000Z', // oracle: cachedUsageUtilization real
      scope: null,
      is_active: false
    })
  })

  it('semanal · todos los modelos: is_active true, sin scope', () => {
    const [, weeklyAll] = parseUsageOutput(REAL_OUTPUT, NOW)
    expect(weeklyAll).toMatchObject({
      kind: 'weekly_all',
      percent: 78,
      resets_at: '2026-09-06T08:00:00.000Z', // oracle: cachedUsageUtilization real
      scope: null,
      is_active: true
    })
  })

  it('semanal · por modelo: scope con el nombre tal cual lo escribe /usage', () => {
    const [, , scoped] = parseUsageOutput(REAL_OUTPUT, NOW)
    expect(scoped).toMatchObject({
      kind: 'weekly_scoped',
      percent: 10,
      resets_at: '2026-09-06T08:00:00.000Z',
      scope: { model: { id: null, display_name: 'Fable' } },
      is_active: false
    })
  })

  it('hora sin minutos ("10am"): minuto 0, no se rompe por la ausencia de ":00"', () => {
    const [, weeklyAll] = parseUsageOutput(REAL_OUTPUT, NOW)
    expect(weeklyAll?.['resets_at']).toBe('2026-09-06T08:00:00.000Z')
  })

  it('salida vacía o irreconocible: lista vacía, nunca lanza', () => {
    expect(parseUsageOutput('', NOW)).toEqual([])
    expect(parseUsageOutput('esto no es /usage en absoluto', NOW)).toEqual([])
  })

  it('salida truncada a media línea: lo que se entiende se queda, el resto se ignora', () => {
    const partial = 'Current session: 39% used · resets Sep 4 at 12:20pm (Europe/Madrid)\nCurrent w'
    const limits = parseUsageOutput(partial, NOW)
    expect(limits).toHaveLength(1)
    expect(limits[0]).toMatchObject({ kind: 'session', percent: 39 })
  })

  it('cruce de año: un reinicio "de enero" visto en diciembre cae en el año que viene', () => {
    const text = 'Current session: 5% used · resets Jan 3 at 9am (Europe/Madrid)'
    const dec = new Date('2026-12-20T00:00:00Z')
    const [session] = parseUsageOutput(text, dec)
    expect(session?.['resets_at']).toBe('2027-01-03T08:00:00.000Z')
  })
})

describe('CliUsage', () => {
  function fixedResult(overrides: Partial<Extract<CliUsageResult, { ok: true }>> = {}) {
    const ok: CliUsageResult = {
      ok: true,
      fetchedAtMs: Date.parse('2026-09-04T08:34:45.083Z'),
      utilization: {
        limits: [
          { kind: 'session', group: 'session', percent: 39, severity: 'normal',
            resets_at: '2026-09-04T10:20:00.000Z', scope: null, is_active: false }
        ]
      },
      ...overrides
    }
    return ok
  }

  it('desactivado: refresh() no llama a fetchUsage — ni una petición sin permiso', async () => {
    let called = false
    const cli = new CliUsage({
      isConfigured: () => true,
      fetchUsage: async () => { called = true; return fixedResult() }
    })
    const view = await cli.refresh()
    expect(view).toBeNull()
    expect(called).toBe(false)
    expect(cli.status).toEqual({ enabled: false, lastResult: 'never', lastError: null })
  })

  it('activado y configurado: refresca, guarda el estado y produce una LimitsView en vivo', async () => {
    const cli = new CliUsage({ isConfigured: () => true, fetchUsage: async () => fixedResult() })
    cli.setEnabled(true)

    const view = await cli.refresh()
    expect(view?.source).toBe('live')
    expect(view?.bars[0]).toMatchObject({ kind: 'session', percent: 39 })
    expect(cli.status).toEqual({ enabled: true, lastResult: 'ok', lastError: null })
  })

  it('activado pero sin binario resoluble: setEnabled no lo verifica, refresh no llama a fetchUsage', async () => {
    let called = false
    const cli = new CliUsage({
      isConfigured: () => false,
      fetchUsage: async () => { called = true; return fixedResult() }
    })
    const enable = cli.setEnabled(true)
    expect(enable).toEqual({ enabled: true, verified: false })

    const view = await cli.refresh()
    expect(view).toBeNull()
    expect(called).toBe(false)
  })

  it('fallo de fetchUsage: degrada a null y guarda el motivo, sin lanzar', async () => {
    const cli = new CliUsage({
      isConfigured: () => true,
      fetchUsage: async () => ({ ok: false, code: 'BAD_OUTPUT', message: 'formato irreconocible' })
    })
    cli.setEnabled(true)

    const view = await cli.refresh()
    expect(view).toBeNull()
    expect(cli.status).toEqual({
      enabled: true,
      lastResult: 'failed',
      lastError: 'formato irreconocible'
    })
  })

  it('tras un fallo, no reintenta antes de LEVEL_B_RETRY_MS (evita insistir gastando peticiones)', async () => {
    let calls = 0
    let now = Date.parse('2026-09-04T10:00:00.000Z')
    const cli = new CliUsage({
      isConfigured: () => true,
      now: () => now,
      fetchUsage: async () => {
        calls++
        return { ok: false, code: 'SPAWN_ERROR', message: 'x' }
      }
    })
    cli.setEnabled(true)

    await cli.refresh()
    expect(calls).toBe(1)

    // 1 minuto después: sigue en periodo de espera, no reintenta.
    now += 60_000
    const stillWaiting = await cli.refresh()
    expect(stillWaiting).toBeNull()
    expect(calls).toBe(1)

    // 31 minutos después del fallo original: ya puede reintentar.
    now += 30 * 60_000
    await cli.refresh()
    expect(calls).toBe(2)
  })

  it('desactivarlo detiene los refrescos incluso si estaba configurado', async () => {
    let called = false
    const cli = new CliUsage({
      isConfigured: () => true,
      fetchUsage: async () => { called = true; return fixedResult() }
    })
    cli.setEnabled(true)
    cli.setEnabled(false)

    const view = await cli.refresh()
    expect(view).toBeNull()
    expect(called).toBe(false)
  })
})

/**
 * El sondeo del Nivel B lanza Claude Code de verdad. CÓMO lo lanza no es un detalle:
 * heredando el `cwd` del padre (que en una app de macOS abierta desde el Dock es `/`)
 * arrancaba una sesión completa en la raíz del disco, con los MCP del usuario, y macOS
 * le atribuía a Orbix los permisos que pedía esa sesión.
 */
describe('cómo se lanza el sondeo', () => {
  it('no arranca ningún servidor MCP del usuario', () => {
    expect(USAGE_ARGS).toContain('--strict-mcp-config')
    // Sin un `--mcp-config` que lo acompañe, ese flag deja la sesión sin MCP alguno.
    expect(USAGE_ARGS).not.toContain('--mcp-config')
  })

  it('sigue pidiendo /usage en modo no interactivo', () => {
    expect(USAGE_ARGS).toContain('-p')
    expect(USAGE_ARGS).toContain('/usage')
  })

  it('el directorio de trabajo es propio, vacío y creado si no existe', () => {
    const home = mkdtempSync(join(tmpdir(), 'orbix-home-'))
    try {
      const dir = levelBWorkdir(home)
      expect(dir).toBe(join(home, 'Library', 'Application Support', 'Orbix', 'levelb'))
      expect(existsSync(dir)).toBe(true)
      expect(readdirSync(dir)).toEqual([])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('si no puede crearlo cae en tmp, nunca en la raíz ni en el home', () => {
    // `/dev/null` no es un directorio: `mkdirSync` no puede colgar nada de ahí.
    const dir = levelBWorkdir('/dev/null')
    expect(dir).toBe(tmpdir())
    expect(dir).not.toBe('/')
    expect(dir).not.toBe('/dev/null')
  })
})
