/**
 * miniClaudio — composición del subsistema de eventos.
 *
 * Junta las cuatro piezas (instalador, servidor, router y máquina de estados) para que
 * `src/main/index.ts` solo tenga que llamar a `startEventSubsystem()` en el paso 9 del
 * arranque (`01-arquitectura.md` §8) y a `stop()` en `before-quit`.
 *
 * Lo que NO hace: abrir la base de datos, crear ventanas ni tocar `electron`. El sink de
 * persistencia y el emisor de `pet:command` se inyectan desde fuera.
 */

import type { AppNotice, HookStatus, Prefs } from '@shared/types'
import type { PetCommand } from '@shared/pet'

import { HookInstaller, type HookInstallerOptions } from './hook-installer'
import { EventRouter, type HookEventSink } from './router'
import { EventServer, type StartOutcome } from './server'
import { SettingsWatcher, detectRemoval } from './settings-watcher'
import { PetStateMachine } from '../pet/state-machine'

export interface EventSubsystemOptions {
  /** Versión de la app, para `GET /health`. */
  version: string
  /** Preferencias vivas: se leen en cada decisión de la máquina de estados. */
  getPrefs: () => Prefs
  /** Envío de `pet:command` al renderer de la mascota. */
  emitPetCommand: (command: PetCommand) => void
  /** Avisos no fatales para `app:notice`. */
  onNotice?: (notice: AppNotice) => void
  /** Persistencia en `hook_events`. Se puede enchufar más tarde con `setSink`. */
  sink?: HookEventSink
  /** `powerMonitor`: true si la pantalla está bloqueada. */
  isScreenLocked?: () => boolean
  onError?: (error: unknown) => void
  installer?: HookInstallerOptions
  /** Se llama cuando `settings.json` cambia por fuera y el estado de los hooks varía. */
  onHookStatusChanged?: (status: HookStatus) => void
}

export interface EventSubsystem {
  server: EventServer
  installer: HookInstaller
  router: EventRouter
  machine: PetStateMachine
  outcome: StartOutcome
  /** Estado de los hooks, recalculado contra el disco. */
  status(): HookStatus
  setSink(sink: HookEventSink | null): void
  stop(): Promise<void>
}

/**
 * Arranca el servidor y prepara los ficheros de coordinación.
 *
 * NO instala los hooks en `settings.json`: eso es una acción explícita del usuario desde
 * Preferencias (`hook:install`). Aquí solo se garantizan el directorio, el token y el
 * script, que son inocuos.
 */
export async function startEventSubsystem(
  options: EventSubsystemOptions
): Promise<EventSubsystem> {
  const installer = new HookInstaller(options.installer ?? {})

  // Directorio 0700, token 0600 y script 0755. Si falla, el servidor arranca igual: sin
  // token no se aceptará ningún evento, pero la app sigue contabilizando.
  let token: string | null = null
  try {
    token = installer.ensureRuntimeFiles().token
  } catch (error) {
    options.onError?.(error)
    options.onNotice?.({
      level: 'warn',
      code: 'HOOK_FILES_FAILED',
      message: 'No se pudieron preparar los ficheros de ~/.claude/miniclaudio.'
    })
  }

  const machine = new PetStateMachine({
    emit: options.emitPetCommand,
    getPrefs: options.getPrefs,
    ...(options.isScreenLocked ? { isScreenLocked: options.isScreenLocked } : {})
  })

  const router = new EventRouter({
    machine,
    ...(options.sink ? { sink: options.sink } : {}),
    ...(options.onError ? { onError: options.onError } : {})
  })

  const server = new EventServer({
    getToken: () => token,
    onEvent: (event) => router.handle(event),
    version: options.version,
    ...(options.onNotice ? { onNotice: options.onNotice } : {}),
    // El puerto se publica en cuanto el `listen` tiene éxito: el hook lo lee en cada
    // invocación, así que cambiar de puerto es transparente y no toca `settings.json`.
    onPort: (port) => {
      try {
        installer.writePort(port)
      } catch (error) {
        options.onError?.(error)
      }
    }
  })

  const outcome = await server.start()

  const status = (): HookStatus =>
    installer.getStatus({ port: server.port, listening: server.listening })

  // Vigilancia de `settings.json`: si alguien nos quita el hook, se avisa. NUNCA se
  // reinstala solo (03-contrato-eventos.md §5.5).
  const settingsWatcher = new SettingsWatcher({
    path: installer.settingsPath,
    readStatus: status,
    onChange: (next, previous) => {
      const removed = detectRemoval(next, previous)
      if (removed.length > 0) {
        options.onNotice?.({
          level: 'warn',
          code: 'HOOK_REMOVED',
          message:
            `Alguien ha quitado el hook de miniClaudio de ${removed.join(', ')}. ` +
            'La mascota dejará de reaccionar a esos eventos; puedes reinstalarlo en Preferencias.'
        })
      }
      options.onHookStatusChanged?.(next)
    },
    ...(options.onError ? { onError: options.onError } : {})
  })
  await settingsWatcher.start()

  return {
    server,
    installer,
    router,
    machine,
    outcome,
    status,
    setSink: (sink) => router.setSink(sink),
    stop: async () => {
      machine.stop()
      await settingsWatcher.stop()
      await server.stop()
    }
  }
}

export { EventRouter, EventServer, HookInstaller, SettingsWatcher }
export type { HookEventRow, HookEventSink } from './router'
export type { StartOutcome } from './server'
export type { NormalizedHookEvent } from './schema'
