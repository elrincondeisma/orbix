/**
 * Orbix — preload del popover del menubar.
 *
 * Espejo en el renderer: `src/renderer/menubar/api.ts`.
 */

import { exposeBridge } from './common'

exposeBridge(
  [
    'stats:getSnapshot',
    'stats:getBreakdown',
    'limits:get',
    'limits:refreshLive',
    'plan:get',
    'prefs:get',
    'prefs:set',
    'ingest:getStatus',
    'pet:setCorner',
    'sound:mute',
    'window:open',
    'app:quit'
  ],
  ['stats:updated', 'limits:updated', 'ingest:progress', 'prefs:changed', 'app:notice']
)
