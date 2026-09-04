/**
 * Orbix — datos de maqueta del popover.
 *
 * SOLO desarrollo. `api.ts` carga este módulo de forma diferida y únicamente cuando
 * no hay puente IPC, de modo que en producción el chunk nunca se descarga.
 *
 * Los ficheros vienen de `tests/fixtures/ipc/` y los mantiene `database-dev` con
 * datos reales de la máquina de Ismael.
 */

import type { Breakdown, LimitsView, PeriodKey, StatsSnapshot } from '@shared/types'
import statsSnapshot from '../../../tests/fixtures/ipc/stats-snapshot.json'
import limitsFresh from '../../../tests/fixtures/ipc/limits-view-fresh.json'
import limitsVeryStale from '../../../tests/fixtures/ipc/limits-view-very-stale.json'
import breakdownProject from '../../../tests/fixtures/ipc/breakdown-project-30d.json'
import breakdownModel from '../../../tests/fixtures/ipc/breakdown-model-30d.json'

/**
 * `?limits=fresh|stale` en la URL elige el fixture, para poder ver los tres
 * tratamientos de antigüedad sin tocar código.
 */
function wants(name: string, fallback: string): string {
  return new URLSearchParams(location.search).get(name) ?? fallback
}

export function snapshot(): StatsSnapshot {
  return statsSnapshot as unknown as StatsSnapshot
}

export function limits(): LimitsView {
  const which = wants('limits', 'stale')
  const raw = which === 'fresh' ? limitsFresh : limitsVeryStale
  const view = raw as unknown as LimitsView
  if (which === 'none') {
    return { ...view, source: 'none', bars: [], fetchedAt: null, ageSeconds: null }
  }
  return view
}

export function breakdown(by: 'project' | 'model', period: PeriodKey): Breakdown {
  const raw = by === 'project' ? breakdownProject : breakdownModel
  return { ...(raw as unknown as Breakdown), period }
}
