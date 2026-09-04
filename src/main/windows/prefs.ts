/**
 * miniClaudio — ventana de preferencias.
 * Fuente de verdad: docs/design/04-frontal.md §11.
 *
 * La ventana y su preload están listos; el formulario con pestañas queda pendiente
 * y de momento el renderer muestra un esqueleto.
 */

import { BrowserWindow } from 'electron'
import { loadRenderer, preloadPath } from './paths'

const WIDTH = 520
const HEIGHT = 620

export class PrefsWindow {
  #win: BrowserWindow | null = null

  /** La ventana viva, para que `ipc/push.ts` pueda enviarle los canales `push`. */
  get window(): BrowserWindow | null {
    return this.isOpen ? this.#win : null
  }

  get isOpen(): boolean {
    return this.#win !== null && !this.#win.isDestroyed()
  }

  open(): void {
    if (this.isOpen) {
      this.#win?.show()
      this.#win?.focus()
      return
    }

    const win = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      resizable: false,
      maximizable: false,
      fullscreenable: false,
      title: 'Preferencias — miniClaudio',
      titleBarStyle: 'hiddenInset',
      show: false,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: preloadPath('prefs'),
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
    loadRenderer(win, 'prefs')
  }

  close(): void {
    if (this.isOpen) this.#win?.close()
  }

  destroy(): void {
    if (this.isOpen) this.#win?.destroy()
    this.#win = null
  }
}
