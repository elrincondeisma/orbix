import { createHash } from 'node:crypto'
import { closeSync, openSync, readSync, statSync, type Stats } from 'node:fs'
import type { Db } from '../db/connection'

/**
 * Cursor de ingesta por fichero: `ingest_files`. Guarda hasta dónde se leyó,
 * la última línea a medias y la identidad del fichero (dev/inode + firma de
 * cabecera) para detectar truncados, rotaciones y renombrados.
 * 02-esquema-bd.md §5.2.
 */

export type FileState = 'active' | 'gone' | 'error' | 'skipped'

export interface FileCursor {
  path: string
  projectKey: string
  sessionId: string | null
  isSidechain: 0 | 1
  dev: number | null
  inode: number | null
  size: number
  byteOffset: number
  partial: string
  mtimeMs: number
  headSig: string | null
  linesIngested: number
  state: FileState
  errorCount: number
}

interface CursorRow {
  path: string
  project_key: string
  session_id: string | null
  is_sidechain: number
  dev: number | null
  inode: number | null
  size: number
  byte_offset: number
  partial: string
  mtime_ms: number
  head_sig: string | null
  lines_ingested: number
  state: FileState
  error_count: number
}

function fromRow(r: CursorRow): FileCursor {
  return {
    path: r.path,
    projectKey: r.project_key,
    sessionId: r.session_id,
    isSidechain: r.is_sidechain === 1 ? 1 : 0,
    dev: r.dev,
    inode: r.inode,
    size: r.size,
    byteOffset: r.byte_offset,
    partial: r.partial,
    mtimeMs: r.mtime_ms,
    headSig: r.head_sig,
    linesIngested: r.lines_ingested,
    state: r.state,
    errorCount: r.error_count
  }
}

const SELECT_COLS = `path, project_key, session_id, is_sidechain, dev, inode, size, byte_offset,
                     partial, mtime_ms, head_sig, lines_ingested, state, error_count`

export function loadCursor(db: Db, path: string): FileCursor | null {
  const row = db.prepare(`SELECT ${SELECT_COLS} FROM ingest_files WHERE path = ?`).get(path) as
    | CursorRow
    | undefined
  return row ? fromRow(row) : null
}

/** Busca por identidad de inodo: detecta ficheros renombrados o movidos. */
export function findByInode(db: Db, dev: number, inode: number): FileCursor | null {
  const row = db
    .prepare(`SELECT ${SELECT_COLS} FROM ingest_files WHERE dev = ? AND inode = ? LIMIT 1`)
    .get(dev, inode) as CursorRow | undefined
  return row ? fromRow(row) : null
}

export function allCursors(db: Db, state?: FileState): FileCursor[] {
  const rows = (
    state
      ? db.prepare(`SELECT ${SELECT_COLS} FROM ingest_files WHERE state = ?`).all(state)
      : db.prepare(`SELECT ${SELECT_COLS} FROM ingest_files`).all()
  ) as CursorRow[]
  return rows.map(fromRow)
}

export function countTracked(db: Db): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ingest_files WHERE state <> 'gone'`).get() as {
    n: number
  }
  return row.n
}

/** Persiste el cursor entero. Se llama SIEMPRE dentro de la transacción de la rodaja. */
export function saveCursor(db: Db, c: FileCursor, now = new Date().toISOString()): void {
  db.prepare(
    `INSERT INTO ingest_files
       (path, project_key, session_id, is_sidechain, dev, inode, size, byte_offset, partial,
        mtime_ms, head_sig, lines_ingested, state, last_seen_at, last_ingested_at, last_error,
        error_count)
     VALUES (@path, @project_key, @session_id, @is_sidechain, @dev, @inode, @size, @byte_offset,
        @partial, @mtime_ms, @head_sig, @lines_ingested, @state, @now, @now, NULL, @error_count)
     ON CONFLICT(path) DO UPDATE SET
       project_key      = excluded.project_key,
       session_id       = COALESCE(excluded.session_id, ingest_files.session_id),
       is_sidechain     = excluded.is_sidechain,
       dev              = excluded.dev,
       inode            = excluded.inode,
       size             = excluded.size,
       byte_offset      = excluded.byte_offset,
       partial          = excluded.partial,
       mtime_ms         = excluded.mtime_ms,
       head_sig         = excluded.head_sig,
       lines_ingested   = excluded.lines_ingested,
       state            = excluded.state,
       last_seen_at     = excluded.last_seen_at,
       last_ingested_at = excluded.last_ingested_at,
       last_error       = NULL,
       error_count      = excluded.error_count`
  ).run({
    path: c.path,
    project_key: c.projectKey,
    session_id: c.sessionId,
    is_sidechain: c.isSidechain,
    dev: c.dev,
    inode: c.inode,
    size: c.size,
    byte_offset: c.byteOffset,
    partial: c.partial,
    mtime_ms: c.mtimeMs,
    head_sig: c.headSig,
    lines_ingested: c.linesIngested,
    state: c.state,
    error_count: c.errorCount,
    now
  })
}

/** Renombrado/movido: mismo inodo, otra ruta. Se conserva el offset. */
export function renameCursor(db: Db, from: string, to: string): void {
  db.prepare(`DELETE FROM ingest_files WHERE path = ?`).run(to)
  db.prepare(`UPDATE ingest_files SET path = ? WHERE path = ?`).run(to, from)
}

/**
 * El fichero ya no está. Se conserva la fila y TODO su histórico: eso es
 * justamente lo que Claude Code destruye a los 30 días (§5.2).
 */
export function markGone(db: Db, path: string, now = new Date().toISOString()): void {
  db.prepare(`UPDATE ingest_files SET state = 'gone', last_seen_at = ? WHERE path = ?`).run(
    now,
    path
  )
}

/** Máximo 5 reintentos y a `skipped`, para no quemar ciclos con un fichero roto. */
export function markError(
  db: Db,
  path: string,
  message: string,
  now = new Date().toISOString(),
  maxRetries = 5
): void {
  db.prepare(
    `UPDATE ingest_files
        SET error_count = error_count + 1,
            last_error  = @msg,
            last_seen_at = @now,
            state = CASE WHEN error_count + 1 >= @max THEN 'skipped' ELSE 'error' END
      WHERE path = @path`
  ).run({ path, msg: message.slice(0, 500), now, max: maxRetries })
}

export function resetCursor(c: FileCursor): void {
  c.byteOffset = 0
  c.partial = ''
  c.headSig = null
}

export const HEAD_BYTES = 4096

/**
 * Firma de cabecera: SHA-1 de los primeros N bytes, con N guardado dentro de la
 * propia firma (`'<n>:<sha1>'`).
 *
 * El número de bytes importa: si se firmaran siempre los primeros 4096 de un
 * fichero que todavía no los tiene, la firma cambiaría al crecer el fichero y
 * cada ciclo lo daría por reescrito, releyéndolo entero. Se firma solo la parte
 * YA CONSUMIDA (`min(4096, byte_offset)`), que no cambia salvo reescritura real.
 */
export function headSignature(path: string, bytes: number): string | null {
  const n = Math.max(0, Math.min(HEAD_BYTES, Math.trunc(bytes)))
  if (n === 0) return null
  let fd: number | null = null
  try {
    fd = openSync(path, 'r')
    const buf = Buffer.allocUnsafe(n)
    const read = readSync(fd, buf, 0, n, 0)
    if (read < n) return null // el fichero encogió: lo resuelve la detección de truncado
    const hash = createHash('sha1').update(buf.subarray(0, read)).digest('hex')
    return `${n}:${hash}`
  } catch {
    return null
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        /* nada que hacer */
      }
    }
  }
}

/** Nº de bytes con los que se calculó una firma guardada. */
export function signatureLength(signature: string | null): number {
  if (!signature) return 0
  const n = Number.parseInt(signature.split(':')[0] ?? '', 10)
  return Number.isFinite(n) ? n : 0
}

export function statOrNull(path: string): Stats | null {
  try {
    return statSync(path)
  } catch {
    return null
  }
}
