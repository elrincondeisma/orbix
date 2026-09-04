/**
 * Orbix — bloque «Hoy / 7 días / 30 días».
 * Fuente de verdad: docs/design/04-frontal.md §10.3 y §10.6.
 *
 * Ojo: todo a cero es un dato válido, no un vacío. Aquí no hay estado «empty».
 */

import { formatCost, formatTokens } from '@shared/format'
import type { PeriodStats } from '@shared/types'
import { EM_DASH } from '@shared/format'
import { fromHtml, must, setStatus, setText } from './dom'

const COLUMNS = [
  { key: 'today', label: 'Hoy' },
  { key: '7d', label: '7 días' },
  { key: '30d', label: '30 días' }
] as const

const TEMPLATE = `
<section class="mb-section" id="sec-periods" data-status="loading">
  <div class="block-content periods">
    ${COLUMNS.map(
      (c) => `
    <div class="period">
      <p class="eyebrow">${c.label}</p>
      <p class="period-cost" data-f="cost-${c.key}">${EM_DASH}</p>
      <p class="note" data-f="tokens-${c.key}">${EM_DASH}</p>
    </div>`
    ).join('')}
  </div>

  <div class="block-skeleton periods" aria-hidden="true">
    <span class="skel skel-col"></span>
    <span class="skel skel-col"></span>
    <span class="skel skel-col"></span>
  </div>
</section>`

export class PeriodsRow {
  readonly element: HTMLElement
  readonly #cells: Map<string, { cost: HTMLElement; tokens: HTMLElement }> = new Map()

  constructor() {
    this.element = fromHtml<HTMLElement>(TEMPLATE)
    for (const c of COLUMNS) {
      this.#cells.set(c.key, {
        cost: must(this.element, `[data-f="cost-${c.key}"]`),
        tokens: must(this.element, `[data-f="tokens-${c.key}"]`)
      })
    }
  }

  render(
    today: PeriodStats,
    last7d: PeriodStats,
    last30d: PeriodStats,
    currencySymbol: string
  ): void {
    const data: Record<string, PeriodStats> = { today, '7d': last7d, '30d': last30d }
    for (const [key, cell] of this.#cells) {
      const stats = data[key]
      if (stats === undefined) continue
      setText(cell.cost, formatCost(stats.costUsd, currencySymbol))
      setText(cell.tokens, `${formatTokens(stats.totalTokens)} tok`)
    }
    setStatus(this.element, 'ready')
  }

  setLoading(): void {
    setStatus(this.element, 'loading')
  }

  /** Sin dato: la fila entera se queda en `—`, sin inventar ceros. */
  setError(message: string): void {
    for (const cell of this.#cells.values()) {
      setText(cell.cost, EM_DASH)
      setText(cell.tokens, EM_DASH)
    }
    this.element.title = message
    setStatus(this.element, 'ready')
  }
}
