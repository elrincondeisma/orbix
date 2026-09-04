/**
 * Orbix — preload del panel de estadísticas.
 *
 * El panel completo es F2. En F1 solo existe el esqueleto de la ventana, pero la
 * superficie IPC ya está declarada porque no cuesta nada y evita tocar el preload
 * cuando se implemente.
 */

import { exposeBridge } from './common'

exposeBridge(
  ['stats:getSnapshot', 'stats:getBreakdown', 'stats:getSeries', 'prefs:get', 'window:closeSelf'],
  ['stats:updated', 'prefs:changed']
)
