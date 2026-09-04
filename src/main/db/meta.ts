import type { Db } from './connection'

/** Claves conocidas de `meta` (02-esquema-bd.md §2). */
export type MetaKey =
  | 'schema_created_at'
  | 'backfill_done'
  | 'timezone'
  | 'last_full_scan_at'
  | 'lines_ingested_total'
  | 'account_uuid'
  | 'account_email'
  | 'org_uuid'
  | 'org_type'
  | 'rate_limit_tier'
  | 'snapshot_imported_at'
  | 'ingest_warnings'

export function getMeta(db: Db, key: MetaKey): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row?.value ?? null
}

export function setMeta(db: Db, key: MetaKey, value: string, now = new Date().toISOString()): void {
  db.prepare(
    `INSERT INTO meta (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, value, now)
}

export function getMetaInt(db: Db, key: MetaKey, fallback = 0): number {
  const raw = getMeta(db, key)
  if (raw === null) return fallback
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) ? n : fallback
}

export function bumpMetaInt(db: Db, key: MetaKey, delta: number, now?: string): number {
  const next = getMetaInt(db, key) + delta
  setMeta(db, key, String(next), now)
  return next
}
