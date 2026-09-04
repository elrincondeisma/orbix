/**
 * miniClaudio — pestaña «Avisos»: bocadillos, sonido y silencio.
 * Fuente de verdad: docs/design/04-frontal.md §11 y §8.2.
 */

import type { Prefs } from '@shared/types'
import { formatPercent } from '@shared/format'
import {
  button,
  buttonBar,
  fromHtml,
  inputRow,
  note,
  section,
  setText,
  sliderRow,
  switchRow
} from './controls'

type Patch = (patch: Partial<Prefs>) => void

/** Fecha muy lejana = silencio indefinido, según `PrefsStore.mute`. */
const FOREVER_YEAR = 2900

function muteLabel(muteUntil: string | null): string {
  if (muteUntil === null) return 'El sonido está activo.'
  const date = new Date(muteUntil)
  if (Number.isNaN(date.getTime())) return 'El sonido está activo.'
  if (date.getFullYear() >= FOREVER_YEAR) return 'Silenciado hasta que lo reactives.'
  if (date.getTime() <= Date.now()) return 'El sonido está activo.'
  const hora = date.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })
  const hoy = date.toDateString() === new Date().toDateString()
  return `Silenciado hasta ${hoy ? 'las' : 'mañana a las'} ${hora}.`
}

export class AlertsTab {
  readonly element: HTMLElement

  readonly #bubbles
  readonly #bubbleMs
  readonly #sound
  readonly #volume
  readonly #subagent
  readonly #quiet
  readonly #quietFrom
  readonly #quietTo
  readonly #lock
  readonly #detailed
  readonly #muteState: HTMLElement

  /** Copia viva de `quietHours`, para poder parchear un solo campo del trío. */
  #currentQuiet: Prefs['quietHours'] = { enabled: false, from: '23:00', to: '08:00' }

  constructor(patch: Patch, mute: (minutes: number | null) => void) {
    this.#bubbles = switchRow('Bocadillos', null, (v) => patch({ bubbleEnabled: v }))
    this.#bubbleMs = sliderRow(
      'Duración del bocadillo',
      { min: 2000, max: 15000, step: 500 },
      (v) => `${(v / 1000).toLocaleString('es-ES', { maximumFractionDigits: 1 })} s`,
      (v) => patch({ bubbleMs: v })
    )

    this.#sound = switchRow('Sonido', null, (v) => patch({ soundEnabled: v }))
    this.#volume = sliderRow(
      'Volumen',
      { min: 0, max: 1, step: 0.05 },
      (v) => formatPercent(v * 100),
      (v) => patch({ volume: v })
    )
    this.#subagent = switchRow(
      'Sonar al terminar un subagente',
      'Desactivado por defecto: en una sesión con muchos agentes cansa.',
      (v) => patch({ soundOnSubagentStop: v })
    )

    this.#quiet = switchRow('Horas de silencio', null, (v) =>
      patch({ quietHours: { ...this.#currentQuiet, enabled: v } })
    )
    this.#quietFrom = inputRow('Desde', null, { type: 'time', width: '110px' }, (v) =>
      patch({ quietHours: { ...this.#currentQuiet, from: v } })
    )
    this.#quietTo = inputRow('Hasta', null, { type: 'time', width: '110px' }, (v) =>
      patch({ quietHours: { ...this.#currentQuiet, to: v } })
    )

    this.#lock = switchRow(
      'Silenciar con la pantalla bloqueada',
      null,
      (v) => patch({ muteWhenScreenLocked: v })
    )

    this.#detailed = switchRow(
      'Estados detallados de herramientas',
      'Instala también los hooks PreToolUse y PostToolUse, para ver «picando código» ' +
        'y «ejecutando». Si ya tenías los hooks puestos, se reinstalan al cambiarlo.',
      (v) => patch({ detailedToolStates: v })
    )

    this.#muteState = fromHtml<HTMLElement>('<p class="note"></p>')

    this.element = document.createElement('div')
    this.element.className = 'pane'
    this.element.append(
      section('Bocadillos', this.#bubbles.element, this.#bubbleMs.element),
      section(
        'Sonido',
        this.#sound.element,
        this.#volume.element,
        this.#subagent.element,
        this.#lock.element,
        this.#muteState,
        buttonBar(
          button('Silenciar 30 min', 'default', () => mute(30)),
          button('2 h', 'default', () => mute(120)),
          button('Hasta mañana', 'default', () => mute(minutesUntilTomorrow())),
          button('Siempre', 'default', () => mute(null)),
          button('Reactivar', 'primary', () => mute(0))
        )
      ),
      section(
        'Horas de silencio',
        this.#quiet.element,
        this.#quietFrom.element,
        this.#quietTo.element,
        note('El rango puede cruzar la medianoche: de 23:00 a 08:00 es válido.')
      ),
      section('Detalle de los estados', this.#detailed.element)
    )
  }

  render(prefs: Prefs): void {
    this.#currentQuiet = prefs.quietHours
    this.#bubbles.set(prefs.bubbleEnabled)
    this.#bubbleMs.set(prefs.bubbleMs)
    this.#bubbleMs.setDisabled(!prefs.bubbleEnabled)
    this.#sound.set(prefs.soundEnabled)
    this.#volume.set(prefs.volume)
    this.#volume.setDisabled(!prefs.soundEnabled)
    this.#subagent.set(prefs.soundOnSubagentStop)
    this.#quiet.set(prefs.quietHours.enabled)
    this.#quietFrom.set(prefs.quietHours.from)
    this.#quietTo.set(prefs.quietHours.to)
    this.#quietFrom.setDisabled(!prefs.quietHours.enabled)
    this.#quietTo.setDisabled(!prefs.quietHours.enabled)
    this.#lock.set(prefs.muteWhenScreenLocked)
    this.#detailed.set(prefs.detailedToolStates)
    setText(this.#muteState, muteLabel(prefs.muteUntil))
  }
}

function minutesUntilTomorrow(): number {
  const now = new Date()
  const tomorrow = new Date(now)
  tomorrow.setDate(now.getDate() + 1)
  tomorrow.setHours(8, 0, 0, 0)
  return Math.max(1, Math.round((tomorrow.getTime() - now.getTime()) / 60_000))
}
