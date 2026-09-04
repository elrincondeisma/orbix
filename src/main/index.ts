/**
 * miniClaudio — bootstrap del proceso `main`.
 *
 * Fuente de verdad: `01-arquitectura.md` §8 (arranque y ciclo de vida).
 *
 * Orden de arranque, y el orden importa:
 *   1. preferencias (se leen ANTES que la BD: no dependen de migraciones)
 *   2. capa de datos: abrir + migrar + semillas de precios y planes
 *   3. importar el snapshot de rescate la primera vez (Claude Code borra transcripts
 *      a los 30 días; sin esto el histórico empieza hace ~10 días)
 *   4. plan y límites de `~/.claude.json`
 *   5. servidor de eventos + ficheros de coordinación del hook
 *   6. Tray y ventanas
 *   7. IPC
 *   8. backfill e ingesta continua
 *   9. purga de retención
 *
 * Principios que se respetan aquí:
 *  - un solo proceso escribe en SQLite;
 *  - nada bloquea a Claude Code (el servidor responde y corta);
 *  - la app funciona degradada: sin hooks sigue contabilizando, sin `~/.claude.json`
 *    sigue mostrando coste, sin Nivel B sigue mostrando límites con su antigüedad.
 */

import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { app, powerMonitor, screen, type Rectangle } from 'electron'

import { APP_NAME } from '@shared/constants'
import { PetState, type PetCommand } from '@shared/pet'
import type { IngestStatus, Prefs, StatsSnapshot } from '@shared/types'

import { ClaudeService } from './claude/service'
import { fatal, isFatalHandled } from './fatal'
import { initDataLayer, type DataLayer } from './db'
import { getMeta } from './db/meta'
import { importSnapshotAndRecompute } from './db/snapshot-import'
import { purgeOldData } from './db/retention'
import { startEventSubsystem, type EventSubsystem } from './events'
import { describePortConflict } from './events/server'
import { SqliteHookEventSink } from './events/sink'
import { Ingestor } from './ingest/ingestor'
import { registerIpcHandlers } from './ipc/handlers'
import { PushBus } from './ipc/push'
import { logBlockSync, logSync } from './log'
import { getLaunchAtLogin } from './login-item'
import { PrefsStore, prefsPath } from './prefs/store'
import { AppTray } from './tray'
import { MenubarWindow } from './windows/menubar'
import { PetWindow, watchDisplays } from './windows/pet'
import { PrefsWindow } from './windows/prefs'
import { StatsWindow } from './windows/stats'

/** Fichero de rescate con el histórico que Claude Code ya borró. */
const SNAPSHOT_FILE = 'data/snapshot-2026-09-03.json'

/** Purga de retención: como mucho una vez al día. */
const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000

/** Tiempo máximo que se le concede al apagado antes de forzar la salida. */
const SHUTDOWN_TIMEOUT_MS = 3000

// ---------------------------------------------------------------------------
// Estado del proceso
// ---------------------------------------------------------------------------

let data: DataLayer | null = null
let ingestor: Ingestor | null = null
let claude: ClaudeService | null = null
let events: EventSubsystem | null = null
let tray: AppTray | null = null
let push: PushBus | null = null
let unregisterIpc: (() => void) | null = null
let stopWatchingDisplays: (() => void) | null = null
let ingestTimer: NodeJS.Timeout | null = null
let purgeTimer: NodeJS.Timeout | null = null
let screenLocked = false
let shuttingDown = false
/** true en cuanto `bootstrap()` termina entero. Distingue «fallo al arrancar» de
 *  «fallo con la app ya en marcha», que se tratan de forma muy distinta. */
let booted = false

/**
 * `~/Library/Application Support/miniClaudio/`. Con `MINICLAUDIO_DEV=1` se usa el sufijo
 * `-dev` para poder trastear sin ensuciar los datos buenos. Se calcula UNA vez y se fija
 * en Electron antes de que nadie más pregunte por la ruta.
 */
const USER_DATA_DIR = ((): string => {
  const base = app.getPath('userData')
  if (process.env['MINICLAUDIO_DEV'] !== '1') return base
  const dev = `${base}-dev`
  app.setPath('userData', dev)
  return dev
})()

/** La BD vive junto a las preferencias, en el mismo `userData`. */
const DB_PATH = join(USER_DATA_DIR, 'miniclaudio.db')

const prefsStore = new PrefsStore({
  file: prefsPath(USER_DATA_DIR),
  onChange: (next) => {
    push?.send('prefs:changed', next)
  },
  onError: (error) => report('prefs', error)
})

const windows = {
  pet: new PetWindow(prefsStore.get(), {
    onActivate: () => windows.menubar.toggle(trayBounds()),
    onContextMenu: () => windows.menubar.toggle(trayBounds())
  }),
  menubar: new MenubarWindow(),
  stats: new StatsWindow(),
  prefs: new PrefsWindow()
}

function report(scope: string, error: unknown): void {
  console.error(`[${scope}]`, error instanceof Error ? error.message : error)
}

// ---------------------------------------------------------------------------
// Instancia única
// ---------------------------------------------------------------------------

/**
 * Comprueba que se puede escribir en `userData` ANTES de pedir el lock de instancia
 * única. Si no se puede, Electron falla al crear su `SingletonLock`, el lock devuelve
 * `false` y la app se cerraría en silencio haciéndose pasar por «ya hay otra instancia».
 * Un fallo de permisos tiene que decirse, no disimularse.
 */
function checkUserDataWritable(dir: string): unknown {
  const probe = join(dir, '.miniclaudio-write-test')
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(probe, '')
    unlinkSync(probe)
    return null
  } catch (error) {
    return error
  }
}

const userDataProblem = checkUserDataWritable(USER_DATA_DIR)

if (userDataProblem !== null) {
  // Se espera a `ready` solo para poder pintar el diálogo, y se sale.
  app.whenReady().then(
    () => fatal(userDataProblem, DB_PATH),
    () => app.exit(1)
  )
} else if (!app.requestSingleInstanceLock()) {
  // Ya hay una miniClaudio viva con este mismo `userData`: se le pide que saque su
  // popover (evento `second-instance`) y esta copia se retira. Tampoco esto se hace en
  // silencio, por la misma razón.
  logSync(
    `[arranque] Ya hay una instancia de ${APP_NAME} en marcha: se abre su ventana y esta ` +
      'copia se cierra.'
  )
  app.quit()
} else {
  app.on('second-instance', () => {
    // El segundo intento abre el popover de la instancia que ya estaba.
    windows.menubar.show(trayBounds())
  })

  // App de barra de menús: sin icono en el Dock. En producción lo hace `LSUIElement`,
  // pero en desarrollo hay que pedirlo a mano.
  app.dock?.hide()

  // BUG-1: `.then(bootstrap, onRejected)` NO captura el rechazo de `bootstrap()`, solo
  // el de `whenReady()`. Un fallo dentro del arranque se convertía en
  // `UnhandledPromiseRejection` y la app se quedaba viva, invisible e incerrable.
  app.whenReady()
    .then(bootstrap)
    .then(() => {
      booted = true
    })
    .catch((error: unknown) => fatal(error, DB_PATH))
}

// Redes de seguridad de último recurso. Antes de arrancar, cualquier fallo es mortal:
// una app de barra de menús a medio montar es un zombi invisible. Ya en marcha, se
// registra y se avisa, pero no se mata una app que está funcionando.
process.on('uncaughtException', (error) => {
  if (booted) {
    report('excepción no capturada', error)
    push?.notice('error', 'UNCAUGHT', 'Se ha producido un error interno; revisa el registro.')
    return
  }
  fatal(error, DB_PATH, 'excepción no capturada')
})

process.on('unhandledRejection', (reason) => {
  if (booted) {
    report('promesa sin capturar', reason)
    return
  }
  fatal(reason, DB_PATH, 'promesa sin capturar')
})

// Es una app de barra de menús: cerrar las ventanas NO cierra la app.
app.on('window-all-closed', () => {
  /* intencionadamente vacío */
})

// ---------------------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------------------

async function bootstrap(): Promise<void> {
  const started = Date.now()

  // 1. Preferencias -----------------------------------------------------------
  const prefs = prefsStore.load()

  // 2. Capa de datos ----------------------------------------------------------
  const layer = initDataLayer({ path: DB_PATH, timezone: prefs.timezone })
  data = layer

  push = new PushBus(
    (target) => windows[target].window ?? null,
    (error) => report('push', error)
  )

  if (layer.migration.status === 'future-schema') {
    push.notice(
      'error',
      'DB_FUTURE_SCHEMA',
      'La base de datos es de una versión más nueva de miniClaudio: se abrió en solo lectura.'
    )
  }

  // 3. Snapshot de rescate, solo la primera vez -------------------------------
  importSnapshotOnce(layer)

  // 4. Plan y límites ---------------------------------------------------------
  claude = new ClaudeService({
    db: layer.db,
    onLimits: (view) => push?.send('limits:updated', view),
    onWeeklyPercent: (percent) => events?.machine.onWeeklyPercent(percent),
    onError: (error) => report('claude', error)
  })
  claude.refresh(false)

  // 5. Servidor de eventos ----------------------------------------------------
  events = await startEventSubsystem({
    version: app.getVersion(),
    getPrefs: () => prefsStore.get(),
    emitPetCommand: onPetCommand,
    isScreenLocked: () => screenLocked,
    sink: new SqliteHookEventSink(layer.db),
    onNotice: (notice) => push?.send('app:notice', notice),
    onError: (error) => report('events', error)
  })

  if (!events.outcome.ok && events.outcome.reason === 'other-instance') {
    // El lock de instancia única no llega hasta aquí cuando las dos copias usan
    // `userData` distintos (desarrollo junto a la instalada, por ejemplo): el lock es por
    // directorio, así que quien las distingue es la sonda del puerto.
    //
    // Salir en silencio sería un arranque que termina sin decir por qué, y eso es un bug
    // latente aunque el motivo sea legítimo. Se explica en el log, de forma síncrona
    // porque el `app.quit()` de la línea siguiente se lleva por delante lo que quede en
    // el búfer. No se abre diálogo: no es un error, y la instancia que sobra suele ser la
    // de desarrollo.
    logBlockSync(describePortConflict(events.outcome))
    app.quit()
    return
  }

  // 6. Tray y ventanas --------------------------------------------------------
  tray = new AppTray({
    onToggle: (bounds) => windows.menubar.toggle(bounds),
    onOpenStats: () => windows.stats.open(),
    onOpenPrefs: () => windows.prefs.open(),
    onMute: (minutes) => applyPrefs(prefsStore.mute(minutes)),
    onTogglePet: () => applyPrefs(prefsStore.set({ petVisible: !prefsStore.get().petVisible })),
    onQuit: () => quit()
  })
  tray.create()

  if (prefs.petVisible) windows.pet.create()
  windows.menubar.create()
  stopWatchingDisplays = watchDisplays(windows.pet)

  // 7. IPC --------------------------------------------------------------------
  ingestor = new Ingestor({
    db: layer.db,
    prices: layer.prices,
    timezone: layer.timezone,
    onProgress: (status) => push?.ingestProgress(status)
  })

  unregisterIpc = registerIpcHandlers({
    data: layer,
    ingestor,
    claude,
    prefs: prefsStore,
    events,
    push,
    windows,
    trayBounds,
    snapshot,
    ingestStatus,
    applyPrefs,
    quit,
    onError: (error) => report('ipc', error)
  })

  // La mascota ya puede recibir eventos: el servidor deja de responder 503.
  events.server.setReady(true)
  events.machine.boot()

  // El sistema manda sobre `prefs.json`: si el usuario quitó el elemento de inicio por
  // fuera, el valor guardado se corrige en silencio al arrancar.
  const realLoginItem = getLaunchAtLogin()
  if (realLoginItem !== prefs.launchAtLogin) prefsStore.set({ launchAtLogin: realLoginItem })

  applyPrefs(prefsStore.get())
  push.send('limits:updated', claude.limits)

  // 8. Ingesta ----------------------------------------------------------------
  await startIngestion(layer)

  // 9. Vigilancia y mantenimiento --------------------------------------------
  await claude.startWatching()
  schedulePurge(layer)
  wirePowerMonitor()

  console.log(
    `[main] listo en ${Date.now() - started} ms · puerto ${String(events.server.port)} · ` +
      `esquema v${String(layer.schemaVersion)}`
  )
}

// ---------------------------------------------------------------------------
// Piezas del arranque
// ---------------------------------------------------------------------------

/**
 * Importa `data/snapshot-*.json` una sola vez. Trae los rollups de los días que Claude
 * Code ya borró de `~/.claude/projects`, sin los cuales el multiplicador de 30 días
 * sería un suelo muy por debajo de la realidad.
 */
function importSnapshotOnce(layer: DataLayer): void {
  if (layer.migration.status === 'future-schema') return
  if (getMeta(layer.db, 'snapshot_imported_at') !== null) return

  const file = join(app.getAppPath(), SNAPSHOT_FILE)
  if (!existsSync(file)) return

  try {
    const result = importSnapshotAndRecompute(layer.db, file, layer.prices)
    console.log(
      `[main] snapshot importado: ${String(result.rowsWritten)} filas, ` +
        `${String(result.days)} días`
    )
  } catch (error) {
    // Que el snapshot no entre no puede impedir arrancar: se sigue con lo que haya.
    report('snapshot', error)
  }
}

/** Backfill inicial (una vez) y ciclo continuo con el watcher de `~/.claude/projects`. */
async function startIngestion(layer: DataLayer): Promise<void> {
  const ing = ingestor
  if (ing === null) return

  const isFirstRun = getMeta(layer.db, 'backfill_done') === null

  try {
    await ing.start()
  } catch (error) {
    report('ingest:watcher', error)
  }

  // La primera pasada es el backfill: emite progreso para la barra del menubar.
  void ing
    .runOnce({ backfill: isFirstRun })
    .then((result) => {
      console.log(
        `[main] ingesta inicial: ${String(result.files)} ficheros, ` +
          `${String(result.linesIngested)} líneas en ${String(result.durationMs)} ms`
      )
      push?.statsUpdated('ingest', snapshot)
    })
    .catch((error: unknown) => report('ingest', error))

  scheduleIngestLoop()
}

/** Ciclo de ingesta según `prefs.ingestIntervalMs`. Se recrea al cambiar la preferencia. */
function scheduleIngestLoop(): void {
  if (ingestTimer !== null) clearInterval(ingestTimer)
  const interval = prefsStore.get().ingestIntervalMs
  ingestTimer = setInterval(() => {
    // El silencio temporal vencido se limpia en el mismo tick, sin timer propio.
    prefsStore.clearExpiredMute()
    void ingestor
      ?.runOnce()
      .then((result) => {
        if (result.linesIngested > 0 || result.requestsTouched > 0) {
          push?.statsUpdated('ingest', snapshot)
          refreshTray()
        }
      })
      .catch((error: unknown) => report('ingest', error))
  }, interval)
}

function schedulePurge(layer: DataLayer): void {
  const run = (): void => {
    try {
      const result = purgeOldData(layer.db)
      const total = result.hookEvents + result.limitsSnapshots + result.goneFiles
      if (total > 0) console.log(`[main] purga: ${String(total)} filas retiradas`)
    } catch (error) {
      report('purga', error)
    }
  }
  run()
  purgeTimer = setInterval(run, PURGE_INTERVAL_MS)
}

/**
 * `powerMonitor`: al reanudar tras suspensión se fuerza un ciclo completo y se relee
 * `~/.claude.json`; el bloqueo de pantalla silencia los sonidos si así se ha pedido.
 */
function wirePowerMonitor(): void {
  powerMonitor.on('resume', () => {
    void ingestor?.runOnce({ full: true }).catch((error: unknown) => report('ingest', error))
    claude?.refresh()
  })
  powerMonitor.on('lock-screen', () => {
    screenLocked = true
  })
  powerMonitor.on('unlock-screen', () => {
    screenLocked = false
  })
}

// ---------------------------------------------------------------------------
// Puentes entre servicios
// ---------------------------------------------------------------------------

function ingestStatus(): IngestStatus {
  return (
    ingestor?.getStatus() ?? {
      state: 'idle',
      filesTracked: 0,
      lastRunAt: null,
      lastDurationMs: null,
      backfillProgress: null,
      linesIngestedTotal: 0,
      lastError: null
    }
  )
}

function snapshot(): StatsSnapshot {
  const layer = data
  if (layer === null) throw new Error('La capa de datos todavía no está lista')
  return layer.queries.snapshot({
    plan: claude?.plan ?? {
      tierId: null,
      organizationType: null,
      displayName: 'Plan desconocido',
      monthlyUsd: null,
      accountEmail: null,
      detected: false
    },
    ingest: ingestStatus()
  })
}

/** Posición del icono del Tray. Sin Tray, la esquina superior derecha del área útil. */
function trayBounds(): Rectangle {
  const bounds = tray?.bounds
  if (bounds && bounds.width > 0) return bounds
  const wa = screen.getPrimaryDisplay().workArea
  return { x: wa.x + wa.width - 220, y: 0, width: 24, height: Math.max(wa.y, 24) }
}

/** Cada `pet:command` va al renderer de la mascota y, si toca, al título del Tray. */
function onPetCommand(command: PetCommand): void {
  windows.pet.send(command)
  tray?.update({ needsYou: command.state === PetState.NEEDS_YOU })
}

/** Refresca el título del Tray con el coste de hoy. */
function refreshTray(): void {
  if (tray === null || data === null) return
  const prefs = prefsStore.get()
  try {
    tray.update({
      todayCostUsd: data.queries.periodStats('today').costUsd,
      showCost: prefs.showCostInMenubar,
      currencySymbol: prefs.currencySymbol,
      petVisible: prefs.petVisible,
      muted: prefs.muteUntil !== null
    })
  } catch (error) {
    report('tray', error)
  }
}

/**
 * Propaga preferencias nuevas al resto de la app. Es el único sitio donde un cambio de
 * `Prefs` se convierte en efectos: ventana de la mascota, Tray, ingestor y zona horaria.
 */
function applyPrefs(prefs: Prefs): void {
  windows.pet.applyPrefs(prefs)
  refreshTray()

  if (data !== null && data.queries.getTimezone() !== prefs.timezone) {
    // Cambiar de zona altera `day_local` de todo el histórico; el recálculo completo
    // no se hace aquí a lo bruto: se deja constancia y se recalcula en el próximo ciclo.
    data.queries.setTimezone(prefs.timezone)
    ingestor?.setTimezone(prefs.timezone)
    push?.notice(
      'warn',
      'TIMEZONE_CHANGED',
      'Has cambiado la zona horaria: los totales por día se recalcularán poco a poco.'
    )
  }

  if (ingestTimer !== null) scheduleIngestLoop()
  // OJO: el arranque automático NO se aplica aquí. Se toca solo desde `prefs:set`, que
  // además relee el estado real del sistema; hacerlo en cada `applyPrefs` reescribiría
  // los Elementos de inicio del usuario en cada cambio de cualquier preferencia.
}

// ---------------------------------------------------------------------------
// Apagado
// ---------------------------------------------------------------------------

function quit(): void {
  app.quit()
}

app.on('before-quit', (event) => {
  // Tras un error fatal se sale por `app.exit()`, que no pasa por aquí; la guarda está
  // por si alguien llamara a `quit()` en medio de la gestión del fallo.
  if (shuttingDown || isFatalHandled()) return
  shuttingDown = true
  event.preventDefault()

  // Timeout duro: si algo se atasca, se sale igualmente.
  const forced = setTimeout(() => {
    console.warn('[main] apagado forzado por timeout')
    app.exit(0)
  }, SHUTDOWN_TIMEOUT_MS)

  void shutdown()
    .catch((error: unknown) => report('apagado', error))
    .finally(() => {
      clearTimeout(forced)
      app.exit(0)
    })
})

async function shutdown(): Promise<void> {
  if (ingestTimer !== null) clearInterval(ingestTimer)
  if (purgeTimer !== null) clearInterval(purgeTimer)
  ingestTimer = null
  purgeTimer = null

  unregisterIpc?.()
  stopWatchingDisplays?.()
  push?.dispose()

  await Promise.allSettled([ingestor?.stop(), claude?.stop(), events?.stop()])

  windows.pet.destroy()
  windows.menubar.destroy()
  windows.stats.destroy()
  windows.prefs.destroy()
  tray?.destroy()

  if (data !== null) {
    try {
      // Deja el WAL consolidado: el próximo arranque abre sin trabajo pendiente.
      data.db.pragma('wal_checkpoint(TRUNCATE)')
    } catch (error) {
      report('apagado', error)
    }
    data.close()
    data = null
  }

  console.log(`[main] ${APP_NAME} cerrado limpiamente`)
}
