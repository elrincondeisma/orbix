/**
 * miniClaudio — panel de estadísticas (F2).
 * Fuente de verdad: docs/design/04-frontal.md §10.4 y §10.7.
 *
 * Mismo criterio que el menubar, porque es el mismo principio: un dato con
 * antigüedad se muestra con su antigüedad, y el multiplicador se marca como suelo
 * mientras haya menos de 30 días de histórico.
 *
 * Las gráficas son SVG a mano. `uplot` no está instalado y no hace falta para unas
 * barras y dos ejes.
 */

import '../shared/tokens.css'
import './stats.css'

import { formatAge, formatCost, formatMultiplier, formatTokens, pluralize } from '@shared/format'
import type { PeriodKey, StatsSnapshot } from '@shared/types'
import * as api from './api'
import { DayChart, type Metric } from './components/DayChart'
import { RankList } from './components/RankList'

const PERIODS: readonly { key: PeriodKey; label: string }[] = [
  { key: 'today', label: 'Hoy' },
  { key: '7d', label: '7 días' },
  { key: '30d', label: '30 días' },
  { key: 'mtd', label: 'Este mes' },
  { key: 'all', label: 'Todo' }
]

const must = <T extends Element>(sel: string): T => {
  const el = document.querySelector<T>(sel)
  if (el === null) throw new Error(`Falta ${sel}`)
  return el
}

const periodBar = must<HTMLElement>('#periods')
const metricBar = must<HTMLElement>('#metrics')
const kpis = must<HTMLElement>('#kpis')
const freshness = must<HTMLElement>('#freshness')
const chartHost = must<HTMLElement>('#chart')
const ranks = must<HTMLElement>('#ranks')
const errorBox = must<HTMLElement>('#error')

const chart = new DayChart()
chartHost.appendChild(chart.element)

const byProject = new RankList('Por proyecto')
const byModel = new RankList('Por modelo')
ranks.append(byProject.element, byModel.element)

let period: PeriodKey = '30d'
let metric: Metric = 'cost'
let symbol = '$'
let snapshot: StatsSnapshot | null = null

// ---------------------------------------------------------------------------
// Selectores
// ---------------------------------------------------------------------------

periodBar.innerHTML = PERIODS.map(
  (p) =>
    `<button type="button" role="radio" aria-checked="${p.key === period}" data-period="${p.key}">${p.label}</button>`
).join('')

metricBar.innerHTML = (
  [
    { key: 'cost', label: 'Coste' },
    { key: 'tokens', label: 'Tokens' }
  ] as const
)
  .map(
    (m) =>
      `<button type="button" role="radio" aria-checked="${m.key === metric}" data-metric="${m.key}">${m.label}</button>`
  )
  .join('')

periodBar.addEventListener('click', (event) => {
  const key = (event.target as HTMLElement).closest<HTMLElement>('[data-period]')?.dataset['period']
  if (key === undefined || key === period) return
  period = key as PeriodKey
  for (const b of periodBar.querySelectorAll<HTMLElement>('[data-period]')) {
    b.setAttribute('aria-checked', String(b.dataset['period'] === period))
  }
  void load()
})

metricBar.addEventListener('click', (event) => {
  const key = (event.target as HTMLElement).closest<HTMLElement>('[data-metric]')?.dataset['metric']
  if (key === undefined || key === metric) return
  metric = key as Metric
  for (const b of metricBar.querySelectorAll<HTMLElement>('[data-metric]')) {
    b.setAttribute('aria-checked', String(b.dataset['metric'] === metric))
  }
  chart.setMetric(metric)
})

// ---------------------------------------------------------------------------
// Pintado
// ---------------------------------------------------------------------------

/** El periodo elegido determina qué bloque del snapshot alimenta los KPI. */
function statsFor(s: StatsSnapshot): { costUsd: number; totalTokens: number; requests: number } {
  switch (period) {
    case 'today':
      return s.today
    case '7d':
      return s.last7d
    case 'mtd':
      return s.monthToDate
    case 'all':
      return s.allTime
    default:
      return s.last30d
  }
}

function renderKpis(s: StatsSnapshot): void {
  const p = statsFor(s)
  const m = s.multiplier

  const cards = [
    { label: 'Coste', value: formatCost(p.costUsd, symbol), sub: PERIODS.find((x) => x.key === period)?.label ?? '' },
    { label: 'Tokens', value: formatTokens(p.totalTokens), sub: pluralize(p.requests, 'petición', 'peticiones') },
    {
      label: 'Multiplicador',
      value: formatMultiplier(m.value),
      // Nada de mentiras: con menos de 30 días esto es un suelo, y se dice.
      sub: m.isFloor
        ? `suelo · ${pluralize(m.coveredDays, 'día', 'días')} de datos`
        : `sobre ${formatCost(m.planMonthlyUsd ?? 0, symbol)}/mes`,
      floor: m.isFloor
    },
    { label: 'Plan', value: s.plan.displayName, sub: s.plan.detected ? 'detectado' : 'no reconocido' }
  ]

  kpis.innerHTML = cards
    .map(
      (c) =>
        `<div class="kpi"${'floor' in c && c.floor ? ' data-floor="true"' : ''}>` +
        `<p class="kpi-label">${c.label}</p>` +
        `<p class="kpi-value">${c.value}</p>` +
        `<p class="kpi-sub">${c.sub}</p></div>`
    )
    .join('')
}

function renderFreshness(s: StatsSnapshot): void {
  const age = (Date.now() - Date.parse(s.generatedAt)) / 1000
  const ingest = s.ingest
  const parts = [
    `calculado ${formatAge(Number.isFinite(age) ? age : null)}`,
    pluralize(ingest.filesTracked, 'fichero', 'ficheros')
  ]
  if (ingest.state === 'error') parts.push('error de ingesta')
  freshness.textContent = parts.join(' · ')
  freshness.dataset['stale'] = String(age > 300)
}

// ---------------------------------------------------------------------------
// Carga
// ---------------------------------------------------------------------------

let requestId = 0

async function load(): Promise<void> {
  const id = ++requestId
  byProject.setLoading()
  byModel.setLoading()
  errorBox.hidden = true

  try {
    const [snap, series, project, model] = await Promise.all([
      api.getSnapshot(),
      api.getSeries(period),
      api.getBreakdown('project', period),
      api.getBreakdown('model', period)
    ])
    if (id !== requestId) return
    snapshot = snap
    renderKpis(snap)
    renderFreshness(snap)
    chart.setData(series.points)
    byProject.render(project)
    byModel.render(model)
  } catch (error) {
    if (id !== requestId) return
    errorBox.hidden = false
    errorBox.textContent = `No se pudieron cargar las estadísticas: ${(error as Error).message}`
  }
}

// El panel solo se refresca cuando está a la vista.
let off: (() => void) | null = null

function activate(): void {
  if (off !== null) return
  off = api.onStatsUpdated((s) => {
    snapshot = s
    renderKpis(s)
    renderFreshness(s)
  })
  void load()
}

function deactivate(): void {
  off?.()
  off = null
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') activate()
  else deactivate()
})

// La ventana es redimensionable: la gráfica se redibuja al cambiar de tamaño.
new ResizeObserver(() => chart.draw()).observe(chartHost)

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') api.closeSelf()
})

void api.getPrefs().then((prefs) => {
  if (prefs !== null) {
    symbol = prefs.currencySymbol
    chart.setCurrencySymbol(symbol)
    byProject.setCurrencySymbol(symbol)
    byModel.setCurrencySymbol(symbol)
    if (snapshot !== null) renderKpis(snapshot)
  }
})

activate()
