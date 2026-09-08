/**
 * Tests del título del icono de la barra de menús.
 *
 * Reglas que se protegen:
 *  - el aviso de la mascota (`●`) gana a cualquier cifra: es lo urgente;
 *  - el % que se enseña es el de la ventana de 5 h, y solo si el usuario lo ha pedido;
 *  - con el dato de límites de más de un día, el % NO se pinta (§1.3, nada de mentiras),
 *    pero el tooltip sigue contando el porcentaje y su antigüedad.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const pintado = { title: '', tooltip: '' }

vi.mock('electron', () => {
  class FakeTray {
    setTitle(title: string): void {
      pintado.title = title
    }
    setToolTip(text: string): void {
      pintado.tooltip = text
    }
    on(): void {}
    getBounds(): { x: number; y: number; width: number; height: number } {
      return { x: 0, y: 0, width: 24, height: 24 }
    }
    destroy(): void {}
    popUpContextMenu(): void {}
  }
  return {
    Tray: FakeTray,
    Menu: { buildFromTemplate: () => ({}) },
    app: { getAppPath: () => '/ruta/que/no/existe' },
    nativeImage: {
      createFromPath: () => ({ isEmpty: () => true, setTemplateImage: () => {} }),
      createEmpty: () => ({ setTemplateImage: () => {} })
    }
  }
})

const { AppTray } = await import('../../src/main/tray')

function nuevoTray(): InstanceType<typeof AppTray> {
  const tray = new AppTray({
    onToggle: () => {},
    onOpenStats: () => {},
    onOpenPrefs: () => {},
    onMute: () => {},
    onTogglePet: () => {},
    onQuit: () => {}
  })
  tray.create()
  return tray
}

describe('AppTray · título', () => {
  beforeEach(() => {
    pintado.title = ''
    pintado.tooltip = ''
  })

  it('sin nada activado, el título va vacío', () => {
    nuevoTray()
    expect(pintado.title).toBe('')
    expect(pintado.tooltip).toBe('Orbix')
  })

  it('enseña coste y % de la ventana de 5 h separados por un punto medio', () => {
    const tray = nuevoTray()
    tray.update({
      todayCostUsd: 12.84,
      showCost: true,
      sessionPercent: 43.4,
      showSessionPercent: true,
      limitsAgeSeconds: 720
    })
    expect(pintado.title).toBe('$13 · 43 %')
    expect(pintado.tooltip).toBe('Orbix\nVentana de 5 h: 43 % · hace 12 min')
  })

  it('solo el %, si el coste está desactivado', () => {
    const tray = nuevoTray()
    tray.update({ showCost: false, sessionPercent: 7, showSessionPercent: true })
    expect(pintado.title).toBe('7 %')
  })

  it('con el dato de límites de hace días, el % se calla y el tooltip lo explica', () => {
    const tray = nuevoTray()
    tray.update({
      todayCostUsd: 12.84,
      showCost: true,
      sessionPercent: 43,
      showSessionPercent: true,
      limitsAgeSeconds: 259_200,
      limitsVeryStale: true
    })
    expect(pintado.title).toBe('$13')
    expect(pintado.tooltip).toContain('pero el dato es de hace 3 días')
  })

  it('sin ninguna lectura de límites no se inventa un 0 %', () => {
    const tray = nuevoTray()
    tray.update({ showCost: false, sessionPercent: null, showSessionPercent: true })
    expect(pintado.title).toBe('')
    expect(pintado.tooltip).toBe('Orbix\nVentana de 5 h: aún sin datos')
  })

  it('el aviso de la mascota gana a coste y porcentaje', () => {
    const tray = nuevoTray()
    tray.update({
      todayCostUsd: 12.84,
      showCost: true,
      sessionPercent: 43,
      showSessionPercent: true,
      needsYou: true
    })
    expect(pintado.title).toBe('●')
  })
})
