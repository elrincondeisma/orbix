-- ============================================================
-- miniClaudio · rollups importados de snapshot · versión 3
-- ============================================================
-- Claude Code borra los transcripts a los 30 días, así que el histórico vivo es
-- incompleto. `data/snapshot-*.json` (schema miniclaudio.snapshot/2) trae rollups
-- ya a grano de petición e incluyendo subagentes, pero sin coste.
--
-- No se importan a `rollup_daily` porque esa tabla es derivada y se reconstruye
-- entera desde `usage_requests`: el import se perdería en el primer recálculo.
-- Tampoco a `usage_requests`, porque no hay peticiones individuales que insertar
-- y falsearlas rompería la invariante I1 (COUNT(usage_requests) = COUNT(DISTINCT
-- request_id) en usage_lines).
--
-- Vive en su propia tabla y `rollups.ts` la fusiona al recalcular cada día:
-- para cada (day_local, project_key, model_key) gana la fuente con más tokens
-- totales (la real cuando el transcript sobrevive, el snapshot cuando ya no).
-- Ni se duplica ni se pierde histórico.
--
-- DISCREPANCIA CONTROLADA con 02-esquema-bd.md: esta tabla no está en §2.
-- Se añade porque el §0 del encargo exige poder importar el snapshot de rescate.

CREATE TABLE IF NOT EXISTS snapshot_rollups (
  day_local      TEXT    NOT NULL,
  project_key    TEXT    NOT NULL,
  model_key      TEXT    NOT NULL,
  project_path   TEXT,                        -- ruta original del snapshot (cwd)
  model_raw      TEXT,
  requests       INTEGER NOT NULL DEFAULT 0,  -- 'messages' del snapshot: peticiones
  input_tok      INTEGER NOT NULL DEFAULT 0,
  output_tok     INTEGER NOT NULL DEFAULT 0,
  thinking_tok   INTEGER NOT NULL DEFAULT 0,
  cache_write_5m INTEGER NOT NULL DEFAULT 0,
  cache_write_1h INTEGER NOT NULL DEFAULT 0,
  cache_read     INTEGER NOT NULL DEFAULT 0,
  source_file    TEXT    NOT NULL,            -- basename del json importado
  generated_at   TEXT,                        -- snapshot.generated_at
  imported_at    TEXT    NOT NULL,
  PRIMARY KEY (day_local, project_key, model_key)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_snaproll_day ON snapshot_rollups(day_local);
