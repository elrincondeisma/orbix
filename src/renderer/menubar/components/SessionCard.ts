/**
 * miniClaudio — bloque «Sesión actual».
 * Fuente de verdad: docs/design/04-frontal.md §10.3 y §10.6.
 */

import { formatAge, formatCost, formatTokens } from '@shared/format'
import type { SessionStats } from '@shared/types'
import { ageSecondsFrom, fromHtml, must, setStatus, setText } from './dom'

const TEMPLATE = `
<section class="mb-section" id="sec-session" data-status="loading">
  <p class="eyebrow">Sesión actual<span class="eyebrow-value" data-f="scope"></span></p>

  <div class="block-content">
    <div class="figure">
      <span class="figure-main" data-f="cost">—</span>
      <span class="figure-side" data-f="tokens">—</span>
    </div>
    <p class="note" data-f="age"></p>
  </div>

  <div class="block-skeleton" aria-hidden="true">
    <span class="skel skel-figure"></span>
    <span class="skel skel-note"></span>
  </div>

  <p class="block-empty">Sin sesión activa</p>

  <p class="block-error" role="alert">
    No se pudo leer la sesión
    <button type="button" class="link" data-act="retry">Reintentar</button>
  </p>
</section>`

export class SessionCard {
  readonly element: HTMLElement
  readonly #scope: HTMLElement
  readonly #cost: HTMLElement
  readonly #tokens: HTMLElement
  readonly #age: HTMLElement

  constructor(onRetry: () => void) {
    this.element = fromHtml<HTMLElement>(TEMPLATE)
    this.#scope = must(this.element, '[data-f="scope"]')
    this.#cost = must(this.element, '[data-f="cost"]')
    this.#tokens = must(this.element, '[data-f="tokens"]')
    this.#age = must(this.element, '[data-f="age"]')
    must<HTMLButtonElement>(this.element, '[data-act="retry"]').addEventListener('click', onRetry)
  }

  render(session: SessionStats, currencySymbol: string): void {
    if (session.sessionId === null) {
      setStatus(this.element, 'empty')
      return
    }

    // El nombre del proyecto conserva sus mayúsculas: es un identificador, no una
    // etiqueta. Por eso va fuera del `text-transform` del rótulo.
    setText(this.#scope, ` · ${session.projectName ?? 'sin proyecto'}`)
    setText(this.#cost, formatCost(session.costUsd, currencySymbol))
    setText(this.#tokens, `${formatTokens(session.totalTokens)} tok`)

    const age = ageSecondsFrom(session.lastActivityAt)
    // La sesión inactiva se sigue mostrando, pero dice claramente que no lo está.
    setText(
      this.#age,
      session.isActive ? `activa ${formatAge(age)}` : `sin actividad · última ${formatAge(age)}`
    )
    this.element.classList.toggle('is-inactive', !session.isActive)
    setStatus(this.element, 'ready')
  }

  setLoading(): void {
    setStatus(this.element, 'loading')
  }

  setError(): void {
    setStatus(this.element, 'error')
  }
}
