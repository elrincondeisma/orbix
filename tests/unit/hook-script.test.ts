/**
 * Tests del script `scripts/hook/miniclaudio-hook.sh` ejecutándolo DE VERDAD.
 *
 * REGLA DURA que se verifica aquí: **el hook nunca puede bloquear ni ralentizar a Claude
 * Code**. Con miniClaudio cerrado, `curl` falla por conexión rechazada en microsegundos y
 * el script sale 0. Claude Code no percibe absolutamente nada.
 *
 * Se ejecuta siempre con un `HOME` temporal: el `~/.claude` real no se toca.
 */

import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { EventServer } from '../../src/main/events/server'
import type { NormalizedHookEvent } from '../../src/main/events/schema'
import { HookInstaller } from '../../src/main/events/hook-installer'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '../..')
const HOOK_SOURCE = join(REPO, 'scripts/hook/miniclaudio-hook.sh')

const TOKEN = 'c'.repeat(64)
const PUERTO = 45401

interface RunResult {
  code: number | null
  stdout: string
  stderr: string
  ms: number
}

/** Ejecuta el hook exactamente como lo hace Claude Code: payload por stdin. */
function runHook(home: string, payload: unknown): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const started = process.hrtime.bigint()
    const child = spawn('/bin/sh', [join(home, '.claude/miniclaudio/hook.sh')], {
      env: { ...process.env, HOME: home },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()))
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()))
    child.on('error', reject)
    child.on('close', (code) => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6
      resolve({ code, stdout, stderr, ms })
    })
    child.stdin.end(JSON.stringify(payload))
  })
}

describe('el hook no bloquea a Claude Code', () => {
  let home: string
  let installer: HookInstaller

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'miniclaudio-hook-'))
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(join(home, '.claude/settings.json'), '{}\n')
    installer = new HookInstaller({ home, hookSourcePath: HOOK_SOURCE })
    installer.ensureRuntimeFiles()
    // Token conocido, para poder comprobar que el servidor lo acepta.
    writeFileSync(installer.tokenPath, TOKEN, { mode: 0o600 })
    installer.writePort(PUERTO)
  })

  afterAll(() => {
    rmSync(home, { recursive: true, force: true })
  })

  it('CON miniClaudio CERRADO sale 0, sin salida y en un abrir y cerrar de ojos', async () => {
    const result = await runHook(home, { hook_event_name: 'Stop', session_id: 's1' })

    expect(result.code).toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('')
    // Cota generosa: en la práctica son pocos milisegundos (conexión rechazada).
    expect(result.ms).toBeLessThan(500)
  })

  it('sin fichero de puerto ni de token tampoco falla', async () => {
    rmSync(installer.portPath, { force: true })
    rmSync(installer.tokenPath, { force: true })
    const result = await runHook(home, { hook_event_name: 'Notification' })
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')

    // Se restauran para el resto de los tests.
    writeFileSync(installer.tokenPath, TOKEN, { mode: 0o600 })
    installer.writePort(PUERTO)
  })

  it('con un payload enorme y con caracteres raros sigue saliendo 0', async () => {
    const result = await runHook(home, {
      hook_event_name: 'UserPromptSubmit',
      prompt: `${'ñ'.repeat(5000)}\n"; rm -rf / #\n$(whoami)\n\`id\``
    })
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
  })

  it('CON el servidor levantado entrega el payload intacto y sigue siendo instantáneo', async () => {
    const received: NormalizedHookEvent[] = []
    const server = new EventServer({
      getToken: () => TOKEN,
      onEvent: (e) => received.push(e),
      version: '0.1.0',
      ports: [PUERTO]
    })
    const outcome = await server.start()
    expect(outcome.ok).toBe(true)
    server.setReady(true)

    try {
      const result = await runHook(home, {
        hook_event_name: 'Stop',
        session_id: 'sesion-real',
        cwd: '/Users/icatala/Projects/propios/miniClaudio',
        transcript_path: '/Users/icatala/.claude/projects/x/y.jsonl',
        permission_mode: 'auto',
        stop_hook_active: false
      })

      expect(result.code).toBe(0)
      expect(result.stdout).toBe('')
      expect(result.stderr).toBe('')
      expect(result.ms).toBeLessThan(1000)

      await new Promise((r) => setTimeout(r, 50))
      expect(received).toHaveLength(1)
      expect(received[0]?.event).toBe('Stop')
      expect(received[0]?.sessionId).toBe('sesion-real')
      expect(received[0]?.projectKey).toBe('-Users-icatala-Projects-propios-miniClaudio')
      expect(received[0]?.projectName).toBe('miniClaudio')
    } finally {
      await server.stop()
    }
  })

  it('el puerto se lee del fichero en cada invocación: cambiarlo es transparente', async () => {
    const otroPuerto = 45402
    const received: NormalizedHookEvent[] = []
    const server = new EventServer({
      getToken: () => TOKEN,
      onEvent: (e) => received.push(e),
      version: '0.1.0',
      ports: [otroPuerto]
    })
    await server.start()
    server.setReady(true)
    installer.writePort(otroPuerto)

    try {
      const result = await runHook(home, { hook_event_name: 'SessionStart', source: 'startup' })
      expect(result.code).toBe(0)
      await new Promise((r) => setTimeout(r, 50))
      expect(received.map((e) => e.event)).toEqual(['SessionStart'])
    } finally {
      await server.stop()
      installer.writePort(PUERTO)
    }
  })

  it('un token equivocado no hace ruido en Claude Code: 401 silencioso y exit 0', async () => {
    const received: NormalizedHookEvent[] = []
    const server = new EventServer({
      getToken: () => 'otro-token-distinto',
      onEvent: (e) => received.push(e),
      version: '0.1.0',
      ports: [PUERTO]
    })
    await server.start()
    server.setReady(true)

    try {
      const result = await runHook(home, { hook_event_name: 'Stop' })
      expect(result.code).toBe(0)
      expect(result.stderr).toBe('')
      await new Promise((r) => setTimeout(r, 50))
      expect(received).toHaveLength(0)
    } finally {
      await server.stop()
    }
  })

  it('el script declara su versión y cumple las cuatro salvaguardas del contrato', async () => {
    const { readFileSync } = await import('node:fs')
    const source = readFileSync(HOOK_SOURCE, 'utf8')

    expect(source.startsWith('#!/bin/sh')).toBe(true)
    expect(source).toContain('# miniclaudio-hook-version: 1')
    expect(source).toMatch(/-m 1/)
    expect(source).toMatch(/--connect-timeout 0\.3/)
    expect(source).toContain('--data-binary @-')
    expect(source.trimEnd().endsWith('exit 0')).toBe(true)
    // Se mira solo el código, no los comentarios (que sí mencionan `jq` para explicar
    // por qué no se usa).
    const code = source
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n')
    // Sin `set -e` y sin `jq`: un fallo intermedio no debe abortar antes del exit 0.
    expect(code).not.toMatch(/^\s*set -e/m)
    expect(code).not.toMatch(/\bjq\b/)
    // Sin -f: no queremos que curl escriba en stderr por un 4xx.
    expect(code).not.toMatch(/curl[^\n]*\s-f\b/)
  })

  it('la entrada que se instala en settings.json lleva async:true y timeout:2', async () => {
    await installer.install({ port: PUERTO, listening: true })
    const { readFileSync } = await import('node:fs')
    const settings = JSON.parse(readFileSync(installer.settingsPath, 'utf8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ async?: boolean; timeout?: number }> }>>
    }
    for (const groups of Object.values(settings.hooks)) {
      const nuestro = groups.at(-1)!.hooks[0]!
      expect(nuestro.async).toBe(true)
      expect(nuestro.timeout).toBe(2)
    }
  })
})
