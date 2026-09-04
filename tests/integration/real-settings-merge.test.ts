/**
 * Verificación del merge contra el `~/.claude/settings.json` REAL de la máquina.
 *
 * ⚠️ ES DE SOLO LECTURA. Lee el fichero, hace el merge EN MEMORIA y comprueba que no se
 * pierde ni se duplica nada. **Nunca escribe.** El fichero real solo lo toca el usuario
 * pulsando "Instalar hooks" en Preferencias.
 *
 * No corre por defecto (depende de la máquina). Para lanzarla:
 *
 *   ORBIX_REAL=1 npx vitest run tests/integration/real-settings-merge.test.ts
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  countForeignHooks,
  installedEvents,
  isOurEntry,
  mergeHooks,
  stripHooks,
  type SettingsObject
} from '../../src/main/events/hook-installer'
import { HOOK_EVENTS_ALL } from '../../src/shared/constants'

const ENABLED = process.env['ORBIX_REAL'] === '1'
const SETTINGS = join(homedir(), '.claude/settings.json')

interface Entrada {
  evento: string
  comando: string
}

/** Todas las entradas de comando, con su evento, para comparar antes y después. */
function entradas(settings: SettingsObject): Entrada[] {
  const hooks = (settings['hooks'] ?? {}) as Record<string, unknown>
  const out: Entrada[] = []
  for (const [evento, grupos] of Object.entries(hooks)) {
    for (const grupo of (grupos ?? []) as Array<{ hooks?: Array<{ command?: string }> }>) {
      for (const entrada of grupo.hooks ?? []) {
        if (typeof entrada.command === 'string') out.push({ evento, comando: entrada.command })
      }
    }
  }
  return out
}

describe.skipIf(!ENABLED)('merge contra el settings.json real (solo lectura)', () => {
  it('el fichero real existe y es JSON estricto', () => {
    expect(existsSync(SETTINGS)).toBe(true)
    expect(() => JSON.parse(readFileSync(SETTINGS, 'utf8')) as unknown).not.toThrow()
  })

  it('instalar EN MEMORIA no pierde ni un solo hook del usuario', () => {
    const original = JSON.parse(readFileSync(SETTINGS, 'utf8')) as SettingsObject
    const antes = entradas(original).filter((e) => !e.comando.includes('orbix/hook.sh'))

    const conNuestros = mergeHooks(original, HOOK_EVENTS_ALL)
    const despues = entradas(conNuestros).filter((e) => !e.comando.includes('orbix/hook.sh'))

    // Mismos comandos, mismos eventos, mismo orden.
    expect(despues).toEqual(antes)
    expect(countForeignHooks(conNuestros)).toBe(countForeignHooks(original))

    // Y nuestras nueve entradas están puestas.
    expect(installedEvents(conNuestros).sort()).toEqual([...HOOK_EVENTS_ALL].sort())

    // Informe para el humano: qué hooks de terceros se han respetado.
    console.log('Hooks de terceros preservados:')
    for (const e of antes) console.log(`  ${e.evento.padEnd(18)} ${e.comando}`)
  })

  it('desinstalar EN MEMORIA devuelve el fichero exactamente a su estado original', () => {
    const original = JSON.parse(readFileSync(SETTINGS, 'utf8')) as SettingsObject
    const ciclo = stripHooks(mergeHooks(original, HOOK_EVENTS_ALL))
    expect(ciclo).toEqual(original)
    expect(JSON.stringify(ciclo, null, 2)).toBe(JSON.stringify(original, null, 2))
  })

  it('ninguna entrada existente se confunde con una nuestra', () => {
    const original = JSON.parse(readFileSync(SETTINGS, 'utf8')) as SettingsObject
    for (const { comando } of entradas(original)) {
      expect(isOurEntry({ command: comando })).toBe(false)
    }
  })
})
