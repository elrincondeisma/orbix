/**
 * Orbix — tipos compartidos entre `main`, `preload` y los renderers.
 *
 * Fuente de verdad: `docs/design/01-arquitectura.md` §3.4 y §3.5.
 *
 * REGLA DURA: este directorio (`src/shared`) NO puede importar de `node:*` ni de
 * `electron`. Es código neutro que compila tanto con `tsconfig.node.json` como con
 * `tsconfig.web.json`. Se verifica en `tests/unit/shared-purity.test.ts`.
 */

// ---------------------------------------------------------------------------
// Errores y resultados de IPC
// ---------------------------------------------------------------------------

export type IpcErrorCode =
  | 'DB_ERROR'
  | 'NOT_READY'
  | 'NOT_FOUND'
  | 'BAD_INPUT'
  | 'CLAUDE_CONFIG_MISSING'
  | 'KEYCHAIN_DENIED'
  | 'LIVE_API_FAILED'
  | 'HOOK_WRITE_FAILED'
  | 'PORT_UNAVAILABLE'
  | 'INTERNAL'

export interface IpcError {
  code: IpcErrorCode
  message: string
  detail?: string
}

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: IpcError }

// ---------------------------------------------------------------------------
// Claves de periodo y geometría
// ---------------------------------------------------------------------------

export type PeriodKey = 'today' | '7d' | '30d' | 'mtd' | 'all'
export type Corner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

// ---------------------------------------------------------------------------
// Consumo
// ---------------------------------------------------------------------------

export interface TokenTotals {
  input: number
  output: number
  /** Subconjunto informativo de `output`. NO se suma aparte en `totalTokens`. */
  thinking: number
  cacheWrite5m: number
  cacheWrite1h: number
  cacheRead: number
}

export interface PeriodStats {
  tokens: TokenTotals
  /** input + output + cacheWrite5m + cacheWrite1h + cacheRead (thinking excluido). */
  totalTokens: number
  costUsd: number
  /** Número de `request_id` distintos. */
  requests: number
}

export interface SessionStats extends PeriodStats {
  sessionId: string | null
  /** Ej. "-Users-icatala-Projects-propios-Orbix". */
  projectKey: string | null
  /** Ej. "Orbix". */
  projectName: string | null
  /** Ej. "/Users/icatala/Projects/propios/Orbix". */
  projectPath: string | null
  /** ISO UTC. */
  startedAt: string | null
  /** ISO UTC. */
  lastActivityAt: string | null
  /** Última actividad hace menos de 30 min. */
  isActive: boolean
}

export interface PlanInfo {
  /** Ej. "default_claude_max_20x". */
  tierId: string | null
  /** Ej. "claude_max". */
  organizationType: string | null
  /** Ej. "Max 20×" o "Plan desconocido". */
  displayName: string
  monthlyUsd: number | null
  accountEmail: string | null
  detected: boolean
}

export interface Multiplier {
  /** costUsd(last30d) / monthlyUsd, o null si no hay precio de plan. */
  value: number | null
  basis: 'last30d'
  planMonthlyUsd: number | null
  costUsd: number
  /** true si hay menos de 30 días de histórico en BD: el valor real es mayor. */
  isFloor: boolean
  /** Días distintos con datos dentro de la ventana. */
  coveredDays: number
}

export interface StatsSnapshot {
  /** ISO UTC. */
  generatedAt: string
  session: SessionStats
  today: PeriodStats
  last7d: PeriodStats
  last30d: PeriodStats
  monthToDate: PeriodStats
  allTime: PeriodStats
  plan: PlanInfo
  multiplier: Multiplier
  ingest: IngestStatus
}

// ---------------------------------------------------------------------------
// Límites de suscripción
// ---------------------------------------------------------------------------

export type LimitSeverity = 'normal' | 'warning' | 'critical' | 'unknown'
export type LimitKind = 'session' | 'weekly_all' | 'weekly_scoped'
export type LimitGroup = 'session' | 'weekly'

export interface LimitBar {
  kind: LimitKind
  group: LimitGroup
  /** "Ventana 5 h" | "Semanal total" | "Semanal · Opus". */
  label: string
  /** 0-100, ya clampado. */
  percent: number
  severity: LimitSeverity
  /** ISO UTC normalizado, o null si el servidor no lo manda. */
  resetsAt: string | null
  /** "Opus" | null. */
  scopeLabel: string | null
  isActive: boolean
}

export type LimitsSource = 'live' | 'cache' | 'none'
export type LevelBResult = 'ok' | 'failed' | 'never'

export interface LevelBStatus {
  enabled: boolean
  lastResult: LevelBResult
  lastError: string | null
}

export interface LimitsView {
  source: LimitsSource
  /** ISO UTC del momento en que el dato se obtuvo de verdad (no de cuando lo leímos). */
  fetchedAt: string | null
  ageSeconds: number | null
  /** ageSeconds > 3600. */
  stale: boolean
  /** ageSeconds > 86400. */
  veryStale: boolean
  bars: LimitBar[]
  extraUsageEnabled: boolean
  spendUsedUsd: number | null
  levelB: LevelBStatus
}

// ---------------------------------------------------------------------------
// Desgloses y series
// ---------------------------------------------------------------------------

export interface BreakdownRow {
  key: string
  label: string
  tokens: TokenTotals
  totalTokens: number
  costUsd: number
  requests: number
  /** 0-1 sobre el coste del periodo. */
  share: number
}

export interface Breakdown {
  by: 'project' | 'model'
  period: PeriodKey
  rows: BreakdownRow[]
  totalCostUsd: number
}

export interface SeriesPoint {
  /** "YYYY-MM-DD" en la zona horaria de las preferencias. */
  day: string
  costUsd: number
  totalTokens: number
  key?: string
}

export interface Series {
  period: PeriodKey
  by: 'project' | 'model' | null
  points: SeriesPoint[]
}

// ---------------------------------------------------------------------------
// Ingesta
// ---------------------------------------------------------------------------

export interface IngestStatus {
  state: 'idle' | 'scanning' | 'backfilling' | 'error'
  filesTracked: number
  /** ISO UTC. */
  lastRunAt: string | null
  lastDurationMs: number | null
  /** 0-1, o null si no hay backfill en curso. */
  backfillProgress: number | null
  linesIngestedTotal: number
  lastError: string | null
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export interface HookStatus {
  installed: boolean
  /** Eventos con nuestro hook presente en `settings.json`. */
  events: string[]
  missingEvents: string[]
  scriptPath: string
  /** Leída de la línea `# orbix-hook-version: N` del script instalado. */
  scriptVersion: string | null
  settingsPath: string
  serverPort: number | null
  serverListening: boolean
  /** Hooks de terceros detectados y respetados (ntfy, cerebro, …). */
  foreignHooksPreserved: number
  lastBackupPath: string | null
}

// ---------------------------------------------------------------------------
// Precios
// ---------------------------------------------------------------------------

export interface ModelPrice {
  id: number
  modelKey: string
  inputPerMtok: number
  outputPerMtok: number
  cacheWrite5mPerMtok: number
  cacheWrite1hPerMtok: number
  cacheReadPerMtok: number
  /** ISO UTC; aplica a ts >= validFrom. */
  validFrom: string
  source: 'seed' | 'user' | 'import'
  note: string | null
}

export interface ModelPriceInput {
  modelKey: string
  inputPerMtok: number
  outputPerMtok: number
  cacheWrite5mPerMtok: number
  cacheWrite1hPerMtok: number
  cacheReadPerMtok: number
  validFrom: string
  note?: string | null
}

// ---------------------------------------------------------------------------
// Preferencias
// ---------------------------------------------------------------------------

export interface QuietHours {
  enabled: boolean
  /** "HH:MM" en hora local. Puede cruzar la medianoche (from > to). */
  from: string
  to: string
}

export interface Prefs {
  // Mascota
  petVisible: boolean
  corner: Corner
  /** null = pantalla con el cursor / activa. */
  displayId: number | null
  followActiveDisplay: boolean
  /** 0.75 | 1 | 1.25 | 1.5 */
  petScale: number
  /** 0.35 - 1 */
  petOpacityIdle: number
  clickThrough: boolean

  // Bocadillo
  bubbleEnabled: boolean
  /** 2000 - 15000 */
  bubbleMs: number

  // Sonido
  soundEnabled: boolean
  /** 0 - 1 */
  volume: number
  soundOnSubagentStop: boolean
  quietHours: QuietHours
  muteWhenScreenLocked: boolean
  /** ISO UTC; `main` lo limpia solo al vencer. null = sin silencio temporal. */
  muteUntil: string | null

  // Datos
  /** IANA. */
  timezone: string
  currencySymbol: string
  /** Mínimo 1000. */
  ingestIntervalMs: number

  // Nivel B
  levelBEnabled: boolean
  levelBIntervalMs: number

  // Hooks
  /** true → instala también PreToolUse/PostToolUse. */
  detailedToolStates: boolean

  // Sistema
  showCostInMenubar: boolean
  /** % gastado de la ventana de 5 h junto al icono de la barra de menús. */
  showSessionPercentInMenubar: boolean
  launchAtLogin: boolean
  devMode: boolean
}

export interface PetVisualPrefs {
  petScale: number
  petOpacityIdle: number
  bubbleEnabled: boolean
  bubbleMs: number
  soundEnabled: boolean
  volume: number
  /** Derivado del sistema, no editable. */
  reducedMotion: boolean
}

// ---------------------------------------------------------------------------
// Información de la app
// ---------------------------------------------------------------------------

export interface AppInfo {
  version: string
  electron: string
  node: string
  dbPath: string
  dbSizeBytes: number
  schemaVersion: number
  platform: string
  arch: string
  /**
   * ¿Se puede activar el arranque al iniciar sesión?
   *
   * `false` en desarrollo: registrarlo dejaría en los Elementos de inicio del usuario una
   * entrada apuntando al Electron de `node_modules`. La interfaz debe deshabilitar el
   * interruptor y explicar que solo funciona con la app instalada.
   */
  launchAtLoginAvailable: boolean
}

export type NoticeLevel = 'info' | 'warn' | 'error'

export interface AppNotice {
  level: NoticeLevel
  /** Código estable para que el frontal pueda reaccionar: PORT_FALLBACK, HOOK_REMOVED… */
  code: string
  message: string
}
