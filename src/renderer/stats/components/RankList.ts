/**
 * Orbix — desglose por proyecto o por modelo, en barras horizontales.
 *
 * `stats:getSeries` solo devuelve la serie total (`by: null`), así que el «por
 * proyecto» y el «por modelo» se resuelven con `stats:getBreakdown`, que sí
 * agrupa. Se dice aquí para que no parezca un olvido.
 */

import { formatCost, formatPercent, formatTokens } from '@shared/format'
import type { Breakdown, BreakdownRow } from '@shared/types'

export class RankList {
  readonly element: HTMLElement
  readonly #title: string
  readonly #body: HTMLElement
  #symbol = '$'

  constructor(title: string) {
    this.#title = title
    this.element = document.createElement('section')
    this.element.className = 'rank'
    this.element.innerHTML =
      `<header class="rank-head"><h2>${title}</h2><span class="rank-total"></span></header>` +
      `<ol class="rank-body"></ol>` +
      `<p class="rank-empty" hidden>Sin actividad en este periodo</p>`
    const body = this.element.querySelector<HTMLElement>('.rank-body')
    if (body === null) throw new Error('RankList: falta el cuerpo')
    this.#body = body
  }

  setCurrencySymbol(symbol: string): void {
    this.#symbol = symbol
  }

  setLoading(): void {
    this.element.dataset['status'] = 'loading'
    this.#body.innerHTML = '<li class="rank-skel"></li>'.repeat(5)
  }

  render(data: Breakdown): void {
    this.element.dataset['status'] = 'ready'
    const empty = this.element.querySelector<HTMLElement>('.rank-empty')
    if (empty !== null) empty.hidden = data.rows.length > 0

    const total = this.element.querySelector<HTMLElement>('.rank-total')
    if (total !== null) {
      total.textContent = `${this.#title === 'Por proyecto' ? '' : ''}${formatCost(data.totalCostUsd, this.#symbol)}`
    }

    if (data.rows.length === 0) {
      this.#body.replaceChildren()
      return
    }

    // La barra es proporcional al mayor de la lista: así la primera llena y el
    // resto se comparan de un vistazo.
    const max = data.rows.reduce((m, r) => Math.max(m, r.costUsd), 0)
    this.#body.innerHTML = data.rows.map((row) => this.#row(row, max)).join('')
  }

  #row(row: BreakdownRow, max: number): string {
    const fill = max > 0 ? row.costUsd / max : 0
    return (
      `<li class="rank-row">` +
      `<span class="rank-name" title="${escapeAttr(row.label)}"><bdi>${escapeHtml(row.label)}</bdi></span>` +
      `<span class="rank-cost">${formatCost(row.costUsd, this.#symbol)}</span>` +
      `<span class="rank-track"><span class="rank-fill" style="--fill:${fill.toFixed(4)}"></span></span>` +
      `<span class="rank-meta">${formatTokens(row.totalTokens)} tok · ${formatPercent(row.share * 100)}</span>` +
      `</li>`
    )
  }
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c
  )
}

const escapeAttr = escapeHtml
