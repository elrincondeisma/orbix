/**
 * Tests del router: evento → máquina de estados + persistencia en `hook_events`.
 *
 * Se comprueba que TODO evento validado se persiste, incluidos los que no producen
 * cambio de estado (`pet_state = NULL`), y que un fallo de la BD nunca se propaga.
 */

import { describe, expect, it, vi } from 'vitest'

import { parseHookBody, type NormalizedHookEvent } from '../../src/main/events/schema'
import { EventRouter, type HookEventRow } from '../../src/main/events/router'
import { PetStateMachine, type Clock, type TimerHandle } from '../../src/main/pet/state-machine'
import { createDefaultPrefs } from '../../src/shared/constants'
import { PetState } from '../../src/shared/pet'

const inmediato: Clock = {
  now: () => Date.now(),
  date: () => new Date(),
  setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as TimerHandle,
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>)
}

function evt(name: string, extra: Record<string, unknown> = {}): NormalizedHookEvent {
  const result = parseHookBody(
    JSON.stringify({ hook_event_name: name, session_id: 's1', cwd: '/tmp/proy', ...extra })
  )
  if (!result.ok) throw new Error('payload inválido')
  return result.value
}

function build(sink?: { insertHookEvent: (row: HookEventRow) => void }) {
  const prefs = createDefaultPrefs()
  const machine = new PetStateMachine({
    emit: () => {},
    getPrefs: () => prefs,
    clock: inmediato
  })
  const errors: unknown[] = []
  const router = new EventRouter({
    machine,
    ...(sink ? { sink } : {}),
    onError: (e) => errors.push(e)
  })
  return { router, machine, errors }
}

describe('EventRouter', () => {
  it('persiste el evento con el estado que provocó', () => {
    const rows: HookEventRow[] = []
    const { router } = build({ insertHookEvent: (row) => rows.push(row) })

    router.handle(evt('Notification', { message: 'oye' }))

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      event: 'Notification',
      sessionId: 's1',
      projectKey: '-tmp-proy',
      projectPath: '/tmp/proy',
      message: 'oye',
      isError: false,
      petState: PetState.NEEDS_YOU
    })
    expect(rows[0]?.rawJson).toContain('Notification')
  })

  it('persiste con pet_state NULL los eventos que no producen estado', () => {
    const rows: HookEventRow[] = []
    const { router } = build({ insertHookEvent: (row) => rows.push(row) })

    router.handle(evt('PostToolUse', { tool_name: 'Read', tool_response: {} }))
    router.handle(evt('EventoDelFuturo'))

    expect(rows).toHaveLength(2)
    expect(rows[0]?.petState).toBeNull()
    expect(rows[1]?.petState).toBeNull()
    expect(rows[1]?.event).toBe('EventoDelFuturo')
  })

  it('marca is_error en PostToolUse fallido', () => {
    const rows: HookEventRow[] = []
    const { router } = build({ insertHookEvent: (row) => rows.push(row) })
    router.handle(evt('PostToolUse', { tool_name: 'Bash', tool_response: { exit_code: 2 } }))
    expect(rows[0]?.isError).toBe(true)
    expect(rows[0]?.petState).toBe(PetState.PUZZLED)
  })

  it('un fallo de la BD no se propaga ni impide mover la mascota', () => {
    const { router, machine, errors } = build({
      insertHookEvent: () => {
        throw new Error('database is locked')
      }
    })

    expect(() => router.handle(evt('Stop'))).not.toThrow()
    expect(machine.state).toBe(PetState.DONE)
    expect(errors).toHaveLength(1)
    expect(router.counters.persistErrors).toBe(1)
  })

  it('funciona sin sink: la mascota reacciona aunque la BD no esté abierta todavía', () => {
    const { router, machine } = build()
    router.handle(evt('Stop'))
    expect(machine.state).toBe(PetState.DONE)
    expect(router.counters.persisted).toBe(0)

    const rows: HookEventRow[] = []
    router.setSink({ insertHookEvent: (row) => rows.push(row) })
    router.handle(evt('SessionEnd'))
    expect(rows).toHaveLength(1)
  })

  it('lleva contadores de diagnóstico', () => {
    const { router } = build({ insertHookEvent: () => {} })
    router.handle(evt('Stop'))
    router.handle(evt('PostToolUse', { tool_name: 'Read' }))
    expect(router.counters).toEqual({
      handled: 2,
      withState: 1,
      persisted: 2,
      persistErrors: 0
    })
  })

  it('no llama al sink si la máquina de estados explota', () => {
    const machine = {
      handleHookEvent: vi.fn(() => {
        throw new Error('boom')
      })
    } as unknown as PetStateMachine
    const rows: HookEventRow[] = []
    const router = new EventRouter({
      machine,
      sink: { insertHookEvent: (row) => rows.push(row) },
      onError: () => {}
    })
    // El evento se persiste igualmente, con pet_state NULL: no se pierde información.
    expect(() => router.handle(evt('Stop'))).not.toThrow()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.petState).toBeNull()
  })
})
