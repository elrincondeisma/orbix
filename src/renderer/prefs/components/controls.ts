/**
 * Orbix — controles de formulario de Preferencias.
 *
 * Sin framework (01-arquitectura.md §5): plantillas con template literals y
 * actualización puntual. Cada control devuelve su elemento y un `set()` para
 * reflejar el valor que ha confirmado `main`, nunca el que el usuario tecleó.
 *
 * Regla de toda esta ventana: el control NO es la fuente de verdad. Se manda el
 * cambio, `main` responde con las `Prefs` completas ya saneadas y ENTONCES se
 * repinta. Así lo que se ve es siempre lo que hay en disco.
 */

export function fromHtml<T extends HTMLElement>(html: string): T {
  const template = document.createElement('template')
  template.innerHTML = html.trim()
  const node = template.content.firstElementChild
  if (node === null) throw new Error('fromHtml: plantilla vacía')
  return node as T
}

export function must<T extends Element>(root: ParentNode, selector: string): T {
  const found = root.querySelector<T>(selector)
  if (found === null) throw new Error(`Falta el nodo "${selector}"`)
  return found
}

export function setText(el: Element, value: string): void {
  if (el.textContent !== value) el.textContent = value
}

/** Escapa texto que va dentro de una plantilla HTML. */
export function esc(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c
  )
}

let uid = 0
const nextId = (): string => `mc-c${++uid}`

// ---------------------------------------------------------------------------

export interface Control<T> {
  readonly element: HTMLElement
  set(value: T): void
  setDisabled(disabled: boolean, reason?: string): void
}

/** Interruptor. */
export function switchRow(
  label: string,
  hint: string | null,
  onChange: (value: boolean) => void
): Control<boolean> {
  const id = nextId()
  const element = fromHtml<HTMLElement>(`
    <div class="row">
      <div class="row-label">
        <label for="${id}">${esc(label)}</label>
        ${hint === null ? '' : `<p class="hint">${esc(hint)}</p>`}
      </div>
      <input class="switch" type="checkbox" id="${id}" role="switch" />
    </div>`)
  const input = must<HTMLInputElement>(element, 'input')
  input.addEventListener('change', () => onChange(input.checked))
  return {
    element,
    set: (value) => {
      if (input.checked !== value) input.checked = value
    },
    setDisabled: (disabled, reason) => {
      input.disabled = disabled
      element.classList.toggle('is-disabled', disabled)
      if (reason !== undefined) element.title = reason
    }
  }
}

/** Deslizador con su valor formateado a la derecha. */
export function sliderRow(
  label: string,
  range: { min: number; max: number; step: number },
  format: (value: number) => string,
  onCommit: (value: number) => void
): Control<number> {
  const id = nextId()
  const element = fromHtml<HTMLElement>(`
    <div class="row">
      <div class="row-label"><label for="${id}">${esc(label)}</label></div>
      <div class="slider-wrap">
        <input type="range" id="${id}" min="${range.min}" max="${range.max}" step="${range.step}" />
        <span class="slider-value"></span>
      </div>
    </div>`)
  const input = must<HTMLInputElement>(element, 'input')
  const value = must<HTMLElement>(element, '.slider-value')
  // `input` pinta en vivo; `change` es el que confirma y escribe en disco.
  input.addEventListener('input', () => setText(value, format(Number(input.value))))
  input.addEventListener('change', () => onCommit(Number(input.value)))
  return {
    element,
    set: (v) => {
      input.value = String(v)
      setText(value, format(v))
    },
    setDisabled: (disabled) => {
      input.disabled = disabled
      element.classList.toggle('is-disabled', disabled)
    }
  }
}

/** Control segmentado (radiogroup real, navegable con teclado). */
export function segmentedRow<T extends string | number>(
  label: string,
  options: readonly { value: T; label: string }[],
  onChange: (value: T) => void
): Control<T> {
  const element = fromHtml<HTMLElement>(`
    <div class="row">
      <div class="row-label"><span>${esc(label)}</span></div>
      <div class="segmented" role="radiogroup" aria-label="${esc(label)}">
        ${options
          .map(
            (o) =>
              `<button type="button" role="radio" aria-checked="false" data-value="${esc(String(o.value))}">${esc(o.label)}</button>`
          )
          .join('')}
      </div>
    </div>`)
  element.addEventListener('click', (event) => {
    const raw = (event.target as HTMLElement).closest<HTMLElement>('[data-value]')?.dataset['value']
    if (raw === undefined) return
    const found = options.find((o) => String(o.value) === raw)
    if (found !== undefined) onChange(found.value)
  })
  return {
    element,
    set: (value) => {
      for (const b of element.querySelectorAll<HTMLElement>('[data-value]')) {
        b.setAttribute('aria-checked', String(b.dataset['value'] === String(value)))
      }
    },
    setDisabled: (disabled) => {
      for (const b of element.querySelectorAll<HTMLButtonElement>('button')) b.disabled = disabled
      element.classList.toggle('is-disabled', disabled)
    }
  }
}

/** Campo de texto corto (hora, precio, número). */
export function inputRow(
  label: string,
  hint: string | null,
  attrs: { type?: string; placeholder?: string; width?: string },
  onCommit: (value: string) => void
): Control<string> {
  const id = nextId()
  const element = fromHtml<HTMLElement>(`
    <div class="row">
      <div class="row-label">
        <label for="${id}">${esc(label)}</label>
        ${hint === null ? '' : `<p class="hint">${esc(hint)}</p>`}
      </div>
      <input class="text" type="${attrs.type ?? 'text'}" id="${id}"
             placeholder="${esc(attrs.placeholder ?? '')}"
             style="width:${attrs.width ?? '110px'}" />
    </div>`)
  const input = must<HTMLInputElement>(element, 'input')
  input.addEventListener('change', () => onCommit(input.value))
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur()
  })
  return {
    element,
    set: (value) => {
      if (document.activeElement !== input) input.value = value
    },
    setDisabled: (disabled) => {
      input.disabled = disabled
      element.classList.toggle('is-disabled', disabled)
    }
  }
}

/** Fila de solo lectura: una etiqueta y un valor seleccionable (rutas, versiones). */
export function infoRow(label: string, selectable = true): Control<string> {
  const element = fromHtml<HTMLElement>(`
    <div class="row row-info">
      <div class="row-label"><span>${esc(label)}</span></div>
      <span class="info-value${selectable ? ' is-selectable' : ''}"></span>
    </div>`)
  const value = must<HTMLElement>(element, '.info-value')
  return {
    element,
    set: (v) => setText(value, v),
    setDisabled: () => {}
  }
}

/** Selector de esquina sobre un diagrama de pantalla. */
export function cornerPicker(
  onChange: (corner: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right') => void
): Control<string> {
  const corners = ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const
  const element = fromHtml<HTMLElement>(`
    <div class="row row-corner">
      <div class="row-label"><span>Esquina</span></div>
      <div class="screen" role="radiogroup" aria-label="Esquina de la pantalla">
        ${corners
          .map(
            (c) =>
              `<button type="button" role="radio" aria-checked="false" class="corner ${c}"
                       data-corner="${c}" aria-label="${c}"><span></span></button>`
          )
          .join('')}
      </div>
    </div>`)
  element.addEventListener('click', (event) => {
    const c = (event.target as HTMLElement).closest<HTMLElement>('[data-corner]')?.dataset['corner']
    if (c !== undefined) onChange(c as (typeof corners)[number])
  })
  return {
    element,
    set: (value) => {
      for (const b of element.querySelectorAll<HTMLElement>('[data-corner]')) {
        b.setAttribute('aria-checked', String(b.dataset['corner'] === value))
      }
    },
    setDisabled: () => {}
  }
}

/** Sección con título dentro de una pestaña. */
export function section(title: string, ...children: HTMLElement[]): HTMLElement {
  const element = fromHtml<HTMLElement>(
    `<section class="pane-section"><h2>${esc(title)}</h2></section>`
  )
  element.append(...children)
  return element
}

/** Párrafo explicativo dentro de una sección. */
export function note(text: string, tone: 'plain' | 'warn' | 'ok' = 'plain'): HTMLElement {
  return fromHtml<HTMLElement>(`<p class="note note-${tone}">${esc(text)}</p>`)
}

export function button(
  label: string,
  variant: 'primary' | 'default' | 'danger',
  onClick: () => void
): HTMLButtonElement {
  const el = fromHtml<HTMLButtonElement>(
    `<button type="button" class="btn btn-${variant}">${esc(label)}</button>`
  )
  el.addEventListener('click', onClick)
  return el
}

export function buttonBar(...children: HTMLElement[]): HTMLElement {
  const el = fromHtml<HTMLElement>('<div class="btn-bar"></div>')
  el.append(...children)
  return el
}
