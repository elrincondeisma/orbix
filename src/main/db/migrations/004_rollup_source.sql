-- ============================================================
-- Orbix · origen de cada rollup y regla de rescate · versión 4
-- ============================================================
-- Decisión de producto (2026-09-03): el snapshot SOLO RELLENA HUECOS.
--
-- Donde hay transcripts vivos mandan ellos, siempre. El snapshot entra solo en
-- los días en los que no queda NI UN transcript vivo (los que Claude Code borró
-- por su retención de 30 días). Nunca compiten, nunca se comparan tokens.
--
-- El criterio que manda es que la cifra sea REPRODUCIBLE: Ismael puede escanear
-- él mismo `~/.claude/projects` y obtener exactamente lo que ve en el menubar,
-- más los días rescatados que ya no existen en disco. La regla anterior ("gana
-- el día con más tokens") daba una cifra más alta pero que no cuadraba con
-- ninguna fuente. Cuesta ~$53 de consumo real en los días mixtos y se acepta:
-- el principio del diseño es "nada de mentiras".
--
-- `source` no interviene en el cálculo; está para que el panel de estadísticas
-- pueda marcar los días rescatados y para poder auditar la cifra más adelante.

ALTER TABLE rollup_daily ADD COLUMN source TEXT NOT NULL DEFAULT 'live'
  CHECK (source IN ('live', 'snapshot'));

-- `rollup_daily` es enteramente derivable: se tira y se encolan todos los días
-- para que el primer ciclo de ingesta la reconstruya con la regla nueva. Así el
-- histórico ya guardado se recalcula solo, sin depender de que nadie llame a
-- `rebuildAllRollups()` a mano.
DELETE FROM rollup_daily;

INSERT OR IGNORE INTO rollup_dirty (day_local, marked_at)
SELECT DISTINCT day_local, '2026-09-03T00:00:00Z' FROM usage_requests;

INSERT OR IGNORE INTO rollup_dirty (day_local, marked_at)
SELECT DISTINCT day_local, '2026-09-03T00:00:00Z' FROM snapshot_rollups;
