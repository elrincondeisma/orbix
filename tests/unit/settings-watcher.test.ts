/**
 * Tests de la vigilancia de `~/.claude/settings.json`.
 *
 * La regla que se protege: si alguien nos quita el hook, se AVISA y **nunca se reinstala
 * solo**. Escribirle el fichero al usuario a sus espaldas, y encima como respuesta a un
 * cambio que ha hecho él, no es aceptable.
 *
 * Todo sobre un directorio temporal; el `~/.claude` real no se toca.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { HookInstaller, mergeHooks, type SettingsObject } from '../../src/main/events/hook-installer'
import { SettingsWatcher, detectRemoval } from '../../src/main/events/settings-watcher'
import { HOOK_EVENTS_ALL } from '../../src/shared/constants'
import type { HookStatus } from '../../src/shared/types'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '../..')
const FIXTURE = join(REPO, 'tests/fixtures/claude/settings-real.json')
const HOOK_SOURCE = join(REPO, 'scripts/hook/miniclaudio-hook.sh')

let home: string
let installer: HookInstaller

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'miniclaudio-watch-'))
  mkdirSync(join(home, '.claude'), { recursive: true })
  writeFileSync(join(home, '.claude/settings.json'), readFileSync(FIXTURE, 'utf8'))
  installer = new HookInstaller({ home, hookSourcePath: HOOK_SOURCE })
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('detectRemoval', () => {
  const base: HookStatus = {
    installed: true,
    events: ['Stop', 'Notification'],
    missingEvents: [],
    scriptPath: '/x/hook.sh',
    scriptVersion: '1',
    settingsPath: '/x/settings.json',
    serverPort: 41414,
    serverListening: true,
    foreignHooksPreserved: 5,
    lastBackupPath: null
  }

  it('detecta los eventos que han desaparecido', () => {
    const after: HookStatus = { ...base, events: ['Stop'] }
    expect(detectRemoval(after, base)).toEqual(['Notification'])
  })

  it('no confunde «nunca instalado» con «desinstalado»', () => {
    const nunca: HookStatus = { ...base, installed: false, events: [] }
    expect(detectRemoval(nunca, nunca)).toEqual([])
    expect(detectRemoval({ ...base, events: [] }, null)).toEqual([])
  })

  it('instalar más eventos no cuenta como retirada', () => {
    const after: HookStatus = { ...base, events: ['Stop', 'Notification', 'PreToolUse'] }
    expect(detectRemoval(after, base)).toEqual([])
  })
})

describe('SettingsWatcher', () => {
  it('avisa cuando alguien retira nuestro hook por fuera, y NO lo reinstala', async () => {
    await installer.install({ port: 41414, listening: true })

    const cambios: Array<{ status: HookStatus; retirados: string[] }> = []
    const watcher = new SettingsWatcher({
      path: installer.settingsPath,
      readStatus: () => installer.getStatus({ port: 41414, listening: true }),
      onChange: (status, previous) =>
        cambios.push({ status, retirados: detectRemoval(status, previous) })
    })
    await watcher.start()

    try {
      // El usuario (o un script suyo) borra el bloque de hooks a mano.
      const actual = JSON.parse(readFileSync(installer.settingsPath, 'utf8')) as SettingsObject
      delete actual['hooks']
      writeFileSync(installer.settingsPath, `${JSON.stringify(actual, null, 2)}\n`)

      // chokidar + awaitWriteFinish + debounce.
      for (let i = 0; i < 40 && cambios.length === 0; i += 1) await wait(100)

      expect(cambios.length).toBeGreaterThan(0)
      const ultimo = cambios.at(-1)!
      expect(ultimo.status.installed).toBe(false)
      expect(ultimo.retirados.sort()).toEqual([...HOOK_EVENTS_ALL].sort())

      // Y lo más importante: el fichero sigue SIN nuestros hooks. No se ha reinstalado.
      await wait(300)
      const despues = JSON.parse(readFileSync(installer.settingsPath, 'utf8')) as SettingsObject
      expect(despues['hooks']).toBeUndefined()
    } finally {
      await watcher.stop()
    }
  })

  it('stop() deja de observar', async () => {
    const cambios: HookStatus[] = []
    const watcher = new SettingsWatcher({
      path: installer.settingsPath,
      readStatus: () => installer.getStatus({ port: null, listening: false }),
      onChange: (status) => cambios.push(status)
    })
    await watcher.start()
    await watcher.stop()

    writeFileSync(installer.settingsPath, '{}\n')
    await wait(800)
    expect(cambios).toEqual([])
  })
})

describe('estados detallados de herramientas', () => {
  it('desactivarlos retira PreToolUse/PostToolUse y respeta el resto', () => {
    const original = JSON.parse(readFileSync(FIXTURE, 'utf8')) as SettingsObject
    const todos = mergeHooks(original, HOOK_EVENTS_ALL)
    const sinHerramientas = mergeHooks(todos, [
      'SessionStart',
      'UserPromptSubmit',
      'Notification',
      'SubagentStop',
      'PreCompact',
      'Stop',
      'SessionEnd'
    ])

    const hooks = sinHerramientas['hooks'] as Record<string, unknown>
    expect(hooks['PreToolUse']).toBeUndefined()
    expect(hooks['PostToolUse']).toBeUndefined()
    // Los hooks de ntfy y cerebro siguen donde estaban.
    expect(JSON.stringify(hooks)).toContain('ntfy-notify.sh')
    expect(JSON.stringify(hooks)).toContain('cerebro hook arranque')
  })
})
