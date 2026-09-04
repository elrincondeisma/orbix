/**
 * Orbix — bloque de límites de la suscripción.
 * Fuente de verdad: docs/design/04-frontal.md §10.5 y §10.6.
 *
 * LA PARTE QUE NO SE PUEDE ESCATIMAR: la antigüedad del dato es de primera clase.
 * El caché de límites de Claude Code puede llevar días sin refrescarse, así que hay
 * tres tratamientos visuales distintos —fresco, rancio y muy rancio— y en el tercero
 * se dice con todas las letras que Claude Code no ha refrescado esos porcentajes.
 * Nunca se presenta un porcentaje rancio como si fuera actual.
 */

import { formatAge, formatPercent, formatReset } from '@shared/format'
import type { LimitBar, LimitsView } from '@shared/types'
import { fromHtml, must, setAttr, setStatus, setText } from './dom'

type AgeClass = 'live' | 'fresh' | 'stale' | 'very-stale'

const TEMPLATE = `
<section class="mb-section" id="sec-limits" data-status="loading" data-age="fresh">
  <header class="limits-head">
    <p class="eyebrow">Límites</p>
    <p class="limits-age" data-f="age"></p>
    <button type="button" class="link" data-act="refresh" hidden>Refrescar</button>
  </header>

  <div class="block-content">
    <div class="limits-bars" data-f="bars"></div>
    <p class="limits-warning" data-f="warning" hidden></p>
  </div>

  <div class="block-skeleton" aria-hidden="true">
    <span class="skel skel-bar"></span>
    <span class="skel skel-bar"></span>
    <span class="skel skel-bar"></span>
  </div>

  <p class="block-empty">Sin datos de límites todavía.</p>
</section>`

const BAR_TEMPLATE = `
<div class="limit">
  <span class="limit-label"></span>
  <span class="limit-pct"></span>
  <span class="limit-track"><span class="limit-fill"></span></span>
  <span class="limit-reset"></span>
</div>`

interface BarNodes {
  root: HTMLElement
  label: HTMLElement
  pct: HTMLElement
  fill: HTMLElement
  reset: HTMLElement
}

export class LimitsCard {
  readonly element: HTMLElement
  readonly #age: HTMLElement
  readonly #warning: HTMLElement
  readonly #barsHost: HTMLElement
  readonly #refresh: HTMLButtonElement

  /** Firma del juego de barras dibujado, para no reconstruir el DOM en cada refresco. */
  #signature = ''
  #bars: BarNodes[] = []
  #timezone: string | undefined

  constructor(onRefresh: () => void) {
    this.element = fromHtml<HTMLElement>(TEMPLATE)
    this.#age = must(this.element, '[data-f="age"]')
    this.#warning = must(this.element, '[data-f="warning"]')
    this.#barsHost = must(this.element, '[data-f="bars"]')
    this.#refresh = must<HTMLButtonElement>(this.element, '[data-act="refresh"]')
    this.#refresh.addEventListener('click', onRefresh)
  }

  setTimezone(timezone: string | undefined): void {
    this.#timezone = timezone
  }

  render(view: LimitsView): void {
    if (view.source === 'none' || view.bars.length === 0) {
      setStatus(this.element, 'empty')
      return
    }

    const age = this.#classify(view)
    setAttr(this.element, 'data-age', age)
    this.#renderHeader(view, age)
    this.#renderBars(view.bars, age === 'very-stale')
    setStatus(this.element, 'ready')
  }

  setLoading(): void {
    setStatus(this.element, 'loading')
  }

  /** Error y vacío se ven igual: no hay barras que enseñar. */
  setError(): void {
    setStatus(this.element, 'empty')
  }

  // -----------------------------------------------------------------

  #classify(view: LimitsView): AgeClass {
    if (view.source === 'live' && !view.stale) return 'live'
    if (view.veryStale) return 'very-stale'
    if (view.stale) return 'stale'
    return 'fresh'
  }

  #renderHeader(view: LimitsView, age: AgeClass): void {
    const readable = formatAge(view.ageSeconds)
    switch (age) {
      case 'live':
        setText(this.#age, `en vivo · ${readable}`)
        break
      case 'fresh':
        setText(this.#age, `actualizado ${readable}`)
        break
      case 'stale':
        setText(this.#age, `⚠ actualizado ${readable}`)
        break
      case 'very-stale':
        // "hace 7 días" → "dato de hace 7 días": deja claro que no es de ahora.
        setText(this.#age, `⚠ dato de ${readable}`)
        break
    }

    const veryStale = age === 'very-stale'
    this.#warning.hidden = !veryStale
    if (veryStale) {
      setText(
        this.#warning,
        'Claude Code no ha refrescado estos porcentajes desde entonces.'
      )
    }

    // Nivel B caído no se muestra aquí: degradación silenciosa (§10.5).
    this.#refresh.hidden = view.levelB.enabled !== true
  }

  /**
   * `hideReset` (Ismael, 2026-09-04): con el dato muy desfasado, una fecha de
   * reinicio concreta ("venció el 27 ago") mete más ruido que información — es
   * técnicamente exacta sobre el fetch congelado, pero para una ventana de 5 horas
   * que lleva días sin refrescarse esa fecha ya no dice nada real (se habrá
   * reiniciado decenas de veces desde entonces) y contradice visualmente al aviso
   * de arriba. El aviso de cabecera ya deja claro que el dato es viejo; la fecha
   * por barra solo se enseña cuando puede ser mínimamente de fiar.
   */
  #renderBars(bars: readonly LimitBar[], hideReset: boolean): void {
    const signature = bars.map((b) => `${b.kind}:${b.label}`).join('|')
    if (signature !== this.#signature) {
      this.#barsHost.replaceChildren()
      this.#bars = bars.map(() => {
        const root = fromHtml<HTMLElement>(BAR_TEMPLATE)
        this.#barsHost.appendChild(root)
        return {
          root,
          label: must(root, '.limit-label'),
          pct: must(root, '.limit-pct'),
          fill: must(root, '.limit-fill'),
          reset: must(root, '.limit-reset')
        }
      })
      this.#signature = signature
    }

    bars.forEach((bar, i) => {
      const nodes = this.#bars[i]
      if (nodes === undefined) return
      setText(nodes.label, bar.label)
      setText(nodes.pct, formatPercent(bar.percent))
      // Se anima `scaleX`, nunca `width` (§10.5).
      nodes.fill.style.setProperty('--fill', String(Math.min(1, Math.max(0, bar.percent / 100))))
      setAttr(nodes.root, 'data-severity', bar.severity)
      setAttr(nodes.root, 'data-active', String(bar.isActive))
      // Si `resetsAt` es null, o el dato está muy desfasado, no se muestra nada:
      // no se inventa una hora ni se presenta una vieja como si fuera de fiar.
      setText(nodes.reset, hideReset ? '' : formatReset(bar.resetsAt, this.#timezone))
    })
  }
}
