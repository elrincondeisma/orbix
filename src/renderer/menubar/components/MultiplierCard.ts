/**
 * Orbix — bloque del multiplicador («6,1× lo que pagas por tu plan»).
 * Fuente de verdad: docs/design/04-frontal.md §10.3 y §10.6.
 *
 * El copy evita comparar el multiplicador con el «20×» del nombre del plan: son
 * cosas distintas y juntas confunden. Aquí el número solo responde a «¿cuánto me
 * rinde lo que pago?» — coste equivalente a tarifas de API frente a la cuota.
 *
 * Nada de mentiras (§1.3): un multiplicador calculado con menos de 30 días de
 * histórico se marca como suelo, con el número de días cubiertos a la vista.
 */

import { formatCost, formatMultiplier } from '@shared/format'
import type { Multiplier, PlanInfo } from '@shared/types'
import { fromHtml, must, setStatus, setText } from './dom'

const TEMPLATE = `
<section class="mb-section" id="sec-multiplier" data-status="loading">
  <div class="block-content">
    <p class="multiplier">
      <span class="multiplier-value" data-f="value">—</span>
      <span class="multiplier-label" data-f="label"></span>
    </p>
    <p class="note" data-f="basis"></p>
    <p class="note is-floor-note" data-f="floor" hidden></p>
  </div>

  <div class="block-skeleton" aria-hidden="true">
    <span class="skel skel-figure"></span>
    <span class="skel skel-note"></span>
  </div>

  <p class="block-empty">
    Plan no reconocido
    <button type="button" class="link" data-act="prefs">Indica el precio mensual</button>
  </p>
</section>`

export class MultiplierCard {
  readonly element: HTMLElement
  readonly #value: HTMLElement
  readonly #label: HTMLElement
  readonly #basis: HTMLElement
  readonly #floor: HTMLElement

  constructor(onOpenPrefs: () => void) {
    this.element = fromHtml<HTMLElement>(TEMPLATE)
    this.#value = must(this.element, '[data-f="value"]')
    this.#label = must(this.element, '[data-f="label"]')
    this.#basis = must(this.element, '[data-f="basis"]')
    this.#floor = must(this.element, '[data-f="floor"]')
    must<HTMLButtonElement>(this.element, '[data-act="prefs"]').addEventListener(
      'click',
      onOpenPrefs
    )
  }

  render(multiplier: Multiplier, plan: PlanInfo, currencySymbol: string): void {
    if (multiplier.planMonthlyUsd === null || multiplier.value === null) {
      setStatus(this.element, 'empty')
      return
    }

    setText(this.#value, formatMultiplier(multiplier.value))
    setText(this.#label, 'lo que pagas por tu plan')

    const spent = formatCost(multiplier.costUsd, currencySymbol)
    const monthly = formatCost(multiplier.planMonthlyUsd, currencySymbol)
    setText(
      this.#basis,
      `${spent} en tarifas de API en 30 días · tu plan ${plan.displayName} cuesta ${monthly}/mes`
    )

    // Con menos de 30 días de histórico el multiplicador es un SUELO, y eso se
    // dice en su propia línea en vez de esconderse al final de la anterior.
    this.#floor.hidden = !multiplier.isFloor
    if (multiplier.isFloor) {
      setText(
        this.#floor,
        `Como mínimo: solo llevamos ${multiplier.coveredDays} días midiendo, no 30.`
      )
    }
    this.element.classList.toggle('is-floor', multiplier.isFloor)
    setStatus(this.element, 'ready')
  }

  setLoading(): void {
    setStatus(this.element, 'loading')
  }

  setError(): void {
    setStatus(this.element, 'error')
  }
}
