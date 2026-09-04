/**
 * Fechas de calendario en la zona del usuario. SQLite no sabe de zonas IANA, así
 * que `day_local` se calcula siempre aquí y se guarda como texto 'YYYY-MM-DD'
 * (02-esquema-bd.md §1 y §5.4).
 */

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone)
  if (!f) {
    // 'sv-SE' da 'YYYY-MM-DD' directamente, sin recomponer partes.
    f = new Intl.DateTimeFormat('sv-SE', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    })
    formatters.set(timeZone, f)
  }
  return f
}

/** Zona por defecto: la del sistema. */
export function systemTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

/** epoch ms → 'YYYY-MM-DD' en la zona indicada. Zona inválida → UTC, sin lanzar. */
export function dayLocal(tsEpochMs: number, timeZone: string): string {
  try {
    return formatterFor(timeZone).format(new Date(tsEpochMs))
  } catch {
    return formatterFor('UTC').format(new Date(tsEpochMs))
  }
}

/** 'YYYY-MM-DD' sumándole días (positivo o negativo) en calendario puro. */
export function shiftDay(day: string, deltaDays: number): string {
  const ms = Date.parse(`${day}T00:00:00Z`)
  if (!Number.isFinite(ms)) return day
  return new Date(ms + deltaDays * 86_400_000).toISOString().slice(0, 10)
}

export interface PeriodBounds {
  readonly today: string
  /** hoy − 6 días: la ventana de 7 días incluye hoy. */
  readonly d7from: string
  /** hoy − 29 días. */
  readonly d30from: string
  /** día 1 del mes local. */
  readonly mtdFrom: string
}

/** Los cuatro límites de fecha que consumen las consultas del menubar (§7). */
export function periodBounds(timeZone: string, now: number = Date.now()): PeriodBounds {
  const today = dayLocal(now, timeZone)
  return {
    today,
    d7from: shiftDay(today, -6),
    d30from: shiftDay(today, -29),
    mtdFrom: `${today.slice(0, 7)}-01`
  }
}

/** Nº de días de calendario que cubre [from, to], ambos inclusive. */
export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`)
  const b = Date.parse(`${to}T00:00:00Z`)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0
  return Math.floor((b - a) / 86_400_000) + 1
}

/** ISO con offset → ISO UTC con 'Z'. Devuelve null si no se puede parsear. */
export function toUtcIso(value: string | null | undefined): string | null {
  if (!value) return null
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) return null
  return new Date(ms).toISOString()
}
