/**
 * miniClaudio — ventana de Preferencias.
 * Fuente de verdad: docs/design/04-frontal.md §11.
 *
 * Principio de toda la ventana: el control NO es la fuente de verdad. Se manda el
 * cambio, `main` responde con las `Prefs` completas ya saneadas y entonces se
 * repinta. Si `main` recorta un valor fuera de rango, el control lo enseña
 * recortado en vez de mentir sobre lo que se ha guardado.
 */

import '../shared/tokens.css'
import './prefs.css'

import type { HookStatus, Prefs } from '@shared/types'
import * as api from './api'
import { AlertsTab } from './components/AlertsTab'
import { DataTab } from './components/DataTab'
import { GeneralTab } from './components/GeneralTab'
import { IntegrationTab } from './components/IntegrationTab'
import { PetTab } from './components/PetTab'
import { must, setText } from './components/controls'

const TABS = [
  { id: 'pet', label: 'Mascota' },
  { id: 'alerts', label: 'Avisos' },
  { id: 'integration', label: 'Integración' },
  { id: 'data', label: 'Datos' },
  { id: 'general', label: 'General' }
] as const

type TabId = (typeof TABS)[number]['id']

const tabBar = must<HTMLElement>(document, '#tabs')
const panes = must<HTMLElement>(document, '#panes')
const banner = must<HTMLElement>(document, '#banner')

// ---------------------------------------------------------------------------
// Escritura de preferencias
// ---------------------------------------------------------------------------

/** Cola de un solo hueco: dos clics seguidos no se pisan ni salen desordenados. */
let writing: Promise<void> = Promise.resolve()

function patch(part: Partial<Prefs>): void {
  writing = writing.then(async () => {
    const result = await api.setPrefs(part)
    if (result.ok) applyPrefs(result.data)
    else showBanner('warn', `No se pudo guardar: ${result.error.message}`)
  })
}

function mute(minutes: number | null): void {
  // `sound:mute` no está en la lista blanca de esta ventana; se traduce a `prefs:set`
  // con la misma semántica de `PrefsStore.mute` (null = indefinido, 0 = quitar).
  if (minutes === null) patch({ muteUntil: '2999-12-31T23:59:59.000Z' })
  else if (minutes <= 0) patch({ muteUntil: null })
  else patch({ muteUntil: new Date(Date.now() + minutes * 60_000).toISOString() })
}

// ---------------------------------------------------------------------------
// Pestañas
// ---------------------------------------------------------------------------

const pet = new PetTab(patch, (prefs) => applyPrefs(prefs))
const alerts = new AlertsTab(patch, mute)
const integration = new IntegrationTab((status) => onHookStatus(status))
const data = new DataTab()
const general = new GeneralTab(patch)

const paneOf: Record<TabId, HTMLElement> = {
  pet: pet.element,
  alerts: alerts.element,
  integration: integration.element,
  data: data.element,
  general: general.element
}

for (const tab of TABS) {
  const button = document.createElement('button')
  button.type = 'button'
  button.role = 'tab'
  button.dataset['tab'] = tab.id
  button.textContent = tab.label
  button.setAttribute('aria-selected', 'false')
  tabBar.appendChild(button)
  panes.appendChild(paneOf[tab.id])
}

let current: TabId = 'pet'

function selectTab(id: TabId): void {
  current = id
  for (const b of tabBar.querySelectorAll<HTMLElement>('[data-tab]')) {
    b.setAttribute('aria-selected', String(b.dataset['tab'] === id))
  }
  for (const tab of TABS) paneOf[tab.id].hidden = tab.id !== id
}

tabBar.addEventListener('click', (event) => {
  const id = (event.target as HTMLElement).closest<HTMLElement>('[data-tab]')?.dataset['tab']
  if (id !== undefined) selectTab(id as TabId)
})

// Flechas dentro de la barra de pestañas, como manda un `tablist`.
tabBar.addEventListener('keydown', (event) => {
  if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
  const index = TABS.findIndex((t) => t.id === current)
  const delta = event.key === 'ArrowRight' ? 1 : -1
  const next = TABS[(index + delta + TABS.length) % TABS.length]
  if (next !== undefined) {
    selectTab(next.id)
    tabBar.querySelector<HTMLElement>(`[data-tab="${next.id}"]`)?.focus()
  }
})

// ---------------------------------------------------------------------------
// Aviso superior
// ---------------------------------------------------------------------------

let bannerTimer: number | null = null

function showBanner(tone: 'info' | 'warn' | 'ok', message: string): void {
  banner.hidden = false
  banner.dataset['tone'] = tone
  setText(banner, message)
  if (bannerTimer !== null) window.clearTimeout(bannerTimer)
  bannerTimer = window.setTimeout(() => {
    banner.hidden = true
    bannerTimer = null
  }, 6000)
}

// ---------------------------------------------------------------------------
// Reparto de datos
// ---------------------------------------------------------------------------

function applyPrefs(prefs: Prefs): void {
  pet.render(prefs)
  alerts.render(prefs)
  data.renderPrefs(prefs)
  general.render(prefs)
}

let hooksSeen = false

function onHookStatus(status: HookStatus): void {
  general.setHookStatus(status)
  // La primera vez, si no hay hooks, se abre directamente donde hay que actuar:
  // sin ellos la app cuenta tokens pero la mascota no reacciona a nada.
  if (!hooksSeen) {
    hooksSeen = true
    if (!status.installed) selectTab('integration')
  }
}

async function load(): Promise<void> {
  const prefs = await api.getPrefs()
  if (prefs.ok) applyPrefs(prefs.data)
  else showBanner('warn', `No se pudieron leer las preferencias: ${prefs.error.message}`)

  await integration.refresh()

  const [plan, info, ingest, prices] = await Promise.all([
    api.getPlan(),
    api.getAppInfo(),
    api.getIngestStatus(),
    api.listPrices()
  ])
  if (plan.ok) data.renderPlan(plan.data)
  if (info.ok) {
    data.renderInfo(info.data)
    general.renderInfo(info.data)
  }
  if (ingest.ok) {
    data.renderIngest(ingest.data)
    general.setIngestStatus(ingest.data)
  }
  if (prices.ok) data.renderPrices(prices.data)
}

// `prefs:changed` llega también cuando el cambio lo hace otra ventana o el propio
// `main` (por ejemplo al vencer un silencio temporal).
api.onPrefsChanged(applyPrefs)
api.onIngestProgress((status) => {
  data.renderIngest(status)
  general.setIngestStatus(status)
})
api.onNotice((notice) => {
  const tone = notice.level === 'error' || notice.level === 'warn' ? 'warn' : 'info'
  showBanner(tone, notice.message)
})

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') api.closeSelf()
})

selectTab('pet')
void load()
