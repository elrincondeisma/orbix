/**
 * Tests del instalador de hooks.
 *
 * Lo que se protege aquí es el flujo de trabajo diario del usuario: su `settings.json`
 * ya tiene hooks de `ntfy-notify.sh` y del binario `cerebro`. Si el merge los destruye o
 * los duplica, se le rompe todo. Todo se prueba sobre una COPIA en un directorio temporal;
 * el `~/.claude/settings.json` real no se toca jamás.
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  HookInstaller,
  HookWriteError,
  countForeignHooks,
  installedEvents,
  isOurEntry,
  mergeHooks,
  stripHooks,
  timestamp,
  type SettingsObject
} from '../../src/main/events/hook-installer'
import { HOOK_EVENTS_ALL, HOOK_EVENTS_PLAIN } from '../../src/shared/constants'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '../..')
const FIXTURE = join(REPO, 'tests/fixtures/claude/settings-real.json')
const HOOK_SOURCE = join(REPO, 'scripts/hook/miniclaudio-hook.sh')

function loadFixture(): SettingsObject {
  return JSON.parse(readFileSync(FIXTURE, 'utf8')) as SettingsObject
}

/** Todos los comandos de hook presentes en un settings, aplanados. */
function allCommands(settings: SettingsObject): string[] {
  const hooks = (settings['hooks'] ?? {}) as Record<string, unknown>
  const out: string[] = []
  for (const groups of Object.values(hooks)) {
    for (const group of groups as Array<{ hooks?: Array<{ command?: string }> }>) {
      for (const entry of group.hooks ?? []) {
        if (typeof entry.command === 'string') out.push(entry.command)
      }
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Funciones puras de merge
// ---------------------------------------------------------------------------

describe('mergeHooks — no destruye los hooks existentes del usuario', () => {
  it('conserva ntfy-notify.sh y cerebro exactamente igual', () => {
    const before = loadFixture()
    const after = mergeHooks(before, HOOK_EVENTS_ALL)

    const foreignBefore = allCommands(before)
    const foreignAfter = allCommands(after).filter((c) => !c.includes('miniclaudio/hook.sh'))

    expect(foreignAfter).toEqual(foreignBefore)
    expect(foreignAfter).toContain('~/.claude/hooks/ntfy-notify.sh')
    expect(foreignAfter).toContain('/Users/icatala/.local/bin/cerebro hook cierre')
    expect(foreignAfter).toContain('/Users/icatala/.local/bin/cerebro hook arranque')
    // ntfy aparece en Stop, Notification y SessionEnd: tres veces, ni una menos.
    expect(foreignAfter.filter((c) => c.includes('ntfy-notify.sh'))).toHaveLength(3)
  })

  it('preserva los `timeout: 10` y `async: true` ajenos sin tocarlos', () => {
    const after = mergeHooks(loadFixture(), HOOK_EVENTS_ALL)
    const stopGroups = (after['hooks'] as Record<string, unknown>)['Stop'] as Array<{
      hooks: Array<{ command: string; timeout?: number; async?: boolean }>
    }>
    const ntfy = stopGroups.flatMap((g) => g.hooks).find((h) => h.command.includes('ntfy'))
    expect(ntfy).toEqual({
      type: 'command',
      command: '~/.claude/hooks/ntfy-notify.sh',
      timeout: 10,
      async: true
    })
  })

  it('añade nuestro grupo al final del array del evento, sin fusionarlo con los ajenos', () => {
    const after = mergeHooks(loadFixture(), HOOK_EVENTS_ALL)
    const stopGroups = (after['hooks'] as Record<string, unknown>)['Stop'] as Array<{
      hooks: Array<{ command: string }>
    }>
    expect(stopGroups).toHaveLength(3) // ntfy + cerebro + el nuestro
    const last = stopGroups[2]!
    expect(last.hooks).toHaveLength(1)
    expect(last.hooks[0]).toEqual({
      type: 'command',
      command: '~/.claude/miniclaudio/hook.sh',
      timeout: 2,
      async: true
    })
  })

  it('instala los nueve eventos, con matcher solo en PreToolUse y PostToolUse', () => {
    const after = mergeHooks(loadFixture(), HOOK_EVENTS_ALL)
    expect(installedEvents(after).sort()).toEqual([...HOOK_EVENTS_ALL].sort())

    const hooks = after['hooks'] as Record<string, Array<{ matcher?: string }>>
    for (const event of ['PreToolUse', 'PostToolUse']) {
      const ours = hooks[event]!.at(-1)!
      expect(ours.matcher).toBe('*')
    }
    for (const event of HOOK_EVENTS_PLAIN) {
      const ours = hooks[event]!.at(-1)!
      expect(ours.matcher).toBeUndefined()
    }
  })

  it('es idempotente: instalar dos veces no duplica nada', () => {
    const once = mergeHooks(loadFixture(), HOOK_EVENTS_ALL)
    const twice = mergeHooks(once, HOOK_EVENTS_ALL)
    expect(twice).toEqual(once)
    expect(allCommands(twice).filter((c) => c.includes('miniclaudio'))).toHaveLength(9)
  })

  it('al desactivar los estados detallados quita PreToolUse/PostToolUse y nada más', () => {
    const full = mergeHooks(loadFixture(), HOOK_EVENTS_ALL)
    const reduced = mergeHooks(full, HOOK_EVENTS_PLAIN)
    expect(installedEvents(reduced).sort()).toEqual([...HOOK_EVENTS_PLAIN].sort())
    // Los hooks ajenos siguen intactos.
    expect(countForeignHooks(reduced)).toBe(countForeignHooks(loadFixture()))
  })

  it('no muta el objeto de entrada', () => {
    const before = loadFixture()
    const snapshot = JSON.stringify(before)
    mergeHooks(before, HOOK_EVENTS_ALL)
    expect(JSON.stringify(before)).toBe(snapshot)
  })

  it('funciona sobre un settings.json vacío o sin bloque hooks', () => {
    expect(installedEvents(mergeHooks({}, HOOK_EVENTS_ALL)).sort()).toEqual(
      [...HOOK_EVENTS_ALL].sort()
    )
    const withOther = mergeHooks({ model: 'opus' }, HOOK_EVENTS_ALL)
    expect(withOther['model']).toBe('opus')
  })

  it('preserva el orden de las claves de nivel superior', () => {
    const before = loadFixture()
    const after = mergeHooks(before, HOOK_EVENTS_ALL)
    expect(Object.keys(after)).toEqual(Object.keys(before))
  })
})

describe('stripHooks — desinstalación', () => {
  it('devuelve el settings a su estado original', () => {
    const original = loadFixture()
    const installed = mergeHooks(original, HOOK_EVENTS_ALL)
    const removed = stripHooks(installed)
    expect(removed).toEqual(original)
  })

  it('elimina el array del evento si se queda vacío y `hooks` si queda vacío del todo', () => {
    const only = mergeHooks({}, HOOK_EVENTS_ALL)
    const removed = stripHooks(only)
    expect(removed['hooks']).toBeUndefined()
  })
})

describe('isOurEntry / countForeignHooks', () => {
  it('la marca de identidad es únicamente la subcadena del comando', () => {
    expect(isOurEntry({ command: '~/.claude/miniclaudio/hook.sh' })).toBe(true)
    expect(isOurEntry({ command: '/otra/ruta/miniclaudio/hook.sh --x' })).toBe(true)
    expect(isOurEntry({ command: '~/.claude/hooks/ntfy-notify.sh' })).toBe(false)
    expect(isOurEntry({ command: 'cerebro hook cierre' })).toBe(false)
    expect(isOurEntry(null)).toBe(false)
    expect(isOurEntry({})).toBe(false)
  })

  it('cuenta los cuatro hooks de terceros del fichero real', () => {
    // ntfy ×3 (Stop, Notification, SessionEnd) + cerebro ×2 (Stop, SessionStart)
    expect(countForeignHooks(loadFixture())).toBe(5)
    expect(countForeignHooks(mergeHooks(loadFixture(), HOOK_EVENTS_ALL))).toBe(5)
  })
})

describe('timestamp', () => {
  it('genera un sufijo ordenable YYYYMMDD-HHmmss', () => {
    expect(timestamp(new Date(2026, 8, 3, 7, 5, 9))).toBe('20260903-070509')
  })
})

// ---------------------------------------------------------------------------
// Instalador contra disco (siempre en un directorio temporal)
// ---------------------------------------------------------------------------

describe('HookInstaller sobre una copia real de settings.json', () => {
  let home: string
  let installer: HookInstaller
  const server = { port: 41414, listening: true }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'miniclaudio-test-'))
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(join(home, '.claude/settings.json'), readFileSync(FIXTURE, 'utf8'))
    installer = new HookInstaller({ home, hookSourcePath: HOOK_SOURCE })
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  it('instala, hace backup y deja el fichero parseable', async () => {
    const before = readFileSync(installer.settingsPath, 'utf8')
    const status = await installer.install(server)

    expect(status.installed).toBe(true)
    expect(status.events.sort()).toEqual([...HOOK_EVENTS_ALL].sort())
    expect(status.missingEvents).toEqual([])
    expect(status.foreignHooksPreserved).toBe(5)
    expect(status.scriptVersion).toBe('1')
    expect(status.lastBackupPath).not.toBeNull()
    expect(readFileSync(status.lastBackupPath!, 'utf8')).toBe(before)

    const after = JSON.parse(readFileSync(installer.settingsPath, 'utf8')) as SettingsObject
    expect(countForeignHooks(after)).toBe(5)
    // Indentación de 2 espacios y salto final, como el fichero original.
    const text = readFileSync(installer.settingsPath, 'utf8')
    expect(text.endsWith('}\n')).toBe(true)
    expect(text).toContain('\n  "model": "opus[1m]"')
  })

  it('crea los ficheros de coordinación con los permisos correctos', async () => {
    await installer.install(server, true, 41414)

    expect(existsSync(installer.scriptPath)).toBe(true)
    expect(installer.readToken()).toMatch(/^[0-9a-f]{64}$/)
    expect(installer.readPort()).toBe(41414)

    const { statSync } = await import('node:fs')
    expect(statSync(installer.tokenPath).mode & 0o777).toBe(0o600)
    expect(statSync(installer.scriptPath).mode & 0o777).toBe(0o755)
    expect(statSync(installer.dir).mode & 0o777).toBe(0o700)
  })

  it('el token no se regenera en instalaciones sucesivas', async () => {
    await installer.install(server)
    const first = installer.readToken()
    await installer.install(server)
    expect(installer.readToken()).toBe(first)
  })

  it('instalar dos veces no duplica entradas', async () => {
    await installer.install(server)
    await installer.install(server)
    const after = JSON.parse(readFileSync(installer.settingsPath, 'utf8')) as SettingsObject
    expect(allCommands(after).filter((c) => c.includes('miniclaudio'))).toHaveLength(9)
  })

  it('desinstala dejando el fichero como estaba', async () => {
    const before = readFileSync(installer.settingsPath, 'utf8')
    await installer.install(server)
    const status = await installer.uninstall(server)

    expect(status.installed).toBe(false)
    expect(status.events).toEqual([])
    const after = JSON.parse(readFileSync(installer.settingsPath, 'utf8')) as SettingsObject
    expect(after).toEqual(JSON.parse(before) as SettingsObject)
  })

  it('ABORTA sin tocar nada si settings.json no parsea', async () => {
    const roto = '{ "model": "opus", '
    writeFileSync(installer.settingsPath, roto)

    await expect(installer.install(server)).rejects.toBeInstanceOf(HookWriteError)
    expect(readFileSync(installer.settingsPath, 'utf8')).toBe(roto)
  })

  it('funciona si settings.json no existe todavía', async () => {
    rmSync(installer.settingsPath)
    const status = await installer.install(server)
    expect(status.installed).toBe(true)
    expect(status.lastBackupPath).toBeNull()
  })

  it('conserva como mucho cinco backups', async () => {
    for (let i = 0; i < 8; i += 1) {
      const inst = new HookInstaller({
        home,
        hookSourcePath: HOOK_SOURCE,
        now: () => new Date(2026, 8, 3, 10, 0, i)
      })
      await inst.install(server)
    }
    const backups = readdirSync(join(home, '.claude')).filter((n) =>
      n.startsWith('settings.json.miniclaudio-bak-')
    )
    expect(backups).toHaveLength(5)
  })

  it('no deja ficheros temporales ni el lock por el camino', async () => {
    await installer.install(server)
    const claudeDir = readdirSync(join(home, '.claude'))
    expect(claudeDir.some((n) => n.endsWith('.miniclaudio-tmp'))).toBe(false)
    expect(existsSync(join(installer.dir, '.lock'))).toBe(false)
  })

  it('BUG-4: si settings.json es un symlink, se escribe A TRAVÉS y el enlace sobrevive', async () => {
    const { lstatSync, realpathSync, mkdirSync: mkdir, symlinkSync } = await import('node:fs')

    // Montaje típico de dotfiles: ~/.claude/settings.json → ~/dotfiles/claude/settings.json
    const dotfiles = join(home, 'dotfiles/claude')
    mkdir(dotfiles, { recursive: true })
    const real = join(dotfiles, 'settings.json')
    const contenido = readFileSync(FIXTURE, 'utf8')
    writeFileSync(real, contenido)
    rmSync(installer.settingsPath)
    symlinkSync(real, installer.settingsPath)

    expect(lstatSync(installer.settingsPath).isSymbolicLink()).toBe(true)
    expect(installer.realSettingsPath).toBe(realpathSync(real))

    await installer.install(server)

    // 1. Sigue siendo un enlace, no un fichero suelto.
    expect(lstatSync(installer.settingsPath).isSymbolicLink()).toBe(true)
    expect(realpathSync(installer.settingsPath)).toBe(realpathSync(real))

    // 2. Los hooks han ido a parar al fichero versionado, que es lo que el usuario edita.
    const enDotfiles = JSON.parse(readFileSync(real, 'utf8')) as SettingsObject
    expect(installedEvents(enDotfiles).sort()).toEqual([...HOOK_EVENTS_ALL].sort())
    expect(countForeignHooks(enDotfiles)).toBe(5)

    // 3. El backup se deja junto al fichero real, no junto al enlace.
    //    (`realpathSync` porque en macOS /var es un enlace a /private/var.)
    const status = installer.getStatus(server)
    expect(status.lastBackupPath?.startsWith(realpathSync(dotfiles))).toBe(true)
    expect(status.installed).toBe(true)

    // 4. Y desinstalar tampoco rompe el enlace.
    await installer.uninstall(server)
    expect(lstatSync(installer.settingsPath).isSymbolicLink()).toBe(true)
    expect(JSON.parse(readFileSync(real, 'utf8'))).toEqual(JSON.parse(contenido))
  })

  it('BUG-4: con el enlace roto se crea el destino y el enlace sigue vivo', async () => {
    const { symlinkSync, lstatSync } = await import('node:fs')
    const destino = join(home, 'dotfiles-todavia-sin-clonar.json')
    rmSync(installer.settingsPath)
    symlinkSync(destino, installer.settingsPath)

    // Se respeta la intención del usuario: se escribe DONDE APUNTA, no encima del enlace.
    expect(installer.realSettingsPath).toBe(destino)

    await installer.install(server)

    expect(lstatSync(installer.settingsPath).isSymbolicLink()).toBe(true)
    expect(existsSync(destino)).toBe(true)
    expect(installer.getStatus(server).installed).toBe(true)
    expect(installedEvents(JSON.parse(readFileSync(destino, 'utf8')) as SettingsObject)).toHaveLength(9)
  })

  it('getStatus refleja la ausencia de instalación sin lanzar', () => {
    const status = installer.getStatus({ port: null, listening: false })
    expect(status.installed).toBe(false)
    expect(status.missingEvents.sort()).toEqual([...HOOK_EVENTS_ALL].sort())
    expect(status.serverListening).toBe(false)
    expect(status.foreignHooksPreserved).toBe(5)
  })
})
