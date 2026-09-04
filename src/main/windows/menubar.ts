/**
 * miniClaudio — popover del menubar.
 * Fuente de verdad: docs/design/04-frontal.md §10.2 y §10.7.
 *
 * Ancho fijo de 340 px; el alto se ajusta al contenido con un techo del 70 % del
 * área de trabajo de la pantalla del Tray. Se cierra al perder el foco, con Escape
 * y con un segundo clic en el icono.
 */

import { BrowserWindow, screen, type Rectangle } from 'electron'
import { loadRenderer, preloadPath } from './paths'

const WIDTH = 340
const MIN_HEIGHT = 240
const MAX_HEIGHT = 620
/** Separación entre la barra de menús y el borde superior del popover. */
const GAP = 6
/** Margen respecto al borde derecho de la pantalla. */
const EDGE_MARGIN = 8

export class MenubarWindow {
  #win: BrowserWindow | null = null
  #ready = false

  get window(): BrowserWindow | null {
    return this.#win
  }

  get isOpen(): boolean {
    return this.#win !== null && !this.#win.isDestroyed()
  }

  get isVisible(): boolean {
    return this.isOpen && this.#win?.isVisible() === true
  }

  /** Crea la ventana oculta. Se llama una vez al arrancar, junto con el Tray. */
  create(): void {
    if (this.isOpen) return

    const win = new BrowserWindow({
      width: WIDTH,
      height: MIN_HEIGHT,
      minWidth: WIDTH,
      maxWidth: WIDTH,
      show: false,
      frame: false,
      transparent: true,
      vibrancy: 'popover',
      visualEffectState: 'active',
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      roundedCorners: true,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: preloadPath('menubar'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false
      }
    })

    win.setAlwaysOnTop(true, 'pop-up-menu')
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

    win.on('blur', () => this.hide())
    win.on('closed', () => {
      this.#win = null
      this.#ready = false
    })

    // Escape cierra el popover. Se atrapa en `main` para no inventar un canal IPC.
    win.webContents.on('before-input-event', (_event, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape') this.hide()
    })

    win.webContents.on('did-finish-load', () => {
      this.#ready = true
    })

    this.#win = win
    loadRenderer(win, 'menubar')
  }

  /** Abre el popover bajo el icono del Tray. */
  show(trayBounds: Rectangle): void {
    if (!this.isOpen) this.create()
    const win = this.#win
    if (win === null) return

    void this.#fitHeight(trayBounds).then(() => {
      win.showInactive()
      win.focus()
    })
  }

  hide(): void {
    if (this.isVisible) this.#win?.hide()
  }

  toggle(trayBounds: Rectangle): void {
    if (this.isVisible) this.hide()
    else this.show(trayBounds)
  }

  destroy(): void {
    if (this.isOpen) this.#win?.destroy()
    this.#win = null
    this.#ready = false
  }

  // -----------------------------------------------------------------

  /**
   * Mide el contenido real y coloca la ventana. Se usa `executeJavaScript` en vez
   * de un canal nuevo: §3 del contrato IPC es cerrado y esto es una medida, no un dato.
   */
  async #fitHeight(trayBounds: Rectangle): Promise<void> {
    const win = this.#win
    if (win === null) return

    const display = screen.getDisplayNearestPoint({
      x: Math.round(trayBounds.x + trayBounds.width / 2),
      y: Math.round(trayBounds.y + trayBounds.height / 2)
    })
    const ceiling = Math.min(MAX_HEIGHT, Math.floor(display.workArea.height * 0.7))

    let height = MIN_HEIGHT
    if (this.#ready) {
      try {
        // `documentElement.scrollHeight` no sirve: el layout es `height: 100%` con
        // scroll en el cuerpo, así que siempre devolvería el alto de la ventana.
        // Se suman cabecera + contenido real del cuerpo + pie.
        const measured = (await win.webContents.executeJavaScript(
          `(() => {
             const head = document.querySelector('.mb-head')
             const body = document.querySelector('.mb-body')
             const foot = document.querySelector('.mb-foot')
             if (!head || !body || !foot) return document.documentElement.scrollHeight
             return head.offsetHeight + body.scrollHeight + foot.offsetHeight
           })()`,
          true
        )) as unknown
        if (typeof measured === 'number' && Number.isFinite(measured)) {
          height = Math.round(measured)
        }
      } catch {
        // Si la medida falla se usa el alto mínimo: el cuerpo hace scroll.
      }
    }
    height = Math.max(MIN_HEIGHT, Math.min(ceiling, height))

    const centered = Math.round(trayBounds.x + trayBounds.width / 2 - WIDTH / 2)
    const maxX = display.workArea.x + display.workArea.width - WIDTH - EDGE_MARGIN
    const x = Math.max(display.workArea.x + EDGE_MARGIN, Math.min(centered, maxX))
    const y = Math.round(trayBounds.y + trayBounds.height + GAP)

    win.setBounds({ x, y, width: WIDTH, height })
  }
}
