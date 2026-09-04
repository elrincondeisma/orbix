/**
 * miniClaudio — contrato IPC: nombres de canal y firmas.
 *
 * Fuente de verdad: `docs/design/01-arquitectura.md` §3. Los nombres son literales y
 * **no se inventan canales nuevos sin actualizar ese documento**.
 *
 * Reglas:
 *  - Renderer → main: siempre `ipcRenderer.invoke`. Nunca `send` síncrono.
 *  - Main → renderer: `webContents.send`, expuesto en preload como `on…(cb): () => void`.
 *  - Toda respuesta de `invoke` es `IpcResult<T>`: jamás una excepción cruda al renderer.
 *
 * REGLA DURA: sin imports de `node:*` ni de `electron`.
 */

import type { PetCommand, PetState } from './pet'
import type {
  AppInfo,
  AppNotice,
  Breakdown,
  Corner,
  HookStatus,
  IngestStatus,
  IpcResult,
  LimitsView,
  ModelPrice,
  ModelPriceInput,
  PeriodKey,
  PetVisualPrefs,
  PlanInfo,
  Prefs,
  Series,
  StatsSnapshot
} from './types'

// ---------------------------------------------------------------------------
// Canales `invoke` (renderer → main)
// ---------------------------------------------------------------------------

/**
 * Mapa canal → { request, response }. `response` es lo que viaja dentro de
 * `IpcResult<T>`, no el `IpcResult` completo.
 */
export interface IpcInvokeMap {
  'stats:getSnapshot': { request: void; response: StatsSnapshot }
  'stats:getBreakdown': {
    request: { by: 'project' | 'model'; period: PeriodKey; limit?: number }
    response: Breakdown
  }
  /**
   * Serie diaria del TOTAL. La respuesta trae `Series.by = null` siempre.
   *
   * ⚠️ BUG-3. El contrato admitía `by?: 'project' | 'model'` pero nadie lo implementaba:
   * la consulta devolvía el total pasara lo que pasara. Se ha quitado del tipo en vez de
   * dejar un parámetro que se traga y se ignora; el handler rechaza con `BAD_INPUT`
   * cualquier `by` que no sea `null`. El desglose por serie es F2 y, cuando llegue,
   * habrá que ampliar `Queries.series()` (database-dev) y volver a añadirlo aquí.
   */
  'stats:getSeries': {
    request: { period: PeriodKey; groupBy: 'day'; by?: null }
    response: Series
  }

  'limits:get': { request: void; response: LimitsView }
  'limits:refreshLive': { request: void; response: LimitsView }

  'plan:get': { request: void; response: PlanInfo }

  'prefs:get': { request: void; response: Prefs }
  'prefs:set': { request: Partial<Prefs>; response: Prefs }

  'hook:getStatus': { request: void; response: HookStatus }
  'hook:install': { request: void; response: HookStatus }
  'hook:uninstall': { request: void; response: HookStatus }

  'ingest:getStatus': { request: void; response: IngestStatus }
  'ingest:runNow': { request: { full?: boolean }; response: IngestStatus }

  'prices:list': { request: void; response: ModelPrice[] }
  'prices:upsert': { request: ModelPriceInput; response: { affectedDays: number } }

  'levelB:setEnabled': {
    request: { enabled: boolean }
    response: { enabled: boolean; verified: boolean }
  }

  'pet:setCorner': { request: { corner: Corner; displayId?: number }; response: Prefs }
  'pet:setInteractive': { request: { interactive: boolean }; response: void }
  'pet:activate': { request: void; response: void }
  /** Solo en `devMode`: fuerza un estado para probar la mascota. */
  'pet:poke': { request: { state: PetState; bubble?: string }; response: void }

  'sound:mute': { request: { minutes: number | null }; response: Prefs }

  'window:open': { request: { target: 'stats' | 'prefs' }; response: void }
  'window:closeSelf': { request: void; response: void }

  'app:quit': { request: void; response: void }
  'app:getInfo': { request: void; response: AppInfo }
}

export type InvokeChannel = keyof IpcInvokeMap
export type InvokeRequest<C extends InvokeChannel> = IpcInvokeMap[C]['request']
export type InvokeResponse<C extends InvokeChannel> = IpcInvokeMap[C]['response']

/** Lista cerrada de canales `invoke`. `main` rechaza cualquier cosa fuera de aquí. */
export const INVOKE_CHANNELS: readonly InvokeChannel[] = Object.freeze([
  'stats:getSnapshot',
  'stats:getBreakdown',
  'stats:getSeries',
  'limits:get',
  'limits:refreshLive',
  'plan:get',
  'prefs:get',
  'prefs:set',
  'hook:getStatus',
  'hook:install',
  'hook:uninstall',
  'ingest:getStatus',
  'ingest:runNow',
  'prices:list',
  'prices:upsert',
  'levelB:setEnabled',
  'pet:setCorner',
  'pet:setInteractive',
  'pet:activate',
  'pet:poke',
  'sound:mute',
  'window:open',
  'window:closeSelf',
  'app:quit',
  'app:getInfo'
] as const)

// ---------------------------------------------------------------------------
// Canales `push` (main → renderer)
// ---------------------------------------------------------------------------

export interface IpcPushMap {
  'pet:command': PetCommand
  'pet:prefs': PetVisualPrefs
  'stats:updated': { reason: 'ingest' | 'prices' | 'manual'; snapshot: StatsSnapshot }
  'limits:updated': LimitsView
  'ingest:progress': IngestStatus
  'prefs:changed': Prefs
  'app:notice': AppNotice
}

export type PushChannel = keyof IpcPushMap
export type PushPayload<C extends PushChannel> = IpcPushMap[C]

export const PUSH_CHANNELS: readonly PushChannel[] = Object.freeze([
  'pet:command',
  'pet:prefs',
  'stats:updated',
  'limits:updated',
  'ingest:progress',
  'prefs:changed',
  'app:notice'
] as const)

// ---------------------------------------------------------------------------
// API expuesta por `preload` vía contextBridge
// ---------------------------------------------------------------------------

/** Puente genérico y tipado. Lo implementa `src/preload/common.ts`. */
export interface MiniClaudioBridge {
  invoke<C extends InvokeChannel>(
    channel: C,
    request: InvokeRequest<C>
  ): Promise<IpcResult<InvokeResponse<C>>>
  /** Devuelve la función de baja. */
  on<C extends PushChannel>(channel: C, cb: (payload: PushPayload<C>) => void): () => void
}

/** Firma de un manejador de `invoke` en `main`. */
export type InvokeHandler<C extends InvokeChannel> = (
  request: InvokeRequest<C>
) => InvokeResponse<C> | Promise<InvokeResponse<C>>

export type InvokeHandlers = { [C in InvokeChannel]?: InvokeHandler<C> }

// ---------------------------------------------------------------------------
// Helpers de resultado (usables desde main y desde los renderers)
// ---------------------------------------------------------------------------

export function ipcOk<T>(data: T): IpcResult<T> {
  return { ok: true, data }
}

export function ipcFail<T>(
  code: import('./types').IpcErrorCode,
  message: string,
  detail?: string
): IpcResult<T> {
  return detail === undefined
    ? { ok: false, error: { code, message } }
    : { ok: false, error: { code, message, detail } }
}

/** Desenvuelve un `IpcResult` lanzando si vino en error. Comodidad para los renderers. */
export function unwrap<T>(result: IpcResult<T>): T {
  if (result.ok) return result.data
  throw new Error(`[${result.error.code}] ${result.error.message}`)
}
