/**
 * Orbix — ventana de la mascota.
 * Fuente de verdad: docs/design/04-frontal.md §3.
 *
 * Transparente, sin marco, sin sombra, sin foco y por encima de todo. Por defecto
 * los clics la atraviesan: la ventana es completamente inerte.
 *
 * Nunca se guarda una posición absoluta en preferencias, solo esquina + pantalla,
 * para que un cambio de monitor no deje la mascota fuera de la vista (§3.2).
 */

import { BrowserWindow, screen, type Display, type Rectangle } from 'electron'
import type { PetCommand } from '@shared/pet'
import type { Corner, PetVisualPrefs, Prefs } from '@shared/types'
import { loadRenderer, preloadPath } from './paths'

/**
 * Tamaño lógico de la ventana a escala 1.
 *
 * DESVIACIÓN DEL DISEÑO (reportada): §3.1 fija 320×220 para una mascota de 128 px.
 * El arte definitivo (núcleo de IA) mide 160 px, así que la ventana crece para que
 * quepan el núcleo, el bocadillo de hasta tres líneas y el margen del pico.
 */
const BASE_WIDTH = 340
const BASE_HEIGHT = 270

/**
 * El núcleo mide 160 px a escala 1 (sprite.css #mc-pet). El resto de `BASE_HEIGHT`
 * (110 px: separación + bocadillo de hasta 3 líneas + pico) es el hueco del
 * bocadillo, que a partir de 2026-09-04 tiene su propia escala — `--mc-bubble-scale`
 * en sprite.css, nunca por debajo de 1× aunque el núcleo encoja — para que el texto
 * siga siendo legible con la mascota pequeña. Si el tamaño de la ventana solo
 * siguiera a `petScale`, a 0,5× la ventana medía 135 px y el bocadillo (que ya no
 * encoge con ella) se salía por arriba, cortado.
 */
const ICON_BASE = 160
const BUBBLE_ZONE_H = BASE_HEIGHT - ICON_BASE
/** Igual que `--mc-bubble-scale: max(1, var(--mc-scale))` en sprite.css. */
const BUBBLE_SCALE_FLOOR = 1

/** Margen respecto al borde del área de trabajo, en horizontal y en el borde "libre". */
const MARGIN = 16

/**
 * Margen respecto al borde pegado al Dock/barra de menús (Ismael, 2026-09-04: quiere
 * la mascota "completamente a la altura de la barra de apps", sin el hueco de antes).
 * `workArea` ya excluye el Dock y la barra de menús, así que 0 la deja justo pegada
 * a su borde, no debajo ni tapada por él.
 */
const MARGIN_DOCK_EDGE = 0

/**
 * Sondeo del cursor para seguir a la pantalla activa. Se compara solo el `id` del
 * display: NO se escucha el movimiento del ratón (§3.2).
 */
const FOLLOW_POLL_MS = 2000

/**
 * Payload de `pet:prefs`.
 *
 * DESVIACIÓN DEL CONTRATO (reportada): `01-arquitectura.md` §3.3 tipa el canal como
 * `PetVisualPrefs`, pero §3.2 de `04-frontal.md` manda también el ancla, y el
 * renderer necesita además `clickThrough` para el hit-testing de §3.5. Se envían
 * como campos extra; el renderer los lee como opcionales.
 */
export type PetPrefsPayload = PetVisualPrefs & { anchor: Corner; clickThrough: boolean }

export interface PetWindowCallbacks {
  /** Clic sobre la mascota (solo con `clickThrough === false`). */
  onActivate?: () => void
  /** Clic derecho sobre la mascota: `main` monta el menú nativo. */
  onContextMenu?: () => void
}

export class PetWindow {
  #win: BrowserWindow | null = null
  #prefs: Prefs
  #callbacks: PetWindowCallbacks
  #followTimer: NodeJS.Timeout | null = null
  #followingDisplayId: number | null = null
  /** Comandos emitidos antes de que el renderer termine de cargar. */
  #pending: PetCommand[] = []
  #ready = false

  constructor(prefs: Prefs, callbacks: PetWindowCallbacks = {}) {
    this.#prefs = prefs
    this.#callbacks = callbacks
  }

  get window(): BrowserWindow | null {
    return this.#win
  }

  get isOpen(): boolean {
    return this.#win !== null && !this.#win.isDestroyed()
  }

  create(): void {
    if (this.isOpen) return

    const { width, height } = this.#size()

    const win = new BrowserWindow({
      width,
      height,
      transparent: true,
      frame: false,
      // La sombra del sistema delataría el rectángulo de la ventana.
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false,
      skipTaskbar: true,
      acceptFirstMouse: false,
      roundedCorners: false,
      backgroundColor: '#00000000',
      show: false,
      webPreferences: {
        preload: preloadPath('pet'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        // La ventana nunca tiene foco; sin esto macOS la bajaría a 1 fps justo
        // cuando tiene que saltar.
        backgroundThrottling: false
      }
    })

    // Por encima incluso de apps a pantalla completa.
    win.setAlwaysOnTop(true, 'screen-saver')
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    win.setHiddenInMissionControl(true)
    win.setIgnoreMouseEvents(true, { forward: true })
    win.setWindowButtonVisibility?.(false)

    win.on('closed', () => {
      this.#win = null
      this.#ready = false
    })

    win.webContents.on('did-finish-load', () => {
      this.#ready = true
      this.pushPrefs()
      for (const cmd of this.#pending) this.send(cmd)
      this.#pending.length = 0
      if (this.#prefs.petVisible) win.showInactive()
    })

    // Menú contextual nativo sin canal IPC: el evento llega del propio webContents.
    win.webContents.on('context-menu', () => {
      if (!this.#prefs.clickThrough) this.#callbacks.onContextMenu?.()
    })

    this.#win = win
    loadRenderer(win, 'pet')
    this.reposition()
    this.#startFollowing()
  }

  /** Aplica preferencias nuevas: tamaño, posición, visibilidad y avisos al renderer. */
  applyPrefs(prefs: Prefs): void {
    const before = this.#prefs
    this.#prefs = prefs

    if (!prefs.petVisible) {
      this.#win?.hide()
    } else if (this.isOpen) {
      this.#win?.showInactive()
    } else {
      this.create()
      return
    }

    if (
      before.corner !== prefs.corner ||
      before.petScale !== prefs.petScale ||
      before.displayId !== prefs.displayId ||
      before.followActiveDisplay !== prefs.followActiveDisplay
    ) {
      this.reposition()
    }

    // Con clic pasante la ventana vuelve a ser inerte de inmediato.
    if (prefs.clickThrough) this.setInteractive(false)

    this.#startFollowing()
    this.pushPrefs()
  }

  send(cmd: PetCommand): void {
    if (!this.isOpen || !this.#ready) {
      this.#pending.push(cmd)
      // No se acumulan órdenes viejas: solo importan las últimas.
      if (this.#pending.length > 8) this.#pending.shift()
      return
    }
    this.#win?.webContents.send('pet:command', cmd)
  }

  /** Empuja `pet:prefs` con las preferencias visuales, el ancla y el clic pasante. */
  pushPrefs(): void {
    if (!this.isOpen || !this.#ready) return
    const p = this.#prefs
    const payload: PetPrefsPayload = {
      petScale: p.petScale,
      petOpacityIdle: p.petOpacityIdle,
      bubbleEnabled: p.bubbleEnabled,
      bubbleMs: p.bubbleMs,
      soundEnabled: p.soundEnabled,
      volume: p.volume,
      reducedMotion: false,
      anchor: p.corner,
      clickThrough: p.clickThrough
    }
    this.#win?.webContents.send('pet:prefs', payload)
  }

  /** Respuesta a `pet:setInteractive` (§3.5). */
  setInteractive(interactive: boolean): void {
    if (!this.isOpen) return
    this.#win?.setIgnoreMouseEvents(!interactive, { forward: true })
  }

  /** Recoloca la ventana en la esquina configurada del display elegido. */
  reposition(): void {
    if (!this.isOpen) return
    const display = this.#targetDisplay()
    this.#followingDisplayId = display.id
    const bounds = this.#boundsFor(display, this.#prefs.corner)
    this.#win?.setBounds(bounds)
  }

  destroy(): void {
    this.#stopFollowing()
    if (this.isOpen) this.#win?.destroy()
    this.#win = null
    this.#ready = false
  }

  // -----------------------------------------------------------------

  #size(): { width: number; height: number } {
    const iconScale = this.#prefs.petScale
    // Igual que sprite.css: el bocadillo nunca escala por debajo de 1×.
    const bubbleScale = Math.max(BUBBLE_SCALE_FLOOR, iconScale)
    return {
      // El ancho lo manda quien sea mayor: el núcleo grande o el bocadillo, que no
      // encoge con él.
      width: Math.round(Math.max(ICON_BASE * iconScale, BASE_WIDTH * bubbleScale)),
      height: Math.round(ICON_BASE * iconScale + BUBBLE_ZONE_H * bubbleScale)
    }
  }

  #targetDisplay(): Display {
    if (this.#prefs.followActiveDisplay) {
      return screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    }
    const wanted = this.#prefs.displayId
    const found =
      wanted === null ? undefined : screen.getAllDisplays().find((d) => d.id === wanted)
    // Si la pantalla guardada ha desaparecido, se cae a la principal sin avisar.
    return found ?? screen.getPrimaryDisplay()
  }

  /**
   * `workArea` para izquierda/derecha/arriba (no queremos irnos por debajo de la
   * barra de menús ni fuera de la pantalla en horizontal). `bounds` — la pantalla
   * física entera, SIN el recorte que macOS hace para el Dock — para abajo: Ismael,
   * 2026-09-04, quiere la mascota pegada al borde físico de verdad, no solo tocando
   * el borde superior del Dock (eso fue el primer intento, insuficiente: seguía
   * "por encima" del Dock en vez de "abajo del todo"). La ventana queda por encima
   * del Dock en el eje Z gracias a `setAlwaysOnTop(true, 'screen-saver')`, así que
   * no la tapa aunque ocupe su mismo sitio en pantalla.
   */
  #boundsFor(display: Display, corner: Corner): Rectangle {
    const { workArea, bounds } = display
    const { width, height } = this.#size()
    const right = workArea.x + workArea.width - width - MARGIN
    const left = workArea.x + MARGIN
    const bottom = bounds.y + bounds.height - height - MARGIN_DOCK_EDGE
    const top = workArea.y + MARGIN

    const x = corner === 'top-right' || corner === 'bottom-right' ? right : left
    const y = corner === 'top-left' || corner === 'top-right' ? top : bottom

    return { x: Math.round(x), y: Math.round(y), width, height }
  }

  #startFollowing(): void {
    this.#stopFollowing()
    if (!this.#prefs.followActiveDisplay) return
    this.#followTimer = setInterval(() => {
      if (!this.isOpen) return
      const id = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id
      if (id !== this.#followingDisplayId) this.reposition()
    }, FOLLOW_POLL_MS)
  }

  #stopFollowing(): void {
    if (this.#followTimer !== null) {
      clearInterval(this.#followTimer)
      this.#followTimer = null
    }
  }
}

/**
 * Suscribe la recolocación a los eventos de pantalla. `main` debe llamarlo una vez
 * y volver a llamar a `reposition()` también en `powerMonitor.on('resume')` (§3.2).
 */
export function watchDisplays(pet: PetWindow): () => void {
  const relocate = (): void => pet.reposition()
  screen.on('display-added', relocate)
  screen.on('display-removed', relocate)
  screen.on('display-metrics-changed', relocate)
  return (): void => {
    screen.off('display-added', relocate)
    screen.off('display-removed', relocate)
    screen.off('display-metrics-changed', relocate)
  }
}
