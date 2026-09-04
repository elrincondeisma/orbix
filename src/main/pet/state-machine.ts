/**
 * miniClaudio — máquina de estados de la mascota.
 *
 * Fuente de verdad: `docs/design/03-contrato-eventos.md` §6 (mapa evento → PetState,
 * prioridades, resolución de eventos que se pisan) y `04-frontal.md` §8.2 (cuándo NO suena).
 *
 * Toda la decisión vive aquí. El renderer solo recibe `PetCommand` y lo dibuja: si un
 * comando no trae `sound`, no suena; si no trae `bubble`, no habla.
 */

import {
  IDLE_TO_SLEEP_MS,
  PENDING_EVENT_TTL_MS,
  SOUND_MIN_INTERVAL_MS,
  STARTUP_SILENCE_MS,
  TOOL_BURST_DEBOUNCE_MS,
  WORRIED_REARM_PCT,
  WORRIED_THRESHOLD_PCT
} from '@shared/constants'
import { PetState, SOUND_RANK, type PetCommand, type SoundId } from '@shared/pet'
import type { Prefs } from '@shared/types'

import type { NormalizedHookEvent } from '../events/schema'
import { phraseFor, type PhraseVars, type RandomFn } from './phrases'
import { classifyTool } from './tool-classes'

// ---------------------------------------------------------------------------
// Reloj inyectable (los tests no esperan 90 segundos de verdad)
// ---------------------------------------------------------------------------

/** Opaco a propósito: los tests inyectan un reloj falso con identificadores propios. */
export type TimerHandle = unknown

export interface Clock {
  /** Milisegundos monótonos. */
  now(): number
  /** Hora de pared, para las horas de silencio y para `issuedAt`. */
  date(): Date
  setTimeout(fn: () => void, ms: number): TimerHandle
  clearTimeout(handle: TimerHandle): void
}

export const systemClock: Clock = {
  now: () => performance.now(),
  date: () => new Date(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

// ---------------------------------------------------------------------------
// Reglas (tabla del §6)
// ---------------------------------------------------------------------------

export interface PetRule {
  state: PetState
  priority: number
  /** Durante este tiempo la prioridad no decae. */
  minDurationMs: number
  returnTo: PetState | null
  returnAfterMs: number | null
  /** Solo `NEEDS_YOU`: no vuelve solo. */
  sticky: boolean
  sound: SoundId | null
  /** `PreToolUse` llega en ráfagas: se agrupan en ventanas de 250 ms. */
  debounce: boolean
}

function rule(
  state: PetState,
  priority: number,
  minDurationMs: number,
  returnTo: PetState | null,
  returnAfterMs: number | null,
  extra: Partial<Pick<PetRule, 'sticky' | 'sound' | 'debounce'>> = {}
): PetRule {
  return {
    state,
    priority,
    minDurationMs,
    returnTo,
    returnAfterMs,
    sticky: extra.sticky ?? false,
    sound: extra.sound ?? null,
    debounce: extra.debounce ?? false
  }
}

/** Prioridad de reposo con la que se aplican las vueltas automáticas. */
const BASE_PRIORITY: Readonly<Partial<Record<PetState, number>>> = Object.freeze({
  [PetState.IDLE]: 20,
  [PetState.SLEEPING]: 15,
  [PetState.THINKING]: 45
})

/** Reglas 1-12 de la tabla, ya resueltas por disparador. */
export const RULES = Object.freeze({
  sessionStart: rule(PetState.WAKING, 40, 1500, PetState.IDLE, 3000),
  userPrompt: rule(PetState.THINKING, 50, 800, PetState.IDLE, 90_000),
  toolWrite: rule(PetState.CODING, 50, 800, PetState.THINKING, 20_000, { debounce: true }),
  toolExec: rule(PetState.RUNNING, 50, 800, PetState.THINKING, 20_000, { debounce: true }),
  toolOther: rule(PetState.THINKING, 45, 500, PetState.IDLE, 90_000, { debounce: true }),
  toolError: rule(PetState.PUZZLED, 65, 2000, PetState.THINKING, 4000),
  subagentStop: rule(PetState.SUBAGENT_DONE, 55, 1500, PetState.THINKING, 3000, {
    sound: 'blip'
  }),
  preCompact: rule(PetState.COMPACTING, 60, 2000, PetState.THINKING, 6000),
  notification: rule(PetState.NEEDS_YOU, 100, 4000, null, null, {
    sticky: true,
    sound: 'attention'
  }),
  stop: rule(PetState.DONE, 90, 3000, PetState.IDLE, 15_000, { sound: 'done' }),
  sessionEnd: rule(PetState.SLEEPING, 30, 2000, null, null),
  worried: rule(PetState.WORRIED, 85, 4000, null, 8000),
  boot: rule(PetState.IDLE, 20, 0, null, null),
  idleToSleep: rule(PetState.SLEEPING, 15, 0, null, null)
} satisfies Record<string, PetRule>)

/**
 * Un evento de prioridad >= 50 es el único capaz de desalojar a `NEEDS_YOU`.
 * Típicamente, el `UserPromptSubmit` de cuando el usuario contesta.
 */
const STICKY_BREAK_PRIORITY = 50

// ---------------------------------------------------------------------------
// Estado interno
// ---------------------------------------------------------------------------

interface PendingTrigger {
  state: PetState
  priority: number
  rule: PetRule
  vars: PhraseVars
  expiresAt: number
}

export interface PetRuntime {
  state: PetState
  priority: number
  enteredAt: number
  minUntil: number
  returnTo: PetState | null
  returnAt: number | null
  sticky: boolean
  lastSessionId: string | null
  lastProjectName: string | null
}

export interface PetStateMachineOptions {
  /** Envía el comando al renderer de la mascota. */
  emit: (command: PetCommand) => void
  /** Preferencias vivas. Se lee en cada decisión: no se cachea. */
  getPrefs: () => Prefs
  /** `powerMonitor`: true si la pantalla está bloqueada. */
  isScreenLocked?: () => boolean
  clock?: Clock
  random?: RandomFn
}

// ---------------------------------------------------------------------------
// Máquina
// ---------------------------------------------------------------------------

export class PetStateMachine {
  private readonly emit: (command: PetCommand) => void
  private readonly getPrefs: () => Prefs
  private readonly isScreenLocked: () => boolean
  private readonly clock: Clock
  private readonly random: RandomFn

  private readonly startedAt: number
  private seq = 0

  private rt: PetRuntime

  private pending: PendingTrigger | null = null
  private pendingTimer: TimerHandle | null = null
  private returnTimer: TimerHandle | null = null
  private idleTimer: TimerHandle | null = null

  /** Ráfaga de `PreToolUse` en curso. */
  private burst: { rule: PetRule; vars: PhraseVars } | null = null
  private burstTimer: TimerHandle | null = null

  /** Antirrepetición de sonidos. */
  private lastSoundAt = Number.NEGATIVE_INFINITY
  private pendingSound: SoundId | null = null
  private soundTimer: TimerHandle | null = null

  /** Histéresis del aviso de límite semanal. */
  private worriedArmed = true

  constructor(options: PetStateMachineOptions) {
    this.emit = options.emit
    this.getPrefs = options.getPrefs
    this.isScreenLocked = options.isScreenLocked ?? ((): boolean => false)
    this.clock = options.clock ?? systemClock
    this.random = options.random ?? Math.random
    this.startedAt = this.clock.now()

    this.rt = {
      state: PetState.IDLE,
      priority: RULES.boot.priority,
      enteredAt: this.startedAt,
      minUntil: this.startedAt,
      returnTo: null,
      returnAt: null,
      sticky: false,
      lastSessionId: null,
      lastProjectName: null
    }
  }

  /** Instantánea del runtime. Solo lectura, para depuración y tests. */
  get runtime(): Readonly<PetRuntime> {
    return { ...this.rt }
  }

  get state(): PetState {
    return this.rt.state
  }

  /** Regla 15: arranque de la app. Emite el `IDLE` inicial y arma el paso a `SLEEPING`. */
  boot(): void {
    this.apply(RULES.boot, {}, { silent: true })
  }

  /**
   * Regla 1-12: procesa un evento de hook ya normalizado.
   *
   * Devuelve el `PetState` que el evento pretende provocar, o `null` si el evento no
   * produce estado (evento desconocido, `PostToolUse` sin error, o desalojado por la
   * pegajosidad de `NEEDS_YOU`). El router lo usa para `hook_events.pet_state`.
   */
  handleHookEvent(event: NormalizedHookEvent): PetState | null {
    if (!event.known) return null

    const resolved = this.ruleFor(event)
    if (!resolved) return null

    const vars: PhraseVars = {
      project: event.projectName,
      message: event.message,
      tool: event.toolName
    }

    // Multiproyecto: gana el más reciente. No hay una mascota por proyecto.
    this.rt.lastSessionId = event.sessionId
    this.rt.lastProjectName = event.projectName

    // La pegajosidad de NEEDS_YOU se comprueba antes que nada: un evento menor ni
    // siquiera queda pendiente, o el aviso se perdería al vencer su duración mínima.
    if (this.rt.sticky && resolved.priority < STICKY_BREAK_PRIORITY) return null

    if (resolved.debounce) {
      this.enqueueBurst(resolved, vars)
      return resolved.state
    }

    this.admit(resolved, vars)
    return resolved.state
  }

  /**
   * Regla 13: el límite semanal cruza el 80 % hacia arriba. Se dispara una sola vez por
   * cruce; se rearma al bajar del 75 % (histéresis de 5 puntos).
   */
  onWeeklyPercent(percent: number | null): void {
    if (percent === null || !Number.isFinite(percent)) return
    if (percent < WORRIED_REARM_PCT) {
      this.worriedArmed = true
      return
    }
    if (percent < WORRIED_THRESHOLD_PCT || !this.worriedArmed) return

    this.worriedArmed = false
    // Vuelve al estado anterior a los 8 s (returnTo dinámico).
    const previous = this.rt.state
    this.admit({ ...RULES.worried, returnTo: previous }, { percent })
  }

  /** Solo en `devMode`: fuerza un estado desde `pet:poke`. */
  poke(state: PetState, bubble?: string): void {
    const forced: PetRule = {
      state,
      priority: 200,
      minDurationMs: 1500,
      returnTo: null,
      returnAfterMs: null,
      sticky: false,
      sound: null,
      debounce: false
    }
    this.apply(forced, {}, bubble === undefined ? {} : { bubbleOverride: bubble })
  }

  /** Para todos los temporizadores. Se llama en `before-quit`. */
  stop(): void {
    for (const timer of [
      this.pendingTimer,
      this.returnTimer,
      this.idleTimer,
      this.burstTimer,
      this.soundTimer
    ]) {
      if (timer !== null) this.clock.clearTimeout(timer)
    }
    this.pendingTimer = null
    this.returnTimer = null
    this.idleTimer = null
    this.burstTimer = null
    this.soundTimer = null
    this.pending = null
    this.burst = null
    this.pendingSound = null
  }

  // -------------------------------------------------------------------------
  // Mapa evento → regla
  // -------------------------------------------------------------------------

  private ruleFor(event: NormalizedHookEvent): PetRule | null {
    switch (event.event) {
      case 'SessionStart':
        return RULES.sessionStart
      case 'UserPromptSubmit':
        return RULES.userPrompt
      case 'PreToolUse': {
        const cls = classifyTool(event.toolName)
        if (cls === 'write') return RULES.toolWrite
        if (cls === 'exec') return RULES.toolExec
        return RULES.toolOther
      }
      case 'PostToolUse':
        // Regla 7: sin error no cambia de estado.
        return event.isError ? RULES.toolError : null
      case 'SubagentStop':
        return RULES.subagentStop
      case 'PreCompact':
        return RULES.preCompact
      case 'Notification':
        return RULES.notification
      case 'Stop':
        return RULES.stop
      case 'SessionEnd':
        return RULES.sessionEnd
      default:
        return null
    }
  }

  // -------------------------------------------------------------------------
  // Ráfagas de PreToolUse: debounce de 250 ms
  // -------------------------------------------------------------------------

  private enqueueBurst(next: PetRule, vars: PhraseVars): void {
    // Dentro de la ventana se queda el de mayor prioridad; si empatan, el último.
    if (this.burst === null || next.priority >= this.burst.rule.priority) {
      this.burst = { rule: next, vars }
    }
    if (this.burstTimer === null) {
      this.burstTimer = this.clock.setTimeout(() => {
        this.burstTimer = null
        const winner = this.burst
        this.burst = null
        if (winner) this.admit(winner.rule, winner.vars)
      }, TOOL_BURST_DEBOUNCE_MS)
    }
  }

  // -------------------------------------------------------------------------
  // Admisión (§6.3)
  // -------------------------------------------------------------------------

  private admit(next: PetRule, vars: PhraseVars): void {
    const now = this.clock.now()
    // La prioridad decae al cumplirse la duración mínima.
    const effective = now < this.rt.minUntil ? this.rt.priority : 0

    if (next.state === this.rt.state) {
      // Mismo estado repetido: no se reinicia la animación, solo se alarga la vuelta.
      this.rescheduleReturn(next)
      const bubble = this.buildBubble(next.state, vars)
      if (bubble) {
        // Solo se emite por el bocadillo (y por el sonido, si lo hubiera).
        this.send(next, bubble, this.resolveSound(next))
      }
      return
    }

    if (next.priority >= effective) {
      this.apply(next, vars)
      return
    }

    // El evento pierde, pero no se tira: se guarda como pendiente y se aplica al vencer
    // la duración mínima del estado actual, si sigue vigente.
    this.pending = {
      state: next.state,
      priority: next.priority,
      rule: next,
      vars,
      expiresAt: now + PENDING_EVENT_TTL_MS
    }
    this.schedulePendingFlush(Math.max(0, this.rt.minUntil - now))
  }

  private schedulePendingFlush(delayMs: number): void {
    if (this.pendingTimer !== null) this.clock.clearTimeout(this.pendingTimer)
    this.pendingTimer = this.clock.setTimeout(() => {
      this.pendingTimer = null
      const p = this.pending
      this.pending = null
      if (!p) return
      if (this.clock.now() > p.expiresAt) return
      if (this.rt.sticky && p.priority < STICKY_BREAK_PRIORITY) return
      this.apply(p.rule, p.vars)
    }, delayMs)
  }

  private apply(
    next: PetRule,
    vars: PhraseVars,
    opts: { silent?: boolean; bubbleOverride?: string } = {}
  ): void {
    const now = this.clock.now()

    this.rt = {
      ...this.rt,
      state: next.state,
      priority: next.priority,
      enteredAt: now,
      minUntil: now + next.minDurationMs,
      returnTo: next.returnTo,
      returnAt: next.returnAfterMs === null ? null : now + next.returnAfterMs,
      sticky: next.sticky
    }

    this.armReturnTimer(next)
    this.armIdleTimer(next.state)

    if (opts.silent === true) {
      // El IDLE de arranque no se anuncia con bocadillo ni sonido, pero sí se pinta.
      this.send(next, null, null)
      return
    }

    const bubble =
      opts.bubbleOverride === undefined
        ? this.buildBubble(next.state, vars)
        : { text: opts.bubbleOverride, ms: this.getPrefs().bubbleMs }

    this.send(next, bubble, this.resolveSound(next))
  }

  private armReturnTimer(next: PetRule): void {
    if (this.returnTimer !== null) {
      this.clock.clearTimeout(this.returnTimer)
      this.returnTimer = null
    }
    if (next.returnTo === null || next.returnAfterMs === null) return

    const target = next.returnTo
    this.returnTimer = this.clock.setTimeout(() => {
      this.returnTimer = null
      // La vuelta automática es de reposo: prioridad base y sin bocadillo ni sonido.
      this.apply(
        rule(target, BASE_PRIORITY[target] ?? 20, 0, null, null),
        {},
        { silent: true }
      )
    }, next.returnAfterMs)
  }

  /** Recoloca la vuelta cuando se repite el mismo estado, sin reiniciar la animación. */
  private rescheduleReturn(next: PetRule): void {
    if (next.returnAfterMs === null || next.returnTo === null) return
    this.rt.returnAt = this.clock.now() + next.returnAfterMs
    this.armReturnTimer(next)
  }

  /** Regla 14: cinco minutos en `IDLE` sin eventos → `SLEEPING`. */
  private armIdleTimer(state: PetState): void {
    if (this.idleTimer !== null) {
      this.clock.clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
    if (state !== PetState.IDLE) return
    this.idleTimer = this.clock.setTimeout(() => {
      this.idleTimer = null
      if (this.rt.state !== PetState.IDLE) return
      this.apply(RULES.idleToSleep, {}, { silent: true })
    }, IDLE_TO_SLEEP_MS)
  }

  // -------------------------------------------------------------------------
  // Bocadillo y sonido
  // -------------------------------------------------------------------------

  private buildBubble(state: PetState, vars: PhraseVars): { text: string; ms: number } | null {
    const prefs = this.getPrefs()
    if (!prefs.bubbleEnabled) return null
    const text = phraseFor(state, vars, this.random)
    if (text === null) return null
    return { text, ms: prefs.bubbleMs }
  }

  /**
   * Filtrado de sonido (04-frontal.md §8.2). Todo se decide aquí: si devuelve `null`,
   * el `PetCommand` sale sin `sound` y el renderer no reproduce nada.
   */
  private resolveSound(next: PetRule): SoundId | null {
    const sound = next.sound
    if (sound === null) return null

    const prefs = this.getPrefs()
    if (sound === 'blip' && !prefs.soundOnSubagentStop) return null
    if (!prefs.soundEnabled || prefs.volume <= 0) return null
    if (this.isMutedUntil(prefs)) return null
    if (prefs.quietHours.enabled && this.inQuietHours(prefs)) return null
    if (prefs.muteWhenScreenLocked && this.isScreenLocked()) return null

    const now = this.clock.now()
    // Al iniciar sesión en el Mac no se chilla.
    if (now - this.startedAt < STARTUP_SILENCE_MS) return null

    const sinceLast = now - this.lastSoundAt
    if (sinceLast < SOUND_MIN_INTERVAL_MS) {
      // Antirrepetición: se guarda el de mayor jerarquía y se emite al abrirse la ventana.
      if (this.pendingSound === null || SOUND_RANK[sound] > SOUND_RANK[this.pendingSound]) {
        this.pendingSound = sound
        if (this.soundTimer !== null) this.clock.clearTimeout(this.soundTimer)
        this.soundTimer = this.clock.setTimeout(
          () => this.flushPendingSound(),
          SOUND_MIN_INTERVAL_MS - sinceLast
        )
      }
      return null
    }

    this.lastSoundAt = now
    return sound
  }

  private flushPendingSound(): void {
    this.soundTimer = null
    const sound = this.pendingSound
    this.pendingSound = null
    if (sound === null) return
    this.lastSoundAt = this.clock.now()
    // Se reenvía el estado actual solo para transportar el sonido pendiente.
    this.send(
      rule(this.rt.state, this.rt.priority, 0, this.rt.returnTo, null),
      null,
      sound
    )
  }

  private isMutedUntil(prefs: Prefs): boolean {
    if (prefs.muteUntil === null) return false
    const until = Date.parse(prefs.muteUntil)
    if (Number.isNaN(until)) return false
    return this.clock.date().getTime() < until
  }

  /** Rango que puede cruzar la medianoche ("23:00" → "08:00"). */
  private inQuietHours(prefs: Prefs): boolean {
    const from = parseHhmm(prefs.quietHours.from)
    const to = parseHhmm(prefs.quietHours.to)
    if (from === null || to === null) return false
    const d = this.clock.date()
    const minutes = d.getHours() * 60 + d.getMinutes()
    return from <= to ? minutes >= from && minutes < to : minutes >= from || minutes < to
  }

  // -------------------------------------------------------------------------
  // Emisión
  // -------------------------------------------------------------------------

  private send(
    next: PetRule,
    bubble: { text: string; ms: number } | null,
    sound: SoundId | null
  ): void {
    this.seq += 1
    const command: PetCommand = {
      state: next.state,
      priority: next.priority,
      issuedAt: this.clock.date().toISOString(),
      seq: this.seq,
      intensity: clamp(next.priority / 100, 0.2, 1)
    }
    if (bubble !== null) command.bubble = bubble
    if (sound !== null) command.sound = sound
    if (next.sticky) command.sticky = true

    this.emit(command)
  }
}

// ---------------------------------------------------------------------------
// Auxiliares
// ---------------------------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** "23:00" → 1380. `null` si el formato no es válido. */
export function parseHhmm(text: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return h * 60 + min
}
