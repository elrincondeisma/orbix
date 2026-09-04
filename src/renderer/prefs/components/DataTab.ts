/**
 * Orbix — pestaña «Datos»: plan, precios, base de datos y Nivel B.
 * Fuente de verdad: docs/design/04-frontal.md §11.
 */

import { formatAge, formatCost, pluralize } from '@shared/format'
import type { AppInfo, IngestStatus, ModelPrice, PlanInfo, Prefs } from '@shared/types'
import * as api from '../api'
import {
  button,
  buttonBar,
  fromHtml,
  infoRow,
  inputRow,
  must,
  note,
  section,
  setText,
  switchRow
} from './controls'

function bytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toLocaleString('es-ES', { maximumFractionDigits: 1 })} KB`
  return `${(n / 1024 ** 2).toLocaleString('es-ES', { maximumFractionDigits: 1 })} MB`
}

/** Una fila editable de la tabla de tarifas. */
const PRICE_ROW = `
<tr>
  <td class="model"><span></span><small></small></td>
  <td><input class="text num" type="number" step="0.01" min="0" data-k="inputPerMtok" /></td>
  <td><input class="text num" type="number" step="0.01" min="0" data-k="outputPerMtok" /></td>
  <td><input class="text num" type="number" step="0.01" min="0" data-k="cacheWrite5mPerMtok" /></td>
  <td><input class="text num" type="number" step="0.01" min="0" data-k="cacheWrite1hPerMtok" /></td>
  <td><input class="text num" type="number" step="0.001" min="0" data-k="cacheReadPerMtok" /></td>
</tr>`

export class DataTab {
  readonly element: HTMLElement

  readonly #plan = infoRow('Plan detectado')
  readonly #account = infoRow('Cuenta')
  readonly #monthly = infoRow('Precio mensual del plan')
  readonly #monthlyNote: HTMLElement
  readonly #timezone = infoRow('Zona horaria')

  readonly #dbPath = infoRow('Base de datos')
  readonly #dbSize = infoRow('Tamaño')
  readonly #schema = infoRow('Versión de esquema')
  readonly #ingest = infoRow('Última ingesta')
  readonly #ingestFiles = infoRow('Ficheros vigilados')

  readonly #levelB
  readonly #levelBNote: HTMLElement

  readonly #priceBody: HTMLElement
  readonly #priceResult: HTMLElement
  readonly #priceValidFrom
  readonly #busy: HTMLElement

  #prices: ModelPrice[] = []

  constructor() {
    this.#monthlyNote = fromHtml<HTMLElement>('<p class="note" hidden></p>')

    this.#levelB = switchRow(
      'Refrescar los límites por mi cuenta',
      'Cada 20 min, Orbix ejecuta "claude -p /usage" (el comando oficial de ' +
        'Claude Code, sin interfaz) e interpreta su respuesta. Cada refresco consume ' +
        'una petición real de tu suscripción. Si algo falla o cambia el formato del ' +
        'texto, se vuelve al dato en caché de siempre, sin avisar.',
      (v) => {
        void api.setLevelBEnabled(v).then((r) => {
          if (r.ok && !r.data.verified) this.#showLevelBUnverified()
        })
      }
    )
    this.#levelBNote = fromHtml<HTMLElement>('<p class="note note-warn"></p>')

    this.#priceValidFrom = inputRow(
      'Vigente desde',
      'Las tarifas se guardan con fecha. Al cambiar una, se recalcula el histórico ' +
        'desde ese día en adelante y las cifras anteriores no se tocan.',
      { type: 'date', width: '150px' },
      () => {}
    )

    const table = fromHtml<HTMLElement>(`
      <div class="table-wrap">
        <table class="prices">
          <thead>
            <tr>
              <th>Modelo</th><th>Entrada</th><th>Salida</th>
              <th>Caché 5 m</th><th>Caché 1 h</th><th>Lectura</th>
            </tr>
          </thead>
          <tbody></tbody>
        </table>
      </div>`)
    this.#priceBody = must(table, 'tbody')
    this.#priceResult = fromHtml<HTMLElement>('<p class="note" hidden></p>')
    this.#busy = fromHtml<HTMLElement>('<p class="note" hidden></p>')

    this.element = document.createElement('div')
    this.element.className = 'pane'
    this.element.append(
      section(
        'Plan',
        this.#plan.element,
        this.#account.element,
        this.#monthly.element,
        this.#monthlyNote,
        this.#timezone.element
      ),
      section(
        'Tarifas por modelo',
        note('Precios en dólares por millón de tokens. Al guardar se recalcula el histórico.'),
        this.#priceValidFrom.element,
        table,
        buttonBar(button('Guardar tarifas', 'primary', () => void this.#savePrices())),
        this.#priceResult
      ),
      section(
        'Límites en vivo (Nivel B)',
        this.#levelB.element,
        this.#levelBNote
      ),
      section(
        'Base de datos',
        this.#dbPath.element,
        this.#dbSize.element,
        this.#schema.element,
        this.#ingestFiles.element,
        this.#ingest.element,
        buttonBar(
          button('Reanalizar lo nuevo', 'default', () => void this.#runIngest(false)),
          button('Reanalizar todo', 'danger', () => void this.#runIngest(true))
        ),
        this.#busy,
        note(
          'El snapshot de rescate (el histórico que Claude Code ya borró) se importa solo ' +
            'la primera vez que arranca la app. No hay canal IPC para relanzarlo a mano.'
        )
      )
    )
  }

  renderPrefs(prefs: Prefs): void {
    this.#timezone.set(prefs.timezone)
    this.#levelB.set(prefs.levelBEnabled)
    // Ya no está bloqueado (2026-09-04): el punto abierto B2 —el endpoint HTTP interno—
    // sigue cerrado a propósito, pero `claude -p "/usage"` (cli-usage.ts) es un camino
    // real y soportado. `#levelBNote` queda para avisos reactivos (verificación
    // fallida): con el interruptor activado, el estado dice cada cuánto refresca.
    const minutes = Math.round(prefs.levelBIntervalMs / 60_000)
    setText(
      this.#levelBNote,
      prefs.levelBEnabled ? `Activo: se refresca cada ${pluralize(minutes, 'minuto', 'minutos')}.` : ''
    )
  }

  renderPlan(plan: PlanInfo): void {
    this.#plan.set(plan.detected ? plan.displayName : `${plan.displayName} (no detectado)`)
    this.#account.set(plan.accountEmail ?? '—')
    this.#monthly.set(plan.monthlyUsd === null ? '—' : `${formatCost(plan.monthlyUsd)}/mes`)

    /*
     * HUECO DEL CONTRATO (reportado): §11 pide poder corregir el precio mensual a
     * mano cuando el plan no se detecta, pero `Prefs` no tiene ningún campo donde
     * guardarlo ni hay canal para ello. No se inventa: se dice lo que hay.
     */
    const falta = !plan.detected || plan.monthlyUsd === null
    this.#monthlyNote.hidden = !falta
    if (falta) {
      this.#monthlyNote.className = 'note note-warn'
      setText(
        this.#monthlyNote,
        'El plan no se ha reconocido en ~/.claude.json, así que no hay precio con el que ' +
          'calcular el multiplicador. Todavía no se puede escribir a mano: falta el campo ' +
          'en las preferencias y el canal para guardarlo.'
      )
    }
  }

  renderInfo(info: AppInfo): void {
    this.#dbPath.set(info.dbPath)
    this.#dbSize.set(bytes(info.dbSizeBytes))
    this.#schema.set(`v${info.schemaVersion}`)
  }

  renderIngest(status: IngestStatus): void {
    this.#ingestFiles.set(pluralize(status.filesTracked, 'fichero', 'ficheros'))
    const age =
      status.lastRunAt === null
        ? '—'
        : formatAge((Date.now() - Date.parse(status.lastRunAt)) / 1000)
    const dur = status.lastDurationMs === null ? '' : ` · ${status.lastDurationMs} ms`
    this.#ingest.set(status.state === 'error' ? (status.lastError ?? 'error') : `${age}${dur}`)

    const running = status.state === 'backfilling' || status.state === 'scanning'
    this.#busy.hidden = !running
    if (running) {
      const pct =
        status.backfillProgress === null
          ? ''
          : ` ${Math.round(status.backfillProgress * 100)} %`
      setText(this.#busy, `Analizando…${pct}`)
    }
  }

  renderPrices(prices: ModelPrice[]): void {
    this.#prices = prices
    this.#priceBody.replaceChildren()
    for (const price of prices) {
      const row = fromHtml<HTMLElement>(PRICE_ROW)
      row.dataset['model'] = price.modelKey
      setText(must(row, '.model span'), price.modelKey)
      setText(must(row, '.model small'), `desde ${price.validFrom.slice(0, 10)} · ${price.source}`)
      for (const input of row.querySelectorAll<HTMLInputElement>('input[data-k]')) {
        const key = input.dataset['k'] as keyof ModelPrice
        input.value = String(price[key] ?? 0)
      }
      this.#priceBody.appendChild(row)
    }
    if (this.#priceValidFrom.element.querySelector<HTMLInputElement>('input')?.value === '') {
      this.#priceValidFrom.set(new Date().toISOString().slice(0, 10))
    }
  }

  // -----------------------------------------------------------------

  #showLevelBUnverified(): void {
    setText(
      this.#levelBNote,
      'No se ha podido verificar: no se encontró el ejecutable de claude en las rutas ' +
        'conocidas (~/.local/bin, /opt/homebrew/bin, /usr/local/bin…). Se sigue usando ' +
        'el dato en caché.'
    )
  }

  async #runIngest(full: boolean): Promise<void> {
    this.#busy.hidden = false
    setText(this.#busy, full ? 'Reanalizando todo el histórico…' : 'Buscando novedades…')
    const result = await api.runIngest(full)
    if (result.ok) this.renderIngest(result.data)
    else {
      this.#busy.hidden = false
      setText(this.#busy, `No se pudo reanalizar: ${result.error.message}`)
    }
  }

  async #savePrices(): Promise<void> {
    const validFromRaw =
      this.#priceValidFrom.element.querySelector<HTMLInputElement>('input')?.value ?? ''
    if (validFromRaw === '') {
      this.#priceResult.hidden = false
      this.#priceResult.className = 'note note-warn'
      setText(this.#priceResult, 'Indica desde qué día se aplican las tarifas.')
      return
    }
    const validFrom = new Date(`${validFromRaw}T00:00:00.000Z`).toISOString()

    let affected = 0
    let failed: string | null = null
    for (const row of this.#priceBody.querySelectorAll<HTMLElement>('tr')) {
      const modelKey = row.dataset['model']
      if (modelKey === undefined) continue
      const original = this.#prices.find((p) => p.modelKey === modelKey)
      if (original === undefined) continue

      const values: Record<string, number> = {}
      let changed = false
      for (const input of row.querySelectorAll<HTMLInputElement>('input[data-k]')) {
        const key = input.dataset['k']
        if (key === undefined) continue
        const value = Number(input.value)
        if (!Number.isFinite(value) || value < 0) {
          failed = `Tarifa inválida en ${modelKey}`
          break
        }
        values[key] = value
        if (value !== (original[key as keyof ModelPrice] as number)) changed = true
      }
      if (failed !== null) break
      // Una fecha nueva también es un cambio: crea un tramo de vigencia.
      if (!changed && validFrom.slice(0, 10) === original.validFrom.slice(0, 10)) continue

      const result = await api.upsertPrice({
        modelKey,
        inputPerMtok: values['inputPerMtok'] ?? 0,
        outputPerMtok: values['outputPerMtok'] ?? 0,
        cacheWrite5mPerMtok: values['cacheWrite5mPerMtok'] ?? 0,
        cacheWrite1hPerMtok: values['cacheWrite1hPerMtok'] ?? 0,
        cacheReadPerMtok: values['cacheReadPerMtok'] ?? 0,
        validFrom
      })
      if (!result.ok) {
        failed = result.error.message
        break
      }
      affected += result.data.affectedDays
    }

    this.#priceResult.hidden = false
    if (failed !== null) {
      this.#priceResult.className = 'note note-warn'
      setText(this.#priceResult, `No se guardó: ${failed}`)
      return
    }
    this.#priceResult.className = 'note note-ok'
    setText(
      this.#priceResult,
      affected === 0
        ? 'No había ningún cambio que guardar.'
        : `Tarifas guardadas. Se han recalculado ${pluralize(affected, 'día', 'días')} de histórico.`
    )
    const fresh = await api.listPrices()
    if (fresh.ok) this.renderPrices(fresh.data)
  }
}
