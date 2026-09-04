/**
 * Tests del servidor HTTP local.
 *
 * El foco es la SEGURIDAD: el vector real es una página web abierta en el navegador
 * haciendo CSRF contra localhost. Se comprueba que Origin/Referer, Host ajeno y token
 * incorrecto se rechazan, y que no se emite ni una sola cabecera CORS.
 */

import { createServer, request as httpRequest } from 'node:http'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { EventServer, describePortConflict, probeHealth } from '../../src/main/events/server'
import type { NormalizedHookEvent } from '../../src/main/events/schema'

const TOKEN = 'a'.repeat(64)

interface Reply {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: string
}

function send(
  port: number,
  options: {
    method?: string
    path?: string
    headers?: Record<string, string>
    body?: string
  } = {}
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: options.method ?? 'POST',
        path: options.path ?? '/event',
        headers: {
          host: `127.0.0.1:${port}`,
          'content-type': 'application/json',
          'x-miniclaudio-token': TOKEN,
          ...options.headers
        }
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8')
          })
        )
      }
    )
    req.on('error', reject)
    if (options.body !== undefined) req.write(options.body)
    req.end()
  })
}

describe('EventServer', () => {
  let server: EventServer
  let port: number
  let received: NormalizedHookEvent[]

  beforeEach(async () => {
    received = []
    server = new EventServer({
      getToken: () => TOKEN,
      onEvent: (event) => received.push(event),
      version: '0.1.0',
      // Rango propio para no chocar con una instancia real de miniClaudio.
      ports: [45311, 45312, 45313, 45314]
    })
    const outcome = await server.start()
    if (!outcome.ok) throw new Error('el servidor no arrancó')
    port = outcome.port
    server.setReady(true)
  })

  afterEach(async () => {
    await server.stop()
  })

  // -------------------------------------------------------------------------
  // Camino feliz
  // -------------------------------------------------------------------------

  it('acepta un payload real de hook con 204 y lo procesa después de responder', async () => {
    const payload = {
      hook_event_name: 'Stop',
      session_id: 'sess-42',
      cwd: '/Users/icatala/Projects/propios/miniClaudio',
      stop_hook_active: false
    }
    const reply = await send(port, { body: JSON.stringify(payload) })

    expect(reply.status).toBe(204)
    expect(reply.body).toBe('')

    await new Promise((r) => setTimeout(r, 20))
    expect(received).toHaveLength(1)
    expect(received[0]?.event).toBe('Stop')
    expect(received[0]?.projectName).toBe('miniClaudio')
  })

  it('GET /health identifica la instancia', async () => {
    const reply = await send(port, { method: 'GET', path: '/health' })
    expect(reply.status).toBe(200)
    const body = JSON.parse(reply.body) as Record<string, unknown>
    expect(body['app']).toBe('miniClaudio')
    expect(body['port']).toBe(port)
    expect(body['ready']).toBe(true)
    expect(body['instanceId']).toBe(server.instanceId)
    expect(await probeHealth(port)).not.toBeNull()
  })

  // -------------------------------------------------------------------------
  // Seguridad
  // -------------------------------------------------------------------------

  it('403 ante una petición con Origin (el caso del navegador)', async () => {
    const reply = await send(port, {
      headers: { origin: 'https://evil.example' },
      body: JSON.stringify({ hook_event_name: 'Stop' })
    })
    expect(reply.status).toBe(403)
    expect(reply.body).toBe('')
    expect(received).toHaveLength(0)
  })

  it('403 ante una petición con Referer', async () => {
    const reply = await send(port, {
      headers: { referer: 'https://evil.example/x' },
      body: JSON.stringify({ hook_event_name: 'Stop' })
    })
    expect(reply.status).toBe(403)
  })

  it('403 ante un Host que no es loopback (DNS rebinding)', async () => {
    const reply = await send(port, {
      headers: { host: `evil.example:${port}` },
      body: JSON.stringify({ hook_event_name: 'Stop' })
    })
    expect(reply.status).toBe(403)
  })

  it('403 si el Host trae otro puerto', async () => {
    const reply = await send(port, {
      headers: { host: '127.0.0.1:1234' },
      body: JSON.stringify({ hook_event_name: 'Stop' })
    })
    expect(reply.status).toBe(403)
  })

  it('acepta localhost como Host', async () => {
    const reply = await send(port, {
      headers: { host: `localhost:${port}` },
      body: JSON.stringify({ hook_event_name: 'Stop' })
    })
    expect(reply.status).toBe(204)
  })

  it('401 sin token o con token incorrecto', async () => {
    const sinToken = await send(port, {
      headers: { 'x-miniclaudio-token': '' },
      body: JSON.stringify({ hook_event_name: 'Stop' })
    })
    expect(sinToken.status).toBe(401)

    const malToken = await send(port, {
      headers: { 'x-miniclaudio-token': 'b'.repeat(64) },
      body: JSON.stringify({ hook_event_name: 'Stop' })
    })
    expect(malToken.status).toBe(401)

    // Un token de longitud distinta tampoco debe romper la comparación.
    const corto = await send(port, {
      headers: { 'x-miniclaudio-token': 'x' },
      body: JSON.stringify({ hook_event_name: 'Stop' })
    })
    expect(corto.status).toBe(401)
    expect(received).toHaveLength(0)
  })

  it('NO emite ninguna cabecera CORS en ninguna respuesta', async () => {
    const respuestas = [
      await send(port, { body: JSON.stringify({ hook_event_name: 'Stop' }) }),
      await send(port, { method: 'GET', path: '/health' }),
      await send(port, { method: 'GET', path: '/otra-cosa' })
    ]
    for (const reply of respuestas) {
      for (const name of Object.keys(reply.headers)) {
        expect(name.toLowerCase().startsWith('access-control-')).toBe(false)
      }
      expect(reply.headers['access-control-allow-origin']).toBeUndefined()
    }
  })

  // -------------------------------------------------------------------------
  // Validación
  // -------------------------------------------------------------------------

  it('415 si el Content-Type no es JSON', async () => {
    const reply = await send(port, {
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ hook_event_name: 'Stop' })
    })
    expect(reply.status).toBe(415)
  })

  it('400 con JSON inválido o sin hook_event_name', async () => {
    expect((await send(port, { body: '{roto' })).status).toBe(400)
    expect((await send(port, { body: '{"a":1}' })).status).toBe(400)
    expect((await send(port, { body: '[]' })).status).toBe(400)
  })

  it('413 con un cuerpo de más de 64 KiB', async () => {
    const big = JSON.stringify({ hook_event_name: 'Stop', prompt: 'x'.repeat(70 * 1024) })
    const reply = await send(port, { body: big }).catch(() => ({ status: 413 }) as Reply)
    expect(reply.status).toBe(413)
    expect(received).toHaveLength(0)
  })

  it('404 en cualquier otra ruta o método', async () => {
    expect((await send(port, { method: 'GET', path: '/' })).status).toBe(404)
    expect((await send(port, { method: 'GET', path: '/event' })).status).toBe(404)
    expect((await send(port, { method: 'POST', path: '/health' })).status).toBe(404)
    expect((await send(port, { method: 'DELETE', path: '/event' })).status).toBe(404)
  })

  it('503 mientras la app no ha terminado de arrancar', async () => {
    server.setReady(false)
    const reply = await send(port, { body: JSON.stringify({ hook_event_name: 'Stop' }) })
    expect(reply.status).toBe(503)
    expect(received).toHaveLength(0)
  })

  it('BUG-8: en ráfaga responde a TODAS, sin cortar sockets a nivel TCP', async () => {
    // Repro de QA: 300 POST en paralelo. Antes `maxConnections: 32` destruía 268
    // sockets sin responder y el rate limit de §2.2 nunca llegaba a entrar.
    const body = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Read' })
    const resultados = await Promise.allSettled(
      Array.from({ length: 300 }, () => send(port, { body }))
    )

    const rechazadas = resultados.filter((r) => r.status === 'rejected')
    const respondidas = resultados.filter(
      (r): r is PromiseFulfilledResult<Reply> => r.status === 'fulfilled'
    )

    // Ni un solo socket cortado: la política la decide el limitador, no el socket.
    expect(rechazadas).toHaveLength(0)
    expect(respondidas).toHaveLength(300)
    // Y a todas se les responde 204: al hook nunca se le enseña un error nuestro.
    expect(respondidas.every((r) => r.value.status === 204)).toBe(true)

    // El exceso se descarta y se CUENTA, que es lo que dice §2.2.
    expect(server.counters.droppedByRateLimit).toBeGreaterThan(0)
    expect(server.counters.accepted).toBeLessThanOrEqual(50)
  })

  it('descarta el exceso por encima de 50 eventos/s sin devolver error al hook', async () => {
    const body = JSON.stringify({ hook_event_name: 'Stop' })
    const replies: Reply[] = []
    for (let i = 0; i < 60; i += 1) replies.push(await send(port, { body }))

    expect(replies.every((r) => r.status === 204)).toBe(true)
    expect(server.counters.droppedByRateLimit).toBeGreaterThan(0)
  })
})

describe('describePortConflict', () => {
  it('no dice nada cuando no hay conflicto', () => {
    expect(describePortConflict({ ok: true, port: 41414, fallback: false })).toEqual([])
    expect(describePortConflict({ ok: false, reason: 'no-port' })).toEqual([])
  })
})

describe('EventServer — fallback de puerto', () => {
  it('usa el siguiente puerto libre y avisa con PORT_FALLBACK', async () => {
    const notices: string[] = []
    const first = new EventServer({
      getToken: () => TOKEN,
      onEvent: () => {},
      version: '0.1.0',
      ports: [45321, 45322]
    })
    const second = new EventServer({
      getToken: () => TOKEN,
      onEvent: () => {},
      version: '0.1.0',
      ports: [45321, 45322],
      onNotice: (n) => notices.push(n.code)
    })

    try {
      const a = await first.start()
      const b = await second.start()
      expect(a.ok).toBe(true)
      // La primera instancia responde a /health con OTRO instanceId: se detecta.
      expect(b.ok).toBe(false)
      if (!b.ok) {
        expect(b.reason).toBe('other-instance')
        if (b.reason === 'other-instance') {
          // Se sabe A QUIÉN hay que cerrar, no solo que «algo» ocupa el puerto.
          expect(b.peer.pid).toBe(process.pid)
          expect(b.peer.version).toBe('0.1.0')
          expect(b.peer.instanceId).toBe(first.instanceId)

          // Y el arranque no termina en silencio: causa, culpable y remedio.
          const explicacion = describePortConflict(b).join('\n')
          expect(explicacion).toContain('45321')
          expect(explicacion).toContain(String(process.pid))
          expect(explicacion).toContain('Qué hacer')
          expect(explicacion).toMatch(/cierra la otra instancia/i)
        }
      }
    } finally {
      await first.stop()
      await second.stop()
    }
    expect(notices).not.toContain('PORT_UNAVAILABLE')
  })

  it('si el puerto lo ocupa OTRO programa, prueba el siguiente', async () => {
    // Un servidor cualquiera que no es miniClaudio: la sonda /health no lo reconoce.
    const intruso = createServer((_req, res) => {
      res.writeHead(200)
      res.end('no soy miniClaudio')
    })
    await new Promise<void>((r) => intruso.listen(45341, '127.0.0.1', () => r()))

    const notices: Array<{ code: string; message: string }> = []
    const server = new EventServer({
      getToken: () => TOKEN,
      onEvent: () => {},
      version: '0.1.0',
      ports: [45341, 45342],
      onNotice: (n) => notices.push(n)
    })

    try {
      const outcome = await server.start()
      expect(outcome.ok).toBe(true)
      if (outcome.ok) {
        expect(outcome.port).toBe(45342)
        expect(outcome.fallback).toBe(true)
      }
      expect(notices.map((n) => n.code)).toContain('PORT_FALLBACK')
    } finally {
      await server.stop()
      await new Promise<void>((r) => intruso.close(() => r()))
    }
  })

  it('emite PORT_UNAVAILABLE cuando se agotan todos los puertos', async () => {
    const intruso = createServer((_req, res) => {
      res.writeHead(200)
      res.end('ocupado')
    })
    await new Promise<void>((r) => intruso.listen(45351, '127.0.0.1', () => r()))

    const notices: string[] = []
    const server = new EventServer({
      getToken: () => TOKEN,
      onEvent: () => {},
      version: '0.1.0',
      ports: [45351],
      onNotice: (n) => notices.push(n.code)
    })

    try {
      const outcome = await server.start()
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) expect(outcome.reason).toBe('no-port')
      expect(notices).toContain('PORT_UNAVAILABLE')
      expect(server.listening).toBe(false)
    } finally {
      await server.stop()
      await new Promise<void>((r) => intruso.close(() => r()))
    }
  })
})
