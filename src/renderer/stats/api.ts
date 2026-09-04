/**
 * miniClaudio — superficie IPC del panel de estadísticas.
 *
 * Espejo en tiempo de compilación de la lista blanca de `src/preload/stats.ts`.
 */

import { unwrap } from '@shared/ipc'
import type { Breakdown, PeriodKey, Prefs, Series, StatsSnapshot } from '@shared/types'

function bridge(): NonNullable<Window['miniClaudio']> | null {
  return window.miniClaudio ?? null
}

export async function getSnapshot(): Promise<StatsSnapshot> {
  const b = bridge()
  if (b === null) throw new Error('Puente IPC no disponible')
  return unwrap(await b.invoke('stats:getSnapshot', undefined))
}

export async function getSeries(period: PeriodKey): Promise<Series> {
  const b = bridge()
  if (b === null) throw new Error('Puente IPC no disponible')
  return unwrap(await b.invoke('stats:getSeries', { period, groupBy: 'day' }))
}

export async function getBreakdown(
  by: 'project' | 'model',
  period: PeriodKey
): Promise<Breakdown> {
  const b = bridge()
  if (b === null) throw new Error('Puente IPC no disponible')
  return unwrap(await b.invoke('stats:getBreakdown', { by, period, limit: 12 }))
}

export async function getPrefs(): Promise<Prefs | null> {
  const b = bridge()
  if (b === null) return null
  return unwrap(await b.invoke('prefs:get', undefined))
}

export function closeSelf(): void {
  void bridge()?.invoke('window:closeSelf', undefined)
}

const noop = (): void => {}

export function onStatsUpdated(cb: (snapshot: StatsSnapshot) => void): () => void {
  return bridge()?.on('stats:updated', (p) => cb(p.snapshot)) ?? noop
}
