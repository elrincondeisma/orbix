-- ============================================================
-- miniClaudio · esquema inicial · versión 1
-- Fiel a docs/design/02-esquema-bd.md §2.
-- El runner envuelve este fichero en una transacción: no lleva BEGIN/COMMIT.
-- ============================================================

-- ---------- clave/valor de estado interno ----------
CREATE TABLE IF NOT EXISTS meta (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
) WITHOUT ROWID;
-- claves usadas:
--   'schema_created_at'     ISO
--   'backfill_done'         '0' | '1'
--   'timezone'              IANA con la que se calculó day_local
--   'last_full_scan_at'     ISO
--   'lines_ingested_total'  entero como texto
--   'account_uuid' 'account_email' 'org_uuid' 'org_type' 'rate_limit_tier'

-- ---------- cursor de ingesta, uno por fichero JSONL ----------
CREATE TABLE IF NOT EXISTS ingest_files (
  path             TEXT PRIMARY KEY,          -- ruta absoluta
  project_key      TEXT NOT NULL,             -- '-Users-icatala-Projects-propios-miniClaudio'
  session_id       TEXT,                      -- uuid del nombre de fichero o del contenido
  is_sidechain     INTEGER NOT NULL DEFAULT 0 CHECK (is_sidechain IN (0,1)),
  dev              INTEGER,                   -- stat.dev
  inode            INTEGER,                   -- stat.ino
  size             INTEGER NOT NULL DEFAULT 0,
  byte_offset      INTEGER NOT NULL DEFAULT 0,-- bytes ya consumidos y confirmados
  partial          TEXT NOT NULL DEFAULT '',  -- última línea incompleta (sin \n)
  mtime_ms         INTEGER NOT NULL DEFAULT 0,
  head_sig         TEXT,                      -- sha1 de los primeros 4096 bytes
  lines_ingested   INTEGER NOT NULL DEFAULT 0,
  state            TEXT NOT NULL DEFAULT 'active'
                   CHECK (state IN ('active','gone','error','skipped')),
  last_seen_at     TEXT,
  last_ingested_at TEXT,
  last_error       TEXT,
  error_count      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_ingest_files_state ON ingest_files(state);
CREATE INDEX IF NOT EXISTS idx_ingest_files_ident ON ingest_files(dev, inode);

-- ---------- precios, NUNCA hardcodeados ----------
-- (se crea antes que usage_requests porque esta la referencia por clave ajena)
CREATE TABLE IF NOT EXISTS model_prices (
  id                      INTEGER PRIMARY KEY,
  model_key               TEXT NOT NULL,   -- normalizado; '__default__' como comodín
  input_per_mtok          REAL NOT NULL,
  output_per_mtok         REAL NOT NULL,
  cache_write_5m_per_mtok REAL NOT NULL,
  cache_write_1h_per_mtok REAL NOT NULL,
  cache_read_per_mtok     REAL NOT NULL,
  valid_from              TEXT NOT NULL,   -- ISO UTC; aplica a ts >= valid_from
  source                  TEXT NOT NULL DEFAULT 'seed'
                          CHECK (source IN ('seed','user','import')),
  note                    TEXT,
  UNIQUE (model_key, valid_from)
);
CREATE INDEX IF NOT EXISTS idx_prices_lookup ON model_prices(model_key, valid_from DESC);

-- ---------- grano crudo: una fila por LÍNEA assistant del JSONL ----------
-- Idempotencia de la ingesta. NO se usa para calcular coste (ver §0).
CREATE TABLE IF NOT EXISTS usage_lines (
  request_id      TEXT    NOT NULL,
  api_block_index INTEGER NOT NULL,
  line_uuid       TEXT,
  ts              TEXT    NOT NULL,
  ts_epoch        INTEGER NOT NULL,
  session_id      TEXT,
  project_key     TEXT    NOT NULL,
  source_path     TEXT    NOT NULL,
  is_sidechain    INTEGER NOT NULL DEFAULT 0 CHECK (is_sidechain IN (0,1)),
  model_raw       TEXT    NOT NULL,
  input_tok       INTEGER NOT NULL DEFAULT 0,
  output_tok      INTEGER NOT NULL DEFAULT 0,
  thinking_tok    INTEGER NOT NULL DEFAULT 0,
  cache_write_5m  INTEGER NOT NULL DEFAULT 0,
  cache_write_1h  INTEGER NOT NULL DEFAULT 0,
  cache_read      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (request_id, api_block_index)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_usage_lines_req ON usage_lines(request_id);

-- ---------- grano facturable: una fila por PETICIÓN a la API ----------
CREATE TABLE IF NOT EXISTS usage_requests (
  request_id     TEXT PRIMARY KEY,
  ts             TEXT    NOT NULL,   -- ISO UTC del bloque de mayor api_block_index
  ts_epoch       INTEGER NOT NULL,
  day_local      TEXT    NOT NULL,   -- 'YYYY-MM-DD' en meta.timezone
  session_id     TEXT,
  project_key    TEXT    NOT NULL,
  project_path   TEXT,               -- cwd real si la línea lo trae
  is_sidechain   INTEGER NOT NULL DEFAULT 0 CHECK (is_sidechain IN (0,1)),
  model_raw      TEXT    NOT NULL,   -- 'claude-haiku-4-5-20251001'
  model_key      TEXT    NOT NULL,   -- 'claude-haiku-4-5'   (normalizado, §4.2)
  blocks         INTEGER NOT NULL DEFAULT 1,
  input_tok      INTEGER NOT NULL DEFAULT 0,
  output_tok     INTEGER NOT NULL DEFAULT 0,
  thinking_tok   INTEGER NOT NULL DEFAULT 0,
  cache_write_5m INTEGER NOT NULL DEFAULT 0,
  cache_write_1h INTEGER NOT NULL DEFAULT 0,
  cache_read     INTEGER NOT NULL DEFAULT 0,
  cost_usd       REAL    NOT NULL DEFAULT 0,
  price_id       INTEGER REFERENCES model_prices(id),
  cost_stale     INTEGER NOT NULL DEFAULT 0 CHECK (cost_stale IN (0,1)),
  first_seen_at  TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ur_day       ON usage_requests(day_local);
CREATE INDEX IF NOT EXISTS idx_ur_epoch     ON usage_requests(ts_epoch);
CREATE INDEX IF NOT EXISTS idx_ur_session   ON usage_requests(session_id, ts_epoch);
CREATE INDEX IF NOT EXISTS idx_ur_proj_day  ON usage_requests(project_key, day_local);
CREATE INDEX IF NOT EXISTS idx_ur_model_day ON usage_requests(model_key, day_local);
CREATE INDEX IF NOT EXISTS idx_ur_stale     ON usage_requests(cost_stale) WHERE cost_stale = 1;

-- ---------- agregado diario: el menubar nunca escanea usage_requests ----------
CREATE TABLE IF NOT EXISTS rollup_daily (
  day_local      TEXT    NOT NULL,
  project_key    TEXT    NOT NULL,
  model_key      TEXT    NOT NULL,
  requests       INTEGER NOT NULL DEFAULT 0,
  input_tok      INTEGER NOT NULL DEFAULT 0,
  output_tok     INTEGER NOT NULL DEFAULT 0,
  thinking_tok   INTEGER NOT NULL DEFAULT 0,
  cache_write_5m INTEGER NOT NULL DEFAULT 0,
  cache_write_1h INTEGER NOT NULL DEFAULT 0,
  cache_read     INTEGER NOT NULL DEFAULT 0,
  cost_usd       REAL    NOT NULL DEFAULT 0,
  updated_at     TEXT    NOT NULL,
  PRIMARY KEY (day_local, project_key, model_key)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_rollup_day ON rollup_daily(day_local);

-- ---------- cola de días pendientes de recalcular ----------
CREATE TABLE IF NOT EXISTS rollup_dirty (
  day_local  TEXT PRIMARY KEY,
  marked_at  TEXT NOT NULL
) WITHOUT ROWID;

-- ---------- eventos de hooks ----------
CREATE TABLE IF NOT EXISTS hook_events (
  id           INTEGER PRIMARY KEY,
  ts           TEXT    NOT NULL,
  ts_epoch     INTEGER NOT NULL,
  event        TEXT    NOT NULL,   -- hook_event_name
  project_key  TEXT,
  project_path TEXT,
  session_id   TEXT,
  message      TEXT,
  reason       TEXT,
  tool_name    TEXT,
  is_error     INTEGER NOT NULL DEFAULT 0 CHECK (is_error IN (0,1)),
  pet_state    TEXT,               -- estado que provocó, o NULL si se descartó
  raw_json     TEXT                -- payload recortado a 8 KB
);
CREATE INDEX IF NOT EXISTS idx_hook_epoch   ON hook_events(ts_epoch);
CREATE INDEX IF NOT EXISTS idx_hook_session ON hook_events(session_id, ts_epoch);
CREATE INDEX IF NOT EXISTS idx_hook_event   ON hook_events(event, ts_epoch);

-- ---------- planes de suscripción ----------
CREATE TABLE IF NOT EXISTS plans (
  tier_id           TEXT PRIMARY KEY,   -- organizationRateLimitTier
  organization_type TEXT,               -- organizationType
  display_name      TEXT NOT NULL,
  monthly_usd       REAL,
  source            TEXT NOT NULL DEFAULT 'seed' CHECK (source IN ('seed','user')),
  updated_at        TEXT NOT NULL
) WITHOUT ROWID;

-- ---------- histórico de límites (Nivel A y B) ----------
CREATE TABLE IF NOT EXISTS limits_snapshots (
  id             INTEGER PRIMARY KEY,
  captured_at    TEXT    NOT NULL,   -- cuándo lo leyó miniClaudio
  fetched_at_ms  INTEGER,            -- cachedUsageUtilization.fetchedAtMs (Nivel A)
  source         TEXT    NOT NULL CHECK (source IN ('cache','live')),
  five_hour_pct  REAL,
  seven_day_pct  REAL,
  payload_json   TEXT    NOT NULL,   -- el objeto utilization íntegro
  UNIQUE (source, fetched_at_ms)     -- no duplicar el mismo caché rancio una y otra vez
);
CREATE INDEX IF NOT EXISTS idx_limits_captured ON limits_snapshots(captured_at DESC);
