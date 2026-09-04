/**
 * Orbix — superficie IPC del popover del menubar.
 *
 * Espejo en tiempo de compilación de la lista blanca de `src/preload/menubar.ts`.
 *
 * Cuando el puente no existe (renderer servido por `vite` sin `main`), se cae a los
 * fixtures de `tests/fixtures/ipc/` para poder maquetar contra datos reales. Ese
 * camino solo se activa en desarrollo (renderer servido por HTTP).
 */

import { unwrap } from '@shared/ipc'
import type {
  Breakdown,
  IngestStatus,
  LimitsView,
  PeriodKey,
  Prefs,
  StatsSnapshot
} from '@shared/types'

/** En producción el renderer se carga con `file://`; en `dev`, con `http://`. */
const IS_DEV = location.protocol.startsWith('http')

function bridge(): NonNullable<Window['Orbix']> | null {
  return window.Orbix ?? null
}

export function hasBridge(): boolean {
  return bridge() !== null
}

async function mock(): Promise<typeof import('./mock')> {
  return import('./mock')
}

export async function getSnapshot(): Promise<StatsSnapshot> {
  const b = bridge()
  if (b === null) {
    if (!IS_DEV) throw new Error('Puente IPC no disponible')
    return (await mock()).snapshot()
  }
  return unwrap(await b.invoke('stats:getSnapshot', undefined))
}

export async function getLimits(): Promise<LimitsView> {
  const b = bridge()
  if (b === null) {
    if (!IS_DEV) throw new Error('Puente IPC no disponible')
    return (await mock()).limits()
  }
  return unwrap(await b.invoke('limits:get', undefined))
}

export async function refreshLiveLimits(): Promise<LimitsView> {
  const b = bridge()
  if (b === null) return getLimits()
  return unwrap(await b.invoke('limits:refreshLive', undefined))
}

export async function getBreakdown(
  by: 'project' | 'model',
  period: PeriodKey
): Promise<Breakdown> {
  const b = bridge()
  if (b === null) {
    if (!IS_DEV) throw new Error('Puente IPC no disponible')
    return (await mock()).breakdown(by, period)
  }
  return unwrap(await b.invoke('stats:getBreakdown', { by, period, limit: 5 }))
}

export async function getIngestStatus(): Promise<IngestStatus> {
  const b = bridge()
  if (b === null) return (await getSnapshot()).ingest
  return unwrap(await b.invoke('ingest:getStatus', undefined))
}

export async function getPrefs(): Promise<Prefs | null> {
  const b = bridge()
  if (b === null) return null
  return unwrap(await b.invoke('prefs:get', undefined))
}

export async function mute(minutes: number | null): Promise<void> {
  await bridge()?.invoke('sound:mute', { minutes })
}

export function openWindow(target: 'stats' | 'prefs'): void {
  void bridge()?.invoke('window:open', { target })
}

export function quit(): void {
  void bridge()?.invoke('app:quit', undefined)
}

// --- Suscripciones -----------------------------------------------------------

const noop = (): void => {}

export function onStatsUpdated(cb: (snapshot: StatsSnapshot) => void): () => void {
  return bridge()?.on('stats:updated', (payload) => cb(payload.snapshot)) ?? noop
}

export function onLimitsUpdated(cb: (limits: LimitsView) => void): () => void {
  return bridge()?.on('limits:updated', cb) ?? noop
}

export function onIngestProgress(cb: (status: IngestStatus) => void): () => void {
  return bridge()?.on('ingest:progress', cb) ?? noop
}

export function onPrefsChanged(cb: (prefs: Prefs) => void): () => void {
  return bridge()?.on('prefs:changed', cb) ?? noop
}
