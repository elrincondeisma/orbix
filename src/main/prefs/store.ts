/**
 * Orbix — persistencia de preferencias.
 *
 * Fuente de verdad: `01-arquitectura.md` §3.5.
 *
 * Fichero JSON en `~/Library/Application Support/Orbix/prefs.json`, con escritura
 * atómica (temp + fsync + rename). *Alternativa descartada:* tabla en SQLite — las
 * preferencias deben poder leerse ANTES de que la base de datos esté migrada.
 *
 * Nada de lo que llega por `prefs:set` se confía: todo valor se valida y se recorta a su
 * rango. Un renderer comprometido no puede meter aquí un `bubbleMs` de 10 años.
 */

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { CORNERS, PREFS_LIMITS, createDefaultPrefs } from '@shared/constants'
import type { Corner, Prefs, QuietHours } from '@shared/types'

export const PREFS_FILE = 'prefs.json'

export interface PrefsStoreOptions {
  /** Ruta completa del fichero. Los tests pasan un directorio temporal. */
  file: string
  /** Se llama tras cada cambio efectivo, para emitir `prefs:changed`. */
  onChange?: (prefs: Prefs) => void
  onError?: (error: unknown) => void
}

export class PrefsStore {
  private readonly file: string
  private readonly onChange: (prefs: Prefs) => void
  private readonly onError: (error: unknown) => void
  private current: Prefs

  constructor(options: PrefsStoreOptions) {
    this.file = options.file
    this.onChange = options.onChange ?? ((): void => {})
    this.onError = options.onError ?? ((): void => {})
    this.current = createDefaultPrefs()
  }

  get path(): string {
    return this.file
  }

  /** Instantánea inmutable para el resto de la app. */
  get(): Prefs {
    return { ...this.current, quietHours: { ...this.current.quietHours } }
  }

  /**
   * Carga del disco. Si el fichero no existe o está corrupto se parte de los valores por
   * defecto y se reescribe: nunca se aborta el arranque por unas preferencias ilegibles.
   */
  load(): Prefs {
    const defaults = createDefaultPrefs()
    let raw: string | null = null
    try {
      raw = readFileSync(this.file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.onError(error)
    }

    if (raw !== null) {
      try {
        const parsed: unknown = JSON.parse(raw)
        this.current = sanitizePrefs(parsed, defaults)
      } catch (error) {
        this.onError(error)
        this.current = defaults
      }
    } else {
      this.current = defaults
    }

    // Un silencio temporal vencido se limpia al arrancar.
    this.clearExpiredMute()
    this.persist()
    return this.get()
  }

  /** Aplica un parche validado. Devuelve las preferencias completas resultantes. */
  set(patch: unknown): Prefs {
    const merged = sanitizePrefs({ ...this.current, ...asObject(patch) }, createDefaultPrefs())
    const changed = JSON.stringify(merged) !== JSON.stringify(this.current)
    this.current = merged
    if (changed) {
      this.persist()
      this.onChange(this.get())
    }
    return this.get()
  }

  /** `sound:mute`: `null` = silencio indefinido, `0` = quitar el silencio. */
  mute(minutes: number | null): Prefs {
    if (minutes === null) {
      // Silencio indefinido: se representa con una fecha muy lejana.
      return this.set({ muteUntil: '2999-12-31T23:59:59.000Z' })
    }
    if (!Number.isFinite(minutes) || minutes <= 0) return this.set({ muteUntil: null })
    return this.set({ muteUntil: new Date(Date.now() + minutes * 60_000).toISOString() })
  }

  /**
   * Limpia `muteUntil` si ya venció. Devuelve `true` si hubo cambio, para que `main`
   * emita `prefs:changed`. Se llama desde el tick del ingestor.
   */
  clearExpiredMute(now: number = Date.now()): boolean {
    const until = this.current.muteUntil
    if (until === null) return false
    const ms = Date.parse(until)
    if (Number.isNaN(ms) || ms > now) return false
    this.current = { ...this.current, muteUntil: null }
    this.persist()
    this.onChange(this.get())
    return true
  }

  /** Escritura atómica: temp + fsync + rename. Nunca deja el fichero a medias. */
  private persist(): void {
    const tmp = `${this.file}.tmp`
    const text = `${JSON.stringify(this.current, null, 2)}\n`
    let fd: number | null = null
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      fd = openSync(tmp, 'w', 0o600)
      writeSync(fd, text)
      fsyncSync(fd)
      closeSync(fd)
      fd = null
      renameSync(tmp, this.file)
    } catch (error) {
      this.onError(error)
      if (fd !== null) {
        try {
          closeSync(fd)
        } catch {
          /* ya cerrado */
        }
      }
      try {
        unlinkSync(tmp)
      } catch {
        /* no existía */
      }
    }
  }
}

/** Ruta por defecto dentro del `userData` de la app. */
export function prefsPath(userDataDir: string): string {
  return join(userDataDir, PREFS_FILE)
}

// ---------------------------------------------------------------------------
// Validación
// ---------------------------------------------------------------------------

function asObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function num(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

function str(value: unknown, fallback: string, maxLen = 64): string {
  if (typeof value !== 'string' || value.length === 0) return fallback
  return value.slice(0, maxLen)
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback
}

/** "HH:MM" o el valor por defecto. */
function hhmm(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^([01]?\d|2[0-3]):[0-5]\d$/.test(value) ? value : fallback
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return Number.isNaN(Date.parse(value)) ? null : value
}

function timezone(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || value.length === 0) return fallback
  try {
    // Si la zona no existe, `Intl` lanza y nos quedamos con la del sistema.
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0)
    return value
  } catch {
    return fallback
  }
}

function quietHours(value: unknown, fallback: QuietHours): QuietHours {
  const o = asObject(value)
  return {
    enabled: bool(o['enabled'], fallback.enabled),
    from: hhmm(o['from'], fallback.from),
    to: hhmm(o['to'], fallback.to)
  }
}

/**
 * Normaliza cualquier entrada a un `Prefs` válido. Es pura y exportada: los tests la
 * usan sin tocar disco, y `prefs:set` la aplica antes de persistir.
 */
export function sanitizePrefs(input: unknown, defaults: Prefs = createDefaultPrefs()): Prefs {
  const o = asObject(input)
  const scale = PREFS_LIMITS.petScale
  const rawScale = o['petScale']
  return {
    petVisible: bool(o['petVisible'], defaults.petVisible),
    corner: oneOf<Corner>(o['corner'], CORNERS, defaults.corner),
    displayId:
      typeof o['displayId'] === 'number' && Number.isFinite(o['displayId'])
        ? Math.trunc(o['displayId'])
        : null,
    followActiveDisplay: bool(o['followActiveDisplay'], defaults.followActiveDisplay),
    // La escala es una lista cerrada: un valor intermedio rompería el SVG.
    petScale:
      typeof rawScale === 'number' && scale.includes(rawScale) ? rawScale : defaults.petScale,
    petOpacityIdle: num(
      o['petOpacityIdle'],
      defaults.petOpacityIdle,
      PREFS_LIMITS.petOpacityIdle.min,
      PREFS_LIMITS.petOpacityIdle.max
    ),
    clickThrough: bool(o['clickThrough'], defaults.clickThrough),

    bubbleEnabled: bool(o['bubbleEnabled'], defaults.bubbleEnabled),
    bubbleMs: Math.round(
      num(o['bubbleMs'], defaults.bubbleMs, PREFS_LIMITS.bubbleMs.min, PREFS_LIMITS.bubbleMs.max)
    ),

    soundEnabled: bool(o['soundEnabled'], defaults.soundEnabled),
    volume: num(o['volume'], defaults.volume, PREFS_LIMITS.volume.min, PREFS_LIMITS.volume.max),
    soundOnSubagentStop: bool(o['soundOnSubagentStop'], defaults.soundOnSubagentStop),
    quietHours: quietHours(o['quietHours'], defaults.quietHours),
    muteWhenScreenLocked: bool(o['muteWhenScreenLocked'], defaults.muteWhenScreenLocked),
    muteUntil: isoOrNull(o['muteUntil']),

    timezone: timezone(o['timezone'], defaults.timezone),
    currencySymbol: str(o['currencySymbol'], defaults.currencySymbol, 4),
    ingestIntervalMs: Math.round(
      num(
        o['ingestIntervalMs'],
        defaults.ingestIntervalMs,
        PREFS_LIMITS.ingestIntervalMs.min,
        PREFS_LIMITS.ingestIntervalMs.max
      )
    ),

    levelBEnabled: bool(o['levelBEnabled'], defaults.levelBEnabled),
    levelBIntervalMs: Math.round(
      num(
        o['levelBIntervalMs'],
        defaults.levelBIntervalMs,
        PREFS_LIMITS.levelBIntervalMs.min,
        PREFS_LIMITS.levelBIntervalMs.max
      )
    ),

    detailedToolStates: bool(o['detailedToolStates'], defaults.detailedToolStates),

    showCostInMenubar: bool(o['showCostInMenubar'], defaults.showCostInMenubar),
    showSessionPercentInMenubar: bool(
      o['showSessionPercentInMenubar'],
      defaults.showSessionPercentInMenubar
    ),
    launchAtLogin: bool(o['launchAtLogin'], defaults.launchAtLogin),
    devMode: bool(o['devMode'], defaults.devMode)
  }
}
