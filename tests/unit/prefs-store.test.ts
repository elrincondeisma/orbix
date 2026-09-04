/**
 * Tests del almacén de preferencias.
 *
 * Lo que se protege: que un renderer comprometido no pueda meter valores absurdos
 * (`bubbleMs` de diez años, `volume` 42, una esquina inventada) y que un fichero
 * corrupto no impida arrancar la app.
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { PrefsStore, prefsPath, sanitizePrefs } from '../../src/main/prefs/store'
import { createDefaultPrefs } from '../../src/shared/constants'
import type { Prefs } from '../../src/shared/types'

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'miniclaudio-prefs-'))
  file = prefsPath(dir)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function store(onChange?: (p: Prefs) => void): PrefsStore {
  return new PrefsStore(onChange ? { file, onChange } : { file })
}

describe('PrefsStore — carga y persistencia', () => {
  it('sin fichero previo escribe los valores por defecto', () => {
    const s = store()
    const prefs = s.load()

    expect(prefs.corner).toBe('bottom-right')
    expect(prefs.bubbleMs).toBe(5000)
    expect(prefs.detailedToolStates).toBe(true)

    const onDisk = JSON.parse(readFileSync(file, 'utf8')) as Prefs
    expect(onDisk.corner).toBe('bottom-right')
  })

  it('relee lo guardado en el arranque siguiente', () => {
    const first = store()
    first.load()
    first.set({ corner: 'top-left', petScale: 1.25, showCostInMenubar: true })

    const second = store()
    const prefs = second.load()
    expect(prefs.corner).toBe('top-left')
    expect(prefs.petScale).toBe(1.25)
    expect(prefs.showCostInMenubar).toBe(true)
  })

  it('un fichero corrupto no impide arrancar: se vuelve a los valores por defecto', () => {
    writeFileSync(file, '{ esto no es json')
    const prefs = store().load()
    expect(prefs.bubbleMs).toBe(5000)
    // Y queda reparado en disco.
    expect(() => JSON.parse(readFileSync(file, 'utf8')) as unknown).not.toThrow()
  })

  it('no deja ficheros temporales tras escribir', () => {
    const s = store()
    s.load()
    s.set({ volume: 0.9 })
    expect(readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([])
  })

  it('avisa del cambio una sola vez y solo si hubo cambio real', () => {
    const cambios: Prefs[] = []
    const s = store((p) => cambios.push(p))
    s.load()

    s.set({ volume: 0.3 })
    expect(cambios).toHaveLength(1)

    // Mismo valor: no hay cambio, no hay aviso.
    s.set({ volume: 0.3 })
    expect(cambios).toHaveLength(1)
  })
})

describe('PrefsStore — silencio temporal', () => {
  it('mute(minutos) fija una fecha futura y mute(0) lo quita', () => {
    const s = store()
    s.load()

    const muted = s.mute(15)
    expect(muted.muteUntil).not.toBeNull()
    expect(Date.parse(muted.muteUntil!)).toBeGreaterThan(Date.now())

    expect(s.mute(0).muteUntil).toBeNull()
  })

  it('mute(null) es silencio indefinido', () => {
    const s = store()
    s.load()
    const muted = s.mute(null)
    expect(Date.parse(muted.muteUntil!)).toBeGreaterThan(Date.now() + 365 * 86_400_000)
  })

  it('un silencio vencido se limpia solo y avisa', () => {
    const cambios: Prefs[] = []
    const s = store((p) => cambios.push(p))
    s.load()
    s.set({ muteUntil: new Date(Date.now() - 60_000).toISOString() })
    cambios.length = 0

    expect(s.clearExpiredMute()).toBe(true)
    expect(s.get().muteUntil).toBeNull()
    expect(cambios).toHaveLength(1)

    // Segunda llamada: ya no hay nada que limpiar.
    expect(s.clearExpiredMute()).toBe(false)
  })

  it('no limpia un silencio todavía vigente', () => {
    const s = store()
    s.load()
    s.mute(30)
    expect(s.clearExpiredMute()).toBe(false)
    expect(s.get().muteUntil).not.toBeNull()
  })
})

describe('sanitizePrefs — nunca se confía en el cliente', () => {
  const defaults = createDefaultPrefs()

  it('recorta los números a su rango', () => {
    const p = sanitizePrefs(
      { bubbleMs: 999_999_999, volume: 42, petOpacityIdle: -3, ingestIntervalMs: 1 },
      defaults
    )
    expect(p.bubbleMs).toBe(15_000)
    expect(p.volume).toBe(1)
    expect(p.petOpacityIdle).toBe(0.35)
    expect(p.ingestIntervalMs).toBe(1000)
  })

  it('la escala de la mascota es una lista cerrada', () => {
    expect(sanitizePrefs({ petScale: 1.25 }, defaults).petScale).toBe(1.25)
    // Un valor intermedio rompería el SVG: se ignora.
    expect(sanitizePrefs({ petScale: 3 }, defaults).petScale).toBe(1)
    expect(sanitizePrefs({ petScale: 1.1 }, defaults).petScale).toBe(1)
  })

  it('rechaza esquinas y tipos inventados', () => {
    expect(sanitizePrefs({ corner: 'centro' }, defaults).corner).toBe('bottom-right')
    expect(sanitizePrefs({ petVisible: 'sí' }, defaults).petVisible).toBe(true)
    expect(sanitizePrefs({ displayId: 'la buena' }, defaults).displayId).toBeNull()
  })

  it('valida las horas de silencio y la zona horaria', () => {
    const p = sanitizePrefs(
      { quietHours: { enabled: true, from: '25:00', to: '08:30' }, timezone: 'Marte/Olympus' },
      defaults
    )
    expect(p.quietHours.from).toBe('23:00') // el inválido cae al por defecto
    expect(p.quietHours.to).toBe('08:30')
    expect(p.timezone).toBe(defaults.timezone)
    expect(sanitizePrefs({ timezone: 'Europe/Madrid' }, defaults).timezone).toBe('Europe/Madrid')
  })

  it('un muteUntil que no es fecha se descarta', () => {
    expect(sanitizePrefs({ muteUntil: 'mañana' }, defaults).muteUntil).toBeNull()
    const iso = new Date().toISOString()
    expect(sanitizePrefs({ muteUntil: iso }, defaults).muteUntil).toBe(iso)
  })

  it('entradas que no son objetos devuelven los valores por defecto', () => {
    for (const input of [null, undefined, 42, 'hola', []]) {
      expect(sanitizePrefs(input, defaults)).toEqual(defaults)
    }
  })

  it('el símbolo de moneda se recorta a cuatro caracteres', () => {
    expect(sanitizePrefs({ currencySymbol: '$$$$$$$$$$' }, defaults).currencySymbol).toBe('$$$$')
  })
})
