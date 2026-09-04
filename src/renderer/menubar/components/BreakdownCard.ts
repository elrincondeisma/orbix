/**
 * miniClaudio — desgloses «Por proyecto» y «Por modelo».
 * Fuente de verdad: docs/design/04-frontal.md §10.3, §10.6 y §10.7.
 *
 * No se pide nada hasta desplegar: el popover se abre y se cierra muchas veces al
 * día y estas consultas son las más caras del menubar.
 */

import { formatCost, formatTokens } from '@shared/format'
import type { Breakdown, BreakdownRow, PeriodKey } from '@shared/types'
import { fromHtml, must, setStatus, setText } from './dom'

const TEMPLATE = `
<section class="mb-section mb-breakdown" data-status="loading" data-open="false">
  <button type="button" class="disclosure" aria-expanded="false">
    <span class="disclosure-caret" aria-hidden="true"></span>
    <span class="disclosure-title"></span>
  </button>

  <div class="disclosure-panel" hidden>
    <div class="block-content">
      <ol class="rows" data-f="rows"></ol>
    </div>

    <div class="block-skeleton" aria-hidden="true">
      <span class="skel skel-row"></span>
      <span class="skel skel-row"></span>
      <span class="skel skel-row"></span>
      <span class="skel skel-row"></span>
      <span class="skel skel-row"></span>
    </div>

    <p class="block-empty">Sin actividad en este periodo</p>

    <p class="block-error" role="alert">
      No se pudo cargar el desglose
      <button type="button" class="link" data-act="retry">Reintentar</button>
    </p>
  </div>
</section>`

const ROW_TEMPLATE = `
<li class="row">
  <span class="row-name"><bdi></bdi></span>
  <span class="row-cost"></span>
  <span class="row-track"><span class="row-fill"></span></span>
  <span class="row-tokens"></span>
</li>`

/** Filas visibles antes de agrupar el resto en «Otros (N)». */
const TOP_N = 5

interface RowNodes {
  root: HTMLElement
  name: HTMLElement
  cost: HTMLElement
  fill: HTMLElement
  tokens: HTMLElement
}

export class BreakdownCard {
  readonly element: HTMLElement
  readonly #button: HTMLButtonElement
  readonly #panel: HTMLElement
  readonly #rowsHost: HTMLElement
  readonly #by: 'project' | 'model'
  readonly #load: (by: 'project' | 'model', period: PeriodKey) => Promise<Breakdown>

  #rows: RowNodes[] = []
  #open = false
  #period: PeriodKey = '30d'
  #currencySymbol = '$'
  #requestId = 0

  constructor(
    by: 'project' | 'model',
    title: string,
    load: (by: 'project' | 'model', period: PeriodKey) => Promise<Breakdown>
  ) {
    this.#by = by
    this.#load = load
    this.element = fromHtml<HTMLElement>(TEMPLATE)
    this.#button = must<HTMLButtonElement>(this.element, '.disclosure')
    this.#panel = must(this.element, '.disclosure-panel')
    this.#rowsHost = must(this.element, '[data-f="rows"]')
    setText(must(this.element, '.disclosure-title'), title)

    this.#button.addEventListener('click', () => this.toggle())
    must<HTMLButtonElement>(this.element, '[data-act="retry"]').addEventListener('click', () => {
      void this.refresh()
    })
  }

  get isOpen(): boolean {
    return this.#open
  }

  setCurrencySymbol(symbol: string): void {
    this.#currencySymbol = symbol
  }

  /** Cambia el periodo. Solo recarga si el bloque está desplegado. */
  setPeriod(period: PeriodKey): void {
    if (this.#period === period) return
    this.#period = period
    if (this.#open) void this.refresh()
  }

  toggle(): void {
    this.#open = !this.#open
    this.element.dataset['open'] = String(this.#open)
    this.#button.setAttribute('aria-expanded', String(this.#open))
    this.#panel.hidden = !this.#open
    if (this.#open) void this.refresh()
  }

  async refresh(): Promise<void> {
    if (!this.#open) return
    const id = ++this.#requestId
    setStatus(this.element, 'loading')
    try {
      const data = await this.#load(this.#by, this.#period)
      // Una respuesta vieja no puede pisar a una nueva.
      if (id !== this.#requestId) return
      this.#render(data)
    } catch {
      if (id !== this.#requestId) return
      setStatus(this.element, 'error')
    }
  }

  // -----------------------------------------------------------------

  #render(data: Breakdown): void {
    if (data.rows.length === 0) {
      setStatus(this.element, 'empty')
      return
    }

    const visible = this.#collapse(data.rows)
    // La barra es proporcional al máximo de la lista, no al total del periodo:
    // así la primera fila siempre llena y las demás se comparan de un vistazo.
    const max = visible.reduce((m, r) => Math.max(m, r.costUsd), 0)

    this.#ensureRows(visible.length)
    visible.forEach((row, i) => {
      const nodes = this.#rows[i]
      if (nodes === undefined) return
      const bdi = nodes.name.firstElementChild
      if (bdi !== null) setText(bdi, row.label)
      nodes.name.title = row.label
      setText(nodes.cost, formatCost(row.costUsd, this.#currencySymbol))
      setText(nodes.tokens, `${formatTokens(row.totalTokens)} tok`)
      nodes.fill.style.setProperty('--fill', String(max > 0 ? row.costUsd / max : 0))
    })

    setStatus(this.element, 'ready')
  }

  /** Top 5 y una sexta fila «Otros (N)» con el resto agregado. */
  #collapse(rows: readonly BreakdownRow[]): BreakdownRow[] {
    if (rows.length <= TOP_N + 1) return [...rows]
    const head = rows.slice(0, TOP_N)
    const tail = rows.slice(TOP_N)
    const others = tail.reduce(
      (acc, r) => {
        acc.costUsd += r.costUsd
        acc.totalTokens += r.totalTokens
        acc.requests += r.requests
        acc.share += r.share
        return acc
      },
      { costUsd: 0, totalTokens: 0, requests: 0, share: 0 }
    )
    const first = rows[0]
    if (first === undefined) return head
    return [
      ...head,
      {
        key: '__others__',
        label: `Otros (${tail.length})`,
        tokens: first.tokens,
        totalTokens: others.totalTokens,
        costUsd: others.costUsd,
        requests: others.requests,
        share: others.share
      }
    ]
  }

  #ensureRows(count: number): void {
    while (this.#rows.length > count) {
      this.#rows.pop()?.root.remove()
    }
    while (this.#rows.length < count) {
      const root = fromHtml<HTMLElement>(ROW_TEMPLATE)
      this.#rowsHost.appendChild(root)
      this.#rows.push({
        root,
        name: must(root, '.row-name'),
        cost: must(root, '.row-cost'),
        fill: must(root, '.row-fill'),
        tokens: must(root, '.row-tokens')
      })
    }
  }
}
