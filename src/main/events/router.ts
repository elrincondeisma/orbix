/**
 * Orbix — enrutado de un evento de hook: máquina de estados + persistencia.
 *
 * Fuente de verdad: `docs/design/03-contrato-eventos.md` §6.6.
 *
 * Todo evento validado se escribe en `hook_events`, **incluidos los que no producen
 * cambio de estado** (`pet_state = NULL`): sirve para depurar, para cerrar el punto
 * abierto C1 y para un futuro historial de avisos.
 *
 * Este módulo NO abre la base de datos: consume un `HookEventSink` que implementa el
 * equipo de `src/main/db/`. Así el servidor de eventos se puede probar sin SQLite.
 */

import type { PetState } from '@shared/pet'

import type { NormalizedHookEvent } from './schema'
import type { PetStateMachine } from '../pet/state-machine'

/** Fila de `hook_events` (ver `02-esquema-bd.md` §2). */
export interface HookEventRow {
  /** ISO UTC de recepción. */
  ts: string
  tsEpoch: number
  /** `hook_event_name`. */
  event: string
  projectKey: string | null
  projectPath: string | null
  sessionId: string | null
  message: string | null
  reason: string | null
  toolName: string | null
  isError: boolean
  /** Estado que provocó, o `null` si el evento no produjo ninguno. */
  petState: PetState | null
  /** Payload recortado a 8 KiB. */
  rawJson: string
}

/**
 * Puerto de persistencia. Lo implementa `src/main/db/` (database-dev).
 * DEPENDENCIA PENDIENTE: la tabla `hook_events` y su sentencia preparada.
 */
export interface HookEventSink {
  insertHookEvent(row: HookEventRow): void
}

export interface EventRouterOptions {
  machine: PetStateMachine
  /** Si no se pasa, los eventos mueven la mascota pero no se persisten. */
  sink?: HookEventSink
  /** Para no perder errores de BD en silencio absoluto. */
  onError?: (error: unknown) => void
}

export class EventRouter {
  private readonly machine: PetStateMachine
  private sink: HookEventSink | null
  private readonly onError: (error: unknown) => void

  /** Contadores de diagnóstico, visibles en preferencias en `devMode`. */
  readonly counters = { handled: 0, withState: 0, persisted: 0, persistErrors: 0 }

  constructor(options: EventRouterOptions) {
    this.machine = options.machine
    this.sink = options.sink ?? null
    this.onError = options.onError ?? ((): void => {})
  }

  /** La BD se abre después que el servidor: el sink se puede enchufar más tarde. */
  setSink(sink: HookEventSink | null): void {
    this.sink = sink
  }

  /**
   * Procesa un evento ya validado. Se llama SIEMPRE fuera del ciclo de la respuesta
   * HTTP (`queueMicrotask`), nunca dentro. No lanza jamás.
   */
  handle(event: NormalizedHookEvent): void {
    this.counters.handled += 1

    let petState: PetState | null = null
    try {
      petState = this.machine.handleHookEvent(event)
      if (petState !== null) this.counters.withState += 1
    } catch (error) {
      this.onError(error)
    }

    if (this.sink === null) return
    try {
      this.sink.insertHookEvent(toRow(event, petState))
      this.counters.persisted += 1
    } catch (error) {
      this.counters.persistErrors += 1
      this.onError(error)
    }
  }
}

export function toRow(event: NormalizedHookEvent, petState: PetState | null): HookEventRow {
  return {
    ts: event.ts,
    tsEpoch: event.tsEpoch,
    event: event.event,
    projectKey: event.projectKey,
    projectPath: event.projectPath,
    sessionId: event.sessionId,
    message: event.message,
    reason: event.reason,
    toolName: event.toolName,
    isError: event.isError,
    petState,
    rawJson: event.rawJson
  }
}
