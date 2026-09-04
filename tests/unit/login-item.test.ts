/**
 * Tests del arranque al iniciar sesión.
 *
 * Regla que se protege: **el estado que se enseña es el del SISTEMA**, no una copia en
 * `prefs.json`. El usuario puede quitar el elemento de inicio desde Ajustes del Sistema
 * sin que la app se entere, y una copia local se quedaría mintiendo para siempre.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const estado = {
  openAtLogin: false,
  isPackaged: true,
  /** Simula un macOS que se niega a registrar el elemento de inicio. */
  rechaza: false,
  llamadas: [] as Array<{ openAtLogin: boolean; openAsHidden?: boolean }>
}

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return estado.isPackaged
    },
    getLoginItemSettings: () => ({ openAtLogin: estado.openAtLogin }),
    setLoginItemSettings: (opts: { openAtLogin: boolean; openAsHidden?: boolean }) => {
      estado.llamadas.push(opts)
      if (!estado.rechaza) estado.openAtLogin = opts.openAtLogin
    }
  }
}))

const { getLaunchAtLogin, isLaunchAtLoginAvailable, setLaunchAtLogin } = await import(
  '../../src/main/login-item'
)

beforeEach(() => {
  estado.openAtLogin = false
  estado.isPackaged = true
  estado.rechaza = false
  estado.llamadas = []
})

describe('disponibilidad', () => {
  it('en la app instalada está disponible', () => {
    expect(isLaunchAtLoginAvailable()).toBe(true)
  })

  it('en desarrollo NO: registraría el Electron de node_modules', () => {
    estado.isPackaged = false
    expect(isLaunchAtLoginAvailable()).toBe(false)
  })

  it('en desarrollo no se toca el sistema aunque se pida', () => {
    estado.isPackaged = false
    expect(setLaunchAtLogin(true)).toBe(false)
    expect(estado.llamadas).toEqual([])
  })
})

describe('lectura y escritura', () => {
  it('lee el estado real del sistema', () => {
    expect(getLaunchAtLogin()).toBe(false)
    estado.openAtLogin = true
    expect(getLaunchAtLogin()).toBe(true)
  })

  it('activarlo lo registra oculto, que es lo que toca en una app de barra de menús', () => {
    expect(setLaunchAtLogin(true)).toBe(true)
    expect(estado.llamadas).toEqual([{ openAtLogin: true, openAsHidden: true }])
  })

  it('desactivarlo lo quita', () => {
    setLaunchAtLogin(true)
    expect(setLaunchAtLogin(false)).toBe(false)
    expect(getLaunchAtLogin()).toBe(false)
  })

  it('si el sistema lo rechaza, se devuelve la verdad, no lo que se pidió', () => {
    estado.rechaza = true
    // Se pidió activarlo y el sistema no lo aplicó: el interruptor debe rebotar.
    expect(setLaunchAtLogin(true)).toBe(false)
  })

  it('un cambio hecho por fuera se ve en la siguiente lectura', () => {
    setLaunchAtLogin(true)
    expect(getLaunchAtLogin()).toBe(true)
    // El usuario lo quita desde Ajustes del Sistema.
    estado.openAtLogin = false
    expect(getLaunchAtLogin()).toBe(false)
  })
})
