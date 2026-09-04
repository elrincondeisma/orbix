/**
 * miniClaudio — bocadillo de la mascota.
 * Fuente de verdad: docs/design/04-frontal.md §7.
 *
 * Es un `<div>` HTML y no SVG a propósito: el texto en SVG no se ajusta ni se recorta.
 *
 * Reglas duras de §9: ningún `setInterval` y ningún `requestAnimationFrame` en bucle.
 * Aquí solo hay `setTimeout` de un disparo.
 */

/** Tiempo mínimo que un bocadillo permanece visible antes de poder ser sustituido. */
const MIN_VISIBLE_MS = 1200

/** Máximo de bocadillos en cola. Al llegar el cuarto se descarta el más antiguo. */
const MAX_QUEUE = 3

/** Duración de la animación de salida; debe coincidir con `pet.css`. */
const LEAVE_MS = 180

interface BubbleItem {
  text: string
  ms: number
  /** Los estados de prioridad ≥ 90 (DONE, NEEDS_YOU) vacían la cola. */
  urgent: boolean
}

export class Bubble {
  readonly #el: HTMLDivElement
  readonly #textEl: HTMLSpanElement

  #queue: BubbleItem[] = []
  #current: BubbleItem | null = null
  #shownAt = 0
  #hideTimer: number | null = null
  #leaveTimer: number | null = null

  #enabled = true
  #defaultMs = 5000

  constructor() {
    const el = document.createElement('div')
    el.id = 'mc-bubble'
    // Es contenido, no decoración: VoiceOver debe anunciarlo una vez (§12).
    el.setAttribute('role', 'status')
    el.setAttribute('aria-live', 'polite')

    const text = document.createElement('span')
    text.className = 'bubble-text'
    el.appendChild(text)

    this.#el = el
    this.#textEl = text
  }

  get element(): HTMLDivElement {
    return this.#el
  }

  setEnabled(enabled: boolean): void {
    this.#enabled = enabled
    if (!enabled) this.clear()
  }

  setDefaultMs(ms: number): void {
    if (Number.isFinite(ms) && ms > 0) this.#defaultMs = ms
  }

  /**
   * Encola un bocadillo. `urgent` corresponde a un `PetCommand` con `priority ≥ 90`.
   *
   * El contrato `PetRenderer.say(text, ms?)` no lleva prioridad, así que la urgencia
   * se deriva del estado en curso (DONE y NEEDS_YOU son los únicos ≥ 90). Ver §7.2.
   */
  say(text: string, ms?: number, urgent = false): void {
    if (!this.#enabled) return
    const clean = text.trim()
    if (clean.length === 0) return

    const item: BubbleItem = {
      text: clean,
      ms: ms !== undefined && Number.isFinite(ms) && ms > 0 ? ms : this.#defaultMs,
      urgent
    }

    // Repetido: solo se reinicia el temporizador, sin reanimar.
    if (this.#current !== null && this.#current.text === item.text) {
      this.#current.ms = item.ms
      this.#scheduleHide(item.ms)
      return
    }

    if (item.urgent) this.#queue.length = 0

    if (this.#current === null) {
      this.#show(item)
      return
    }

    this.#queue.push(item)
    // Si llega un cuarto, se descarta el más antiguo de la cola, nunca el visible.
    while (this.#queue.length > MAX_QUEUE) this.#queue.shift()

    if (item.urgent) {
      // Se muestra en cuanto el actual cumpla su mínimo de 1 200 ms.
      const elapsed = Date.now() - this.#shownAt
      this.#scheduleHide(Math.max(0, MIN_VISIBLE_MS - elapsed))
    }
  }

  /** Oculta lo visible y vacía la cola, sin animación de salida. */
  clear(): void {
    this.#clearTimers()
    this.#queue.length = 0
    this.#current = null
    this.#el.classList.remove('is-visible', 'is-leaving')
    this.#textEl.textContent = ''
  }

  destroy(): void {
    this.#clearTimers()
    this.#el.remove()
  }

  // -----------------------------------------------------------------

  #show(item: BubbleItem): void {
    this.#clearTimers()
    this.#current = item
    this.#shownAt = Date.now()
    this.#textEl.textContent = item.text
    this.#el.classList.remove('is-leaving')
    this.#el.classList.add('is-visible')
    this.#scheduleHide(item.ms)
  }

  #scheduleHide(inMs: number): void {
    if (this.#hideTimer !== null) window.clearTimeout(this.#hideTimer)
    this.#hideTimer = window.setTimeout(() => {
      this.#hideTimer = null
      this.#hide()
    }, inMs)
  }

  #hide(): void {
    this.#el.classList.add('is-leaving')
    this.#leaveTimer = window.setTimeout(() => {
      this.#leaveTimer = null
      this.#el.classList.remove('is-visible', 'is-leaving')
      this.#current = null
      const next = this.#queue.shift()
      if (next !== undefined) this.#show(next)
    }, LEAVE_MS)
  }

  #clearTimers(): void {
    if (this.#hideTimer !== null) {
      window.clearTimeout(this.#hideTimer)
      this.#hideTimer = null
    }
    if (this.#leaveTimer !== null) {
      window.clearTimeout(this.#leaveTimer)
      this.#leaveTimer = null
    }
  }
}
