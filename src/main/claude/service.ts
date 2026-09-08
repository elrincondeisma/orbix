/**
 * Orbix — servicio de plan y límites (Nivel A, con Nivel B opcional).
 *
 * Junta cuatro cosas que hasta ahora estaban sueltas:
 *  - lectura de `~/.claude.json` (`config-reader.ts`),
 *  - resolución del plan contra la tabla `plans`,
 *  - persistencia del `utilization` en `limits_snapshots`,
 *  - vigilancia del fichero con chokidar y debounce de 1 s.
 *
 * ⚠️ **La antigüedad del dato manda.** `cachedUsageUtilization` solo se refresca cuando
 * Claude Code quiere: en la máquina de referencia llevaba siete días parado. Todo lo que
 * sale de aquí lleva `fetchedAt`/`ageSeconds`/`stale`/`veryStale`, y el menubar está
 * obligado a pintarlos. Nunca se presenta un porcentaje rancio como si fuera actual.
 */

import { homedir } from 'node:os'

import chokidar, { type FSWatcher } from 'chokidar'

import { CLAUDE_JSON_DEBOUNCE_MS } from '@shared/constants'
import type { LevelBStatus, LimitsView, PlanInfo } from '@shared/types'

import type { Db } from '../db/connection'
import { getMeta, setMeta } from '../db/meta'
import {
  buildLimitsView,
  buildPlanInfo,
  claudeJsonPath,
  emptyLimitsView,
  readClaudeConfig,
  weeklyPercent,
  type CachedUsage,
  type ClaudeAccountMeta,
  type PlanRow
} from './config-reader'
import { CliUsage } from './cli-usage'

export interface ClaudeServiceOptions {
  db: Db
  home?: string
  /** Se emite cuando cambia la vista de límites (arranque, watcher o Nivel B). */
  onLimits?: (view: LimitsView) => void
  /** Porcentaje semanal, para la regla 13 de la mascota (`WORRIED`). */
  onWeeklyPercent?: (percent: number | null) => void
  onError?: (error: unknown) => void
  /**
   * Inyectable en tests. Sin esto, cualquier test que llame a `refreshLive()` en una
   * máquina con `claude` instalado (cualquier máquina de desarrollo de este proyecto)
   * lanzaría de verdad `claude -p "/usage"` — un proceso real, gastando una petición de
   * la suscripción en cada pasada de `npm test`. Por defecto, `new CliUsage()`.
   */
  levelB?: CliUsage
}

export class ClaudeService {
  private readonly db: Db
  private readonly home: string
  private readonly onLimits: (view: LimitsView) => void
  private readonly onWeeklyPercent: (percent: number | null) => void
  private readonly onError: (error: unknown) => void

  private readonly levelB: CliUsage

  private meta: ClaudeAccountMeta | null = null
  private cache: CachedUsage = { fetchedAtMs: null, utilization: null }
  private view: LimitsView = emptyLimitsView()
  private planInfo: PlanInfo = {
    tierId: null,
    organizationType: null,
    displayName: 'Plan desconocido',
    monthlyUsd: null,
    accountEmail: null,
    detected: false
  }

  private watcher: FSWatcher | null = null
  private debounce: NodeJS.Timeout | null = null

  constructor(options: ClaudeServiceOptions) {
    this.db = options.db
    this.home = options.home ?? homedir()
    this.onLimits = options.onLimits ?? ((): void => {})
    this.onWeeklyPercent = options.onWeeklyPercent ?? ((): void => {})
    this.onError = options.onError ?? ((): void => {})
    this.levelB = options.levelB ?? new CliUsage()
  }

  get plan(): PlanInfo {
    return this.planInfo
  }

  get limits(): LimitsView {
    return this.view
  }

  get levelBStatus(): LevelBStatus {
    return this.levelB.status
  }

  /**
   * Lee `~/.claude.json`, resuelve el plan y persiste el snapshot. Nunca lanza.
   *
   * ⚠️ BUG-7. Si el fichero no se puede leer, **NO se borra lo que ya sabíamos**. Antes
   * se sustituía la vista por una vacía y el popover pasaba a «Sin datos de límites
   * todavía» habiendo tenido datos hace un segundo. Y no es un caso teórico: Claude Code
   * reescribe ese fichero cada pocos minutos, así que basta con pillarlo a mitad de
   * escritura. Ahora se conserva lo último conocido con su antigüedad real, que es
   * justamente para lo que existe `limits_snapshots`.
   */
  refresh(notify = true): LimitsView {
    try {
      const read = readClaudeConfig(this.home)

      if (!read.ok) {
        this.onError(new Error(`No se pudo leer ${read.path}: ${read.error ?? 'motivo desconocido'}`))
        // Sin dato en memoria todavía (primer arranque con el fichero roto), se rescata
        // el último snapshot guardado en la BD.
        if (this.view.source === 'none') this.restoreFromDb()
        if (notify) {
          this.onLimits(this.view)
          this.onWeeklyPercent(weeklyPercent(this.view))
        }
        return this.view
      }

      this.meta = read.meta
      this.cache = read.cache

      this.planInfo = buildPlanInfo(read.meta, this.lookupPlan(read.meta.rateLimitTier))

      // ⚠️ El Nivel A NO pisa al Nivel B cuando el suyo es más viejo. Claude Code
      // reescribe `~/.claude.json` cada pocos minutos, pero `cachedUsageUtilization`
      // dentro puede llevar DÍAS parado (medido: 98 h el 2026-09-08). Sin esta guarda,
      // cada escritura del fichero tiraba el porcentaje recién traído por `/usage` y lo
      // sustituía por el del caché rancio: los límites parecían no actualizarse nunca.
      const fresher = this.fresherLevelBSnapshot(read.cache)
      this.view =
        fresher !== null
          ? buildLimitsView(fresher, { source: 'live', levelB: this.levelB.status })
          : buildLimitsView(read.cache, {
              levelB: this.levelB.status,
              metaExtraUsage: read.meta.hasExtraUsageEnabled
            })

      this.persistMeta(read.meta)
      this.persistSnapshot('cache', read.cache)
    } catch (error) {
      this.onError(error)
    }

    if (notify) {
      this.onLimits(this.view)
      this.onWeeklyPercent(weeklyPercent(this.view))
    }
    return this.view
  }

  /**
   * Rescata el último `utilization` guardado en `limits_snapshots` y reconstruye la
   * vista con su antigüedad REAL. El plan se reconstruye desde `meta`, que también se
   * guardó en su día.
   *
   * Es lo que salva el arranque cuando `~/.claude.json` está roto, borrado o es
   * demasiado grande: se enseña el último dato bueno diciendo cuándo se obtuvo, en vez
   * de fingir que no hay nada.
   */
  private restoreFromDb(): void {
    try {
      const row = this.db
        .prepare(
          `SELECT fetched_at_ms, source, payload_json
             FROM limits_snapshots
            ORDER BY captured_at DESC
            LIMIT 1`
        )
        .get() as
        | { fetched_at_ms: number | null; source: string; payload_json: string }
        | undefined

      if (row !== undefined) {
        const utilization = JSON.parse(row.payload_json) as Record<string, unknown>
        this.view = buildLimitsView(
          { fetchedAtMs: row.fetched_at_ms, utilization },
          {
            source: row.source === 'live' ? 'live' : 'cache',
            levelB: this.levelB.status
          }
        )
      }

      // El plan también sobrevive: se guardó en `meta` la última vez que se pudo leer.
      const tier = getMeta(this.db, 'rate_limit_tier')
      if (tier !== null) {
        const meta: ClaudeAccountMeta = {
          accountUuid: getMeta(this.db, 'account_uuid'),
          accountEmail: getMeta(this.db, 'account_email'),
          organizationUuid: getMeta(this.db, 'org_uuid'),
          organizationType: getMeta(this.db, 'org_type'),
          rateLimitTier: tier,
          hasExtraUsageEnabled: false
        }
        this.meta = meta
        this.planInfo = buildPlanInfo(meta, this.lookupPlan(tier))
      }
    } catch (error) {
      this.onError(error)
    }
  }

  /**
   * Nivel B: refresco por cuenta propia. Degradación silenciosa — si no está
   * configurado (punto abierto B2) o falla, se devuelve la vista del Nivel A tal cual.
   */
  async refreshLive(): Promise<LimitsView> {
    try {
      const live = await this.levelB.refresh()
      if (live !== null) {
        this.view = live
        this.persistSnapshot(
          'live',
          this.levelB.snapshot ?? {
            fetchedAtMs: live.fetchedAt === null ? null : Date.parse(live.fetchedAt),
            utilization: this.cache.utilization
          }
        )
        this.onLimits(this.view)
        this.onWeeklyPercent(weeklyPercent(this.view))
        return this.view
      }
    } catch (error) {
      this.onError(error)
    }
    // Sin Nivel B se reetiqueta la vista con el estado actual y se sigue con el caché.
    this.view = { ...this.view, levelB: this.levelB.status }
    return this.view
  }

  /**
   * El snapshot del Nivel B si es más reciente que el del caché que acaba de leerse;
   * `null` si el caché va por delante (o si aún no hay dato de Nivel B). Se devuelve el
   * `CachedUsage` crudo, no la vista, para que `buildLimitsView` recalcule
   * `ageSeconds`/`stale` con la hora de ahora: el frontal pinta esos campos tal cual, y
   * una vista reutilizada los dejaría congelados en el valor que tuvieran al nacer.
   */
  private fresherLevelBSnapshot(cache: CachedUsage): CachedUsage | null {
    const live = this.levelB.snapshot
    if (live === null || live.fetchedAtMs === null) return null
    if (cache.fetchedAtMs !== null && cache.fetchedAtMs >= live.fetchedAtMs) return null
    return live
  }

  /** `levelB:setEnabled`. `verified` solo es true si hay token Y endpoint. */
  async setLevelBEnabled(enabled: boolean): Promise<{ enabled: boolean; verified: boolean }> {
    const result = await this.levelB.setEnabled(enabled)
    this.view = { ...this.view, levelB: this.levelB.status }
    this.onLimits(this.view)
    return result
  }

  get levelBAvailable(): boolean {
    return this.levelB.available
  }

  /**
   * Vigila `~/.claude.json` con debounce de 1 s. El fichero es grande y se reescribe a
   * menudo; solo se reparsea cuando el watcher se calma.
   */
  async startWatching(): Promise<void> {
    if (this.watcher !== null) return
    const path = claudeJsonPath(this.home)
    try {
      // Sondeo en vez de fsevents: sobre un fichero suelto el watcher nativo de macOS
      // pierde cambios de forma no determinista (medido). Un `stat` cada dos segundos
      // sobre un único fichero no se nota, y aquí perder un cambio significa enseñar
      // porcentajes viejos como si fueran nuevos.
      const watcher = chokidar.watch(path, {
        ignoreInitial: true,
        usePolling: true,
        interval: 2000,
        awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 }
      })
      watcher.on('all', () => this.scheduleRefresh())
      watcher.on('error', (error) => this.onError(error))
      this.watcher = watcher
      await new Promise<void>((resolve) => {
        watcher.once('ready', () => resolve())
        setTimeout(resolve, 2000)
      })
    } catch (error) {
      this.onError(error)
    }
  }

  private scheduleRefresh(): void {
    if (this.debounce !== null) clearTimeout(this.debounce)
    this.debounce = setTimeout(() => {
      this.debounce = null
      this.refresh()
    }, CLAUDE_JSON_DEBOUNCE_MS)
  }

  async stop(): Promise<void> {
    if (this.debounce !== null) {
      clearTimeout(this.debounce)
      this.debounce = null
    }
    if (this.watcher !== null) {
      await this.watcher.close()
      this.watcher = null
    }
    this.levelB.stop()
  }

  // -------------------------------------------------------------------------
  // Base de datos
  // -------------------------------------------------------------------------

  private lookupPlan(tierId: string | null): PlanRow | null {
    if (tierId === null) return null
    try {
      const row = this.db
        .prepare(
          `SELECT tier_id, organization_type, display_name, monthly_usd
             FROM plans WHERE tier_id = ?`
        )
        .get(tierId) as
        | {
            tier_id: string
            organization_type: string | null
            display_name: string
            monthly_usd: number | null
          }
        | undefined
      if (row === undefined) return null
      return {
        tierId: row.tier_id,
        organizationType: row.organization_type,
        displayName: row.display_name,
        monthlyUsd: row.monthly_usd
      }
    } catch (error) {
      this.onError(error)
      return null
    }
  }

  private persistMeta(meta: ClaudeAccountMeta): void {
    const now = new Date().toISOString()
    const pairs = [
      ['account_uuid', meta.accountUuid],
      ['account_email', meta.accountEmail],
      ['org_uuid', meta.organizationUuid],
      ['org_type', meta.organizationType],
      ['rate_limit_tier', meta.rateLimitTier]
    ] as const
    try {
      for (const [key, value] of pairs) {
        if (value !== null) setMeta(this.db, key, value, now)
      }
    } catch (error) {
      this.onError(error)
    }
  }

  /**
   * Guarda el `utilization` íntegro. El `UNIQUE (source, fetched_at_ms)` de la tabla
   * evita duplicar el mismo caché rancio una y otra vez, así que basta un
   * `INSERT OR IGNORE`.
   */
  private persistSnapshot(source: 'cache' | 'live', cache: CachedUsage): void {
    if (cache.utilization === null) return
    try {
      const fiveHour = this.view.bars.find((b) => b.kind === 'session')?.percent ?? null
      const sevenDay = this.view.bars.find((b) => b.kind === 'weekly_all')?.percent ?? null
      this.db
        .prepare(
          `INSERT OR IGNORE INTO limits_snapshots
             (captured_at, fetched_at_ms, source, five_hour_pct, seven_day_pct, payload_json)
           VALUES (@captured_at, @fetched_at_ms, @source, @five_hour, @seven_day, @payload)`
        )
        .run({
          captured_at: new Date().toISOString(),
          fetched_at_ms: cache.fetchedAtMs,
          source,
          five_hour: fiveHour,
          seven_day: sevenDay,
          payload: JSON.stringify(cache.utilization)
        })
    } catch (error) {
      this.onError(error)
    }
  }
}
