/**
 * Orbix — utilidades de DOM del popover.
 *
 * Sin framework de UI (01-arquitectura.md §5): plantillas con template literals y
 * actualización puntual. La regla de §9.6 es dura: se actualizan SOLO los nodos de
 * texto que han cambiado; nunca se reconstruye el DOM en un refresco.
 */

/** Estado de carga de un bloque del popover (§10.6). */
export type BlockStatus = 'loading' | 'ready' | 'empty' | 'error'

/** Crea un elemento a partir de una plantilla HTML. */
export function fromHtml<T extends HTMLElement>(html: string): T {
  const template = document.createElement('template')
  template.innerHTML = html.trim()
  const node = template.content.firstElementChild
  if (node === null) throw new Error('fromHtml: plantilla vacía')
  return node as T
}

/** Busca un descendiente obligatorio. Falla pronto si la plantilla se desincroniza. */
export function must<T extends Element>(root: ParentNode, selector: string): T {
  const found = root.querySelector<T>(selector)
  if (found === null) throw new Error(`Falta el nodo "${selector}"`)
  return found
}

/** Escribe texto solo si ha cambiado: evita repintados innecesarios. */
export function setText(el: Element, value: string): void {
  if (el.textContent !== value) el.textContent = value
}

/** Fija un atributo solo si ha cambiado. */
export function setAttr(el: Element, name: string, value: string): void {
  if (el.getAttribute(name) !== value) el.setAttribute(name, value)
}

export function setStatus(el: HTMLElement, status: BlockStatus): void {
  setAttr(el, 'data-status', status)
}

/** Segundos transcurridos desde una marca ISO. `null` si no hay marca o no parsea. */
export function ageSecondsFrom(iso: string | null): number | null {
  if (iso === null) return null
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return null
  return Math.max(0, (Date.now() - t) / 1000)
}
