import { closeSync, openSync, readSync } from 'node:fs'
import type Database from 'better-sqlite3'
import type { Db } from '../db/connection'
import { bumpMetaInt, getMetaInt, setMeta } from '../db/meta'
import type { PriceCache } from '../db/prices'
import { SYNTHETIC_MODEL_KEY } from '../db/prices'
import { markDirtyDays, rebuildAllRollups, recomputeDirtyDays } from '../db/rollups'
import { dayLocal } from '../db/time'
import {
  countTracked,
  findByInode,
  headSignature,
  loadCursor,
  markError,
  markGone,
  renameCursor,
  resetCursor,
  saveCursor,
  signatureLength,
  statOrNull,
  type FileCursor
} from './cursor'
import {
  emptyWarnings,
  mergeWarnings,
  parseJsonlLine,
  type FileContext,
  type ParseWarnings,
  type UsageLine
} from './parser'
import { discoverFiles, projectsRoot, ProjectsWatcher, type DiscoveredFile } from './scanner'

/** Sentencia preparada con parámetros con nombre (`@param`). */
type Stmt = Database.Statement<unknown[]>

/**
 * Orquestación de la ingesta (02-esquema-bd.md §5.3).
 *
 * Reglas duras:
 *  - rodajas de 8 MiB / 200 ms como mucho, cediendo el event loop entre rodajas:
 *    el proceso `main` no se puede bloquear.
 *  - el avance del cursor y las filas insertadas van en la MISMA transacción; si
 *    el proceso muere a mitad se reprocesa la rodaja y la dedup por clave la
 *    absorbe sin duplicar.
 */

export const SLICE_BYTES = 8 * 1024 * 1024
export const SLICE_MS = 200
/** Tope duro para una sola línea JSONL antes de darla por corrupta. */
export const MAX_LINE_BYTES = 64 * 1024 * 1024

/** Igual que `IngestStatus` de 01-arquitectura.md §3.4. */
export interface IngestStatusLike {
  state: 'idle' | 'scanning' | 'backfilling' | 'error'
  filesTracked: number
  lastRunAt: string | null
  lastDurationMs: number | null
  backfillProgress: number | null
  linesIngestedTotal: number
  lastError: string | null
}

export interface IngestRunResult {
  readonly files: number
  readonly linesIngested: number
  /** Peticiones creadas o con contadores nuevos. */
  readonly requestsTouched: number
  readonly daysDirty: number
  readonly durationMs: number
  readonly warnings: ParseWarnings
}

export interface IngestorOptions {
  readonly db: Db
  readonly prices: PriceCache
  /** IANA. Determina `day_local`. */
  readonly timezone: string
  readonly root?: string
  readonly sliceBytes?: number
  readonly sliceMs?: number
  /** Se llama al terminar cada fichero durante el backfill (máx. 2/s lo hace `main`). */
  readonly onProgress?: (status: IngestStatusLike) => void
}

export class Ingestor {
  private readonly db: Db
  private readonly prices: PriceCache
  private readonly root: string
  private readonly sliceBytes: number
  private readonly sliceMs: number
  private readonly onProgress: ((status: IngestStatusLike) => void) | null

  private timezone: string
  private watcher: ProjectsWatcher | null = null
  private queue: string[] = []
  private running = false
  private state: IngestStatusLike['state'] = 'idle'
  private lastRunAt: string | null = null
  private lastDurationMs: number | null = null
  private lastError: string | null = null
  private backfillProgress: number | null = null

  // Sentencias preparadas: se compilan una vez por instancia, no por línea.
  private readonly insertLine: Stmt
  private readonly upsertRequest: Stmt
  private readonly updateCost: Stmt
  private readonly updateDay: Stmt

  constructor(options: IngestorOptions) {
    this.db = options.db
    this.prices = options.prices
    this.timezone = options.timezone
    this.root = options.root ?? projectsRoot()
    this.sliceBytes = options.sliceBytes ?? SLICE_BYTES
    this.sliceMs = options.sliceMs ?? SLICE_MS
    this.onProgress = options.onProgress ?? null

    this.insertLine = this.db.prepare(INSERT_LINE_SQL)
    this.upsertRequest = this.db.prepare(UPSERT_REQUEST_SQL)
    this.updateCost = this.db.prepare(UPDATE_COST_SQL)
    this.updateDay = this.db.prepare(UPDATE_DAY_SQL)
  }

  setTimezone(tz: string): void {
    this.timezone = tz
  }

  getStatus(): IngestStatusLike {
    return {
      state: this.state,
      filesTracked: countTracked(this.db),
      lastRunAt: this.lastRunAt,
      lastDurationMs: this.lastDurationMs,
      backfillProgress: this.backfillProgress,
      linesIngestedTotal: getMetaInt(this.db, 'lines_ingested_total'),
      lastError: this.lastError
    }
  }

  /** Arranca el watcher. La primera pasada la hace `runOnce()`. */
  async start(): Promise<void> {
    if (this.watcher) return
    this.watcher = new ProjectsWatcher({
      root: this.root,
      onFiles: (paths) => {
        for (const p of paths) if (!this.queue.includes(p)) this.queue.push(p)
      }
    })
    await this.watcher.start()
  }

  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.stop()
      this.watcher = null
    }
  }

  /**
   * Un ciclo completo: descubre ficheros, los procesa por rodajas y recalcula
   * los días tocados. Reentrante: si ya hay uno en marcha, no hace nada.
   */
  async runOnce(
    options: { readonly backfill?: boolean; readonly full?: boolean } = {}
  ): Promise<IngestRunResult> {
    if (this.running) {
      return {
        files: 0,
        linesIngested: 0,
        requestsTouched: 0,
        daysDirty: 0,
        durationMs: 0,
        warnings: emptyWarnings()
      }
    }
    this.running = true
    const started = Date.now()
    this.state = options.backfill === true ? 'backfilling' : 'scanning'

    let linesIngested = 0
    let requestsTouched = 0
    let warnings = emptyWarnings()
    const dirtyDays = new Set<string>()

    try {
      const discovered = discoverFiles(this.root)
      const totalBytes = discovered.reduce((n, f) => n + f.size, 0)
      let doneBytes = 0

      const queued = new Set(this.queue)
      this.queue = []

      const seen = new Set<string>()
      for (const file of discovered) {
        seen.add(file.path)
        const result = await this.ingestFile(file, dirtyDays)
        linesIngested += result.lines
        requestsTouched += result.requests
        warnings = mergeWarnings(warnings, result.warnings)
        doneBytes += file.size
        if (options.backfill === true) {
          this.backfillProgress = totalBytes > 0 ? doneBytes / totalBytes : 1
          this.onProgress?.(this.getStatus())
        }
      }

      // Rutas encoladas por el watcher que el barrido no vio (borradas entre medias)
      for (const path of queued) {
        if (seen.has(path)) continue
        if (statOrNull(path) === null) markGone(this.db, path)
      }

      // Ficheros que teníamos y ya no están: se marcan, NUNCA se borra su histórico
      const tracked = this.db
        .prepare(`SELECT path FROM ingest_files WHERE state = 'active'`)
        .all() as Array<{ path: string }>
      for (const { path } of tracked) {
        if (!seen.has(path) && statOrNull(path) === null) markGone(this.db, path)
      }

      markDirtyDays(this.db, dirtyDays)
      let pending = 0
      do {
        pending = recomputeDirtyDays(this.db, this.prices, { limit: 50 })
      } while (pending > 0)

      // `ingest:runNow { full: true }`: `rollup_daily` es derivada, se tira y se
      // reconstruye entera desde `usage_requests` + `snapshot_rollups`.
      if (options.full === true) rebuildAllRollups(this.db, this.prices)

      setMeta(this.db, 'last_full_scan_at', new Date().toISOString())
      if (options.backfill === true) setMeta(this.db, 'backfill_done', '1')
      this.lastError = null
      this.state = 'idle'
      this.backfillProgress = null

      const durationMs = Date.now() - started
      this.lastRunAt = new Date().toISOString()
      this.lastDurationMs = durationMs
      return {
        files: discovered.length,
        linesIngested,
        requestsTouched,
        daysDirty: dirtyDays.size,
        durationMs,
        warnings
      }
    } catch (err) {
      this.state = 'error'
      this.lastError = err instanceof Error ? err.message : String(err)
      throw err
    } finally {
      this.running = false
    }
  }

  /** Lee un fichero entero, rodaja a rodaja, cediendo el event loop entre ellas. */
  private async ingestFile(
    file: DiscoveredFile,
    dirtyDays: Set<string>
  ): Promise<{ lines: number; requests: number; warnings: ParseWarnings }> {
    let cursor = loadCursor(this.db, file.path)
    const st = statOrNull(file.path)
    if (!st) {
      if (cursor) markGone(this.db, file.path)
      return { lines: 0, requests: 0, warnings: emptyWarnings() }
    }

    if (!cursor) {
      // ¿es un renombrado de algo que ya conocíamos? entonces se conserva el offset
      const byInode = findByInode(this.db, st.dev, st.ino)
      if (byInode) {
        renameCursor(this.db, byInode.path, file.path)
        cursor = { ...byInode, path: file.path }
      } else {
        cursor = {
          path: file.path,
          projectKey: file.projectKey,
          sessionId: file.sessionId,
          isSidechain: file.isSidechain,
          dev: st.dev,
          inode: st.ino,
          size: 0,
          byteOffset: 0,
          partial: '',
          mtimeMs: 0,
          headSig: null,
          linesIngested: 0,
          state: 'active',
          errorCount: 0
        }
      }
    }
    if (cursor.state === 'skipped') return { lines: 0, requests: 0, warnings: emptyWarnings() }
    cursor.projectKey = file.projectKey
    cursor.isSidechain = file.isSidechain
    cursor.sessionId = cursor.sessionId ?? file.sessionId
    cursor.state = 'active'

    let lines = 0
    let requests = 0
    let warnings = emptyWarnings()
    const deadline = Date.now() + this.sliceMs

    for (;;) {
      let outcome: SliceOutcome
      try {
        outcome = this.readSlice(cursor, dirtyDays)
      } catch (err) {
        markError(this.db, cursor.path, err instanceof Error ? err.message : String(err))
        break
      }
      lines += outcome.lines
      requests += outcome.requests
      warnings = mergeWarnings(warnings, outcome.warnings)
      if (outcome.status !== 'more') break
      if (Date.now() > deadline) await yieldToEventLoop()
    }

    return { lines, requests, warnings }
  }

  /**
   * Una rodaja: lee como mucho `sliceBytes`, procesa las líneas completas y
   * persiste cursor + filas en una única transacción.
   *
   * Desviación consciente del pseudocódigo de §5.3: no se guarda la última línea
   * incompleta en `partial`; el cursor se queda al principio de esa línea y se
   * relee en el siguiente ciclo. Evita partir un carácter UTF-8 multibyte en el
   * corte de la rodaja (que corrompería la línea) y hace la recuperación tras un
   * cierre inesperado trivial. `partial` se mantiene en el esquema, siempre ''.
   */
  private readSlice(cursor: FileCursor, dirtyDays: Set<string>): SliceOutcome {
    const st = statOrNull(cursor.path)
    if (!st) {
      markGone(this.db, cursor.path)
      return { status: 'gone', lines: 0, requests: 0, warnings: emptyWarnings() }
    }

    // Sin cambios y ya consumido entero: ni se abre el fichero (§5.2).
    // Si queda una línea a medias, `byte_offset < size` y se vuelve a mirar: son
    // unos pocos KB, y es lo que permite no guardar `partial` en la BD.
    if (st.size === cursor.byteOffset && st.mtimeMs === cursor.mtimeMs) {
      return { status: 'done', lines: 0, requests: 0, warnings: emptyWarnings() }
    }

    if (st.size < cursor.byteOffset) resetCursor(cursor) // truncado
    if (cursor.dev !== st.dev || cursor.inode !== st.ino) {
      resetCursor(cursor) // reescrito en sitio / rotación
      cursor.dev = st.dev
      cursor.inode = st.ino
    }

    // La firma se comprueba con los mismos bytes con los que se calculó
    if (cursor.byteOffset > 0 && cursor.headSig !== null) {
      const actual = headSignature(cursor.path, signatureLength(cursor.headSig))
      if (actual !== cursor.headSig) resetCursor(cursor) // mismo path e inodo, contenido nuevo
    }

    if (cursor.byteOffset >= st.size) {
      cursor.size = st.size
      cursor.mtimeMs = st.mtimeMs
      cursor.headSig = headSignature(cursor.path, cursor.byteOffset)
      this.persist(cursor)
      return { status: 'done', lines: 0, requests: 0, warnings: emptyWarnings() }
    }

    // Ventana de lectura: `sliceBytes`, ampliada si la línea no cabe. Las líneas
    // de los transcripts llegan a 2,4 MB medidos, y un tool_result grande puede
    // superar la rodaja; no se puede descartar una línea solo por ser larga.
    let window = this.sliceBytes
    let chunk: Buffer = Buffer.alloc(0)
    let to = cursor.byteOffset
    let lastNl = -1
    for (;;) {
      to = Math.min(st.size, cursor.byteOffset + window)
      chunk = readRange(cursor.path, cursor.byteOffset, to - cursor.byteOffset)
      lastNl = chunk.lastIndexOf(0x0a)
      if (lastNl !== -1 || to >= st.size || window >= MAX_LINE_BYTES) break
      window *= 2
    }

    if (lastNl === -1) {
      if (to < st.size) {
        // línea imposible: se descarta ese tramo y se sigue
        cursor.byteOffset = to
        cursor.size = st.size
        cursor.mtimeMs = st.mtimeMs
        cursor.headSig = headSignature(cursor.path, cursor.byteOffset)
        this.persist(cursor)
        markError(this.db, cursor.path, `línea de más de ${MAX_LINE_BYTES} bytes descartada`)
        return { status: 'more', lines: 0, requests: 0, warnings: emptyWarnings() }
      }
      // cola incompleta: se espera a que Claude Code cierre la línea
      cursor.size = st.size
      cursor.mtimeMs = st.mtimeMs
      this.persist(cursor)
      return { status: 'done', lines: 0, requests: 0, warnings: emptyWarnings() }
    }

    const text = chunk.subarray(0, lastNl).toString('utf8')
    const consumed = lastNl + 1
    const nextOffset = cursor.byteOffset + consumed
    const more = nextOffset < st.size

    const fileCtx: FileContext = {
      path: cursor.path,
      projectKey: cursor.projectKey,
      sessionId: cursor.sessionId,
      isSidechain: cursor.isSidechain
    }

    const warnings = emptyWarnings()
    let lines = 0
    let requests = 0

    const apply = this.db.transaction(() => {
      for (const raw of text.split('\n')) {
        if (raw.trim() === '') continue
        let parsed: UsageLine | null = null
        try {
          parsed = parseJsonlLine(raw, fileCtx, warnings)
        } catch {
          warnings.badJson += 1 // el parser no debería lanzar nunca; por si acaso
          continue
        }
        if (!parsed) continue
        lines += 1
        if (this.storeLine(parsed, dirtyDays)) requests += 1
      }
      cursor.byteOffset = nextOffset
      cursor.partial = ''
      cursor.size = st.size
      cursor.mtimeMs = st.mtimeMs
      cursor.headSig = headSignature(cursor.path, nextOffset)
      cursor.linesIngested += lines
      saveCursor(this.db, cursor)
      if (lines > 0) bumpMetaInt(this.db, 'lines_ingested_total', lines)
    })
    apply()

    return { status: more ? 'more' : 'done', lines, requests, warnings }
  }

  private persist(cursor: FileCursor): void {
    const run = this.db.transaction(() => saveCursor(this.db, cursor))
    run()
  }

  /**
   * Guarda la línea (idempotencia) y hace el upsert facturable por `request_id`
   * agregando con MAX (§0 y §5.4). Devuelve true si la petición ganó contadores.
   */
  private storeLine(line: UsageLine, dirtyDays: Set<string>): boolean {
    this.insertLine.run({
      request_id: line.requestId,
      api_block_index: line.apiBlockIndex,
      line_uuid: line.lineUuid,
      ts: line.ts,
      ts_epoch: line.tsEpoch,
      session_id: line.sessionId,
      project_key: line.projectKey,
      source_path: line.sourcePath,
      is_sidechain: line.isSidechain,
      model_raw: line.modelRaw,
      input_tok: line.inputTok,
      output_tok: line.outputTok,
      thinking_tok: line.thinkingTok,
      cache_write_5m: line.cacheWrite5m,
      cache_write_1h: line.cacheWrite1h,
      cache_read: line.cacheRead
    })

    const day = dayLocal(line.tsEpoch, this.timezone)
    const now = new Date().toISOString()
    const cost = this.prices.costOf(line.modelKey, line.ts, {
      input_tok: line.inputTok,
      output_tok: line.outputTok,
      cache_write_5m: line.cacheWrite5m,
      cache_write_1h: line.cacheWrite1h,
      cache_read: line.cacheRead
    })

    const row = this.upsertRequest.get({
      request_id: line.requestId,
      ts: line.ts,
      ts_epoch: line.tsEpoch,
      day_local: day,
      session_id: line.sessionId,
      project_key: line.projectKey,
      project_path: line.projectPath,
      is_sidechain: line.isSidechain,
      model_raw: line.modelRaw,
      model_key: line.modelKey,
      input_tok: line.inputTok,
      output_tok: line.outputTok,
      thinking_tok: line.thinkingTok,
      cache_write_5m: line.cacheWrite5m,
      cache_write_1h: line.cacheWrite1h,
      cache_read: line.cacheRead,
      cost_usd: cost.costUsd,
      price_id: cost.priceId,
      now
    }) as UpsertedRow | undefined

    // El WHERE del upsert bloqueó el UPDATE: línea duplicada sin novedad
    if (!row) return false

    dirtyDays.add(row.day_local)

    // `day_local` tiene que ser SIEMPRE el día de `ts`, y `ts` avanza al bloque
    // más tardío. Si un bloque posterior cruza la medianoche, la petición cambia
    // de día: se mueve y se recalculan los dos días implicados. Sin esto la
    // cifra deja de cuadrar con un escaneo independiente de los transcripts,
    // que es justo lo que la app promete.
    const diaDeTs = dayLocal(row.ts_epoch, this.timezone)
    if (diaDeTs !== row.day_local) {
      this.updateDay.run({ day: diaDeTs, rid: row.request_id, now })
      dirtyDays.add(diaDeTs)
    }

    // Los contadores se han fundido con MAX: hay que recalcular el coste
    if (row.cost_stale === 1) {
      const merged = this.prices.costOf(row.model_key, row.ts, {
        input_tok: row.input_tok,
        output_tok: row.output_tok,
        cache_write_5m: row.cache_write_5m,
        cache_write_1h: row.cache_write_1h,
        cache_read: row.cache_read
      })
      this.updateCost.run({
        rid: row.request_id,
        cost: merged.costUsd,
        price_id: merged.priceId,
        now
      })
    }
    return true
  }

}

const INSERT_LINE_SQL = `INSERT INTO usage_lines
       (request_id, api_block_index, line_uuid, ts, ts_epoch, session_id, project_key,
        source_path, is_sidechain, model_raw, input_tok, output_tok, thinking_tok,
        cache_write_5m, cache_write_1h, cache_read)
     VALUES (@request_id, @api_block_index, @line_uuid, @ts, @ts_epoch, @session_id, @project_key,
        @source_path, @is_sidechain, @model_raw, @input_tok, @output_tok, @thinking_tok,
        @cache_write_5m, @cache_write_1h, @cache_read)
     ON CONFLICT(request_id, api_block_index) DO UPDATE SET
       output_tok   = MAX(usage_lines.output_tok,   excluded.output_tok),
       thinking_tok = MAX(usage_lines.thinking_tok, excluded.thinking_tok),
       ts           = MAX(usage_lines.ts,           excluded.ts)`

/**
 * El corazón de todo: una fila por PETICIÓN, con MAX de cada contador entre sus
 * bloques. MAX y no "último bloque" porque es conmutativo e idempotente: da
 * igual el orden de llegada ni cuántas veces se reingiera.
 */
const UPSERT_REQUEST_SQL = `INSERT INTO usage_requests
       (request_id, ts, ts_epoch, day_local, session_id, project_key, project_path,
        is_sidechain, model_raw, model_key, blocks,
        input_tok, output_tok, thinking_tok, cache_write_5m, cache_write_1h, cache_read,
        cost_usd, price_id, cost_stale, first_seen_at, updated_at)
     VALUES (@request_id, @ts, @ts_epoch, @day_local, @session_id, @project_key, @project_path,
        @is_sidechain, @model_raw, @model_key, 1,
        @input_tok, @output_tok, @thinking_tok, @cache_write_5m, @cache_write_1h, @cache_read,
        @cost_usd, @price_id, 0, @now, @now)
     ON CONFLICT(request_id) DO UPDATE SET
       input_tok      = MAX(usage_requests.input_tok,      excluded.input_tok),
       output_tok     = MAX(usage_requests.output_tok,     excluded.output_tok),
       thinking_tok   = MAX(usage_requests.thinking_tok,   excluded.thinking_tok),
       cache_write_5m = MAX(usage_requests.cache_write_5m, excluded.cache_write_5m),
       cache_write_1h = MAX(usage_requests.cache_write_1h, excluded.cache_write_1h),
       cache_read     = MAX(usage_requests.cache_read,     excluded.cache_read),
       blocks         = usage_requests.blocks + 1,
       ts             = MAX(usage_requests.ts, excluded.ts),
       ts_epoch       = MAX(usage_requests.ts_epoch, excluded.ts_epoch),
       session_id     = COALESCE(usage_requests.session_id, excluded.session_id),
       project_path   = COALESCE(usage_requests.project_path, excluded.project_path),
       cost_stale     = 1,
       updated_at     = excluded.updated_at
     WHERE excluded.input_tok      > usage_requests.input_tok
        OR excluded.output_tok     > usage_requests.output_tok
        OR excluded.cache_write_5m > usage_requests.cache_write_5m
        OR excluded.cache_write_1h > usage_requests.cache_write_1h
        OR excluded.cache_read     > usage_requests.cache_read
        OR excluded.ts_epoch       > usage_requests.ts_epoch
     RETURNING request_id, ts, ts_epoch, day_local, model_key, cost_stale,
               input_tok, output_tok, cache_write_5m, cache_write_1h, cache_read`

/**
 * El `ON CONFLICT` de arriba avanza `ts`/`ts_epoch` al bloque más tardío pero
 * deja `day_local` como estaba: así el RETURNING devuelve el día ANTERIOR y se
 * puede marcar como sucio antes de moverlo. Solo hace falta cuando una petición
 * cruza la medianoche entre bloques (medido: 1 de 12.858 peticiones reales).
 */
const UPDATE_DAY_SQL = `UPDATE usage_requests
        SET day_local = @day, updated_at = @now
      WHERE request_id = @rid`

const UPDATE_COST_SQL = `UPDATE usage_requests
        SET cost_usd = @cost, price_id = @price_id, cost_stale = 0, updated_at = @now
      WHERE request_id = @rid`

interface UpsertedRow {
  request_id: string
  ts: string
  ts_epoch: number
  day_local: string
  model_key: string
  cost_stale: number
  input_tok: number
  output_tok: number
  cache_write_5m: number
  cache_write_1h: number
  cache_read: number
}

interface SliceOutcome {
  readonly status: 'done' | 'more' | 'gone'
  readonly lines: number
  readonly requests: number
  readonly warnings: ParseWarnings
}

/** Lee `length` bytes desde `offset`. Devuelve lo que haya podido leer. */
function readRange(path: string, offset: number, length: number): Buffer {
  if (length <= 0) return Buffer.alloc(0)
  const buf = Buffer.allocUnsafe(length)
  let fd: number | null = null
  let read = 0
  try {
    fd = openSync(path, 'r')
    read = readSync(fd, buf, 0, length, offset)
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        /* nada que hacer */
      }
    }
  }
  return buf.subarray(0, read)
}

export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

export { SYNTHETIC_MODEL_KEY }
