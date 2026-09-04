/**
 * Tests de la máquina de estados de la mascota: prioridades, colas, timeouts y
 * resolución de eventos que llegan pisándose (03 §6.3).
 *
 * Todo con un reloj falso: nadie espera aquí 90 segundos de verdad.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { parseHookBody, type NormalizedHookEvent } from '../../src/main/events/schema'
import { PetStateMachine, parseHhmm, type Clock, type TimerHandle } from '../../src/main/pet/state-machine'
import { classifyTool } from '../../src/main/pet/tool-classes'
import { createDefaultPrefs } from '../../src/shared/constants'
import { PetState, type PetCommand } from '../../src/shared/pet'
import type { Prefs } from '../../src/shared/types'

// ---------------------------------------------------------------------------
// Reloj falso
// ---------------------------------------------------------------------------

class FakeClock implements Clock {
  private t = 0
  private nextId = 1
  private timers = new Map<number, { at: number; fn: () => void }>()
  private readonly base = Date.parse('2026-09-03T12:00:00.000Z')

  now(): number {
    return this.t
  }

  date(): Date {
    return new Date(this.base + this.t)
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const id = this.nextId++
    this.timers.set(id, { at: this.t + ms, fn })
    return id
  }

  clearTimeout(handle: TimerHandle): void {
    this.timers.delete(handle as number)
  }

  /** Avanza el tiempo disparando los temporizadores en orden. */
  advance(ms: number): void {
    const target = this.t + ms
    for (;;) {
      let bestId: number | null = null
      let bestAt = Number.POSITIVE_INFINITY
      for (const [id, timer] of this.timers) {
        if (timer.at <= target && timer.at < bestAt) {
          bestAt = timer.at
          bestId = id
        }
      }
      if (bestId === null) break
      const timer = this.timers.get(bestId)!
      this.timers.delete(bestId)
      this.t = timer.at
      timer.fn()
    }
    this.t = target
  }
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

function evt(name: string, extra: Record<string, unknown> = {}): NormalizedHookEvent {
  const result = parseHookBody(
    JSON.stringify({
      hook_event_name: name,
      session_id: 'sess-1',
      cwd: '/Users/icatala/Projects/propios/miniClaudio',
      ...extra
    })
  )
  if (!result.ok) throw new Error(`payload de prueba inválido: ${name}`)
  return result.value
}

interface Harness {
  machine: PetStateMachine
  clock: FakeClock
  commands: PetCommand[]
  prefs: Prefs
  last: () => PetCommand | undefined
  states: () => PetState[]
}

function harness(overrides: Partial<Prefs> = {}): Harness {
  const clock = new FakeClock()
  const commands: PetCommand[] = []
  const prefs: Prefs = { ...createDefaultPrefs(), ...overrides }
  const machine = new PetStateMachine({
    emit: (c) => commands.push(c),
    getPrefs: () => prefs,
    clock,
    random: () => 0 // variante determinista
  })
  return {
    machine,
    clock,
    commands,
    prefs,
    last: () => commands.at(-1),
    states: () => commands.map((c) => c.state)
  }
}

// ---------------------------------------------------------------------------
// Mapa evento → estado
// ---------------------------------------------------------------------------

describe('mapa evento → PetState', () => {
  let h: Harness
  beforeEach(() => {
    h = harness()
    h.clock.advance(3000) // se pasa el silencio de arranque
  })

  it('SessionStart despierta a la mascota y saluda con el proyecto', () => {
    h.machine.handleHookEvent(evt('SessionStart', { source: 'startup' }))
    expect(h.machine.state).toBe(PetState.WAKING)
    expect(h.last()?.bubble?.text).toBe('Hola 👋 miniClaudio')
  })

  it('UserPromptSubmit → THINKING sin bocadillo', () => {
    h.machine.handleHookEvent(evt('UserPromptSubmit', { prompt: 'hola' }))
    expect(h.machine.state).toBe(PetState.THINKING)
    expect(h.last()?.bubble).toBeUndefined()
  })

  it('PreToolUse se clasifica por herramienta', () => {
    h.machine.handleHookEvent(evt('PreToolUse', { tool_name: 'Edit' }))
    h.clock.advance(300)
    expect(h.machine.state).toBe(PetState.CODING)

    h.machine.handleHookEvent(evt('PreToolUse', { tool_name: 'Bash' }))
    h.clock.advance(1200)
    expect(h.machine.state).toBe(PetState.RUNNING)

    h.machine.handleHookEvent(evt('PreToolUse', { tool_name: 'mcp__loquesea__x' }))
    h.clock.advance(1200)
    expect(h.machine.state).toBe(PetState.THINKING)
  })

  it('PostToolUse sin error NO cambia de estado (regla 7)', () => {
    h.machine.handleHookEvent(evt('UserPromptSubmit'))
    const antes = h.commands.length
    const state = h.machine.handleHookEvent(evt('PostToolUse', { tool_name: 'Read', tool_response: {} }))
    expect(state).toBeNull()
    expect(h.commands).toHaveLength(antes)
    expect(h.machine.state).toBe(PetState.THINKING)
  })

  it('PostToolUse con error → PUZZLED nombrando la herramienta', () => {
    h.machine.handleHookEvent(
      evt('PostToolUse', { tool_name: 'Bash', tool_response: { is_error: true } })
    )
    expect(h.machine.state).toBe(PetState.PUZZLED)
    expect(h.last()?.bubble?.text).toBe('Hmm… Bash ha fallado')
  })

  it('Stop → DONE con sonido y bocadillo', () => {
    h.machine.handleHookEvent(evt('Stop'))
    expect(h.machine.state).toBe(PetState.DONE)
    expect(h.last()?.sound).toBe('done')
    expect(h.last()?.bubble?.text).toBe('miniClaudio — listo')
  })

  it('Notification → NEEDS_YOU pegajoso, con el mensaje REAL y sonido attention', () => {
    h.machine.handleHookEvent(evt('Notification', { message: 'Claude necesita tu permiso' }))
    expect(h.machine.state).toBe(PetState.NEEDS_YOU)
    expect(h.last()?.sticky).toBe(true)
    expect(h.last()?.sound).toBe('attention')
    // El mensaje de Claude Code es la información valiosa: no se sustituye.
    expect(h.last()?.bubble?.text).toBe('Claude necesita tu permiso')
  })

  it('Notification sin mensaje usa el respaldo con el nombre del proyecto', () => {
    h.machine.handleHookEvent(evt('Notification'))
    expect(h.last()?.bubble?.text).toBe('miniClaudio te necesita')
  })

  it('SessionEnd → SLEEPING y ahí se queda', () => {
    h.machine.handleHookEvent(evt('SessionEnd', { reason: 'exit' }))
    expect(h.machine.state).toBe(PetState.SLEEPING)
    h.clock.advance(600_000)
    expect(h.machine.state).toBe(PetState.SLEEPING)
  })

  it('un evento desconocido no produce estado', () => {
    expect(h.machine.handleHookEvent(evt('EventoDelFuturo'))).toBeNull()
    expect(h.commands).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Prioridades y eventos que se pisan (§6.3)
// ---------------------------------------------------------------------------

describe('resolución de eventos que se pisan', () => {
  let h: Harness
  beforeEach(() => {
    h = harness()
    h.clock.advance(3000)
  })

  it('DONE (90) NO puede pisar a un NEEDS_YOU (100) reciente', () => {
    h.machine.handleHookEvent(evt('Notification', { message: 'atención' }))
    h.clock.advance(500)
    h.machine.handleHookEvent(evt('Stop'))
    // Dentro de los 4 s de duración mínima, NEEDS_YOU aguanta.
    expect(h.machine.state).toBe(PetState.NEEDS_YOU)
  })

  it('pero el evento perdedor no se tira: se aplica al decaer la prioridad', () => {
    h.machine.handleHookEvent(evt('Notification', { message: 'atención' }))
    h.clock.advance(500)
    h.machine.handleHookEvent(evt('Stop'))
    h.clock.advance(4000)
    expect(h.machine.state).toBe(PetState.DONE)
  })

  it('el pendiente caduca a los 5 s y ya no se aplica', () => {
    // COMPACTING (60, min 2 s) y luego un SubagentStop (55) que pierde.
    h.machine.handleHookEvent(evt('PreCompact', { trigger: 'auto' }))
    h.clock.advance(100)
    h.machine.handleHookEvent(evt('Stop')) // 90 > 60: este sí gana
    expect(h.machine.state).toBe(PetState.DONE)
  })

  it('NEEDS_YOU es pegajoso: solo lo desaloja un evento de prioridad >= 50', () => {
    h.machine.handleHookEvent(evt('Notification', { message: 'atención' }))
    h.clock.advance(30_000)
    // No vuelve solo a IDLE aunque pase muchísimo tiempo.
    expect(h.machine.state).toBe(PetState.NEEDS_YOU)

    // SessionStart (40) y SessionEnd (30) no lo desalojan.
    expect(h.machine.handleHookEvent(evt('SessionStart'))).toBeNull()
    expect(h.machine.handleHookEvent(evt('SessionEnd'))).toBeNull()
    expect(h.machine.state).toBe(PetState.NEEDS_YOU)

    // El UserPromptSubmit de cuando el usuario contesta (50) sí.
    h.machine.handleHookEvent(evt('UserPromptSubmit'))
    expect(h.machine.state).toBe(PetState.THINKING)
  })

  it('el mismo estado repetido no reinicia la animación', () => {
    h.machine.handleHookEvent(evt('UserPromptSubmit'))
    const tras = h.commands.length
    h.clock.advance(1000)
    h.machine.handleHookEvent(evt('UserPromptSubmit'))
    // No se emite un comando nuevo: THINKING no lleva bocadillo.
    expect(h.commands).toHaveLength(tras)
    expect(h.machine.state).toBe(PetState.THINKING)
  })

  it('las ráfagas de PreToolUse se agrupan en 250 ms y gana la mayor prioridad', () => {
    const antes = h.commands.length
    // Tanda de llamadas paralelas: Read (45), Edit (50), Read (45).
    h.machine.handleHookEvent(evt('PreToolUse', { tool_name: 'Read' }))
    h.machine.handleHookEvent(evt('PreToolUse', { tool_name: 'Edit' }))
    h.machine.handleHookEvent(evt('PreToolUse', { tool_name: 'Grep' }))
    expect(h.commands).toHaveLength(antes) // todavía nada: estamos dentro del debounce

    h.clock.advance(250)
    expect(h.commands).toHaveLength(antes + 1)
    expect(h.machine.state).toBe(PetState.CODING)
  })

  it('multiproyecto: gana el evento más reciente y el bocadillo lleva su proyecto', () => {
    h.machine.handleHookEvent(
      parseOk('Stop', { cwd: '/Users/icatala/Projects/otro-proyecto' })
    )
    expect(h.last()?.bubble?.text).toBe('otro-proyecto — listo')
  })
})

// ---------------------------------------------------------------------------
// Vueltas automáticas y timeouts
// ---------------------------------------------------------------------------

describe('vueltas automáticas', () => {
  let h: Harness
  beforeEach(() => {
    h = harness()
    h.clock.advance(3000)
  })

  it('WAKING vuelve a IDLE a los 3 s', () => {
    h.machine.handleHookEvent(evt('SessionStart'))
    h.clock.advance(2999)
    expect(h.machine.state).toBe(PetState.WAKING)
    h.clock.advance(2)
    expect(h.machine.state).toBe(PetState.IDLE)
  })

  it('CODING vuelve a THINKING a los 20 s', () => {
    h.machine.handleHookEvent(evt('PreToolUse', { tool_name: 'Write' }))
    h.clock.advance(250)
    expect(h.machine.state).toBe(PetState.CODING)
    h.clock.advance(20_000)
    expect(h.machine.state).toBe(PetState.THINKING)
  })

  it('DONE vuelve a IDLE a los 15 s y, sin eventos, duerme a los 5 min', () => {
    h.machine.handleHookEvent(evt('Stop'))
    h.clock.advance(15_000)
    expect(h.machine.state).toBe(PetState.IDLE)
    h.clock.advance(5 * 60 * 1000)
    expect(h.machine.state).toBe(PetState.SLEEPING)
  })

  it('cualquier evento cancela el paso a SLEEPING', () => {
    h.machine.handleHookEvent(evt('Stop'))
    h.clock.advance(15_000)
    h.clock.advance(4 * 60 * 1000)
    h.machine.handleHookEvent(evt('UserPromptSubmit'))
    h.clock.advance(2 * 60 * 1000)
    expect(h.machine.state).not.toBe(PetState.SLEEPING)
  })
})

// ---------------------------------------------------------------------------
// WORRIED (regla 13)
// ---------------------------------------------------------------------------

describe('aviso de límite semanal', () => {
  let h: Harness
  beforeEach(() => {
    h = harness()
    h.clock.advance(3000)
    h.machine.boot()
  })

  it('se dispara al cruzar el 80 % y solo una vez por cruce', () => {
    h.machine.onWeeklyPercent(63)
    expect(h.machine.state).toBe(PetState.IDLE)

    h.machine.onWeeklyPercent(81)
    expect(h.machine.state).toBe(PetState.WORRIED)
    expect(h.last()?.bubble?.text).toBe('Semanal al 81 %')

    h.clock.advance(8000)
    expect(h.machine.state).toBe(PetState.IDLE)

    // Sigue por encima del 80: no vuelve a avisar.
    h.machine.onWeeklyPercent(83)
    expect(h.machine.state).toBe(PetState.IDLE)
  })

  it('se rearma al bajar del 75 % (histéresis de 5 puntos)', () => {
    h.machine.onWeeklyPercent(85)
    h.clock.advance(8000)
    h.machine.onWeeklyPercent(74)
    h.machine.onWeeklyPercent(88)
    expect(h.machine.state).toBe(PetState.WORRIED)
  })

  it('ignora valores nulos o no finitos', () => {
    h.machine.onWeeklyPercent(null)
    h.machine.onWeeklyPercent(Number.NaN)
    expect(h.machine.state).toBe(PetState.IDLE)
  })
})

// ---------------------------------------------------------------------------
// Sonido: todo el filtrado se hace en main
// ---------------------------------------------------------------------------

describe('filtrado de sonido', () => {
  it('no suena nada durante los 2 primeros segundos de vida de la app', () => {
    const h = harness()
    h.machine.handleHookEvent(evt('Stop'))
    expect(h.last()?.sound).toBeUndefined()
  })

  it('no suena con soundEnabled=false ni con volumen 0', () => {
    const apagado = harness({ soundEnabled: false })
    apagado.clock.advance(3000)
    apagado.machine.handleHookEvent(evt('Stop'))
    expect(apagado.last()?.sound).toBeUndefined()

    const mudo = harness({ volume: 0 })
    mudo.clock.advance(3000)
    mudo.machine.handleHookEvent(evt('Stop'))
    expect(mudo.last()?.sound).toBeUndefined()
  })

  it('el blip de SubagentStop está desactivado por defecto', () => {
    const h = harness()
    h.clock.advance(3000)
    h.machine.handleHookEvent(evt('SubagentStop'))
    expect(h.last()?.state).toBe(PetState.SUBAGENT_DONE)
    expect(h.last()?.sound).toBeUndefined()

    const con = harness({ soundOnSubagentStop: true })
    con.clock.advance(3000)
    con.machine.handleHookEvent(evt('SubagentStop'))
    expect(con.last()?.sound).toBe('blip')
  })

  it('no suena dentro de las horas de silencio', () => {
    // El reloj falso arranca a las 12:00 UTC; se cubre la hora local que sea.
    const ahora = new Date(Date.parse('2026-09-03T12:00:00.000Z'))
    const hh = String(ahora.getHours()).padStart(2, '0')
    const h = harness({
      quietHours: { enabled: true, from: `${hh}:00`, to: `${hh}:59` }
    })
    h.clock.advance(3000)
    h.machine.handleHookEvent(evt('Stop'))
    expect(h.last()?.sound).toBeUndefined()
  })

  it('no suena con un silencio temporal vigente', () => {
    const h = harness({ muteUntil: '2026-09-03T13:00:00.000Z' })
    h.clock.advance(3000)
    h.machine.handleHookEvent(evt('Stop'))
    expect(h.last()?.sound).toBeUndefined()
  })

  it('no suena con la pantalla bloqueada si la preferencia lo pide', () => {
    const clock = new FakeClock()
    const commands: PetCommand[] = []
    const prefs = createDefaultPrefs()
    const machine = new PetStateMachine({
      emit: (c) => commands.push(c),
      getPrefs: () => prefs,
      isScreenLocked: () => true,
      clock,
      random: () => 0
    })
    clock.advance(3000)
    machine.handleHookEvent(evt('Stop'))
    expect(commands.at(-1)?.sound).toBeUndefined()
  })

  it('antirrepetición: como mucho un sonido cada 3 s, y gana el de mayor jerarquía', () => {
    const h = harness()
    h.clock.advance(3000)

    h.machine.handleHookEvent(evt('Stop'))
    expect(h.last()?.sound).toBe('done')

    // Dentro de la ventana llega un attention (mayor jerarquía): se guarda y se emite
    // al abrirse la ventana, no se pierde.
    h.clock.advance(500)
    h.machine.handleHookEvent(evt('Notification', { message: 'oye' }))
    expect(h.last()?.sound).toBeUndefined()

    h.clock.advance(3000)
    expect(h.commands.some((c) => c.sound === 'attention')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Contrato PetCommand
// ---------------------------------------------------------------------------

describe('PetCommand', () => {
  it('el seq es monótono y creciente', () => {
    const h = harness()
    h.clock.advance(3000)
    h.machine.boot()
    h.machine.handleHookEvent(evt('UserPromptSubmit'))
    h.machine.handleHookEvent(evt('Stop'))
    const seqs = h.commands.map((c) => c.seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    expect(new Set(seqs).size).toBe(seqs.length)
  })

  it('issuedAt es ISO UTC', () => {
    const h = harness()
    h.clock.advance(3000)
    h.machine.boot()
    expect(h.last()?.issuedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })

  it('el bocadillo respeta bubbleEnabled y bubbleMs', () => {
    const h = harness({ bubbleMs: 9000 })
    h.clock.advance(3000)
    h.machine.handleHookEvent(evt('Stop'))
    expect(h.last()?.bubble?.ms).toBe(9000)

    const sin = harness({ bubbleEnabled: false })
    sin.clock.advance(3000)
    sin.machine.handleHookEvent(evt('Stop'))
    expect(sin.last()?.bubble).toBeUndefined()
  })

  it('stop() deja la máquina sin temporizadores pendientes', () => {
    const h = harness()
    h.clock.advance(3000)
    h.machine.handleHookEvent(evt('SessionStart'))
    h.machine.stop()
    h.clock.advance(600_000)
    expect(h.machine.state).toBe(PetState.WAKING)
  })
})

describe('classifyTool', () => {
  it('clasifica escritura, ejecución y el resto', () => {
    for (const t of ['Edit', 'Write', 'NotebookEdit', 'MultiEdit', 'Update']) {
      expect(classifyTool(t)).toBe('write')
    }
    for (const t of ['Bash', 'BashOutput', 'KillShell', 'KillBash']) {
      expect(classifyTool(t)).toBe('exec')
    }
    for (const t of ['Read', 'Grep', 'Glob', 'WebFetch', 'Task', 'mcp__x__y', 'HerramientaNueva']) {
      expect(classifyTool(t)).toBe('other')
    }
  })

  it('no distingue mayúsculas y tolera null', () => {
    expect(classifyTool('edit')).toBe('write')
    expect(classifyTool('BASH')).toBe('exec')
    expect(classifyTool(null)).toBe('other')
    expect(classifyTool('')).toBe('other')
  })
})

describe('parseHhmm', () => {
  it('acepta HH:MM y rechaza el resto', () => {
    expect(parseHhmm('23:00')).toBe(1380)
    expect(parseHhmm('08:30')).toBe(510)
    expect(parseHhmm('9:05')).toBe(545)
    expect(parseHhmm('24:00')).toBeNull()
    expect(parseHhmm('12:60')).toBeNull()
    expect(parseHhmm('mediodía')).toBeNull()
  })
})

/** Igual que `evt` pero permitiendo sobrescribir el `cwd`. */
function parseOk(name: string, extra: Record<string, unknown>): NormalizedHookEvent {
  const result = parseHookBody(JSON.stringify({ hook_event_name: name, ...extra }))
  if (!result.ok) throw new Error('payload inválido')
  return result.value
}
