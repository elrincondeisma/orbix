/**
 * miniClaudio — popover del menubar.
 * Fuente de verdad: docs/design/04-frontal.md §10.
 *
 * Reglas de rendimiento (§9.5 y §9.6):
 *  - solo se refresca con el popover abierto; al ocultarse se da de baja de todo;
 *  - `stats:updated` llega ya coalescido desde `main`: aquí no hay debounce propio;
 *  - se actualizan los nodos de texto cambiados, nunca se reconstruye el DOM.
 */

import '../shared/tokens.css'
import './menubar.css'

import type { LimitSeverity, LimitsView, Prefs, StatsSnapshot } from '@shared/types'
import * as api from './api'
import { BreakdownCard } from './components/BreakdownCard'
import { IngestStatusView } from './components/IngestStatusView'
import { LimitsCard } from './components/LimitsCard'
import { MultiplierCard } from './components/MultiplierCard'
import { PeriodPicker } from './components/PeriodPicker'
import { PeriodsRow } from './components/PeriodsRow'
import { SessionCard } from './components/SessionCard'
import { must, setAttr, setText } from './components/dom'

/** Cada cuánto se refresca el texto relativo («hace 3 s») con el popover abierto. */
const AGE_TICK_MS = 10_000

const body = must<HTMLElement>(document, '#body')
const footStatus = must<HTMLElement>(document, '#foot-status')
const statusDot = must<HTMLElement>(document, '#status-dot')
const planName = must<HTMLElement>(document, '#plan-name')

// ---------------------------------------------------------------------------
// Composición
// ---------------------------------------------------------------------------

const ingest = new IngestStatusView(() => void load())
const session = new SessionCard(() => void load())
const periods = new PeriodsRow()
const multiplier = new MultiplierCard(() => api.openWindow('prefs'))
const limits = new LimitsCard(() => void refreshLive())

const byProject = new BreakdownCard('project', 'Por proyecto', api.getBreakdown)
const byModel = new BreakdownCard('model', 'Por modelo', api.getBreakdown)
const picker = new PeriodPicker((period) => {
  byProject.setPeriod(period)
  byModel.setPeriod(period)
})

const breakdownGroup = document.createElement('div')
breakdownGroup.className = 'mb-section mb-breakdown-group'
breakdownGroup.appendChild(picker.element)

body.append(
  ingest.banner,
  session.element,
  periods.element,
  multiplier.element,
  limits.element,
  breakdownGroup,
  byProject.element,
  byModel.element
)
footStatus.appendChild(ingest.line)

// ---------------------------------------------------------------------------
// Estado local
// ---------------------------------------------------------------------------

let currencySymbol = '$'
let ageTimer: number | null = null
let unsubscribe: (() => void)[] = []

function applyPrefs(prefs: Prefs): void {
  currencySymbol = prefs.currencySymbol
  limits.setTimezone(prefs.timezone)
  byProject.setCurrencySymbol(currencySymbol)
  byModel.setCurrencySymbol(currencySymbol)
}

function applySnapshot(snapshot: StatsSnapshot): void {
  session.render(snapshot.session, currencySymbol)
  periods.render(snapshot.today, snapshot.last7d, snapshot.last30d, currencySymbol)
  multiplier.render(snapshot.multiplier, snapshot.plan, currencySymbol)
  ingest.render(snapshot.ingest)
  setText(planName, snapshot.plan.displayName)
  planName.classList.toggle('is-unknown', !snapshot.plan.detected)
}

/** El punto de la cabecera lleva la severidad más alta de los límites activos. */
const SEVERITY_RANK: Record<LimitSeverity, number> = {
  unknown: 0,
  normal: 1,
  warning: 2,
  critical: 3
}

function applyLimits(view: LimitsView): void {
  limits.render(view)

  // Un dato de hace días no da para pintar un punto verde de «todo en orden»:
  // sin dato o muy rancio, el punto queda en gris.
  if (view.source === 'none' || view.veryStale) {
    setAttr(statusDot, 'data-severity', 'unknown')
    statusDot.title = 'Sin datos de límites actuales'
    return
  }

  const worst = view.bars
    .filter((b) => b.isActive)
    .reduce<LimitSeverity>(
      (acc, b) => (SEVERITY_RANK[b.severity] > SEVERITY_RANK[acc] ? b.severity : acc),
      'normal'
    )
  setAttr(statusDot, 'data-severity', worst)
  statusDot.title = ''
}

// ---------------------------------------------------------------------------
// Carga
// ---------------------------------------------------------------------------

async function load(): Promise<void> {
  session.setLoading()
  periods.setLoading()
  multiplier.setLoading()
  limits.setLoading()

  const prefs = await api.getPrefs().catch(() => null)
  if (prefs !== null) applyPrefs(prefs)

  const [snapshot, limitsView] = await Promise.allSettled([api.getSnapshot(), api.getLimits()])

  if (snapshot.status === 'fulfilled') {
    applySnapshot(snapshot.value)
  } else {
    session.setError()
    periods.setError('No se pudo leer el consumo')
    multiplier.setError()
  }

  if (limitsView.status === 'fulfilled') applyLimits(limitsView.value)
  else limits.setError()

  await Promise.all([byProject.refresh(), byModel.refresh()])
}

async function refreshLive(): Promise<void> {
  limits.setLoading()
  try {
    applyLimits(await api.refreshLiveLimits())
  } catch {
    // Degradación silenciosa: se vuelve a pintar lo último bueno que tengamos.
    try {
      applyLimits(await api.getLimits())
    } catch {
      limits.setError()
    }
  }
}

// ---------------------------------------------------------------------------
// Ciclo de vida: solo se trabaja con el popover a la vista (§9.5)
// ---------------------------------------------------------------------------

function activate(): void {
  if (unsubscribe.length > 0) return
  unsubscribe = [
    api.onStatsUpdated(applySnapshot),
    api.onLimitsUpdated(applyLimits),
    api.onIngestProgress((status) => ingest.render(status)),
    api.onPrefsChanged((prefs) => {
      applyPrefs(prefs)
      void load()
    })
  ]
  ageTimer = window.setInterval(() => ingest.renderAge(), AGE_TICK_MS)
  void load()
}

function deactivate(): void {
  for (const off of unsubscribe) off()
  unsubscribe = []
  if (ageTimer !== null) {
    window.clearInterval(ageTimer)
    ageTimer = null
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') activate()
  else deactivate()
})

// ---------------------------------------------------------------------------
// Acciones del pie
// ---------------------------------------------------------------------------

must<HTMLElement>(document, '.mb-actions').addEventListener('click', (event) => {
  const action = (event.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset['act']
  if (action === 'stats') api.openWindow('stats')
  else if (action === 'prefs') api.openWindow('prefs')
  else if (action === 'quit') api.quit()
})

activate()
