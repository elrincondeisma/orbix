/**
 * Orbix — canales `push` (main → renderer).
 *
 * Fuente de verdad: `01-arquitectura.md` §3.3.
 *
 * Dos reglas de rendimiento que se implementan AQUÍ, no en el renderer:
 *  - `stats:updated` se coalesce a **máximo uno cada 2 s** (el ingestor puede disparar
 *    muchos ciclos seguidos durante el backfill),
 *  - `ingest:progress` se limita a **2 por segundo**.
 *
 * El renderer no filtra nada: recibe lo que tiene que recibir y lo pinta.
 */

import type { BrowserWindow } from 'electron'

import { INGEST_PROGRESS_MAX_PER_SEC, STATS_PUSH_COALESCE_MS } from '@shared/constants'
import type { PushChannel, PushPayload } from '@shared/ipc'
import type { AppNotice, IngestStatus, NoticeLevel, StatsSnapshot } from '@shared/types'

export type WindowTarget = 'pet' | 'menubar' | 'stats' | 'prefs'

/** Resuelve la ventana viva de cada destino, o `null` si no está abierta. */
export type WindowRegistry = (target: WindowTarget) => BrowserWindow | null

/** Destinos por canal, calcados de la tabla §3.3. */
const TARGETS: Readonly<Record<PushChannel, readonly WindowTarget[]>> = Object.freeze({
  'pet:command': ['pet'],
  'pet:prefs': ['pet'],
  'stats:updated': ['menubar', 'stats'],
  'limits:updated': ['menubar'],
  'ingest:progress': ['menubar', 'prefs'],
  'prefs:changed': ['pet', 'menubar', 'stats', 'prefs'],
  'app:notice': ['menubar', 'prefs']
})

const INGEST_PROGRESS_MIN_GAP_MS = 1000 / INGEST_PROGRESS_MAX_PER_SEC

export type StatsReason = 'ingest' | 'prices' | 'manual'

export class PushBus {
  private readonly registry: WindowRegistry
  private readonly onError: (error: unknown) => void

  private statsTimer: NodeJS.Timeout | null = null
  private statsPending: StatsReason | null = null
  private statsProvider: (() => StatsSnapshot) | null = null

  private lastProgressAt = 0
  private progressTimer: NodeJS.Timeout | null = null
  private progressPending: IngestStatus | null = null

  constructor(registry: WindowRegistry, onError: (error: unknown) => void = () => {}) {
    this.registry = registry
    this.onError = onError
  }

  /** Envío directo, sin coalescer. */
  send<C extends PushChannel>(channel: C, payload: PushPayload<C>): void {
    for (const target of TARGETS[channel]) {
      const win = this.registry(target)
      if (win === null || win.isDestroyed()) continue
      try {
        win.webContents.send(channel, payload)
      } catch (error) {
        this.onError(error)
      }
    }
  }

  /**
   * `stats:updated` coalescido. El `StatsSnapshot` se calcula EN EL MOMENTO DEL ENVÍO,
   * no al encolar: durante el backfill esto ahorra decenas de consultas completas.
   */
  statsUpdated(reason: StatsReason, provider: () => StatsSnapshot): void {
    this.statsPending = reason
    this.statsProvider = provider
    if (this.statsTimer !== null) return
    this.statsTimer = setTimeout(() => {
      this.statsTimer = null
      const pendingReason = this.statsPending
      const pendingProvider = this.statsProvider
      this.statsPending = null
      this.statsProvider = null
      if (pendingReason === null || pendingProvider === null) return
      try {
        this.send('stats:updated', { reason: pendingReason, snapshot: pendingProvider() })
      } catch (error) {
        this.onError(error)
      }
    }, STATS_PUSH_COALESCE_MS)
  }

  /** `ingest:progress` limitado a 2/s; siempre se entrega el último estado conocido. */
  ingestProgress(status: IngestStatus): void {
    const now = Date.now()
    const elapsed = now - this.lastProgressAt
    if (elapsed >= INGEST_PROGRESS_MIN_GAP_MS) {
      this.lastProgressAt = now
      this.send('ingest:progress', status)
      return
    }
    this.progressPending = status
    if (this.progressTimer !== null) return
    this.progressTimer = setTimeout(() => {
      this.progressTimer = null
      const pending = this.progressPending
      this.progressPending = null
      if (pending === null) return
      this.lastProgressAt = Date.now()
      this.send('ingest:progress', pending)
    }, INGEST_PROGRESS_MIN_GAP_MS - elapsed)
  }

  notice(level: NoticeLevel, code: string, message: string): void {
    const notice: AppNotice = { level, code, message }
    // Los avisos también van al log: si el popover está cerrado, si no, se pierden.
    console.log(`[notice:${level}] ${code} — ${message}`)
    this.send('app:notice', notice)
  }

  /** Vacía lo pendiente y para los temporizadores. */
  dispose(): void {
    if (this.statsTimer !== null) clearTimeout(this.statsTimer)
    if (this.progressTimer !== null) clearTimeout(this.progressTimer)
    this.statsTimer = null
    this.progressTimer = null
    this.statsPending = null
    this.statsProvider = null
    this.progressPending = null
  }
}
