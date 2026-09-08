/**
 * Tests de las tres dependencias que quedaban abiertas del subsistema de eventos y de
 * `~/.claude.json`, ya cerradas contra SQLite:
 *
 *  1. `hook_events` ← `SqliteHookEventSink`
 *  2. `plans`       → `PlanInfo` (`buildPlanInfo`)
 *  3. `limits_snapshots` ← el `utilization` íntegro
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CliUsage, type CliUsageResult } from '../../src/main/claude/cli-usage'
import { ClaudeService } from '../../src/main/claude/service'
import type { Db } from '../../src/main/db/connection'
import { getMeta } from '../../src/main/db/meta'
import { EventRouter } from '../../src/main/events/router'
import { parseHookBody, type NormalizedHookEvent } from '../../src/main/events/schema'
import { SqliteHookEventSink } from '../../src/main/events/sink'
import { PetStateMachine } from '../../src/main/pet/state-machine'
import { createDefaultPrefs } from '../../src/shared/constants'
import { PetState } from '../../src/shared/pet'
import { freshDb } from '../helpers/db'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLAUDE_FIXTURE = join(HERE, '../fixtures/claude/claude-json-min.json')

let db: Db

beforeEach(() => {
  db = freshDb().db
})

afterEach(() => {
  db.close()
})

function evt(name: string, extra: Record<string, unknown> = {}): NormalizedHookEvent {
  const result = parseHookBody(
    JSON.stringify({
      hook_event_name: name,
      session_id: 'sess-1',
      cwd: '/Users/icatala/Projects/propios/Orbix',
      ...extra
    })
  )
  if (!result.ok) throw new Error('payload de prueba inválido')
  return result.value
}

// ---------------------------------------------------------------------------
// 1. hook_events
// ---------------------------------------------------------------------------

describe('SqliteHookEventSink', () => {
  it('escribe la fila completa, con is_error como 0/1', () => {
    const sink = new SqliteHookEventSink(db)
    sink.insertHookEvent({
      ts: '2026-09-03T10:00:00.000Z',
      tsEpoch: 1_787_911_200_000,
      event: 'PostToolUse',
      projectKey: '-Users-icatala-Projects-propios-Orbix',
      projectPath: '/Users/icatala/Projects/propios/Orbix',
      sessionId: 'sess-1',
      message: null,
      reason: null,
      toolName: 'Bash',
      isError: true,
      petState: PetState.PUZZLED,
      rawJson: '{"hook_event_name":"PostToolUse"}'
    })

    const row = db.prepare('SELECT * FROM hook_events').get() as Record<string, unknown>
    expect(row['event']).toBe('PostToolUse')
    expect(row['is_error']).toBe(1)
    expect(row['pet_state']).toBe('puzzled')
    expect(row['tool_name']).toBe('Bash')
    expect(row['project_key']).toBe('-Users-icatala-Projects-propios-Orbix')
  })

  it('el router persiste TODO evento, también los que no producen estado', () => {
    const prefs = createDefaultPrefs()
    const machine = new PetStateMachine({ emit: () => {}, getPrefs: () => prefs })
    const router = new EventRouter({ machine, sink: new SqliteHookEventSink(db) })

    router.handle(evt('Notification', { message: 'oye' }))
    router.handle(evt('PostToolUse', { tool_name: 'Read', tool_response: {} }))
    router.handle(evt('EventoDelFuturo'))
    machine.stop()

    const rows = db
      .prepare('SELECT event, pet_state FROM hook_events ORDER BY id')
      .all() as Array<{ event: string; pet_state: string | null }>

    expect(rows).toEqual([
      { event: 'Notification', pet_state: 'needs_you' },
      { event: 'PostToolUse', pet_state: null },
      { event: 'EventoDelFuturo', pet_state: null }
    ])
  })

  it('acepta un raw_json de 8 KiB sin quejarse', () => {
    const sink = new SqliteHookEventSink(db)
    const big = evt('UserPromptSubmit', { prompt: 'á'.repeat(20_000) })
    expect(() => sink.insertHookEvent({ ...big, petState: null })).not.toThrow()
    const row = db.prepare('SELECT length(raw_json) AS n FROM hook_events').get() as { n: number }
    expect(row.n).toBeLessThanOrEqual(8 * 1024)
  })
})

// ---------------------------------------------------------------------------
// 2 y 3. plan y límites
// ---------------------------------------------------------------------------

describe('ClaudeService', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'orbix-home-'))
    writeFileSync(join(home, '.claude.json'), readFileSync(CLAUDE_FIXTURE, 'utf8'))
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  it('resuelve el plan real contra la tabla `plans` sembrada', () => {
    const service = new ClaudeService({ db, home })
    service.refresh(false)

    expect(service.plan).toEqual({
      tierId: 'default_claude_max_20x',
      organizationType: 'claude_max',
      displayName: 'Max 20×',
      monthlyUsd: 200,
      accountEmail: 'usuario@ejemplo.com',
      detected: true
    })
  })

  it('un tier desconocido degrada con honestidad, sin inventar precio', () => {
    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({ oauthAccount: { organizationRateLimitTier: 'plan_del_futuro' } })
    )
    const service = new ClaudeService({ db, home })
    service.refresh(false)

    expect(service.plan.detected).toBe(false)
    expect(service.plan.monthlyUsd).toBeNull()
    expect(service.plan.displayName).toBe('Plan no reconocido')
  })

  it('persiste el utilization íntegro en limits_snapshots, sin duplicar el mismo caché', () => {
    const service = new ClaudeService({ db, home })
    service.refresh(false)
    service.refresh(false)
    service.refresh(false)

    const rows = db
      .prepare('SELECT fetched_at_ms, source, five_hour_pct, seven_day_pct, payload_json FROM limits_snapshots')
      .all() as Array<{
      fetched_at_ms: number
      source: string
      five_hour_pct: number
      seven_day_pct: number
      payload_json: string
    }>

    // Tres lecturas del MISMO caché rancio: una sola fila.
    expect(rows).toHaveLength(1)
    expect(rows[0]?.source).toBe('cache')
    expect(rows[0]?.fetched_at_ms).toBe(1_787_811_021_099)
    expect(rows[0]?.five_hour_pct).toBe(0)
    expect(rows[0]?.seven_day_pct).toBe(63)

    // El payload se guarda entero, incluidos los campos que hoy ignoramos.
    const payload = JSON.parse(rows[0]!.payload_json) as Record<string, unknown>
    expect(payload['limits']).toHaveLength(3)
    expect(payload).toHaveProperty('nimbus_quill')
  })

  it('guarda los metadatos de cuenta en `meta`', () => {
    new ClaudeService({ db, home }).refresh(false)
    expect(getMeta(db, 'rate_limit_tier')).toBe('default_claude_max_20x')
    expect(getMeta(db, 'org_type')).toBe('claude_max')
    expect(getMeta(db, 'account_email')).toBe('usuario@ejemplo.com')
  })

  it('avisa del porcentaje semanal para la regla WORRIED y emite la vista', () => {
    const vistas: number[] = []
    const semanales: Array<number | null> = []
    const service = new ClaudeService({
      db,
      home,
      onLimits: (view) => vistas.push(view.bars.length),
      onWeeklyPercent: (p) => semanales.push(p)
    })
    service.refresh()

    expect(vistas).toEqual([3])
    expect(semanales).toEqual([63])
  })

  it('la vista lleva SIEMPRE la antigüedad: el dato del fixture es de hace siete días', () => {
    const service = new ClaudeService({ db, home })
    const view = service.refresh(false)
    expect(view.source).toBe('cache')
    expect(view.stale).toBe(true)
    expect(view.veryStale).toBe(true)
    expect(view.fetchedAt).toBe('2026-08-27T06:10:21.099Z')
  })

  it('sin ~/.claude.json y sin histórico: ninguna barra, pero tampoco se inventa nada', () => {
    rmSync(join(home, '.claude.json'))
    const service = new ClaudeService({ db, home })
    const view = service.refresh(false)

    expect(view.source).toBe('none')
    expect(view.bars).toEqual([])
    expect(service.plan.detected).toBe(false)
    expect(db.prepare('SELECT COUNT(*) AS n FROM limits_snapshots').get()).toEqual({ n: 0 })
  })

  describe('BUG-7 · con ~/.claude.json ilegible NO se pierde el último dato conocido', () => {
    // Los tres casos que probó QA: roto a mitad de escritura, borrado y gigante.
    const romper = {
      'roto a mitad de escritura': () => writeFileSync(join(home, '.claude.json'), '{ roto'),
      borrado: () => rmSync(join(home, '.claude.json')),
      'de 9 MB': () =>
        writeFileSync(join(home, '.claude.json'), `{"relleno":"${'x'.repeat(9 * 1024 * 1024)}"}`)
    }

    for (const [caso, romperlo] of Object.entries(romper)) {
      it(`${caso}: se conserva la vista y su antigüedad real`, () => {
        const service = new ClaudeService({ db, home })
        const bueno = service.refresh(false)
        expect(bueno.bars).toHaveLength(3)

        romperlo()
        const despues = service.refresh(false)

        // Lo mismo que antes, con su antigüedad: NO «Sin datos de límites todavía».
        expect(despues.source).toBe('cache')
        expect(despues.bars).toHaveLength(3)
        expect(despues.fetchedAt).toBe('2026-08-27T06:10:21.099Z')
        expect(despues.veryStale).toBe(true)
        expect(service.plan.detected).toBe(true)
      })
    }

    it('arrancando de cero con el fichero roto, se rescata el snapshot de la BD', () => {
      // Una ejecución anterior dejó su snapshot y sus metadatos guardados.
      new ClaudeService({ db, home }).refresh(false)
      expect(db.prepare('SELECT COUNT(*) AS n FROM limits_snapshots').get()).toEqual({ n: 1 })

      writeFileSync(join(home, '.claude.json'), '{ roto')

      // App recién arrancada: en memoria no hay nada.
      const nueva = new ClaudeService({ db, home })
      const view = nueva.refresh(false)

      expect(view.source).toBe('cache')
      expect(view.bars.map((b) => b.percent)).toEqual([0, 63, 3])
      expect(view.fetchedAt).toBe('2026-08-27T06:10:21.099Z')
      expect(view.veryStale).toBe(true)
      // Y el plan también sobrevive, reconstruido desde `meta`.
      expect(nueva.plan.displayName).toBe('Max 20×')
      expect(nueva.plan.detected).toBe(true)
    })

    it('el fallo se registra: silencioso para el usuario, no para el log', () => {
      const errores: unknown[] = []
      const service = new ClaudeService({ db, home, onError: (e) => errores.push(e) })
      service.refresh(false)
      writeFileSync(join(home, '.claude.json'), '{ roto')
      service.refresh(false)
      expect(errores).toHaveLength(1)
      expect(String(errores[0])).toContain('.claude.json')
    })
  })

  it('el watcher relee el fichero cuando Claude Code lo refresca', async () => {
    const vistas: Array<number | null> = []
    const service = new ClaudeService({
      db,
      home,
      onLimits: (view) => vistas.push(view.ageSeconds === null ? null : Math.round(view.ageSeconds))
    })
    service.refresh(false)
    await service.startWatching()

    try {
      // Claude Code reescribe el bloque con datos frescos.
      const fresco = {
        oauthAccount: { organizationRateLimitTier: 'default_claude_max_20x' },
        cachedUsageUtilization: {
          fetchedAtMs: Date.now(),
          utilization: {
            limits: [
              { kind: 'weekly_all', group: 'weekly', percent: 88, is_active: true }
            ]
          }
        }
      }
      writeFileSync(join(home, '.claude.json'), JSON.stringify(fresco))

      // Sondeo (2 s) + awaitWriteFinish + debounce de 1 s.
      for (let i = 0; i < 80 && vistas.length === 0; i += 1) {
        await new Promise((r) => setTimeout(r, 100))
      }

      expect(vistas.length).toBeGreaterThan(0)
      expect(service.limits.stale).toBe(false)
      expect(service.limits.bars[0]?.percent).toBe(88)
      // Y el dato nuevo se guarda como una fila aparte, no pisa la anterior.
      const filas = db.prepare('SELECT COUNT(*) AS n FROM limits_snapshots').get() as { n: number }
      expect(filas.n).toBe(2)
    } finally {
      await service.stop()
    }
  }, 15_000)

  it('Nivel B sin el binario de claude: se degrada al Nivel A sin gastar peticiones', async () => {
    // `isConfigured` inyectado a `false` (nunca depende de si ESTA máquina tiene
    // `claude` instalado — de lo contrario el test pasaría en un Mac de desarrollo y
    // fallaría en CI, o al revés). `fetchUsage` nunca debería ni llamarse: si lo
    // hiciera, sería un proceso real lanzándose desde un test.
    let fetchCalled = false
    const levelB = new CliUsage({
      isConfigured: () => false,
      fetchUsage: async () => {
        fetchCalled = true
        return { ok: true, utilization: { limits: [] }, fetchedAtMs: Date.now() }
      }
    })
    const service = new ClaudeService({ db, home, levelB })
    service.refresh(false)

    expect(service.levelBAvailable).toBe(false)
    expect(service.levelBStatus).toEqual({ enabled: false, lastResult: 'never', lastError: null })

    // Activarlo no revienta y no promete lo que no puede cumplir.
    const result = await service.setLevelBEnabled(true)
    expect(result.verified).toBe(false)

    // Y refrescar en vivo devuelve la vista del Nivel A tal cual: degradación silenciosa.
    const view = await service.refreshLive()
    expect(view.source).toBe('cache')
    expect(fetchCalled).toBe(false)
    await service.stop()
  })

  it('Nivel B con claude -p "/usage": refresca la vista con el texto real interpretado', async () => {
    // Salida real capturada en la máquina de Ismael el 2026-09-04, ya pasada por
    // `parseUsageOutput` (probado aparte en cli-usage.test.ts) — aquí solo importa que
    // `ClaudeService` recoja el resultado y lo convierta en una `LimitsView` en vivo.
    // `fetchedAtMs` RELATIVO a ahora, nunca una fecha absoluta: con la de captura fija
    // el test se volvía rojo solo con que pasaran unos días (la vista salía `stale`).
    const okResult: CliUsageResult = {
      ok: true,
      fetchedAtMs: Date.now(),
      utilization: {
        limits: [
          {
            kind: 'session',
            group: 'session',
            percent: 39,
            severity: 'normal',
            resets_at: '2026-09-04T10:20:00.000Z',
            scope: null,
            is_active: false
          },
          {
            kind: 'weekly_all',
            group: 'weekly',
            percent: 78,
            severity: 'normal',
            resets_at: '2026-09-06T08:00:00.000Z',
            scope: null,
            is_active: true
          }
        ]
      }
    }
    const levelB = new CliUsage({
      isConfigured: () => true,
      fetchUsage: async () => okResult
    })
    const service = new ClaudeService({ db, home, levelB })
    service.refresh(false)

    expect(service.levelBAvailable).toBe(true)
    const enable = await service.setLevelBEnabled(true)
    expect(enable).toEqual({ enabled: true, verified: true })

    const view = await service.refreshLive()
    expect(view.source).toBe('live')
    expect(view.stale).toBe(false)
    expect(view.bars.map((b) => [b.kind, b.percent])).toEqual([
      ['session', 39],
      ['weekly_all', 78]
    ])
    expect(service.levelBStatus).toEqual({ enabled: true, lastResult: 'ok', lastError: null })

    // Y el resultado en vivo se persiste en `limits_snapshots` igual que el del Nivel A.
    const filas = db
      .prepare("SELECT COUNT(*) AS n FROM limits_snapshots WHERE source = 'live'")
      .get() as { n: number }
    expect(filas.n).toBeGreaterThan(0)

    await service.stop()
  })

  it('el Nivel A no pisa al Nivel B cuando su dato es más viejo', async () => {
    // El caso real que rompía los límites: `~/.claude.json` se reescribe cada pocos
    // minutos (y con ello se dispara `refresh()`), pero el `cachedUsageUtilization` de
    // dentro puede llevar días congelado. Antes, cada escritura tiraba el porcentaje
    // recién traído por `/usage`.
    const levelB = new CliUsage({
      isConfigured: () => true,
      fetchUsage: async () => ({
        ok: true,
        fetchedAtMs: Date.now(),
        utilization: {
          limits: [
            {
              kind: 'session',
              group: 'session',
              percent: 50,
              severity: 'normal',
              resets_at: null,
              scope: null,
              is_active: false
            },
            {
              kind: 'weekly_all',
              group: 'weekly',
              percent: 37,
              severity: 'normal',
              resets_at: null,
              scope: null,
              is_active: true
            }
          ]
        }
      })
    })
    const service = new ClaudeService({ db, home, levelB })
    service.refresh(false)
    await service.setLevelBEnabled(true)
    await service.refreshLive()

    // La fixture trae `weekly_all: 63` con un `fetchedAtMs` de hace semanas.
    const afterCacheRead = service.refresh(false)
    expect(afterCacheRead.source).toBe('live')
    expect(afterCacheRead.bars.map((b) => [b.kind, b.percent])).toEqual([
      ['session', 50],
      ['weekly_all', 37]
    ])

    await service.stop()
  })

  it("el snapshot 'live' guarda el payload del Nivel B, no el del caché", async () => {
    const levelB = new CliUsage({
      isConfigured: () => true,
      fetchUsage: async () => ({
        ok: true,
        fetchedAtMs: Date.now(),
        utilization: {
          limits: [
            {
              kind: 'weekly_all',
              group: 'weekly',
              percent: 37,
              severity: 'normal',
              resets_at: null,
              scope: null,
              is_active: true
            }
          ]
        }
      })
    })
    const service = new ClaudeService({ db, home, levelB })
    service.refresh(false)
    await service.setLevelBEnabled(true)
    await service.refreshLive()

    const row = db
      .prepare(
        "SELECT payload_json, seven_day_pct FROM limits_snapshots WHERE source = 'live' ORDER BY id DESC LIMIT 1"
      )
      .get() as { payload_json: string; seven_day_pct: number | null }

    const payload = JSON.parse(row.payload_json) as { limits: { percent: number }[] }
    expect(payload.limits[0]?.percent).toBe(37)
    expect(row.seven_day_pct).toBe(37)

    await service.stop()
  })
})
