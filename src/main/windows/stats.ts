/**
 * miniClaudio — ventana de estadísticas.
 *
 * F2. Aquí solo está el esqueleto de la ventana (creación, tamaño mínimo, foco);
 * el contenido con gráficas se implementa en la fase 2 con `uplot`.
 */

import { BrowserWindow } from 'electron'
import { loadRenderer, preloadPath } from './paths'

const DEFAULT_WIDTH = 960
const DEFAULT_HEIGHT = 640
const MIN_WIDTH = 720
const MIN_HEIGHT = 480

export class StatsWindow {
  #win: BrowserWindow | null = null

  /** La ventana viva, para que `ipc/push.ts` pueda enviarle los canales `push`. */
  get window(): BrowserWindow | null {
    return this.isOpen ? this.#win : null
  }

  get isOpen(): boolean {
    return this.#win !== null && !this.#win.isDestroyed()
  }

  /** Abre la ventana, o la trae al frente si ya existe. */
  open(): void {
    if (this.isOpen) {
      this.#win?.show()
      this.#win?.focus()
      return
    }

    const win = new BrowserWindow({
      width: DEFAULT_WIDTH,
      height: DEFAULT_HEIGHT,
      minWidth: MIN_WIDTH,
      minHeight: MIN_HEIGHT,
      title: 'Estadísticas — miniClaudio',
      titleBarStyle: 'hiddenInset',
      show: false,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: preloadPath('stats'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false
      }
    })

    win.once('ready-to-show', () => win.show())
    win.on('closed', () => {
      this.#win = null
    })

    this.#win = win
    loadRenderer(win, 'stats')
  }

  close(): void {
    if (this.isOpen) this.#win?.close()
  }

  destroy(): void {
    if (this.isOpen) this.#win?.destroy()
    this.#win = null
  }
}
