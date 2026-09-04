/**
 * Orbix — icono de la barra de menús.
 *
 * Fuente de verdad: `04-frontal.md` §10.1.
 *
 *  - Imagen PLANTILLA (`trayTemplate.png` + `@2x`): macOS la invierte sola en modo oscuro
 *    y al resaltarla. Se genera con `scripts/gen-tray-icon.mjs`.
 *  - Título opcional a la derecha: el coste de hoy en formato corto, en dígitos
 *    monoespaciados para que no baile al refrescarse cada 2 s.
 *  - Con la mascota en `NEEDS_YOU` el título se sustituye por `●`: es la única forma de
 *    enterarse si la mascota está oculta.
 *  - Clic izquierdo abre/cierra el popover; clic derecho abre el menú nativo.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { Menu, Tray, app, nativeImage, type Rectangle } from 'electron'

import { formatCostShort } from '@shared/format'

export interface TrayCallbacks {
  onToggle: (bounds: Rectangle) => void
  onOpenStats: () => void
  onOpenPrefs: () => void
  onMute: (minutes: number | null) => void
  onTogglePet: () => void
  onQuit: () => void
}

export interface TrayViewState {
  /** Coste de hoy, para el título. */
  todayCostUsd: number
  showCost: boolean
  currencySymbol: string
  /** true → el título pasa a ser el punto de aviso. */
  needsYou: boolean
  petVisible: boolean
  muted: boolean
}

/** Busca el icono tanto en desarrollo como dentro del paquete. */
function trayImage(): Electron.NativeImage {
  const candidates = [
    join(app.getAppPath(), 'resources', 'trayTemplate.png'),
    join(process.resourcesPath ?? '', 'resources', 'trayTemplate.png'),
    join(process.resourcesPath ?? '', 'trayTemplate.png')
  ]
  for (const path of candidates) {
    if (path !== '' && existsSync(path)) {
      const image = nativeImage.createFromPath(path)
      if (!image.isEmpty()) {
        // Con esto macOS aplica el tratamiento de plantilla (invertir, resaltar).
        image.setTemplateImage(true)
        return image
      }
    }
  }
  // Sin icono, `new Tray()` fallaría: se devuelve uno vacío de 16×16 para no tumbar la app.
  const fallback = nativeImage.createEmpty()
  fallback.setTemplateImage(true)
  return fallback
}

export class AppTray {
  #tray: Tray | null = null
  readonly #callbacks: TrayCallbacks
  #state: TrayViewState = {
    todayCostUsd: 0,
    showCost: false,
    currencySymbol: '$',
    needsYou: false,
    petVisible: true,
    muted: false
  }

  constructor(callbacks: TrayCallbacks) {
    this.#callbacks = callbacks
  }

  get bounds(): Rectangle | null {
    return this.#tray?.getBounds() ?? null
  }

  create(): void {
    if (this.#tray !== null) return
    const tray = new Tray(trayImage())
    tray.setToolTip('Orbix')

    // OJO: no se usa `setContextMenu`, porque en macOS eso haría que el clic izquierdo
    // abriera el menú en vez del popover.
    tray.on('click', () => this.#callbacks.onToggle(tray.getBounds()))
    tray.on('right-click', () => tray.popUpContextMenu(this.#menu()))

    this.#tray = tray
    this.#applyTitle()
  }

  update(patch: Partial<TrayViewState>): void {
    this.#state = { ...this.#state, ...patch }
    this.#applyTitle()
  }

  destroy(): void {
    this.#tray?.destroy()
    this.#tray = null
  }

  #applyTitle(): void {
    const tray = this.#tray
    if (tray === null) return
    const s = this.#state
    // El aviso gana siempre al coste: es lo urgente.
    const title = s.needsYou
      ? '●'
      : s.showCost
        ? formatCostShort(s.todayCostUsd, s.currencySymbol)
        : ''
    tray.setTitle(title, { fontType: 'monospacedDigit' })
  }

  #menu(): Menu {
    const s = this.#state
    return Menu.buildFromTemplate([
      { label: 'Estadísticas…', click: () => this.#callbacks.onOpenStats() },
      { label: 'Preferencias…', click: () => this.#callbacks.onOpenPrefs() },
      { type: 'separator' },
      {
        label: s.petVisible ? 'Ocultar mascota' : 'Mostrar mascota',
        click: () => this.#callbacks.onTogglePet()
      },
      {
        label: 'Silenciar',
        submenu: [
          { label: '15 minutos', click: () => this.#callbacks.onMute(15) },
          { label: '1 hora', click: () => this.#callbacks.onMute(60) },
          { label: 'Hasta que lo reactive', click: () => this.#callbacks.onMute(null) },
          { type: 'separator' },
          {
            label: 'Quitar el silencio',
            enabled: s.muted,
            click: () => this.#callbacks.onMute(0)
          }
        ]
      },
      { type: 'separator' },
      { label: 'Salir de Orbix', click: () => this.#callbacks.onQuit() }
    ])
  }
}
