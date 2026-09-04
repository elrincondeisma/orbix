/**
 * miniClaudio — selector de periodo compartido por los dos desgloses.
 * Fuente de verdad: docs/design/04-frontal.md §10.3.
 *
 * Es un `radiogroup` de verdad para que funcione con teclado y con VoiceOver.
 */

import type { PeriodKey } from '@shared/types'
import { fromHtml, setAttr } from './dom'

const OPTIONS = [
  { key: 'today', label: 'Hoy' },
  { key: '7d', label: '7 días' },
  { key: '30d', label: '30 días' }
] as const satisfies readonly { key: PeriodKey; label: string }[]

const TEMPLATE = `
<div class="period-picker" role="radiogroup" aria-label="Periodo del desglose">
  ${OPTIONS.map(
    (o) => `
  <button type="button" role="radio" data-period="${o.key}" aria-checked="false">${o.label}</button>`
  ).join('')}
</div>`

export class PeriodPicker {
  readonly element: HTMLElement
  #value: PeriodKey = '30d'

  constructor(onChange: (period: PeriodKey) => void) {
    this.element = fromHtml<HTMLElement>(TEMPLATE)
    this.element.addEventListener('click', (event) => {
      const target = (event.target as HTMLElement).closest<HTMLElement>('[data-period]')
      const period = target?.dataset['period'] as PeriodKey | undefined
      if (period === undefined || period === this.#value) return
      this.value = period
      onChange(period)
    })
    this.value = this.#value
  }

  get value(): PeriodKey {
    return this.#value
  }

  set value(period: PeriodKey) {
    this.#value = period
    for (const button of this.element.querySelectorAll<HTMLElement>('[data-period]')) {
      setAttr(button, 'aria-checked', String(button.dataset['period'] === period))
    }
  }
}
