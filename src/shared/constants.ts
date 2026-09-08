/**
 * Orbix — constantes compartidas: puerto, rutas relativas y ventanas de tiempo.
 *
 * REGLA DURA: sin imports de `node:*` ni de `electron`. Las rutas se expresan como
 * fragmentos RELATIVOS al home; quien tiene `node:path` (el proceso `main`) las resuelve.
 */

import type { Corner, PeriodKey, Prefs } from './types'

// ---------------------------------------------------------------------------
// Identidad
// ---------------------------------------------------------------------------

export const APP_NAME = 'Orbix'
export const APP_ID = 'com.icatala.orbix'

// ---------------------------------------------------------------------------
// Servidor de eventos (03-contrato-eventos.md §2)
// ---------------------------------------------------------------------------

export const DEFAULT_EVENT_PORT = 41414
export const EVENT_PORT_FALLBACK_COUNT = 10

/** 41414 … 41424: el preferido más los diez de reserva. */
export const EVENT_PORT_CANDIDATES: readonly number[] = Object.freeze(
  Array.from({ length: EVENT_PORT_FALLBACK_COUNT + 1 }, (_, i) => DEFAULT_EVENT_PORT + i)
)

export const EVENT_ROUTE = '/event'
export const HEALTH_ROUTE = '/health'

export const TOKEN_HEADER = 'x-orbix-token'
/** Con la capitalización que usa el script del hook (las cabeceras HTTP son insensibles). */
export const TOKEN_HEADER_SENT = 'X-Orbix-Token'

/** 64 KiB. Por encima → 413 y se corta la conexión. */
export const MAX_EVENT_BODY_BYTES = 64 * 1024
/** El `raw_json` que se guarda en `hook_events` se recorta a 8 KiB. */
export const MAX_RAW_JSON_BYTES = 8 * 1024

export const SERVER_HEADERS_TIMEOUT_MS = 2000
export const SERVER_REQUEST_TIMEOUT_MS = 3000
export const SERVER_KEEPALIVE_TIMEOUT_MS = 1000
/**
 * Techo de sockets simultáneos.
 *
 * ⚠️ BUG-8. El diseño decía 32, pero `maxConnections` **destruye el socket sobrante sin
 * responder**, así que en una tanda de llamadas de herramienta en paralelo cortaba
 * conexiones a nivel TCP y el rate limit de §2.2 (50 ev/s) no llegaba a entrar: la
 * política acababa decidiéndola el socket en vez del contrato.
 *
 * Ahora es un techo de seguridad holgado, un orden de magnitud por encima del rate
 * limit, para que quien decida qué se descarta sea SIEMPRE el limitador — que además
 * responde 204 y no le enseña errores al hook.
 */
export const SERVER_MAX_CONNECTIONS = 512

/** Eventos por segundo aceptados. Por encima se descartan y se cuenta el exceso. */
export const EVENT_RATE_LIMIT_PER_SEC = 50

/** Timeout del sondeo `GET /health` al detectar EADDRINUSE. */
export const HEALTH_PROBE_TIMEOUT_MS = 500

/** Direcciones de socket aceptadas: solo loopback. */
export const LOOPBACK_ADDRESSES: readonly string[] = Object.freeze([
  '127.0.0.1',
  '::ffff:127.0.0.1',
  '::1'
])

/** Hosts aceptados en la cabecera `Host` (sin el puerto). Rompe el DNS rebinding. */
export const ALLOWED_HOST_NAMES: readonly string[] = Object.freeze(['127.0.0.1', 'localhost'])

// ---------------------------------------------------------------------------
// Rutas (relativas al home del usuario)
// ---------------------------------------------------------------------------

/** Directorio de configuración de Claude Code, relativo al home. */
export const CLAUDE_DIR_REL = '.claude'
/** `~/.claude.json`: plan y `cachedUsageUtilization`. */
export const CLAUDE_JSON_REL = '.claude.json'
/** `~/.claude/settings.json`: donde viven los hooks (los nuestros y los de terceros). */
export const CLAUDE_SETTINGS_REL = '.claude/settings.json'
/** `~/.claude/projects`: los JSONL de transcripciones que ingiere el ingestor. */
export const CLAUDE_PROJECTS_REL = '.claude/projects'

/** Nuestro directorio de coordinación, creado con 0700. */
export const ORBIX_DIR_REL = '.claude/orbix'
export const HOOK_SCRIPT_FILE = 'hook.sh'
export const TOKEN_FILE = 'token'
export const PORT_FILE = 'port'
export const LOCK_FILE = '.lock'

/** Ruta del hook tal cual se escribe en `settings.json` (Claude Code expande `~`). */
export const HOOK_COMMAND = '~/.claude/orbix/hook.sh'

/**
 * Marca de identidad de una entrada de hook nuestra. Una entrada es "nuestra" si y solo si
 * su `command` contiene esta subcadena. Nada más: no se usan claves extra en el JSON.
 */
export const HOOK_MARKER = 'orbix/hook.sh'

/** Prefijo de los backups de `settings.json`. */
export const BACKUP_PREFIX = 'settings.json.orbix-bak-'
export const TMP_SETTINGS_SUFFIX = '.orbix-tmp'
/** Cuántos backups se conservan; el resto se borran. */
export const MAX_BACKUPS = 5
/** Timeout del lock de fichero durante la instalación. */
export const INSTALL_LOCK_TIMEOUT_MS = 5000

/** Permisos, en octal, de cada artefacto. */
export const MODE_DIR = 0o700
export const MODE_SCRIPT = 0o755
export const MODE_TOKEN = 0o600
export const MODE_PORT = 0o644

/** Bytes aleatorios del token compartido (se guarda en hex: 64 caracteres). */
export const TOKEN_BYTES = 32

// ---------------------------------------------------------------------------
// Hooks de Claude Code
// ---------------------------------------------------------------------------

/** Los siete eventos sin `matcher`. */
export const HOOK_EVENTS_PLAIN: readonly string[] = Object.freeze([
  'SessionStart',
  'UserPromptSubmit',
  'Notification',
  'SubagentStop',
  'PreCompact',
  'Stop',
  'SessionEnd'
])

/** Los dos eventos de herramienta, que se instalan con `matcher: '*'`. */
export const HOOK_EVENTS_TOOL: readonly string[] = Object.freeze(['PreToolUse', 'PostToolUse'])

/** Los nueve eventos que instala Orbix. */
export const HOOK_EVENTS_ALL: readonly string[] = Object.freeze([
  ...HOOK_EVENTS_PLAIN,
  ...HOOK_EVENTS_TOOL
])

/** Red de seguridad de Claude Code, en segundos. */
export const HOOK_TIMEOUT_SECONDS = 2
/** Versión del script; debe coincidir con `# orbix-hook-version:` de `hook.sh`. */
export const HOOK_SCRIPT_VERSION = '1'

// ---------------------------------------------------------------------------
// Ventanas de tiempo
// ---------------------------------------------------------------------------

/** Una sesión se considera activa si su última actividad es más reciente que esto. */
export const SESSION_ACTIVE_WINDOW_MS = 30 * 60 * 1000

/** Antigüedad a partir de la cual el dato de límites es "rancio". */
export const LIMITS_STALE_SECONDS = 3600
/** Antigüedad a partir de la cual es "muy rancio". */
export const LIMITS_VERY_STALE_SECONDS = 86400

/** Base del multiplicador de plan. */
export const MULTIPLIER_BASIS_DAYS = 30

/** Coalescencia del push `stats:updated`. */
export const STATS_PUSH_COALESCE_MS = 2000
/** Máximo de pushes de progreso de backfill por segundo. */
export const INGEST_PROGRESS_MAX_PER_SEC = 2

/** Antirrepetición de sonidos (04-frontal.md §8.2). */
export const SOUND_MIN_INTERVAL_MS = 3000
/** Durante los primeros 2 s de vida de la app no suena nada. */
export const STARTUP_SILENCE_MS = 2000

/** Debounce de ráfagas de `PreToolUse`. */
export const TOOL_BURST_DEBOUNCE_MS = 250
/** Un evento que pierde la admisión se guarda como pendiente durante este tiempo. */
export const PENDING_EVENT_TTL_MS = 5000
/** Sin eventos durante esto estando en IDLE → SLEEPING. */
export const IDLE_TO_SLEEP_MS = 5 * 60 * 1000

/** Umbral e histéresis del aviso WORRIED por límite semanal. */
export const WORRIED_THRESHOLD_PCT = 80
export const WORRIED_REARM_PCT = 75

/** Reintento máximo del Nivel B cuando ha fallado. */
export const LEVEL_B_RETRY_MS = 30 * 60 * 1000
/** Timeout de `security find-generic-password`. */
export const KEYCHAIN_TIMEOUT_MS = 10_000

/** Si `~/.claude.json` supera esto no se parsea y se emite `app:notice`. */
export const CLAUDE_JSON_MAX_BYTES = 8 * 1024 * 1024
/** Debounce del watcher de `~/.claude.json`. */
export const CLAUDE_JSON_DEBOUNCE_MS = 1000

// ---------------------------------------------------------------------------
// Recortes de texto de los payloads de hook (03-contrato-eventos.md §3)
// ---------------------------------------------------------------------------

export const MAX_HOOK_EVENT_NAME_LEN = 64
export const MAX_MESSAGE_LEN = 500
export const MAX_PROMPT_LEN = 500
export const MAX_TOOL_NAME_LEN = 64
export const MAX_REASON_LEN = 128
export const MAX_CWD_LEN = 512
/** El bocadillo de NEEDS_YOU recorta el mensaje real a esto. */
export const MAX_BUBBLE_LEN = 120

// ---------------------------------------------------------------------------
// Periodos
// ---------------------------------------------------------------------------

export const PERIOD_KEYS: readonly PeriodKey[] = Object.freeze([
  'today',
  '7d',
  '30d',
  'mtd',
  'all'
])

export const CORNERS: readonly Corner[] = Object.freeze([
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right'
])

// ---------------------------------------------------------------------------
// Preferencias por defecto (01-arquitectura.md §3.5)
// ---------------------------------------------------------------------------

/** Todo menos `timezone`, que depende del sistema y se resuelve en `createDefaultPrefs()`. */
export const DEFAULT_PREFS_BASE: Readonly<Omit<Prefs, 'timezone'>> = Object.freeze({
  petVisible: true,
  corner: 'bottom-right',
  displayId: null,
  followActiveDisplay: true,
  petScale: 1,
  petOpacityIdle: 0.85,
  clickThrough: true,

  bubbleEnabled: true,
  bubbleMs: 5000,

  soundEnabled: true,
  volume: 0.5,
  soundOnSubagentStop: false,
  quietHours: Object.freeze({ enabled: false, from: '23:00', to: '08:00' }),
  muteWhenScreenLocked: true,
  muteUntil: null,

  currencySymbol: '$',
  ingestIntervalMs: 3000,

  levelBEnabled: false,
  // 20 min: decisión explícita de Ismael el 2026-09-04 (gasto pequeño y predecible,
  // ~3 peticiones/hora, frente al mínimo de 1 min que permitiría PREFS_LIMITS).
  levelBIntervalMs: 1_200_000,

  detailedToolStates: true,

  showCostInMenubar: false,
  showSessionPercentInMenubar: false,
  launchAtLogin: false,
  devMode: false
})

/** Rangos admitidos, usados por la validación de `prefs:set`. */
export const PREFS_LIMITS = Object.freeze({
  petScale: Object.freeze([0.5, 0.75, 1, 1.25, 1.5]) as readonly number[],
  petOpacityIdle: Object.freeze({ min: 0.35, max: 1 }),
  bubbleMs: Object.freeze({ min: 2000, max: 15_000 }),
  volume: Object.freeze({ min: 0, max: 1 }),
  ingestIntervalMs: Object.freeze({ min: 1000, max: 60_000 }),
  levelBIntervalMs: Object.freeze({ min: 60_000, max: 3_600_000 })
})

/** Preferencias por defecto completas, con la zona horaria del sistema. */
export function createDefaultPrefs(): Prefs {
  let timezone = 'UTC'
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    // Entorno sin ICU: nos quedamos con UTC.
  }
  return {
    ...DEFAULT_PREFS_BASE,
    quietHours: { ...DEFAULT_PREFS_BASE.quietHours },
    timezone
  }
}
