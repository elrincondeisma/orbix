/**
 * miniClaudio — preload de la ventana de preferencias.
 *
 * El formulario de `04-frontal.md` §11 no entra en este lote de trabajo; la ventana
 * existe como esqueleto. La superficie IPC ya está declarada según §3.2.
 */

import { exposeBridge } from './common'

exposeBridge(
  [
    'prefs:get',
    'prefs:set',
    'plan:get',
    'hook:getStatus',
    'hook:install',
    'hook:uninstall',
    'ingest:getStatus',
    'ingest:runNow',
    'prices:list',
    'prices:upsert',
    'levelB:setEnabled',
    'pet:setCorner',
    'app:getInfo',
    'window:closeSelf'
  ],
  ['prefs:changed', 'ingest:progress', 'app:notice']
)
