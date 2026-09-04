/**
 * Orbix — pestaña «Mascota».
 * Fuente de verdad: docs/design/04-frontal.md §11.
 */

import type { Prefs } from '@shared/types'
import { formatPercent } from '@shared/format'
import * as api from '../api'
import { cornerPicker, note, section, segmentedRow, sliderRow, switchRow } from './controls'

type Patch = (patch: Partial<Prefs>) => void

export class PetTab {
  readonly element: HTMLElement

  readonly #visible
  readonly #corner
  readonly #follow
  readonly #scale
  readonly #opacity
  readonly #clickThrough

  constructor(patch: Patch, onPrefs: (prefs: Prefs) => void) {
    this.#visible = switchRow('Mostrar mascota', null, (v) => patch({ petVisible: v }))

    // `pet:setCorner` es el canal específico: además de guardar la preferencia,
    // recoloca la ventana en el acto.
    this.#corner = cornerPicker((corner) => {
      void api.setCorner(corner).then((r) => {
        if (r.ok) onPrefs(r.data)
      })
    })

    this.#follow = switchRow(
      'Seguir a la pantalla activa',
      'La mascota se muda a la pantalla donde esté el cursor.',
      (v) => patch({ followActiveDisplay: v })
    )

    // Las cinco escalas admitidas por `PREFS_LIMITS.petScale`.
    this.#scale = segmentedRow<number>(
      'Tamaño',
      [
        { value: 0.5, label: '0,5×' },
        { value: 0.75, label: '0,75×' },
        { value: 1, label: '1×' },
        { value: 1.25, label: '1,25×' },
        { value: 1.5, label: '1,5×' }
      ],
      (v) => patch({ petScale: v })
    )

    this.#opacity = sliderRow(
      'Opacidad en reposo',
      { min: 0.35, max: 1, step: 0.05 },
      (v) => formatPercent(v * 100),
      (v) => patch({ petOpacityIdle: v })
    )

    this.#clickThrough = switchRow(
      'Dejar pasar los clics',
      'Con esto activado la mascota es inerte: los clics atraviesan a la app de debajo.',
      (v) => patch({ clickThrough: v })
    )

    this.element = document.createElement('div')
    this.element.className = 'pane'
    this.element.append(
      section('Presencia', this.#visible.element, this.#clickThrough.element),
      section(
        'Colocación',
        this.#corner.element,
        this.#follow.element,
        note(
          'La pantalla concreta todavía no se puede elegir a mano: no hay canal IPC ' +
            'para enumerar los monitores. Con «seguir a la pantalla activa» desactivado ' +
            'se usa la última pantalla conocida, y si desaparece, la principal.'
        )
      ),
      section('Aspecto', this.#scale.element, this.#opacity.element)
    )
  }

  render(prefs: Prefs): void {
    this.#visible.set(prefs.petVisible)
    this.#corner.set(prefs.corner)
    this.#follow.set(prefs.followActiveDisplay)
    this.#scale.set(prefs.petScale)
    this.#opacity.set(prefs.petOpacityIdle)
    this.#clickThrough.set(prefs.clickThrough)
  }
}
