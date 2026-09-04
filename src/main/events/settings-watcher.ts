/**
 * Orbix — vigilancia de `~/.claude/settings.json`.
 *
 * Fuente de verdad: `03-contrato-eventos.md` §5.5.
 *
 * Sirve para enterarse de que alguien —otro programa, o el propio usuario editando el
 * fichero— ha quitado nuestro hook. Cuando pasa se recalcula `HookStatus` y se emite un
 * `app:notice` de nivel `warn`.
 *
 * ⚠️ **NUNCA se reinstala solo.** Escribir en el `settings.json` del usuario a sus
 * espaldas, y encima en respuesta a un cambio que ha hecho él, sería intolerable. Solo se
 * avisa; reinstalar es una acción explícita desde Preferencias.
 */

import chokidar, { type FSWatcher } from 'chokidar'

import type { HookStatus } from '@shared/types'

/** Debounce: un editor puede tocar el fichero varias veces al guardar. */
const DEBOUNCE_MS = 500

/**
 * Se vigila por SONDEO, no con fsevents.
 *
 * Medido en macOS 26: el watcher nativo sobre un fichero suelto pierde cambios de forma
 * no determinista durante los primeros cientos de milisegundos tras armarse, y a veces
 * no llega a entregar nada. Para un fichero que se toca una vez cada muchas horas, un
 * `stat` cada dos segundos es irrelevante (el ingestor ya hace 195 `stat` cada tres
 * segundos) y a cambio el aviso de «te han quitado el hook» no se pierde nunca.
 */
const POLL_INTERVAL_MS = 2000

export interface SettingsWatcherOptions {
  path: string
  /** Recalcula el estado leyendo el disco. */
  readStatus: () => HookStatus
  /** Se llama con el estado nuevo tras cada cambio ya asentado. */
  onChange: (status: HookStatus, previous: HookStatus | null) => void
  onError?: (error: unknown) => void
}

export class SettingsWatcher {
  readonly #options: SettingsWatcherOptions
  #watcher: FSWatcher | null = null
  #timer: NodeJS.Timeout | null = null
  #last: HookStatus | null = null

  constructor(options: SettingsWatcherOptions) {
    this.#options = options
  }

  /** Arranca la vigilancia y espera a que chokidar esté armado (`ready`). */
  async start(): Promise<void> {
    if (this.#watcher !== null) return
    try {
      this.#last = this.#options.readStatus()
      const watcher = chokidar.watch(this.#options.path, {
        ignoreInitial: true,
        usePolling: true,
        interval: POLL_INTERVAL_MS,
        awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 }
      })
      watcher.on('all', () => this.#schedule())
      watcher.on('error', (error) => this.#options.onError?.(error))
      this.#watcher = watcher
      await new Promise<void>((resolve) => {
        watcher.once('ready', () => resolve())
        // Red de seguridad: si `ready` no llegara, no se bloquea el arranque.
        setTimeout(resolve, 2000)
      })
    } catch (error) {
      this.#options.onError?.(error)
    }
  }

  #schedule(): void {
    if (this.#timer !== null) clearTimeout(this.#timer)
    this.#timer = setTimeout(() => {
      this.#timer = null
      try {
        const status = this.#options.readStatus()
        const previous = this.#last
        this.#last = status
        this.#options.onChange(status, previous)
      } catch (error) {
        this.#options.onError?.(error)
      }
    }, DEBOUNCE_MS)
  }

  async stop(): Promise<void> {
    if (this.#timer !== null) {
      clearTimeout(this.#timer)
      this.#timer = null
    }
    if (this.#watcher !== null) {
      await this.#watcher.close()
      this.#watcher = null
    }
  }
}

/**
 * ¿Nos han quitado el hook por detrás? Solo cuenta si ANTES estaba instalado: que el
 * usuario nunca lo haya instalado no es una desinstalación.
 */
export function detectRemoval(status: HookStatus, previous: HookStatus | null): string[] {
  if (previous === null || !previous.installed) return []
  return previous.events.filter((event) => !status.events.includes(event))
}
