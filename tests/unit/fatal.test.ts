/**
 * Tests de la clasificación de errores fatales de arranque (BUG-1).
 *
 * Lo que se protege: que un fallo al arrancar produzca un mensaje que el usuario pueda
 * ENTENDER Y ACCIONAR, en vez de un volcado técnico o, peor, nada. Una app de barra de
 * menús que no arranca es invisible: si no lo dice, no se entera nadie.
 */

import { describe, expect, it, vi } from 'vitest'

// `fatal.ts` importa `electron` para el diálogo; en los tests solo se ejercita la parte
// pura de clasificación.
vi.mock('electron', () => ({
  app: { exit: vi.fn(), focus: vi.fn(), dock: { show: vi.fn() } },
  dialog: { showMessageBox: vi.fn(async () => ({ response: 0 })) },
  shell: { showItemInFolder: vi.fn() },
  BrowserWindow: vi.fn()
}))

const { describeFatal } = await import('../../src/main/fatal')

const DB = '/Users/x/Library/Application Support/Orbix/orbix.db'

describe('describeFatal', () => {
  it('BD corrupta: el caso del corte de luz con el WAL abierto', () => {
    // El error literal que reprodujo QA con `head -c 200000 /dev/urandom > …db`.
    const info = describeFatal(new Error('file is not a database'), DB)
    expect(info.kind).toBe('DB_CORRUPT')
    expect(info.message).toContain('dañada')
    // Le dice qué hacer y dónde está el fichero.
    expect(info.detail).toContain('Si lo mueves de sitio')
    expect(info.detail).toContain(DB)
    expect(info.revealPath).toBe(DB)
  })

  it('el aviso de BD corrupta no promete un histórico que no vuelve', () => {
    const info = describeFatal(new Error('file is not a database'), DB)
    // Claude Code borra sus transcripts a los 30 días: lo anterior no se reconstruye.
    expect(info.detail).toMatch(/30 días/)
    expect(info.detail).toMatch(/NO se recupera/)
    // Y se le dice que lo MUEVA, no que lo borre.
    expect(info.detail).toMatch(/Muévelo en vez de borrarlo/)
    expect(info.detail).not.toMatch(/Bórralo/)
  })

  it('reconoce las otras formas de corrupción de SQLite', () => {
    for (const mensaje of [
      'database disk image is malformed',
      'file is encrypted or is not a database'
    ]) {
      expect(describeFatal(new Error(mensaje), DB).kind).toBe('DB_CORRUPT')
    }
  })

  it('ABI equivocado del módulo nativo: le dice el comando exacto', () => {
    const error = new Error(
      "The module '…better_sqlite3.node' was compiled against a different Node.js " +
        'version using NODE_MODULE_VERSION 127. This version of Node.js requires ' +
        'NODE_MODULE_VERSION 136.'
    )
    const info = describeFatal(error, DB)
    expect(info.kind).toBe('NATIVE_ABI')
    expect(info.detail).toContain('npm run rebuild:electron')
  })

  it('sin permiso de escritura', () => {
    const error = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    const info = describeFatal(error, DB)
    expect(info.kind).toBe('DB_PERMISSION')
    expect(info.message).toContain('permiso')
  })

  it('BD de otra aplicación o incompleta', () => {
    expect(describeFatal(new Error('no such table: model_prices'), DB).kind).toBe('DB_INCOMPATIBLE')
    expect(describeFatal(new Error('no such column: cost_usd'), DB).kind).toBe('DB_INCOMPATIBLE')
  })

  it('bloqueada por otro proceso', () => {
    expect(describeFatal(new Error('database is locked'), DB).kind).toBe('DB_LOCKED')
  })

  it('migración fallida: se aclara que no se ha perdido nada', () => {
    const info = describeFatal(new Error('MigrationError: migración 004 falló'), DB)
    expect(info.kind).toBe('MIGRATION')
    expect(info.detail).toContain('transaccional')
  })

  it('lo desconocido también se cuenta, nunca se calla', () => {
    const info = describeFatal(new Error('algo rarísimo'), DB)
    expect(info.kind).toBe('UNKNOWN')
    expect(info.message).toContain('no ha podido arrancar')
    expect(info.detail).toContain('algo rarísimo')
  })

  it('no explota con valores que no son Error', () => {
    for (const raro of [null, undefined, 42, 'texto suelto', {}]) {
      const info = describeFatal(raro, DB)
      expect(typeof info.message).toBe('string')
      expect(info.message.length).toBeGreaterThan(0)
    }
  })

  it('todos los mensajes están en español y son frases, no volcados', () => {
    const casos = [
      new Error('file is not a database'),
      new Error('database is locked'),
      Object.assign(new Error('x'), { code: 'EACCES' }),
      new Error('cualquier cosa')
    ]
    for (const error of casos) {
      const info = describeFatal(error, DB)
      expect(info.message.endsWith('.')).toBe(true)
      // Mayúscula inicial, salvo cuando la frase empieza por el nombre del producto.
      expect(info.message).toMatch(/^([A-ZÁÉÍÓÚ«]|Orbix)/)
    }
  })
})
