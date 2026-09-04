/**
 * Orbix — implementación del núcleo de IA (fase F3).
 *
 * Sustituye a `SvgRenderer` detrás del MISMO contrato `PetSkin`: `main.ts` solo
 * cambió la línea del `new`. Ni el bucle de comandos, ni el bocadillo, ni los
 * sonidos, ni el preload, ni `main` se enteraron del cambio de arte.
 *
 * Este fichero, `sprite.ts` y `sprite.css` son los únicos que conocen píxeles.
 */

import { PetAnim, PetState, type PetRenderer } from '@shared/pet'
import type { PetVisualPrefs } from '@shared/types'
import { Bubble } from './Bubble'
import { FX_SVG, frameUrl, type FrameId } from './sprite'

/**
 * Superficie completa que consume `main.ts`: el contrato cerrado de `@shared/pet`
 * más la aplicación de preferencias visuales.
 *
 * `PetRenderer` no lleva un método para las preferencias porque `PetVisualPrefs`
 * pertenece a `@shared/types` y el contrato de la mascota no debe depender de él.
 */
export interface PetSkin extends PetRenderer<HTMLElement> {
  applyVisualPrefs(prefs: PetVisualPrefs): void
}

/** Estados cuya animación es de una sola pasada: hay que forzar el reinicio (§6.1). */
const ONE_SHOT_STATES: ReadonlySet<PetState> = new Set([
  PetState.WAKING,
  PetState.PUZZLED,
  PetState.SUBAGENT_DONE,
  PetState.DONE,
  PetState.WORRIED,
  PetState.NEEDS_YOU
])

/** Estados de prioridad ≥ 90: su bocadillo vacía la cola (§7.2). */
const URGENT_STATES: ReadonlySet<PetState> = new Set([PetState.DONE, PetState.NEEDS_YOU])

/**
 * "Qué está haciendo ahora mismo": puede llegar más rápido de lo que tarda un
 * bocadillo en desaparecer, así que en `Bubble` nunca hace cola (ver su comentario
 * de `BubbleItem.ambient`). Ismael, 2026-09-04.
 */
const AMBIENT_STATES: ReadonlySet<PetState> = new Set([
  PetState.THINKING,
  PetState.CODING,
  PetState.RUNNING
])

/** Sin comandos durante este tiempo, se pausa toda la animación (§9). */
const DORMANT_AFTER_MS = 60_000

/** Los cuatro frames del arte, en el orden en que se apilan. */
const FRAME_IDS: readonly FrameId[] = ['a', 'b', 'c', 'peak']

/** `PetAnim` → clase de `sprite.css` que dispara la animación puntual. */
const ANIM_CLASS: Readonly<Record<PetAnim, string>> = Object.freeze({
  [PetAnim.BLINK]: 'play-blink',
  [PetAnim.BOUNCE]: 'play-bounce',
  [PetAnim.SHAKE]: 'play-shake',
  [PetAnim.WAVE]: 'play-wave',
  [PetAnim.STRETCH]: 'play-stretch',
  [PetAnim.POP]: 'play-pop',
  [PetAnim.NOD]: 'play-nod'
})

/** Duración de cada animación puntual, alineada con los keyframes de `sprite.css`. */
const ANIM_MS: Readonly<Record<PetAnim, number>> = Object.freeze({
  [PetAnim.BLINK]: 264,
  [PetAnim.BOUNCE]: 528,
  [PetAnim.SHAKE]: 594,
  [PetAnim.WAVE]: 924,
  [PetAnim.STRETCH]: 693,
  [PetAnim.POP]: 429,
  [PetAnim.NOD]: 891
})

export class SpriteRenderer implements PetSkin {
  #root: HTMLElement | null = null
  #pet: HTMLElement | null = null
  #bubble: Bubble | null = null
  #frames: Map<FrameId, HTMLImageElement> = new Map()

  #state: PetState = PetState.IDLE
  #dormantTimer: number | null = null
  #animTimer: number | null = null
  #animClass: string | null = null
  #dprQuery: MediaQueryList | null = null
  #onDprChange: (() => void) | null = null

  mount(root: HTMLElement): void {
    this.destroy()

    const bubble = new Bubble()
    // El bocadillo va primero en el DOM: el orden visual lo decide el ancla en CSS.
    root.appendChild(bubble.element)

    const pet = document.createElement('div')
    pet.id = 'mc-pet'
    // Decorativa: un lector de pantalla no debe leerla en bucle (§12).
    pet.setAttribute('aria-hidden', 'true')
    pet.setAttribute('role', 'presentation')
    pet.dataset['state'] = PetState.IDLE
    pet.dataset['facing'] = 'left'

    const rig = document.createElement('div')
    rig.id = 'mc-rig'
    const anim = document.createElement('div')
    anim.id = 'mc-anim'
    const core = document.createElement('div')
    core.id = 'mc-core'

    // Los cuatro frames se cargan UNA vez y se quedan en el DOM: el ciclo solo
    // alterna `opacity`. Nunca se recarga un PNG en caliente.
    for (const id of FRAME_IDS) {
      const img = document.createElement('img')
      img.id = `pet-${id}`
      img.className = 'pet-frame'
      img.alt = ''
      img.decoding = 'sync'
      img.draggable = false
      core.appendChild(img)
      this.#frames.set(id, img)
    }

    anim.appendChild(core)
    anim.insertAdjacentHTML('beforeend', FX_SVG)
    rig.appendChild(anim)
    pet.appendChild(rig)
    root.appendChild(pet)

    this.#root = root
    this.#pet = pet
    this.#bubble = bubble

    this.#applyFrameScale()
    this.#watchPixelRatio()
    this.#armDormancy()
  }

  setState(state: PetState, opts?: { intensity?: number }): void {
    const pet = this.#pet
    if (pet === null) return

    this.#wake()

    const intensity = opts?.intensity
    if (intensity !== undefined && Number.isFinite(intensity)) {
      // 0-1 → 0,6-1,4: la orden nunca deja la animación en nada.
      pet.style.setProperty(
        '--mc-intensity',
        String(0.6 + Math.min(1, Math.max(0, intensity)) * 0.8)
      )
    }

    const isSame = pet.dataset['state'] === state
    // Dos eventos seguidos del mismo estado deben volver a animar: se quita el
    // atributo, se fuerza reflow y se repone (§6.1).
    if (isSame && ONE_SHOT_STATES.has(state)) {
      delete pet.dataset['state']
      this.#reflow()
    }

    pet.dataset['state'] = state
    this.#state = state
  }

  say(text: string, ms?: number): void {
    this.#wake()
    this.#bubble?.say(text, ms, URGENT_STATES.has(this.#state), AMBIENT_STATES.has(this.#state))
  }

  play(anim: PetAnim): void {
    const pet = this.#pet
    if (pet === null) return
    this.#wake()

    if (this.#animClass !== null) {
      pet.classList.remove(this.#animClass)
      if (this.#animTimer !== null) window.clearTimeout(this.#animTimer)
    }

    const cls = ANIM_CLASS[anim]
    this.#reflow()
    pet.classList.add(cls)
    this.#animClass = cls
    this.#animTimer = window.setTimeout(() => {
      this.#animTimer = null
      this.#animClass = null
      pet.classList.remove(cls)
    }, ANIM_MS[anim])
  }

  setScale(scale: number): void {
    if (!Number.isFinite(scale) || scale <= 0) return
    document.documentElement.style.setProperty('--mc-scale', String(scale))
    // Un núcleo más grande puede necesitar el PNG de la escala siguiente.
    this.#applyFrameScale()
  }

  /**
   * El arte NO se refleja: tiene la luz pintada y el espejo se nota. Lo que mira
   * hacia el centro de la pantalla es la capa de efectos, que es geometría plana.
   */
  setFacing(facing: 'left' | 'right'): void {
    if (this.#pet !== null) this.#pet.dataset['facing'] = facing
  }

  setReducedMotion(enabled: boolean): void {
    document.documentElement.classList.toggle('reduced-motion', enabled)
  }

  applyVisualPrefs(prefs: PetVisualPrefs): void {
    this.setScale(prefs.petScale)
    this.setReducedMotion(prefs.reducedMotion)
    document.documentElement.style.setProperty('--mc-opacity-idle', String(prefs.petOpacityIdle))
    this.#bubble?.setEnabled(prefs.bubbleEnabled)
    this.#bubble?.setDefaultMs(prefs.bubbleMs)
  }

  destroy(): void {
    if (this.#dormantTimer !== null) window.clearTimeout(this.#dormantTimer)
    if (this.#animTimer !== null) window.clearTimeout(this.#animTimer)
    this.#dormantTimer = null
    this.#animTimer = null
    this.#animClass = null
    if (this.#dprQuery !== null && this.#onDprChange !== null) {
      this.#dprQuery.removeEventListener('change', this.#onDprChange)
    }
    this.#dprQuery = null
    this.#onDprChange = null
    this.#bubble?.destroy()
    this.#bubble = null
    this.#pet?.remove()
    this.#pet = null
    this.#frames.clear()
    this.#root = null
  }

  // -----------------------------------------------------------------

  /** Escoge la variante @1x/@2x/@3x que corresponde a la pantalla actual. */
  #applyFrameScale(): void {
    const scale = Number(
      document.documentElement.style.getPropertyValue('--mc-scale').trim() || '1'
    )
    // El PNG se dibuja a `160 · petScale` px lógicos: la densidad efectiva que
    // necesita el bitmap es la de la pantalla multiplicada por esa escala.
    const effective = window.devicePixelRatio * (Number.isFinite(scale) && scale > 0 ? scale : 1)
    for (const [id, img] of this.#frames) {
      const url = frameUrl(id, effective)
      if (img.src !== url) img.src = url
    }
  }

  /**
   * La ventana se mueve entre pantallas (`followActiveDisplay`), así que la
   * densidad puede cambiar. Se escucha el cambio en vez de sondearlo.
   */
  #watchPixelRatio(): void {
    const query = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
    const handler = (): void => {
      this.#applyFrameScale()
      // La consulta queda obsoleta en cuanto cambia la densidad: se rearma.
      if (this.#onDprChange !== null) query.removeEventListener('change', this.#onDprChange)
      this.#watchPixelRatio()
    }
    query.addEventListener('change', handler)
    this.#dprQuery = query
    this.#onDprChange = handler
  }

  /** Reactiva la animación y rearma el reloj de dormancia. */
  #wake(): void {
    this.#pet?.classList.remove('is-dormant')
    this.#armDormancy()
  }

  #armDormancy(): void {
    if (this.#dormantTimer !== null) window.clearTimeout(this.#dormantTimer)
    this.#dormantTimer = window.setTimeout(() => {
      this.#dormantTimer = null
      this.#pet?.classList.add('is-dormant')
    }, DORMANT_AFTER_MS)
  }

  /**
   * Fuerza un reflow para reiniciar una animación CSS. Es el único uso permitido
   * de una lectura de layout en este renderer (§9, regla 1).
   */
  #reflow(): void {
    void this.#root?.offsetWidth
  }
}
