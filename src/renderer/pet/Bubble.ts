/**
 * Orbix — bocadillo de la mascota.
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
  /**
   * THINKING/CODING/RUNNING (Ismael, 2026-09-04): charla de "qué está haciendo ahora
   * mismo", que puede llegar más rápido de lo que tarda un bocadillo en desaparecer.
   * Nunca hace cola: sustituye de inmediato a otro ambiental, y nunca interrumpe ni se
   * cuela detrás de un aviso importante (WAKING, DONE, NEEDS_YOU, PUZZLED,
   * COMPACTING, WORRIED) — un aviso importante manda siempre sobre la charla ambiental.
   */
  ambient: boolean
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
   * `ambient` corresponde a THINKING/CODING/RUNNING (§7.2 + Ismael, 2026-09-04).
   *
   * El contrato `PetRenderer.say(text, ms?)` no lleva prioridad ni estado, así que
   * ambos se derivan del estado en curso del renderer que llama. Ver §7.2.
   */
  say(text: string, ms?: number, urgent = false, ambient = false): void {
    if (!this.#enabled) return
    const clean = text.trim()
    if (clean.length === 0) return

    const item: BubbleItem = {
      text: clean,
      ms: ms !== undefined && Number.isFinite(ms) && ms > 0 ? ms : this.#defaultMs,
      urgent,
      ambient
    }

    // Repetido: solo se reinicia el temporizador, sin reanimar.
    if (this.#current !== null && this.#current.text === item.text) {
      this.#current.ms = item.ms
      this.#scheduleHide(item.ms)
      return
    }

    if (this.#current === null) {
      this.#show(item)
      return
    }

    if (item.ambient) {
      // La charla ambiental nunca hace cola: si lo visible también es ambiental,
      // lo sustituye ya (siempre lo último, sin esperar el mínimo de 1 200 ms); si lo
      // visible es un aviso importante, se descarta en silencio en vez de colarse
      // detrás — habrá uno más fresco cuando el aviso importante termine.
      if (this.#current.ambient) this.#show(item)
      return
    }

    if (this.#current.ambient) {
      // Un aviso importante interrumpe a la charla ambiental de inmediato: no
      // merece la pena que "buscando…" retrase un error o un "terminado".
      this.#show(item)
      return
    }

    if (item.urgent) this.#queue.length = 0

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
