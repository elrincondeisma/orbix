/**
 * Orbix — contrato de la mascota.
 *
 * Fuente de verdad: `docs/design/04-frontal.md` §4 y `docs/design/03-contrato-eventos.md` §6.5.
 * Compartido entre `main` (que decide) y `renderer/pet` (que dibuja).
 *
 * REGLA DURA: sin imports de `node:*` ni de `electron`.
 */

/** Los doce estados de la mascota. El valor es el que viaja por IPC y el que va a BD. */
export enum PetState {
  IDLE = 'idle',
  WAKING = 'waking',
  THINKING = 'thinking',
  CODING = 'coding',
  RUNNING = 'running',
  PUZZLED = 'puzzled',
  SUBAGENT_DONE = 'subagent_done',
  COMPACTING = 'compacting',
  NEEDS_YOU = 'needs_you',
  DONE = 'done',
  SLEEPING = 'sleeping',
  WORRIED = 'worried'
}

/** Animaciones puntuales, independientes del estado. */
export enum PetAnim {
  BLINK = 'blink',
  BOUNCE = 'bounce',
  SHAKE = 'shake',
  WAVE = 'wave',
  STRETCH = 'stretch',
  POP = 'pop',
  NOD = 'nod'
}

export type SoundId = 'attention' | 'done' | 'blip'

/** Jerarquía de sonidos para la antirrepetición de 3 s (04-frontal.md §8.2). */
export const SOUND_RANK: Readonly<Record<SoundId, number>> = Object.freeze({
  attention: 3,
  done: 2,
  blip: 1
})

export interface PetBubble {
  text: string
  /** Milisegundos de permanencia, ya resueltos con `prefs.bubbleMs`. */
  ms: number
}

/**
 * Orden ya resuelta que `main` envía al renderer de la mascota.
 * El renderer NO decide nada: si `sound` no viene, no suena.
 */
export interface PetCommand {
  state: PetState
  priority: number
  bubble?: PetBubble
  /** Ya filtrado por preferencias (silencio, horas de silencio, volumen, pantalla bloqueada). */
  sound?: SoundId
  /** 0-1, para variar la intensidad de la animación. */
  intensity?: number
  /** true solo en NEEDS_YOU: el estado no vuelve solo. */
  sticky?: boolean
  /** ISO UTC. */
  issuedAt: string
  /** Monótono. El renderer descarta cualquier comando con `seq` menor que el último aplicado. */
  seq: number
}

/**
 * Contrato del pintor de la mascota.
 *
 * `TRoot` está parametrizado a propósito: `src/shared` compila también con
 * `tsconfig.node.json`, que no incluye la lib DOM, así que aquí no se puede nombrar
 * `HTMLElement`. El renderer declara `implements PetRenderer<HTMLElement>`.
 */
export interface PetRenderer<TRoot = unknown> {
  mount(root: TRoot): void
  setState(state: PetState, opts?: { intensity?: number }): void
  say(text: string, ms?: number): void
  play(anim: PetAnim): void
  setScale(scale: number): void
  setFacing(facing: 'left' | 'right'): void
  setReducedMotion(enabled: boolean): void
  destroy(): void
}

/** Todos los estados, en orden de declaración. Útil para el modo dev y para validar. */
export const ALL_PET_STATES: readonly PetState[] = Object.freeze([
  PetState.IDLE,
  PetState.WAKING,
  PetState.THINKING,
  PetState.CODING,
  PetState.RUNNING,
  PetState.PUZZLED,
  PetState.SUBAGENT_DONE,
  PetState.COMPACTING,
  PetState.NEEDS_YOU,
  PetState.DONE,
  PetState.SLEEPING,
  PetState.WORRIED
])

export function isPetState(value: unknown): value is PetState {
  return typeof value === 'string' && (ALL_PET_STATES as readonly string[]).includes(value)
}

export function isSoundId(value: unknown): value is SoundId {
  return value === 'attention' || value === 'done' || value === 'blip'
}
