/**
 * Orbix — Nivel B real: refresco de límites vía `claude -p "/usage"`.
 *
 * El punto abierto B2 (`live-usage.ts`) pedía un endpoint HTTP interno no documentado
 * y se dejó cerrado a propósito: mandar el token del usuario a una URL adivinada es
 * peor que no tener la función. `claude-code-guide` lo confirmó el 2026-09-04: no hay
 * endpoint público, y perseguir el interno va contra la propia recomendación oficial.
 *
 * Pero SÍ hay un camino soportado: `/usage` es un comando documentado
 * (code.claude.com/docs/en/costs) y funciona en modo no interactivo (`claude -p
 * "/usage"`), sin necesidad de pulsar «r» a mano. Verificado en la máquina de
 * Ismael el 2026-09-04: la salida de texto trae exactamente los mismos tres
 * porcentajes que `cachedUsageUtilization`, y el análisis de fecha de reinicio
 * ("Sep 4 at 12:20pm (Europe/Madrid)") se contrastó contra el JSON crudo real y
 * coincidió al segundo.
 *
 * Coste real: cada llamada consume una petición de la suscripción del usuario. Por
 * eso Nivel B sigue siendo opt-in (`prefs.levelBEnabled`, `false` por defecto) y con
 * intervalo mínimo de 1 minuto (`PREFS_LIMITS.levelBIntervalMs`), 20 minutos por
 * defecto — decisión explícita de Ismael, no un valor inventado.
 *
 * OJO con CÓMO se lanza (arreglado en 0.1.3). `execFile` hereda el directorio de
 * trabajo del padre, y una app de macOS abierta desde el Dock o al iniciar sesión
 * tiene `cwd = /`: cada sondeo arrancaba una sesión de Claude Code plantada en la
 * RAÍZ DEL DISCO, con los hooks y los servidores MCP del usuario. Como el proceso
 * era hijo de Orbix.app, macOS le atribuía a Orbix los permisos que pedía esa
 * sesión — de ahí el «Orbix quiere acceder a tu fototeca» que reportó Ismael el
 * 2026-09-08. Por eso ahora el sondeo va con `cwd` propio y vacío y con
 * `--strict-mcp-config`. Nada de esto es cosmético: sin ello Orbix carga con
 * permisos que no son suyos y ensucia `~/.claude/projects` con una sesión cada
 * `levelBIntervalMs`.
 *
 * Frágil por diseño: se interpreta texto para humanos, no JSON. Si Anthropic cambia
 * la redacción de `/usage`, `parseUsageOutput` puede dejar de reconocer las líneas y
 * `refresh()` fallará con `BAD_OUTPUT` — degradación silenciosa al Nivel A, igual que
 * cualquier otro fallo de Nivel B. Nunca lanza, nunca bloquea al usuario.
 */

import { execFile } from 'node:child_process'
import { accessSync, constants as fsConstants, mkdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { LEVEL_B_RETRY_MS } from '@shared/constants'
import type { LevelBStatus, LimitsView } from '@shared/types'

import { buildLimitsView, type CachedUsage } from './config-reader'

const execFileAsync = promisify(execFile)

// ---------------------------------------------------------------------------
// Localización del binario
// ---------------------------------------------------------------------------

/**
 * La app empaquetada, lanzada desde Finder/Dock (no desde una terminal), hereda un
 * `PATH` mínimo que casi nunca incluye dónde el usuario instaló `claude` — el clásico
 * problema de las apps de escritorio en macOS. Por eso se prueban rutas conocidas en
 * vez de fiarlo todo a `PATH`.
 */
function candidatePaths(): readonly string[] {
  const home = homedir()
  return [
    join(home, '.local/bin/claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    join(home, '.claude/local/claude'),
    join(home, '.npm-global/bin/claude')
  ]
}

/**
 * Argumentos del sondeo. `--strict-mcp-config` sin `--mcp-config` deja la sesión SIN
 * ningún servidor MCP: los del usuario no pintan nada aquí y arrancarlos cada
 * `levelBIntervalMs` es trabajo y superficie de permisos regalados.
 *
 * `--bare` haría más (también se saltaría los hooks), pero exige `ANTHROPIC_API_KEY`
 * y rompería la autenticación por suscripción, que es justo lo que se va a consultar.
 */
export const USAGE_ARGS: readonly string[] = ['--strict-mcp-config', '-p', '/usage']

/**
 * Directorio de trabajo del sondeo: propio, vacío y nuestro. NUNCA se hereda el del
 * padre (ver la cabecera del fichero). Si no se puede crear, `tmpdir()` — cualquier
 * cosa antes que `/` o el home del usuario.
 */
export function levelBWorkdir(home: string = homedir()): string {
  const dir = join(home, 'Library', 'Application Support', 'Orbix', 'levelb')
  try {
    mkdirSync(dir, { recursive: true })
    return dir
  } catch {
    return tmpdir()
  }
}

/** Memoizado: resolver rutas de fichero en cada llamada sería trabajo de sobra. */
let resolvedBinary: string | null | undefined

export function resolveClaudeBinary(): string | null {
  if (resolvedBinary !== undefined) return resolvedBinary
  for (const candidate of candidatePaths()) {
    try {
      accessSync(candidate, fsConstants.X_OK)
      resolvedBinary = candidate
      return candidate
    } catch {
      // Sigue probando la siguiente ruta.
    }
  }
  resolvedBinary = null
  return null
}

/** Solo para tests: fuerza a volver a resolver el binario. */
export function resetResolvedBinaryForTests(): void {
  resolvedBinary = undefined
}

export function isConfigured(): boolean {
  return resolveClaudeBinary() !== null
}

// ---------------------------------------------------------------------------
// Análisis del texto de `/usage`
// ---------------------------------------------------------------------------

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec'
] as const

/**
 * "12:20pm en Europe/Madrid" → instante UTC. Sin librería de zonas horarias: usa el
 * truco estándar de formatear una fecha candidata con `Intl.DateTimeFormat` en el
 * huso pedido y corregir por la diferencia. Converge en una iteración salvo en el
 * instante exacto de un cambio de hora, irrelevante aquí.
 */
function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string
): Date {
  const guessUtc = Date.UTC(year, month - 1, day, hour, minute)
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(new Date(guessUtc))
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0')
  const hour24 = get('hour') === 24 ? 0 : get('hour')
  const shownUtc = Date.UTC(get('year'), get('month') - 1, get('day'), hour24, get('minute'))
  return new Date(guessUtc + (guessUtc - shownUtc))
}

/** "Sep 4 at 12:20pm (Europe/Madrid)" / "Sep 6 at 10am (Europe/Madrid)" → ISO UTC. */
function parseResetsAt(text: string, now: Date): string | null {
  const m =
    /^([A-Z][a-z]{2}) (\d{1,2}) at (\d{1,2})(?::(\d{2}))?(am|pm) \(([^)]+)\)$/.exec(text.trim())
  if (!m) return null
  const [, monthName, dayStr, hourStr, minuteStr, meridiem, zone] = m
  const monthIdx = MONTHS.indexOf((monthName ?? '') as (typeof MONTHS)[number])
  if (monthIdx === -1 || zone === undefined) return null

  let hour = Number(hourStr) % 12
  if (meridiem === 'pm') hour += 12
  const minute = minuteStr !== undefined ? Number(minuteStr) : 0
  const day = Number(dayStr)
  const month = monthIdx + 1

  // El texto no trae año. Se asume el actual; si sale más de 180 días en el pasado
  // (imposible para un reinicio de verdad), es que ha cruzado a año nuevo.
  const year = now.getUTCFullYear()
  let resolved = zonedTimeToUtc(year, month, day, hour, minute, zone)
  if (now.getTime() - resolved.getTime() > 180 * 24 * 3600 * 1000) {
    resolved = zonedTimeToUtc(year + 1, month, day, hour, minute, zone)
  }
  return resolved.toISOString()
}

const SESSION_RE = /^Current session: (\d+)% used · resets (.+)$/
const WEEKLY_RE = /^Current week \(([^)]+)\): (\d+)% used · resets (.+)$/

/**
 * Interpreta la salida de `claude -p "/usage"` y produce el mismo `limits[]` que
 * `cachedUsageUtilization.utilization` — así se reutiliza `buildLimitsView`/`buildBars`
 * de `config-reader.ts` sin ningún cambio. Formato probado contra la salida real de
 * Ismael (2026-09-04): sesión + semanal total + semanal por modelo, en ese orden.
 */
export function parseUsageOutput(
  text: string,
  now: Date = new Date()
): Record<string, unknown>[] {
  const limits: Record<string, unknown>[] = []

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()

    const session = SESSION_RE.exec(line)
    if (session) {
      const [, percent, resetText] = session
      limits.push({
        kind: 'session',
        group: 'session',
        percent: Number(percent),
        severity: 'normal',
        resets_at: parseResetsAt(resetText ?? '', now),
        scope: null,
        is_active: false
      })
      continue
    }

    const weekly = WEEKLY_RE.exec(line)
    if (weekly) {
      const [, label, percent, resetText] = weekly
      const isAll = (label ?? '').toLowerCase() === 'all models'
      limits.push({
        kind: isAll ? 'weekly_all' : 'weekly_scoped',
        group: 'weekly',
        percent: Number(percent),
        severity: 'normal',
        resets_at: parseResetsAt(resetText ?? '', now),
        scope: isAll ? null : { model: { id: null, display_name: label } },
        is_active: isAll
      })
    }
  }

  return limits
}

// ---------------------------------------------------------------------------
// Ejecución
// ---------------------------------------------------------------------------

const USAGE_TIMEOUT_MS = 45_000
/** Salida de sobra: `/usage` incluye un análisis largo de "qué contribuye al uso". */
const MAX_BUFFER_BYTES = 2 * 1024 * 1024

export type CliUsageErrorCode = 'NOT_CONFIGURED' | 'SPAWN_ERROR' | 'TIMEOUT' | 'BAD_OUTPUT'

export type CliUsageResult =
  | { ok: true; utilization: Record<string, unknown>; fetchedAtMs: number }
  | { ok: false; code: CliUsageErrorCode; message: string }

/** Nunca lanza: cualquier fallo se devuelve como `{ ok: false }`. */
export async function fetchCliUsage(): Promise<CliUsageResult> {
  const bin = resolveClaudeBinary()
  if (bin === null) {
    return {
      ok: false,
      code: 'NOT_CONFIGURED',
      message: 'No se encontró el ejecutable de claude en las rutas conocidas'
    }
  }

  let stdout: string
  try {
    const result = await execFileAsync(bin, USAGE_ARGS as string[], {
      cwd: levelBWorkdir(),
      timeout: USAGE_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER_BYTES
    })
    stdout = result.stdout
  } catch (error) {
    const killed = typeof error === 'object' && error !== null && 'killed' in error
    return {
      ok: false,
      code: killed ? 'TIMEOUT' : 'SPAWN_ERROR',
      message: error instanceof Error ? error.message : 'Fallo al ejecutar claude -p "/usage"'
    }
  }

  const limits = parseUsageOutput(stdout)
  if (limits.length === 0) {
    return {
      ok: false,
      code: 'BAD_OUTPUT',
      message: 'La salida de /usage no tuvo el formato esperado (¿cambió la redacción?)'
    }
  }
  return { ok: true, utilization: { limits }, fetchedAtMs: Date.now() }
}

// ---------------------------------------------------------------------------
// Controlador — misma forma pública que `LiveUsage` (live-usage.ts)
// ---------------------------------------------------------------------------

export interface CliUsageOptions {
  /** Inyectable en tests, para no lanzar procesos de verdad. */
  fetchUsage?: () => Promise<CliUsageResult>
  /**
   * Inyectable en tests: sin esto, `available`/`setEnabled` dependerían de si la
   * máquina que ejecuta los tests tiene `claude` instalado — no determinista entre un
   * Mac de desarrollo (lo tiene) y CI (puede que no).
   */
  isConfigured?: () => boolean
  now?: () => number
}

/**
 * Igual que `LiveUsage` pero sin token: no hace falta, `claude -p` ya lleva su propia
 * autenticación. Mismo backoff de 30 min tras un fallo (`LEVEL_B_RETRY_MS`), para no
 * insistir en gastar peticiones si algo se ha roto.
 */
export class CliUsage {
  private enabled = false
  private lastResult: LevelBStatus['lastResult'] = 'never'
  private lastError: string | null = null
  private lastFailureAt: number | null = null

  /**
   * Último `utilization` obtenido de verdad por `/usage`, con su instante. Lo necesita
   * `ClaudeService` para persistir en `limits_snapshots` el payload DEL NIVEL B: antes
   * guardaba el del Nivel A con la etiqueta `live` y la fecha del Nivel B, es decir, un
   * dato rancio disfrazado de fresco justo en la tabla que sirve para rescatar el
   * arranque.
   */
  private lastSnapshot: CachedUsage | null = null

  private readonly fetchUsage: () => Promise<CliUsageResult>
  private readonly checkConfigured: () => boolean
  private readonly now: () => number

  constructor(options: CliUsageOptions = {}) {
    this.fetchUsage = options.fetchUsage ?? fetchCliUsage
    this.checkConfigured = options.isConfigured ?? isConfigured
    this.now = options.now ?? ((): number => Date.now())
  }

  get status(): LevelBStatus {
    return { enabled: this.enabled, lastResult: this.lastResult, lastError: this.lastError }
  }

  /** `null` mientras no haya habido ni un refresco con éxito. */
  get snapshot(): CachedUsage | null {
    return this.lastSnapshot
  }

  /** Si el binario de `claude` (o el sustituto inyectado en tests) se pudo localizar. */
  get available(): boolean {
    return this.checkConfigured()
  }

  /** `verified: true` solo si el binario de `claude` se pudo localizar. */
  setEnabled(enabled: boolean): { enabled: boolean; verified: boolean } {
    this.enabled = enabled
    return { enabled, verified: enabled && this.checkConfigured() }
  }

  stop(): void {
    // Sin estado que limpiar (a diferencia de `LiveUsage`, no hay token en memoria).
  }

  /**
   * Intenta refrescar. `null` si no procede (desactivado, sin binario, o en periodo de
   * espera tras un fallo): el llamador se queda con el Nivel A.
   */
  async refresh(options: { levelB?: LevelBStatus } = {}): Promise<LimitsView | null> {
    if (!this.enabled || !this.checkConfigured()) return null

    if (
      this.lastResult === 'failed' &&
      this.lastFailureAt !== null &&
      this.now() - this.lastFailureAt < LEVEL_B_RETRY_MS
    ) {
      return null
    }

    const result = await this.fetchUsage()
    if (!result.ok) {
      this.fail(result.message)
      return null
    }

    this.lastResult = 'ok'
    this.lastError = null
    this.lastFailureAt = null

    const cache: CachedUsage = {
      fetchedAtMs: result.fetchedAtMs,
      utilization: result.utilization
    }
    this.lastSnapshot = cache
    return buildLimitsView(cache, {
      source: 'live',
      levelB: options.levelB ?? this.status
    })
  }

  private fail(message: string): void {
    this.lastResult = 'failed'
    this.lastError = message
    this.lastFailureAt = this.now()
    // Degradación silenciosa: el fallo solo se ve en Preferencias, nunca en el menubar.
  }
}
