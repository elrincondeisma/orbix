/**
 * miniClaudio — manejadores de los canales `invoke` (renderer → main).
 *
 * Fuente de verdad: `01-arquitectura.md` §3.2.
 *
 * Reglas duras:
 *  - **Nunca se lanza una excepción cruda al renderer.** Todo sale como `IpcResult`.
 *  - **Nada de lo que llega se confía.** Cada petición se valida aquí; el renderer podría
 *    estar comprometido y el preload solo filtra el nombre del canal, no el contenido.
 *  - La lógica de negocio no vive aquí: esto es cableado entre el contrato IPC y los
 *    servicios (`Queries`, `ClaudeService`, `PrefsStore`, `Ingestor`, máquina de estados).
 */

import { BrowserWindow, app, ipcMain, type IpcMainInvokeEvent, type Rectangle } from 'electron'

import { PERIOD_KEYS, CORNERS } from '@shared/constants'
import {
  INVOKE_CHANNELS,
  ipcFail,
  ipcOk,
  type InvokeChannel,
  type InvokeRequest,
  type InvokeResponse
} from '@shared/ipc'
import { isPetState } from '@shared/pet'
import type {
  AppInfo,
  Corner,
  IngestStatus,
  IpcResult,
  ModelPriceInput,
  PeriodKey,
  Prefs,
  StatsSnapshot
} from '@shared/types'

import { HookWriteError } from '../events/hook-installer'
import type { EventSubsystem } from '../events'
import type { ClaudeService } from '../claude/service'
import type { DataLayer } from '../db'
import { dbStats } from '../db/retention'
import { listPrices, upsertPrice } from '../db/prices'
import { recomputeDirtyDays } from '../db/rollups'
import type { Ingestor } from '../ingest/ingestor'
import { getLaunchAtLogin, isLaunchAtLoginAvailable, setLaunchAtLogin } from '../login-item'
import type { PrefsStore } from '../prefs/store'
import type { MenubarWindow } from '../windows/menubar'
import type { PetWindow } from '../windows/pet'
import type { PrefsWindow } from '../windows/prefs'
import type { StatsWindow } from '../windows/stats'
import type { PushBus } from './push'

export interface IpcContext {
  data: DataLayer
  ingestor: Ingestor
  claude: ClaudeService
  prefs: PrefsStore
  events: EventSubsystem
  push: PushBus
  windows: {
    pet: PetWindow
    menubar: MenubarWindow
    stats: StatsWindow
    prefs: PrefsWindow
  }
  /** Posición del icono del Tray, para anclar el popover. */
  trayBounds: () => Rectangle
  snapshot: () => StatsSnapshot
  ingestStatus: () => IngestStatus
  /** Aplica preferencias nuevas al resto de la app (ventanas, tray, ingestor). */
  applyPrefs: (prefs: Prefs) => void
  quit: () => void
  onError: (error: unknown) => void
}

// ---------------------------------------------------------------------------
// Validación de entrada
// ---------------------------------------------------------------------------

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function asPeriod(value: unknown): PeriodKey | null {
  return typeof value === 'string' && (PERIOD_KEYS as readonly string[]).includes(value)
    ? (value as PeriodKey)
    : null
}

function asPositiveInt(value: unknown, fallback: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback
  return Math.min(max, Math.trunc(value))
}

function asPrice(value: unknown): ModelPriceInput | null {
  const o = asObject(value)
  const key = o['modelKey']
  if (typeof key !== 'string' || key.trim().length === 0 || key.length > 128) return null
  const rate = (name: string): number | null => {
    const n = o[name]
    // Un precio negativo o absurdo produciría costes negativos en todo el histórico.
    return typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 10_000 ? n : null
  }
  const input = rate('inputPerMtok')
  const output = rate('outputPerMtok')
  const cw5m = rate('cacheWrite5mPerMtok')
  const cw1h = rate('cacheWrite1hPerMtok')
  const cread = rate('cacheReadPerMtok')
  if (input === null || output === null || cw5m === null || cw1h === null || cread === null) {
    return null
  }
  const validFromRaw = o['validFrom']
  const validFrom =
    typeof validFromRaw === 'string' && !Number.isNaN(Date.parse(validFromRaw))
      ? new Date(validFromRaw).toISOString()
      : '2000-01-01T00:00:00Z'
  const note = o['note']
  return {
    modelKey: key.trim(),
    inputPerMtok: input,
    outputPerMtok: output,
    cacheWrite5mPerMtok: cw5m,
    cacheWrite1hPerMtok: cw1h,
    cacheReadPerMtok: cread,
    validFrom,
    note: typeof note === 'string' ? note.slice(0, 500) : null
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ---------------------------------------------------------------------------
// Registro
// ---------------------------------------------------------------------------

type Handler<C extends InvokeChannel> = (
  request: InvokeRequest<C>,
  event: IpcMainInvokeEvent
) => InvokeResponse<C> | Promise<InvokeResponse<C>>

/**
 * Registra los 25 canales. Devuelve la función de baja, que `before-quit` invoca para
 * que un reinicio en caliente (HMR de `electron-vite dev`) no duplique manejadores.
 */
export function registerIpcHandlers(ctx: IpcContext): () => void {
  const { data, claude, prefs, ingestor, events, push, windows } = ctx

  /** Error de validación: se devuelve como `BAD_INPUT`, no como excepción. */
  class BadInput extends Error {}
  function bad(text: string): never {
    throw new BadInput(text)
  }

  /**
   * Envuelve un manejador: ejecuta, captura y traduce a `IpcResult`.
   * `BadInput` → `BAD_INPUT`, `HookWriteError` → `HOOK_WRITE_FAILED`, resto → `INTERNAL`.
   */
  function onCh<C extends InvokeChannel>(channel: C, handler: Handler<C>): void {
    ipcMain.handle(channel, async (event, request: unknown): Promise<IpcResult<unknown>> => {
      try {
        return ipcOk(await handler(request as InvokeRequest<C>, event))
      } catch (error) {
        if (error instanceof BadInput) return ipcFail('BAD_INPUT', error.message)
        if (error instanceof HookWriteError) {
          return ipcFail('HOOK_WRITE_FAILED', error.message, error.detail)
        }
        ctx.onError(error)
        return ipcFail('INTERNAL', message(error))
      }
    })
  }

  // --- Estadísticas ---------------------------------------------------------

  onCh('stats:getSnapshot', () => ctx.snapshot())

  onCh('stats:getBreakdown', (request) => {
    const o = asObject(request)
    const by = o['by'] === 'model' ? 'model' : o['by'] === 'project' ? 'project' : null
    if (by === null) bad('`by` debe ser "project" o "model"')
    const period = asPeriod(o['period'])
    if (period === null) bad('`period` no es un periodo válido')
    return data.queries.breakdown(by, period, asPositiveInt(o['limit'], 10, 100))
  })

  onCh('stats:getSeries', (request) => {
    const o = asObject(request)
    const period = asPeriod(o['period'])
    if (period === null) bad('`period` no es un periodo válido')
    if (o['groupBy'] !== 'day') bad('`groupBy` solo admite "day"')
    // BUG-3: antes se aceptaba `by` y se ignoraba en silencio. Ahora o no viene, o viene
    // `null` (que es justo lo que devolvemos), o se rechaza: nada de tragarse un
    // parámetro y responder otra cosa.
    const by = o['by']
    if (by !== undefined && by !== null) {
      bad('`by` no está soportado en stats:getSeries: la serie es siempre del total (F2)')
    }
    return data.queries.series(period)
  })

  // --- Límites y plan -------------------------------------------------------

  onCh('limits:get', () => claude.limits)
  onCh('limits:refreshLive', () => claude.refreshLive())
  onCh('plan:get', () => claude.plan)

  // --- Preferencias ---------------------------------------------------------

  // `launchAtLogin` NO se sirve desde `prefs.json`: se lee del sistema en cada consulta,
  // porque el usuario puede quitarlo desde Ajustes del Sistema sin que nos enteremos.
  const withRealLoginItem = (value: Prefs): Prefs => ({
    ...value,
    launchAtLogin: getLaunchAtLogin()
  })

  onCh('prefs:get', () => withRealLoginItem(prefs.get()))

  onCh('prefs:set', async (request) => {
    const before = prefs.get()
    const patch = { ...asObject(request) }

    // El arranque automático se aplica al sistema y se RELEE: se guarda lo que macOS ha
    // aceptado, no lo que se pidió. Si lo rechaza, el interruptor de Preferencias vuelve
    // solo a su sitio en vez de mentir.
    if ('launchAtLogin' in patch) {
      patch['launchAtLogin'] = setLaunchAtLogin(patch['launchAtLogin'] === true)
    }

    const next = withRealLoginItem(prefs.set(patch))
    ctx.applyPrefs(next)

    // «Estados detallados de herramientas» se traduce literalmente en dos entradas de
    // `settings.json` (PreToolUse/PostToolUse). Si el usuario cambia la preferencia y YA
    // tenía los hooks puestos, se reaplica la instalación para que el interruptor haga
    // algo de verdad. Si nunca los instaló, no se le escribe nada a sus espaldas.
    if (before.detailedToolStates !== next.detailedToolStates && events.status().installed) {
      const port = events.server.port
      await events.installer.install(
        { port, listening: events.server.listening },
        next.detailedToolStates,
        port ?? undefined
      )
    }
    return next
  })

  onCh('sound:mute', (request) => {
    const o = asObject(request)
    const minutes = o['minutes']
    if (minutes !== null && typeof minutes !== 'number') bad('`minutes` debe ser número o null')
    const next = prefs.mute(minutes as number | null)
    ctx.applyPrefs(next)
    return next
  })

  // --- Hooks ----------------------------------------------------------------

  onCh('hook:getStatus', () => events.status())

  onCh('hook:install', async () => {
    const port = events.server.port
    const status = await events.installer.install(
      { port, listening: events.server.listening },
      prefs.get().detailedToolStates,
      port ?? undefined
    )
    push.notice('info', 'HOOK_INSTALLED', 'Hooks instalados. Se aplican en la próxima sesión de Claude Code.')
    return status
  })

  onCh('hook:uninstall', async () => {
    const status = await events.installer.uninstall({
      port: events.server.port,
      listening: events.server.listening
    })
    push.notice('info', 'HOOK_UNINSTALLED', 'Hooks retirados de settings.json.')
    return status
  })

  // --- Ingesta --------------------------------------------------------------

  onCh('ingest:getStatus', () => ctx.ingestStatus())

  onCh('ingest:runNow', async (request) => {
    const full = asObject(request)['full'] === true
    await ingestor.runOnce({ backfill: full, full })
    const status = ctx.ingestStatus()
    push.statsUpdated('manual', ctx.snapshot)
    return status
  })

  // --- Precios (F2) ---------------------------------------------------------

  onCh('prices:list', () => listPrices(data.db))

  onCh('prices:upsert', (request) => {
    const price = asPrice(request)
    if (price === null) bad('Tarifa incompleta o fuera de rango')
    const result = upsertPrice(data.db, { ...price, source: 'user' })
    // Recalcular deja el histórico coherente con la tarifa nueva.
    data.prices.reload()
    let pending = 0
    do {
      pending = recomputeDirtyDays(data.db, data.prices, { limit: 100 })
    } while (pending > 0)
    push.statsUpdated('prices', ctx.snapshot)
    return { affectedDays: result.affectedDays }
  })

  // --- Nivel B --------------------------------------------------------------

  onCh('levelB:setEnabled', async (request) => {
    const enabled = asObject(request)['enabled'] === true
    const result = await claude.setLevelBEnabled(enabled)
    prefs.set({ levelBEnabled: enabled })
    return result
  })

  // --- Mascota --------------------------------------------------------------

  onCh('pet:setCorner', (request) => {
    const o = asObject(request)
    const corner = o['corner']
    if (typeof corner !== 'string' || !(CORNERS as readonly string[]).includes(corner)) {
      bad('`corner` no es una esquina válida')
    }
    const displayId = o['displayId']
    const patch: Partial<Prefs> = { corner: corner as Corner }
    if (typeof displayId === 'number' && Number.isFinite(displayId)) {
      patch.displayId = Math.trunc(displayId)
    }
    const next = prefs.set(patch)
    ctx.applyPrefs(next)
    return next
  })

  onCh('pet:setInteractive', (request) => {
    const interactive = asObject(request)['interactive'] === true
    // Solo tiene sentido con el clic pasante desactivado (04-frontal.md §3.5).
    if (!prefs.get().clickThrough) windows.pet.setInteractive(interactive)
    return undefined
  })

  onCh('pet:activate', () => {
    windows.menubar.toggle(ctx.trayBounds())
    return undefined
  })

  onCh('pet:poke', (request) => {
    // Canal de desarrollo: fuera de `devMode` no existe.
    if (!prefs.get().devMode) bad('pet:poke solo está disponible en modo desarrollo')
    const o = asObject(request)
    if (!isPetState(o['state'])) bad('`state` no es un PetState válido')
    const bubble = o['bubble']
    events.machine.poke(
      o['state'],
      typeof bubble === 'string' && bubble.length > 0 ? bubble.slice(0, 200) : undefined
    )
    return undefined
  })

  // --- Ventanas y app -------------------------------------------------------

  onCh('window:open', (request) => {
    const target = asObject(request)['target']
    if (target === 'stats') windows.stats.open()
    else if (target === 'prefs') windows.prefs.open()
    else bad('`target` debe ser "stats" o "prefs"')
    windows.menubar.hide()
    return undefined
  })

  onCh('window:closeSelf', (_request, event) => {
    BrowserWindow.fromWebContents(event.sender)?.close()
    return undefined
  })

  onCh('app:quit', () => {
    ctx.quit()
    return undefined
  })

  onCh('app:getInfo', () => {
    const stats = dbStats(data.db)
    const info: AppInfo = {
      version: app.getVersion(),
      electron: process.versions['electron'] ?? '',
      node: process.versions.node,
      dbPath: data.db.name,
      dbSizeBytes: stats.sizeBytes,
      schemaVersion: data.schemaVersion,
      platform: process.platform,
      arch: process.arch,
      launchAtLoginAvailable: isLaunchAtLoginAvailable()
    }
    return info
  })

  return () => {
    for (const channel of INVOKE_CHANNELS) ipcMain.removeHandler(channel)
  }
}
