/** Tests de validación y normalización de los payloads de hook (03 §3 y §6.2). */

import { describe, expect, it } from 'vitest'

import {
  isToolError,
  parseHookBody,
  sanitizeText,
  toProjectKey,
  toProjectName,
  truncateUtf8
} from '../../src/main/events/schema'

const NOW = new Date('2026-09-03T09:00:00.000Z')

function parse(body: unknown) {
  return parseHookBody(typeof body === 'string' ? body : JSON.stringify(body), NOW)
}

describe('parseHookBody — rechazos', () => {
  it('rechaza JSON inválido', () => {
    expect(parse('{no soy json')).toEqual({ ok: false, code: 'BAD_JSON' })
  })

  it('rechaza arrays, primitivos y null', () => {
    for (const body of ['[]', '"hola"', '42', 'null', 'true']) {
      expect(parse(body).ok).toBe(false)
    }
  })

  it('rechaza si falta hook_event_name o no es string', () => {
    expect(parse({ session_id: 'x' })).toEqual({ ok: false, code: 'BAD_SHAPE' })
    expect(parse({ hook_event_name: 42 })).toEqual({ ok: false, code: 'BAD_SHAPE' })
    expect(parse({ hook_event_name: '' })).toEqual({ ok: false, code: 'BAD_SHAPE' })
    expect(parse({ hook_event_name: '   ' })).toEqual({ ok: false, code: 'BAD_SHAPE' })
  })

  it('rechaza hook_event_name de más de 64 caracteres', () => {
    expect(parse({ hook_event_name: 'A'.repeat(65) })).toEqual({ ok: false, code: 'BAD_SHAPE' })
    expect(parse({ hook_event_name: 'A'.repeat(64) }).ok).toBe(true)
  })
})

describe('parseHookBody — derivados que calcula el servidor', () => {
  it('deriva project_key, project_name y ts del cwd y de la hora de recepción', () => {
    const result = parse({
      hook_event_name: 'Stop',
      session_id: 'sess-1',
      cwd: '/Users/icatala/Projects/propios/miniClaudio'
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value.projectPath).toBe('/Users/icatala/Projects/propios/miniClaudio')
    // Coincide con el nombre del directorio de ~/.claude/projects/ (verificado).
    expect(result.value.projectKey).toBe('-Users-icatala-Projects-propios-miniClaudio')
    expect(result.value.projectName).toBe('miniClaudio')
    expect(result.value.ts).toBe('2026-09-03T09:00:00.000Z')
    expect(result.value.tsEpoch).toBe(NOW.getTime())
    expect(result.value.known).toBe(true)
  })

  it('sin cwd, el proyecto es "Claude" y la clave null', () => {
    const result = parse({ hook_event_name: 'Notification' })
    if (!result.ok) throw new Error('debería parsear')
    expect(result.value.projectName).toBe('Claude')
    expect(result.value.projectKey).toBeNull()
  })

  it('marca como desconocido un evento futuro, pero lo parsea igual', () => {
    const result = parse({ hook_event_name: 'FutureEventV9', cwd: '/tmp/x' })
    if (!result.ok) throw new Error('debería parsear')
    expect(result.value.known).toBe(false)
    expect(result.value.event).toBe('FutureEventV9')
  })
})

describe('parseHookBody — recortes y saneado', () => {
  it('recorta message a 500, tool_name a 64, reason a 128 y cwd a 512', () => {
    const result = parse({
      hook_event_name: 'Notification',
      message: 'm'.repeat(900),
      tool_name: 't'.repeat(200),
      reason: 'r'.repeat(400),
      cwd: `/${'c'.repeat(900)}`
    })
    if (!result.ok) throw new Error('debería parsear')
    expect(result.value.message).toHaveLength(500)
    expect(result.value.toolName).toHaveLength(64)
    expect(result.value.reason).toHaveLength(128)
    expect(result.value.projectPath).toHaveLength(512)
  })

  it('elimina los caracteres de control pero conserva tab y salto de línea', () => {
    expect(sanitizeText('a\x00b\x1Fc\x08', 100)).toBe('abc')
    expect(sanitizeText('linea1\nlinea2\tfin', 100)).toBe('linea1\nlinea2\tfin')
    expect(sanitizeText('   ', 100)).toBeNull()
    expect(sanitizeText(42, 100)).toBeNull()
  })

  it('recorta raw_json a 8 KiB sin partir caracteres multibyte', () => {
    const result = parse({ hook_event_name: 'Stop', prompt: 'á'.repeat(20_000) })
    if (!result.ok) throw new Error('debería parsear')
    expect(Buffer.byteLength(result.value.rawJson, 'utf8')).toBeLessThanOrEqual(8 * 1024)
    expect(result.value.rawJson).not.toContain('�')
  })

  it('truncateUtf8 no parte un emoji', () => {
    const text = '👋'.repeat(10)
    const cut = truncateUtf8(text, 9) // 2 emojis = 8 bytes; el tercero no cabe entero
    expect(Buffer.byteLength(cut, 'utf8')).toBeLessThanOrEqual(9)
    expect(cut).toBe('👋👋')
  })

  it('el raw_json escapa el contenido: nada se interpreta ni se ejecuta', () => {
    const result = parse({ hook_event_name: 'Stop', message: '"; rm -rf / #' })
    if (!result.ok) throw new Error('debería parsear')
    expect(() => JSON.parse(result.value.rawJson) as unknown).not.toThrow()
  })
})

describe('isToolError — heurística tolerante (punto abierto C1)', () => {
  it('detecta los errores explícitos', () => {
    expect(isToolError({ is_error: true })).toBe(true)
    expect(isToolError({ isError: true })).toBe(true)
    expect(isToolError({ error: 'boom' })).toBe(true)
    expect(isToolError({ success: false })).toBe(true)
    expect(isToolError({ exit_code: 1 })).toBe(true)
    expect(isToolError('Error: no such file')).toBe(true)
    expect(isToolError('<tool_use_error>nope</tool_use_error>')).toBe(true)
  })

  it('ante la duda devuelve false (un falso positivo es peor)', () => {
    expect(isToolError(null)).toBe(false)
    expect(isToolError(undefined)).toBe(false)
    expect(isToolError({})).toBe(false)
    expect(isToolError({ exit_code: 0 })).toBe(false)
    expect(isToolError({ error: '' })).toBe(false)
    expect(isToolError({ success: true })).toBe(false)
    expect(isToolError('todo bien')).toBe(false)
    expect(isToolError(['error'])).toBe(false)
    expect(isToolError(123)).toBe(false)
  })

  it('una herramienta interrumpida por el usuario no es un error', () => {
    expect(isToolError({ interrupted: true })).toBe(false)
  })

  it('solo se evalúa en PostToolUse', () => {
    const pre = parse({ hook_event_name: 'PreToolUse', tool_response: { is_error: true } })
    if (!pre.ok) throw new Error('debería parsear')
    expect(pre.value.isError).toBe(false)

    const post = parse({ hook_event_name: 'PostToolUse', tool_response: { is_error: true } })
    if (!post.ok) throw new Error('debería parsear')
    expect(post.value.isError).toBe(true)
  })
})

describe('derivados de proyecto', () => {
  it('toProjectKey usa el mismo formato que ~/.claude/projects', () => {
    expect(toProjectKey('/Users/icatala/Projects/propios/miniClaudio')).toBe(
      '-Users-icatala-Projects-propios-miniClaudio'
    )
  })

  it('toProjectName cae a "Claude" cuando no hay ruta', () => {
    expect(toProjectName(null)).toBe('Claude')
    expect(toProjectName('/')).toBe('Claude')
    expect(toProjectName('/a/b/proyecto')).toBe('proyecto')
  })
})
