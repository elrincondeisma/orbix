/**
 * Orbix — gráfica de barras por día, en SVG a mano.
 *
 * Sin `uplot` ni ninguna otra dependencia: son barras y dos ejes. Meter un runtime
 * de gráficas en una app que vive 24/7 para esto no sale a cuenta
 * (01-arquitectura.md §5: «sin framework de UI»).
 *
 * Se redibuja al cambiar de periodo, de métrica o de tamaño de ventana. No hay
 * bucle de animación: el SVG se genera una vez por cambio.
 */

import { formatCost, formatTokens } from '@shared/format'
import type { SeriesPoint } from '@shared/types'

export type Metric = 'cost' | 'tokens'

const PAD = { top: 14, right: 12, bottom: 26, left: 58 }
/** Separación mínima entre barras, en px. */
const GAP = 2

function niceCeil(value: number): number {
  if (value <= 0) return 1
  const exp = Math.floor(Math.log10(value))
  const base = 10 ** exp
  for (const step of [1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10]) {
    if (value <= step * base) return step * base
  }
  return 10 * base
}

/** `2026-09-03` → `3 sep`. Sin `Date`, para no arrastrar la zona horaria. */
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']
function shortDay(iso: string): string {
  const [, m, d] = iso.split('-')
  const mes = MESES[Number(m) - 1] ?? ''
  return `${Number(d)} ${mes}`
}

export class DayChart {
  readonly element: HTMLElement
  #points: readonly SeriesPoint[] = []
  #metric: Metric = 'cost'
  #symbol = '$'
  readonly #tooltip: HTMLElement

  constructor() {
    this.element = document.createElement('div')
    this.element.className = 'chart'
    this.#tooltip = document.createElement('div')
    this.#tooltip.className = 'chart-tip'
    this.#tooltip.hidden = true
    this.element.appendChild(this.#tooltip)

    this.element.addEventListener('pointermove', (event) => this.#hover(event))
    this.element.addEventListener('pointerleave', () => {
      this.#tooltip.hidden = true
    })
  }

  setCurrencySymbol(symbol: string): void {
    this.#symbol = symbol
  }

  setMetric(metric: Metric): void {
    this.#metric = metric
    this.draw()
  }

  setData(points: readonly SeriesPoint[]): void {
    this.#points = points
    this.draw()
  }

  #value(p: SeriesPoint): number {
    return this.#metric === 'cost' ? p.costUsd : p.totalTokens
  }

  #format(value: number): string {
    return this.#metric === 'cost'
      ? formatCost(value, this.#symbol)
      : `${formatTokens(value)} tok`
  }

  draw(): void {
    // `getBoundingClientRect` en vez de `clientWidth`: da la medida fraccionaria
    // real y evita dibujar un SVG más alto que su caja.
    const box = this.element.getBoundingClientRect()
    const width = Math.max(320, Math.floor(box.width))
    const height = Math.max(140, Math.floor(box.height))
    const points = this.#points

    const old = this.element.querySelector('svg')
    if (old !== null) old.remove()

    if (points.length === 0) {
      this.element.dataset['empty'] = 'true'
      return
    }
    this.element.dataset['empty'] = 'false'

    const plotW = width - PAD.left - PAD.right
    const plotH = height - PAD.top - PAD.bottom
    const max = niceCeil(Math.max(...points.map((p) => this.#value(p))))
    const step = plotW / points.length
    const barW = Math.max(1, step - GAP)

    // Cuatro líneas de referencia; el eje siempre arranca en cero.
    const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => ({
      y: PAD.top + plotH * (1 - f),
      label: this.#format(max * f)
    }))

    const bars = points
      .map((p, i) => {
        const v = this.#value(p)
        const h = max === 0 ? 0 : (v / max) * plotH
        const x = PAD.left + i * step + GAP / 2
        const y = PAD.top + plotH - h
        return (
          `<rect class="bar" x="${x.toFixed(1)}" y="${y.toFixed(1)}" ` +
          `width="${barW.toFixed(1)}" height="${Math.max(0, h).toFixed(1)}" rx="1.5" ` +
          `data-i="${i}"/>`
        )
      })
      .join('')

    // Como mucho ~8 etiquetas en el eje X: con 30 días no caben todas.
    const every = Math.max(1, Math.ceil(points.length / 8))
    const xLabels = points
      .map((p, i) =>
        i % every === 0
          ? `<text class="axis-x" x="${(PAD.left + i * step + step / 2).toFixed(1)}" ` +
            `y="${height - 8}">${shortDay(p.day)}</text>`
          : ''
      )
      .join('')

    const svg =
      `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" ` +
      `role="img" aria-label="Consumo por día">` +
      ticks
        .map(
          (t) =>
            `<line class="grid" x1="${PAD.left}" y1="${t.y.toFixed(1)}" ` +
            `x2="${width - PAD.right}" y2="${t.y.toFixed(1)}"/>` +
            `<text class="axis-y" x="${PAD.left - 8}" y="${(t.y + 3.5).toFixed(1)}">${t.label}</text>`
        )
        .join('') +
      bars +
      xLabels +
      `</svg>`

    this.element.insertAdjacentHTML('afterbegin', svg)
  }

  #hover(event: PointerEvent): void {
    const points = this.#points
    if (points.length === 0) return
    const rect = this.element.getBoundingClientRect()
    const x = event.clientX - rect.left
    const plotW = rect.width - PAD.left - PAD.right
    const i = Math.floor(((x - PAD.left) / plotW) * points.length)
    const point = points[i]
    if (point === undefined || x < PAD.left || x > rect.width - PAD.right) {
      this.#tooltip.hidden = true
      return
    }
    this.#tooltip.hidden = false
    this.#tooltip.textContent = `${shortDay(point.day)} · ${this.#format(this.#value(point))}`
    const left = Math.min(Math.max(x - 60, 4), rect.width - 124)
    this.#tooltip.style.left = `${left}px`
  }
}
