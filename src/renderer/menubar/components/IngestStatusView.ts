/**
 * Orbix — estado del ingestor: banda de progreso arriba y línea de pie.
 * Fuente de verdad: docs/design/04-frontal.md §10.3 y §10.6.
 *
 * En el primer arranque el popover se abre con la banda de ingesta arriba del todo
 * y el resto en esqueleto; al terminar, la banda desaparece.
 */

import { formatAge, formatPercent, pluralize } from '@shared/format'
import type { IngestStatus } from '@shared/types'
import { ageSecondsFrom, fromHtml, must, setText } from './dom'

const BANNER = `
<section class="mb-section mb-ingest" data-state="idle" hidden>
  <div class="ingest-head">
    <p class="ingest-title" data-f="title"></p>
    <button type="button" class="link" data-act="retry" hidden>Reintentar</button>
  </div>
  <span class="ingest-track"><span class="ingest-fill"></span></span>
</section>`

const LINE = `<p class="mb-ingest-line" data-f="line"></p>`

export class IngestStatusView {
  readonly banner: HTMLElement
  readonly line: HTMLElement
  readonly #title: HTMLElement
  readonly #fill: HTMLElement
  readonly #retry: HTMLButtonElement
  #last: IngestStatus | null = null

  constructor(onRetry: () => void) {
    this.banner = fromHtml<HTMLElement>(BANNER)
    this.line = fromHtml<HTMLElement>(LINE)
    this.#title = must(this.banner, '[data-f="title"]')
    this.#fill = must(this.banner, '.ingest-fill')
    this.#retry = must<HTMLButtonElement>(this.banner, '[data-act="retry"]')
    this.#retry.addEventListener('click', onRetry)
  }

  render(status: IngestStatus): void {
    this.#last = status
    this.banner.dataset['state'] = status.state

    const backfilling = status.state === 'backfilling' && status.backfillProgress !== null
    const failed = status.state === 'error'
    this.banner.hidden = !backfilling && !failed
    this.#retry.hidden = !failed

    if (backfilling) {
      const pct = (status.backfillProgress ?? 0) * 100
      setText(this.#title, `Analizando histórico… ${formatPercent(pct)}`)
      this.#fill.style.setProperty('--fill', String(Math.min(1, Math.max(0, pct / 100))))
    } else if (failed) {
      setText(this.#title, status.lastError ?? 'Error de ingesta')
      this.#fill.style.setProperty('--fill', '0')
    }

    this.renderAge()
  }

  /** Refresca solo la antigüedad; se llama cada pocos segundos mientras esté visible. */
  renderAge(): void {
    const status = this.#last
    if (status === null) return
    const files = pluralize(status.filesTracked, 'fichero', 'ficheros')
    const age = ageSecondsFrom(status.lastRunAt)
    setText(this.line, age === null ? files : `${files} · actualizado ${formatAge(age)}`)
  }
}
