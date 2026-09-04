/**
 * miniClaudio — servidor HTTP local de eventos.
 *
 * Fuente de verdad: `docs/design/03-contrato-eventos.md` §2.
 *
 * REGLA DURA: **el hook nunca puede bloquear ni ralentizar a Claude Code.** Aquí se
 * materializa en que el manejador *responde antes de trabajar*: validar → 204 → cerrar →
 * `queueMicrotask(procesar)`. Escribir en `hook_events` y mover la máquina de estados
 * ocurre siempre después de haber cerrado la respuesta.
 *
 * MODELO DE AMENAZA: una página web abierta en el navegador haciendo CSRF / DNS rebinding
 * contra `localhost`. Mitigaciones (todas obligatorias, todas implementadas aquí):
 *   1. bind solo a 127.0.0.1
 *   2. `remoteAddress` debe ser loopback, o se corta el socket sin responder
 *   3. cabecera `Host` debe ser 127.0.0.1|localhost con nuestro puerto  → rompe el rebinding
 *   4. cualquier petición con `Origin` o `Referer` se rechaza (un hook nunca las manda)
 *   5. token compartido comparado con `timingSafeEqual`
 *   6. cero cabeceras CORS: aunque colara la petición, no podría leer la respuesta
 *   7. rate limit de 50 ev/s
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, get as httpGet, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import {
  ALLOWED_HOST_NAMES,
  APP_NAME,
  EVENT_PORT_CANDIDATES,
  EVENT_RATE_LIMIT_PER_SEC,
  EVENT_ROUTE,
  HEALTH_PROBE_TIMEOUT_MS,
  HEALTH_ROUTE,
  LOOPBACK_ADDRESSES,
  MAX_EVENT_BODY_BYTES,
  SERVER_HEADERS_TIMEOUT_MS,
  SERVER_KEEPALIVE_TIMEOUT_MS,
  SERVER_MAX_CONNECTIONS,
  SERVER_REQUEST_TIMEOUT_MS,
  TOKEN_HEADER
} from '@shared/constants'
import type { AppNotice } from '@shared/types'

import { parseHookBody, type NormalizedHookEvent } from './schema'

export interface EventServerOptions {
  /** Token compartido vigente. Se lee en cada petición para soportar rotación. */
  getToken: () => string | null
  /** Se invoca SIEMPRE fuera del ciclo de la respuesta. */
  onEvent: (event: NormalizedHookEvent) => void
  /** Avisos no fatales (`PORT_FALLBACK`, `PORT_UNAVAILABLE`). */
  onNotice?: (notice: AppNotice) => void
  /** Se llama en cuanto el `listen` tiene éxito, para reescribir `~/.claude/miniclaudio/port`. */
  onPort?: (port: number) => void
  /** Versión de la app, para `GET /health`. */
  version: string
  /** Puertos a probar, en orden. Por defecto 41414…41424. */
  ports?: readonly number[]
}

export type StartOutcome =
  | { ok: true; port: number; fallback: boolean }
  | {
      ok: false
      reason: 'other-instance'
      port: number
      /** Datos de la instancia viva, para poder decir a quién hay que cerrar. */
      peer: { pid: number; version: string; instanceId: string }
    }
  | { ok: false; reason: 'no-port' }

interface HealthBody {
  app: string
  version: string
  pid: number
  port: number
  ready: boolean
  instanceId: string
}

export class EventServer {
  private readonly options: EventServerOptions
  private readonly ports: readonly number[]
  readonly instanceId: string

  private server: Server | null = null
  private boundPort: number | null = null
  private ready = false

  /** Ventana de rate limit de 1 s. */
  private windowStart = 0
  private windowCount = 0

  readonly counters = {
    accepted: 0,
    rejected: 0,
    droppedByRateLimit: 0
  }

  constructor(options: EventServerOptions) {
    this.options = options
    this.ports = options.ports ?? EVENT_PORT_CANDIDATES
    this.instanceId = randomBytes(8).toString('hex')
  }

  get port(): number | null {
    return this.boundPort
  }

  get listening(): boolean {
    return this.server !== null && this.server.listening
  }

  /** Mientras sea `false`, `POST /event` responde 503. */
  setReady(ready: boolean): void {
    this.ready = ready
  }

  // -------------------------------------------------------------------------
  // Arranque con fallback de puerto (§2.4)
  // -------------------------------------------------------------------------

  async start(): Promise<StartOutcome> {
    const [preferred, ...rest] = this.ports
    if (preferred === undefined) return { ok: false, reason: 'no-port' }

    for (const [index, port] of [preferred, ...rest].entries()) {
      const result = await this.tryListen(port)

      if (result === 'ok') {
        this.boundPort = port
        this.options.onPort?.(port)
        if (index > 0) {
          this.options.onNotice?.({
            level: 'warn',
            code: 'PORT_FALLBACK',
            message: `El puerto ${preferred} estaba ocupado; usando ${port}.`
          })
        }
        return { ok: true, port, fallback: index > 0 }
      }

      if (result === 'in-use' && index === 0) {
        // ¿Lo ocupa otra instancia nuestra o un programa cualquiera?
        const health = await probeHealth(port)
        if (health !== null && health.app === APP_NAME && health.instanceId !== this.instanceId) {
          return {
            ok: false,
            reason: 'other-instance',
            port,
            peer: {
              pid: typeof health.pid === 'number' ? health.pid : 0,
              version: typeof health.version === 'string' ? health.version : '?',
              instanceId: typeof health.instanceId === 'string' ? health.instanceId : '?'
            }
          }
        }
      }
      // 'in-use' o 'error': seguimos con el siguiente puerto.
    }

    this.options.onNotice?.({
      level: 'error',
      code: 'PORT_UNAVAILABLE',
      message:
        'No hay ningún puerto libre entre 41414 y 41424. La mascota no recibirá eventos, ' +
        'pero la contabilidad de tokens sigue funcionando.'
    })
    return { ok: false, reason: 'no-port' }
  }

  private tryListen(port: number): Promise<'ok' | 'in-use' | 'error'> {
    return new Promise((resolvePromise) => {
      const server = createServer((req, res) => {
        this.handle(req, res)
      })

      server.headersTimeout = SERVER_HEADERS_TIMEOUT_MS
      server.requestTimeout = SERVER_REQUEST_TIMEOUT_MS
      server.keepAliveTimeout = SERVER_KEEPALIVE_TIMEOUT_MS
      server.maxConnections = SERVER_MAX_CONNECTIONS

      const onError = (error: NodeJS.ErrnoException): void => {
        server.removeListener('listening', onListening)
        server.close()
        resolvePromise(error.code === 'EADDRINUSE' || error.code === 'EACCES' ? 'in-use' : 'error')
      }
      const onListening = (): void => {
        server.removeListener('error', onError)
        // Los errores posteriores no deben tumbar el proceso.
        server.on('error', () => {})
        this.server = server
        resolvePromise('ok')
      }

      server.once('error', onError)
      server.once('listening', onListening)
      // NUNCA 0.0.0.0: solo loopback.
      server.listen(port, '127.0.0.1')
    })
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    this.boundPort = null
    if (server === null) return
    await new Promise<void>((res) => {
      server.close(() => res())
      // Cerrar conexiones keep-alive pendientes para no retrasar la salida.
      server.closeAllConnections?.()
    })
  }

  // -------------------------------------------------------------------------
  // Manejador
  // -------------------------------------------------------------------------

  private handle(req: IncomingMessage, res: ServerResponse): void {
    // (2) Solo loopback. Si no, se corta el socket sin responder nada.
    const remote = req.socket.remoteAddress ?? ''
    if (!LOOPBACK_ADDRESSES.includes(remote)) {
      req.socket.destroy()
      return
    }

    // (4) Un hook nunca manda Origin ni Referer; un navegador siempre.
    if (req.headers.origin !== undefined || req.headers.referer !== undefined) {
      this.deny(res, 403)
      return
    }

    // (3) Host debe ser loopback con nuestro puerto: rompe el DNS rebinding.
    if (!this.isHostAllowed(req.headers.host)) {
      this.deny(res, 403)
      return
    }

    const path = (req.url ?? '').split('?')[0] ?? ''

    if (req.method === 'GET' && path === HEALTH_ROUTE) {
      this.respondHealth(res)
      return
    }

    if (req.method === 'POST' && path === EVENT_ROUTE) {
      this.handleEvent(req, res)
      return
    }

    // Cualquier otra ruta o método.
    this.deny(res, 404)
  }

  private isHostAllowed(host: string | undefined): boolean {
    if (host === undefined) return false
    const lastColon = host.lastIndexOf(':')
    const name = lastColon === -1 ? host : host.slice(0, lastColon)
    const portText = lastColon === -1 ? null : host.slice(lastColon + 1)
    if (!ALLOWED_HOST_NAMES.includes(name.toLowerCase())) return false
    if (portText === null) return false
    return this.boundPort === null || Number(portText) === this.boundPort
  }

  private handleEvent(req: IncomingMessage, res: ServerResponse): void {
    if (!this.ready) {
      this.deny(res, 503)
      return
    }

    // (5) Token compartido, comparado en tiempo constante.
    if (!this.isTokenValid(req.headers[TOKEN_HEADER])) {
      this.deny(res, 401)
      return
    }

    const contentType = String(req.headers['content-type'] ?? '')
    if (!contentType.toLowerCase().includes('application/json')) {
      this.deny(res, 415)
      return
    }

    // (7) Rate limit: por encima de 50 ev/s se descarta y se cuenta el exceso.
    // Se responde 204 igualmente: el hook no debe ver errores por nuestra congestión.
    if (!this.allowRate()) {
      this.counters.droppedByRateLimit += 1
      req.resume()
      this.deny(res, 204)
      return
    }

    const chunks: Buffer[] = []
    let size = 0
    let finished = false

    req.on('data', (chunk: Buffer) => {
      if (finished) return
      size += chunk.length
      if (size > MAX_EVENT_BODY_BYTES) {
        finished = true
        this.deny(res, 413)
        req.socket.destroy() // se corta la conexión, como manda el contrato
        return
      }
      chunks.push(chunk)
    })

    req.on('error', () => {
      finished = true
    })

    req.on('end', () => {
      if (finished) return
      finished = true

      const raw = Buffer.concat(chunks).toString('utf8')
      const parsed = parseHookBody(raw)
      if (!parsed.ok) {
        this.counters.rejected += 1
        this.deny(res, 400)
        return
      }

      // ORDEN OBLIGATORIO: responder ANTES de trabajar.
      this.counters.accepted += 1
      res.writeHead(204)
      res.end()

      const event = parsed.value
      queueMicrotask(() => {
        try {
          this.options.onEvent(event)
        } catch {
          // Un fallo procesando jamás puede propagarse: la respuesta ya se envió.
        }
      })
    })
  }

  private isTokenValid(received: string | string[] | undefined): boolean {
    const expected = this.options.getToken()
    if (expected === null || expected.length === 0) return false
    const value = Array.isArray(received) ? received[0] : received
    if (typeof value !== 'string' || value.length === 0) return false
    // Se comparan digests para no filtrar la longitud y para que `timingSafeEqual`
    // reciba siempre buffers del mismo tamaño.
    const a = createHash('sha256').update(value).digest()
    const b = createHash('sha256').update(expected).digest()
    return timingSafeEqual(a, b)
  }

  private allowRate(): boolean {
    const now = Date.now()
    if (now - this.windowStart >= 1000) {
      this.windowStart = now
      this.windowCount = 0
    }
    this.windowCount += 1
    return this.windowCount <= EVENT_RATE_LIMIT_PER_SEC
  }

  private respondHealth(res: ServerResponse): void {
    const body: HealthBody = {
      app: APP_NAME,
      version: this.options.version,
      pid: process.pid,
      port: this.boundPort ?? 0,
      ready: this.ready,
      instanceId: this.instanceId
    }
    const text = JSON.stringify(body)
    // (6) Cero cabeceras CORS, a propósito.
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(text),
      'cache-control': 'no-store'
    })
    res.end(text)
  }

  /** Respuesta de cuerpo vacío. Sin CORS, sin detalles, sin filtrar nada. */
  private deny(res: ServerResponse, status: number): void {
    if (status >= 400) this.counters.rejected += 1
    try {
      // Un 204 no lleva `content-length`; el resto sí, para que el cuerpo vacío sea explícito.
      if (status === 204) res.writeHead(204)
      else res.writeHead(status, { 'content-length': 0 })
      res.end()
    } catch {
      // El socket ya estaba cerrado (p. ej. tras un cuerpo demasiado grande).
    }
  }
}

// ---------------------------------------------------------------------------
// Sonda de identidad
// ---------------------------------------------------------------------------

/** `GET /health` con timeout corto. `null` si no responde o no es JSON nuestro. */
export function probeHealth(port: number): Promise<HealthBody | null> {
  return new Promise((resolvePromise) => {
    let settled = false
    const done = (value: HealthBody | null): void => {
      if (settled) return
      settled = true
      resolvePromise(value)
    }

    const req = httpGet(
      {
        host: '127.0.0.1',
        port,
        path: HEALTH_ROUTE,
        timeout: HEALTH_PROBE_TIMEOUT_MS,
        headers: { host: `127.0.0.1:${port}` }
      },
      (res) => {
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (c: Buffer) => {
          size += c.length
          if (size > 8192) {
            res.destroy()
            done(null)
            return
          }
          chunks.push(c)
        })
        res.on('end', () => {
          try {
            const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            if (parsed !== null && typeof parsed === 'object') done(parsed as HealthBody)
            else done(null)
          } catch {
            done(null)
          }
        })
      }
    )

    req.on('timeout', () => {
      req.destroy()
      done(null)
    })
    req.on('error', () => done(null))
  })
}

/**
 * Explica, en lenguaje de persona, por qué esta instancia no puede seguir.
 *
 * Un arranque que termina sin decir por qué es un bug latente aunque el motivo sea
 * legítimo: en este proyecto ya ha pasado dos veces (el zombi del BUG-1 y el fallo de
 * permisos disfrazado de «ya hay otra instancia»). Aquí el diagnóstico es trivial de dar,
 * así que se da: causa, quién ocupa el puerto y qué hacer.
 */
export function describePortConflict(outcome: StartOutcome): string[] {
  if (outcome.ok || outcome.reason !== 'other-instance') return []
  const { port, peer } = outcome
  return [
    `[arranque] El puerto ${String(port)} ya lo tiene otra instancia de ${APP_NAME} ` +
      `(PID ${String(peer.pid)}, versión ${peer.version}).`,
    '[arranque] Esta copia se cierra para no duplicar la contabilidad ni pelearse por la ' +
      'base de datos.',
    `[arranque] Qué hacer: cierra la otra instancia (su menú «Salir», o el PID ${String(peer.pid)} ` +
      'en el Monitor de Actividad) y vuelve a abrir esta.',
    '[arranque] Suele pasar al levantar la copia de desarrollo teniendo abierta la instalada.'
  ]
}