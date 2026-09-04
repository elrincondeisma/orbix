/**
 * Orbix — superficie IPC de la ventana de Preferencias.
 *
 * Espejo en tiempo de compilación de la lista blanca de `src/preload/prefs.ts`.
 *
 * A diferencia del menubar, aquí NO se desenvuelve el resultado a ciegas: esta
 * ventana escribe en el `settings.json` del usuario y en la base de datos, así que
 * necesita el `IpcError` completo para decir qué ha pasado y qué hacer.
 */

import type {
  AppInfo,
  HookStatus,
  IngestStatus,
  IpcResult,
  ModelPrice,
  ModelPriceInput,
  PlanInfo,
  Prefs
} from '@shared/types'

function bridge(): NonNullable<Window['Orbix']> | null {
  return window.Orbix ?? null
}

export function hasBridge(): boolean {
  return bridge() !== null
}

const noBridge = <T>(): IpcResult<T> => ({
  ok: false,
  error: { code: 'NOT_READY', message: 'La aplicación todavía no está lista' }
})

// --- Preferencias ------------------------------------------------------------

export async function getPrefs(): Promise<IpcResult<Prefs>> {
  return bridge()?.invoke('prefs:get', undefined) ?? noBridge<Prefs>()
}

export async function setPrefs(patch: Partial<Prefs>): Promise<IpcResult<Prefs>> {
  return bridge()?.invoke('prefs:set', patch) ?? noBridge<Prefs>()
}

export async function setCorner(
  corner: Prefs['corner'],
  displayId?: number
): Promise<IpcResult<Prefs>> {
  const request = displayId === undefined ? { corner } : { corner, displayId }
  return bridge()?.invoke('pet:setCorner', request) ?? noBridge<Prefs>()
}

// --- Hooks -------------------------------------------------------------------

export async function getHookStatus(): Promise<IpcResult<HookStatus>> {
  return bridge()?.invoke('hook:getStatus', undefined) ?? noBridge<HookStatus>()
}

export async function installHooks(): Promise<IpcResult<HookStatus>> {
  return bridge()?.invoke('hook:install', undefined) ?? noBridge<HookStatus>()
}

export async function uninstallHooks(): Promise<IpcResult<HookStatus>> {
  return bridge()?.invoke('hook:uninstall', undefined) ?? noBridge<HookStatus>()
}

// --- Datos -------------------------------------------------------------------

export async function getPlan(): Promise<IpcResult<PlanInfo>> {
  return bridge()?.invoke('plan:get', undefined) ?? noBridge<PlanInfo>()
}

export async function getAppInfo(): Promise<IpcResult<AppInfo>> {
  return bridge()?.invoke('app:getInfo', undefined) ?? noBridge<AppInfo>()
}

export async function getIngestStatus(): Promise<IpcResult<IngestStatus>> {
  return bridge()?.invoke('ingest:getStatus', undefined) ?? noBridge<IngestStatus>()
}

export async function runIngest(full: boolean): Promise<IpcResult<IngestStatus>> {
  return bridge()?.invoke('ingest:runNow', { full }) ?? noBridge<IngestStatus>()
}

export async function listPrices(): Promise<IpcResult<ModelPrice[]>> {
  return bridge()?.invoke('prices:list', undefined) ?? noBridge<ModelPrice[]>()
}

export async function upsertPrice(
  input: ModelPriceInput
): Promise<IpcResult<{ affectedDays: number }>> {
  return bridge()?.invoke('prices:upsert', input) ?? noBridge<{ affectedDays: number }>()
}

// --- Nivel B -----------------------------------------------------------------

export async function setLevelBEnabled(
  enabled: boolean
): Promise<IpcResult<{ enabled: boolean; verified: boolean }>> {
  return (
    bridge()?.invoke('levelB:setEnabled', { enabled }) ??
    noBridge<{ enabled: boolean; verified: boolean }>()
  )
}

// --- Ventana -----------------------------------------------------------------

export function closeSelf(): void {
  void bridge()?.invoke('window:closeSelf', undefined)
}

// --- Suscripciones -----------------------------------------------------------

const noop = (): void => {}

export function onPrefsChanged(cb: (prefs: Prefs) => void): () => void {
  return bridge()?.on('prefs:changed', cb) ?? noop
}

export function onIngestProgress(cb: (status: IngestStatus) => void): () => void {
  return bridge()?.on('ingest:progress', cb) ?? noop
}

export function onNotice(
  cb: (notice: { level: string; code: string; message: string }) => void
): () => void {
  return bridge()?.on('app:notice', cb) ?? noop
}
