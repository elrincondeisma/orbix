/**
 * Orbix — formateo de cifras para pantalla.
 *
 * Fuente de verdad: `docs/design/04-frontal.md` §10.4. Locale fijo `es-ES`.
 * **Ambas partes (menubar y stats) usan estas funciones; no se formatea a mano
 * en ningún sitio.**
 *
 * REGLA DURA: sin imports de `node:*` ni de `electron`.
 */

/** Espacio fino inseparable (U+202F). Va antes del `%` y de las unidades. */
export const THIN_SPACE = '\u202f'

const LOCALE = 'es-ES'

// `useGrouping: 'always'` es deliberado: el es-ES por defecto NO agrupa los números de
// cuatro cifras (1178 en lugar de 1.178) y el diseño pide `$1.178,15`.
const nf2 = new Intl.NumberFormat(LOCALE, {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  useGrouping: 'always'
})
const nf1 = new Intl.NumberFormat(LOCALE, {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
  useGrouping: 'always'
})
const nf0 = new Intl.NumberFormat(LOCALE, {
  maximumFractionDigits: 0,
  useGrouping: 'always'
})

/** Marcador para valores que no existen. Nunca se inventa un número. */
export const EM_DASH = '—'

function isNum(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n)
}

// ---------------------------------------------------------------------------
// Dinero
// ---------------------------------------------------------------------------

/**
 * `$0,00` · `<$0,01` · `$166,74` · `$1.178,15`.
 * `symbol` viene de `prefs.currencySymbol`.
 */
export function formatCost(usd: number, symbol = '$'): string {
  if (!isNum(usd)) return EM_DASH
  if (usd === 0) return `${symbol}0,00`
  if (usd < 0) return `-${formatCost(-usd, symbol)}`
  if (usd < 0.01) return `<${symbol}0,01`
  return symbol + nf2.format(usd)
}

/** Solo para el título del Tray: `$8,3` (< 10) · `$56` (>= 10). */
export function formatCostShort(usd: number, symbol = '$'): string {
  if (!isNum(usd)) return EM_DASH
  if (usd < 0) return `-${formatCostShort(-usd, symbol)}`
  return usd < 10 ? symbol + nf1.format(usd) : symbol + nf0.format(Math.round(usd))
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/**
 * `586` · `274,0 K` · `1,20 M` · `183 M` · `1.568 M`.
 *
 * No se usa `B` ni `G`: en español confunden. Se escala hasta M y el separador de
 * miles hace el resto.
 */
export function formatTokens(n: number): string {
  if (!isNum(n)) return EM_DASH
  if (n < 0) return `-${formatTokens(-n)}`
  if (n < 1000) return nf0.format(Math.round(n))
  if (n < 1e6) return `${nf1.format(n / 1e3)}${THIN_SPACE}K`
  const millions = n / 1e6
  // Por debajo de 10 M se muestran dos decimales para no perder resolución.
  return n < 10e6
    ? `${nf2.format(millions)}${THIN_SPACE}M`
    : `${nf0.format(Math.round(millions))}${THIN_SPACE}M`
}

// ---------------------------------------------------------------------------
// Porcentajes y multiplicador
// ---------------------------------------------------------------------------

/** `63 %`, con espacio fino antes del signo. */
export function formatPercent(p: number): string {
  if (!isNum(p)) return EM_DASH
  return `${Math.round(p)}${THIN_SPACE}%`
}

/** `6,1×` (< 10) · `14×` (>= 10). */
export function formatMultiplier(x: number | null): string {
  if (x === null || !isNum(x)) return EM_DASH
  return x < 10 ? `${nf1.format(x)}×` : `${nf0.format(Math.round(x))}×`
}

// ---------------------------------------------------------------------------
// Antigüedad
// ---------------------------------------------------------------------------

/**
 * `ahora mismo` · `hace 12 s` · `hace 4 min` · `hace 3 h` · `ayer` · `hace 7 días`.
 * La antigüedad del dato es de primera clase: nunca se omite.
 */
export function formatAge(seconds: number | null): string {
  if (seconds === null || !isNum(seconds)) return EM_DASH
  const s = Math.max(0, Math.floor(seconds))
  if (s < 10) return 'ahora mismo'
  if (s < 60) return `hace ${s} s`
  if (s < 3600) return `hace ${Math.floor(s / 60)} min`
  if (s < 86400) return `hace ${Math.floor(s / 3600)} h`
  if (s < 172800) return 'ayer'
  return `hace ${Math.floor(s / 86400)} días`
}

// ---------------------------------------------------------------------------
// Hora de reinicio de un límite
// ---------------------------------------------------------------------------

const WEEKDAYS_SHORT = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'] as const
const MONTHS_SHORT = [
  'ene',
  'feb',
  'mar',
  'abr',
  'may',
  'jun',
  'jul',
  'ago',
  'sep',
  'oct',
  'nov',
  'dic'
] as const

interface CalendarParts {
  year: number
  month: number // 1-12
  day: number
  hour: number
  minute: number
  weekday: number // 0 = domingo
}

/** Descompone una fecha en la zona horaria pedida, sin depender de la del proceso. */
function partsIn(date: Date, timeZone: string | undefined): CalendarParts {
  const options: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    weekday: 'short'
  }
  if (timeZone) options.timeZone = timeZone
  // 'en-US' porque solo leemos valores numéricos; el nombre del día lo ponemos nosotros.
  const parts = new Intl.DateTimeFormat('en-US', options).formatToParts(date)
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '0'
  const weekdayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const weekdayIdx = weekdayNames.indexOf(get('weekday').slice(0, 3))
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
    weekday: weekdayIdx < 0 ? 0 : weekdayIdx
  }
}

/** Número de día absoluto, para restar fechas de calendario sin líos de husos. */
function dayNumber(p: CalendarParts): number {
  return Math.floor(Date.UTC(p.year, p.month - 1, p.day) / 86_400_000)
}

function hhmm(p: CalendarParts): string {
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`
}

/**
 * `↺ hoy 10:00` · `↺ mañana 10:00` · `↺ dom 10:00` · `↺ 12 sep 10:00`.
 *
 * Si la hora ya pasó, se dice que **venció** y se quita el glifo `↺`:
 * `venció hoy 10:00` · `venció ayer 10:00` · `venció el 27 ago 10:00`.
 *
 * ⚠️ BUG-6. Antes no se contemplaba `diff < 0` y el popover pintaba
 * `↺ 27 ago 12:00` un 3 de septiembre: el glifo prometía un reinicio ocurrido hacía una
 * semana, justo en el bloque que existe para no mentir con datos rancios. Pasa siempre
 * que el `resets_at` viene de un `cachedUsageUtilization` viejo, que es lo habitual.
 *
 * Devuelve cadena vacía si `iso` es `null` o no parsea: no se inventa nada.
 */
export function formatReset(iso: string | null, timeZone?: string, now: Date = new Date()): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''

  const target = partsIn(date, timeZone)
  const today = partsIn(now, timeZone)
  const diff = dayNumber(target) - dayNumber(today)
  const time = hhmm(target)

  // La comparación es sobre el instante, no sobre el día: un reinicio de hoy a las 10:00
  // visto a las 12:00 también está vencido.
  if (date.getTime() < now.getTime()) {
    if (diff === 0) return `venció hoy ${time}`
    if (diff === -1) return `venció ayer ${time}`
    const pastMonth = MONTHS_SHORT[target.month - 1] ?? ''
    return `venció el ${target.day} ${pastMonth} ${time}`
  }

  if (diff === 0) return `↺ hoy ${time}`
  if (diff === 1) return `↺ mañana ${time}`
  if (diff > 1 && diff < 7) return `↺ ${WEEKDAYS_SHORT[target.weekday] ?? ''} ${time}`
  const month = MONTHS_SHORT[target.month - 1] ?? ''
  return `↺ ${target.day} ${month} ${time}`
}

// ---------------------------------------------------------------------------
// Auxiliares
// ---------------------------------------------------------------------------

/** `184 ficheros` / `1 fichero`. Pluralización mínima para el pie del popover. */
export function pluralize(n: number, singular: string, plural: string): string {
  return `${nf0.format(n)} ${n === 1 ? singular : plural}`
}

/** Trunca por el final añadiendo elipsis. Para nombres de proyecto usa CSS, no esto. */
export function truncate(text: string, max: number): string {
  if (max <= 0) return ''
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
}
