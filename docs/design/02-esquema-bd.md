# Orbix — 02. Esquema de base de datos e ingestor

> SQLite (`better-sqlite3`), fichero
> `~/Library/Application Support/Orbix/orbix.db`.
> Fecha: 2026-09-03.

---

## 0. CORRECCIÓN CRÍTICA AL PLAN — lee esto antes de escribir una línea

El plan asume que la unidad de coste es `(requestId, apiBlockIndex)`. **No lo es.**
He verificado sobre los transcripts reales de la máquina que **una misma respuesta de la API
se escribe en varias líneas JSONL, una por bloque de contenido, y cada línea repite el mismo
objeto `usage` completo**.

Evidencia reproducible en 10 segundos
(`~/.claude/projects/-Users-icatala-Projects-propios-Orbix/85415fa7-4d4e-4eef-90aa-b6aa28fb3fc6.jsonl`):

| Línea | `requestId` | `apiBlockIndex` | `cache_read_input_tokens` | `output_tokens` |
|---|---|---|---|---|
| 22 | `req_011CegDJVd7cPRt2svHYRMeo` | 0 | 26 354 | 1 388 |
| 23 | `req_011CegDJVd7cPRt2svHYRMeo` | 1 | 26 354 | 1 388 |
| 24 | `req_011CegDJVd7cPRt2svHYRMeo` | 2 | 26 354 | 1 388 |
| 27 | `req_011CegDJVd7cPRt2svHYRMeo` | 3 | 26 354 | 1 388 |
| 31 | `req_011CegDKzANZd7wWzfS5Hg8w` | 0 | 49 329 | 708 |
| 32 | `req_011CegDKzANZd7wWzfS5Hg8w` | 1 | 49 329 | 708 |
| 35 | `req_011CegDKzANZd7wWzfS5Hg8w` | 2 | 49 329 | 708 |

Los 26 354 tokens de caché leída son **una** lectura de caché, no cuatro. Sumar por
`(request_id, api_block_index)` multiplica el coste por el número medio de bloques por
petición (~3-4 en estos datos).

En algunos casos el `output_tokens` **crece** entre bloques (visto en
`.../subagents/agent-ae10c90568ca63e8b.jsonl`: bloques 0 y 1 → `output_tokens: 1`;
bloque 2 → `output_tokens: 183`), porque las líneas se escriben conforme se cierra cada
bloque del stream. El valor bueno es el máximo.

### Consecuencias de diseño

1. **La unidad facturable es `request_id`.** El coste se calcula **una sola vez por
   petición**, tomando **`MAX()` de cada contador entre todos sus bloques**. `MAX` (y no
   "último bloque") porque es conmutativo e idempotente: da igual el orden en que lleguen
   los bloques ni cuántas veces se reingieran.
2. **Se conserva la clave `UNIQUE(request_id, api_block_index)`** del plan, pero en su sitio
   correcto: es la **clave de idempotencia de la ingesta de líneas** (tabla `usage_lines`),
   no la clave de agregación de coste. Así también seguimos deduplicando las líneas que las
   sesiones reanudadas o bifurcadas reescriben (el 42 % medido).
3. ~~**Las cifras de referencia del plan** ($166,74 hoy · $616,83 en 7 días · $1 178,15 en
   30 días) son sumas a nivel de línea, y por tanto un techo inflado.~~ **CADUCADO:** esas
   cifras además se calcularon sin los transcripts de subagentes, que son el 63 % del
   consumo. No sirven ni como techo. Las cifras oficiales, medidas ejecutando el ingestor,
   están en §8. El ratio real línea/petición es **1,91**.

---

## 1. Convenciones

- **Todo el DDL vive en ficheros** `src/main/db/migrations/NNN_nombre.sql`. Nada de DDL
  embebido en TypeScript.
- Timestamps de instante: **texto ISO 8601 en UTC con `Z`** (`ts`), más un entero
  `ts_epoch` en milisegundos para los rangos (los índices sobre enteros son más baratos y
  evitan comparaciones de cadena con offsets distintos).
- Fechas de calendario: **texto `YYYY-MM-DD` en la zona horaria del usuario**
  (`prefs.timezone`, por defecto la del sistema). Se llaman siempre `day_local`.
- Booleanos: `INTEGER` 0/1 con `CHECK (col IN (0,1))`.
- Dinero: `REAL` en USD. La precisión de `double` (15-16 dígitos significativos) sobra para
  cifras de miles de dólares; se redondea solo al presentar.
- Nada de `AUTOINCREMENT` salvo donde se diga; `INTEGER PRIMARY KEY` basta.
- `PRAGMA` de conexión, en este orden, al abrir:
  `journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON`, `busy_timeout=5000`,
  `temp_store=MEMORY`, `mmap_size=134217728`.

---

## 2. DDL — migración `001_init.sql`

```sql
-- ============================================================
-- Orbix · esquema inicial · versión 1
-- ============================================================

-- ---------- clave/valor de estado interno ----------
CREATE TABLE meta (
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
CREATE TABLE ingest_files (
  path             TEXT PRIMARY KEY,          -- ruta absoluta
  project_key      TEXT NOT NULL,             -- '-Users-icatala-Projects-propios-Orbix'
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
  last_error       TEXT
);
CREATE INDEX idx_ingest_files_state ON ingest_files(state);
CREATE INDEX idx_ingest_files_ident ON ingest_files(dev, inode);

-- ---------- grano crudo: una fila por LÍNEA assistant del JSONL ----------
-- Idempotencia de la ingesta. NO se usa para calcular coste (ver §0).
CREATE TABLE usage_lines (
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
  PRIMARY KEY (request_id, api_block_index)     -- ← UNIQUE(request_id, api_block_index)
) WITHOUT ROWID;
CREATE INDEX idx_usage_lines_req ON usage_lines(request_id);

-- ---------- grano facturable: una fila por PETICIÓN a la API ----------
CREATE TABLE usage_requests (
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
CREATE INDEX idx_ur_day        ON usage_requests(day_local);
CREATE INDEX idx_ur_epoch      ON usage_requests(ts_epoch);
CREATE INDEX idx_ur_session    ON usage_requests(session_id, ts_epoch);
CREATE INDEX idx_ur_proj_day   ON usage_requests(project_key, day_local);
CREATE INDEX idx_ur_model_day  ON usage_requests(model_key, day_local);
CREATE INDEX idx_ur_stale      ON usage_requests(cost_stale) WHERE cost_stale = 1;

-- ---------- agregado diario: el menubar nunca escanea usage_requests ----------
CREATE TABLE rollup_daily (
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
CREATE INDEX idx_rollup_day ON rollup_daily(day_local);

-- ---------- cola de días pendientes de recalcular ----------
CREATE TABLE rollup_dirty (
  day_local  TEXT PRIMARY KEY,
  marked_at  TEXT NOT NULL
) WITHOUT ROWID;

-- ---------- eventos de hooks ----------
CREATE TABLE hook_events (
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
CREATE INDEX idx_hook_epoch   ON hook_events(ts_epoch);
CREATE INDEX idx_hook_session ON hook_events(session_id, ts_epoch);
CREATE INDEX idx_hook_event   ON hook_events(event, ts_epoch);

-- ---------- precios, NUNCA hardcodeados ----------
CREATE TABLE model_prices (
  id                    INTEGER PRIMARY KEY,
  model_key             TEXT NOT NULL,   -- normalizado; '__default__' como comodín
  input_per_mtok        REAL NOT NULL,
  output_per_mtok       REAL NOT NULL,
  cache_write_5m_per_mtok REAL NOT NULL,
  cache_write_1h_per_mtok REAL NOT NULL,
  cache_read_per_mtok   REAL NOT NULL,
  valid_from            TEXT NOT NULL,   -- ISO UTC; aplica a ts >= valid_from
  source                TEXT NOT NULL DEFAULT 'seed'
                        CHECK (source IN ('seed','user','import')),
  note                  TEXT,
  UNIQUE (model_key, valid_from)
);
CREATE INDEX idx_prices_lookup ON model_prices(model_key, valid_from DESC);

-- ---------- planes de suscripción ----------
CREATE TABLE plans (
  tier_id           TEXT PRIMARY KEY,   -- organizationRateLimitTier
  organization_type TEXT,               -- organizationType
  display_name      TEXT NOT NULL,
  monthly_usd       REAL,
  source            TEXT NOT NULL DEFAULT 'seed' CHECK (source IN ('seed','user')),
  updated_at        TEXT NOT NULL
) WITHOUT ROWID;

-- ---------- histórico de límites (Nivel A y B) ----------
CREATE TABLE limits_snapshots (
  id             INTEGER PRIMARY KEY,
  captured_at    TEXT    NOT NULL,   -- cuándo lo leyó Orbix
  fetched_at_ms  INTEGER,            -- cachedUsageUtilization.fetchedAtMs (Nivel A)
  source         TEXT    NOT NULL CHECK (source IN ('cache','live')),
  five_hour_pct  REAL,
  seven_day_pct  REAL,
  payload_json   TEXT    NOT NULL,   -- el objeto utilization íntegro
  UNIQUE (source, fetched_at_ms)     -- no duplicar el mismo caché rancio una y otra vez
);
CREATE INDEX idx_limits_captured ON limits_snapshots(captured_at DESC);
```

**Nota sobre `UNIQUE (source, fetched_at_ms)`:** en SQLite los `NULL` se consideran
distintos, así que las capturas `live` (que no tienen `fetched_at_ms`) nunca chocan. Para
`cache`, evita insertar 300 veces al día el mismo bloque rancio de hace 7 días.

### 2.0.1 Tabla añadida en la implementación: `snapshot_rollups` (migración `003`)

> Añadida el 2026-09-03 al implementar. No estaba en el diseño original.

Claude Code borra los transcripts a los 30 días, así que el histórico vivo es incompleto:
de un mes solo sobrevivían ~10 días. `data/snapshot-*.json`
(`schema: orbix.snapshot/2`) trae rollups por día/proyecto/modelo ya a grano de
petición e incluyendo subagentes, **sin coste** (los precios se aplican al importar).

```sql
CREATE TABLE snapshot_rollups (
  day_local      TEXT NOT NULL,
  project_key    TEXT NOT NULL,
  model_key      TEXT NOT NULL,
  project_path   TEXT,                        -- ruta original del snapshot (cwd)
  model_raw      TEXT,
  requests       INTEGER NOT NULL DEFAULT 0,  -- 'messages' del snapshot
  input_tok      INTEGER NOT NULL DEFAULT 0,
  output_tok     INTEGER NOT NULL DEFAULT 0,
  thinking_tok   INTEGER NOT NULL DEFAULT 0,
  cache_write_5m INTEGER NOT NULL DEFAULT 0,
  cache_write_1h INTEGER NOT NULL DEFAULT 0,
  cache_read     INTEGER NOT NULL DEFAULT 0,
  source_file    TEXT NOT NULL,
  generated_at   TEXT,
  imported_at    TEXT NOT NULL,
  PRIMARY KEY (day_local, project_key, model_key)
) WITHOUT ROWID;
CREATE INDEX idx_snaproll_day ON snapshot_rollups(day_local);
```

Vive en su propia tabla y no en otro sitio por dos motivos: en `rollup_daily` la borraría
el primer recálculo (es una tabla derivada), y en `usage_requests` habría que inventar
`request_id`, lo que rompería la invariante **I1**. El importador es idempotente
(`ON CONFLICT` con `MAX()` por contador).

### 2.0.2 Origen de cada rollup (migración `004`)

```sql
ALTER TABLE rollup_daily ADD COLUMN source TEXT NOT NULL DEFAULT 'live'
  CHECK (source IN ('live', 'snapshot'));
```

`source` **no interviene en el cálculo**: está para que el panel de estadísticas marque los
días rescatados y para poder auditar la cifra (ver §5.6.1). La migración además vacía
`rollup_daily` y encola todos los días en `rollup_dirty`, para que el histórico ya guardado
se recalcule solo con la regla nueva sin que nadie tenga que llamar a nada a mano.

### 2.1 Semilla (`002_seed.sql`, idempotente con `INSERT OR IGNORE`)

```sql
INSERT OR IGNORE INTO model_prices
 (model_key,        input_per_mtok, output_per_mtok, cache_write_5m_per_mtok,
  cache_write_1h_per_mtok, cache_read_per_mtok, valid_from,             source) VALUES
 ('claude-opus-5',   5.00, 25.00, 6.25, 10.00, 0.50, '2000-01-01T00:00:00Z', 'seed'),
 ('claude-opus-4-8', 5.00, 25.00, 6.25, 10.00, 0.50, '2000-01-01T00:00:00Z', 'seed'),
 ('claude-sonnet-5', 2.00, 10.00, 2.50,  4.00, 0.20, '2000-01-01T00:00:00Z', 'seed'),
 ('claude-haiku-4-5',1.00,  5.00, 1.25,  2.00, 0.10, '2000-01-01T00:00:00Z', 'seed'),
 ('__default__',     5.00, 25.00, 6.25, 10.00, 0.50, '2000-01-01T00:00:00Z', 'seed');

INSERT OR IGNORE INTO plans (tier_id, organization_type, display_name, monthly_usd, updated_at) VALUES
 ('default_claude_max_20x', 'claude_max',  'Max 20×',  200.0, '2026-09-03T00:00:00Z'),
 ('default_claude_max_5x',  'claude_max',  'Max 5×',   100.0, '2026-09-03T00:00:00Z'),
 ('default_claude_pro',     'claude_pro',  'Pro',       20.0, '2026-09-03T00:00:00Z'),
 ('default_claude_free',    'claude_free', 'Free',       0.0, '2026-09-03T00:00:00Z');
```

`__default__` es la tarifa de seguridad para modelos desconocidos: se usa la de Opus 5
(la más cara) para no infravalorar, y la fila de `usage_requests` se marca con
`price_id` del comodín para que el panel de stats pueda avisar "modelo sin tarifa".

> **PUNTO ABIERTO B1 — Nombres de tier de otros planes.** Solo está verificado
> `default_claude_max_20x` (el de Ismael). Los otros tres tier_id son una conjetura por
> simetría. *Recomendación:* si `plan:get` no encuentra el tier en `plans`, devolver
> `detected: false`, `monthlyUsd: null` y ofrecer en preferencias un campo para que el
> usuario meta el precio; nunca inventar el multiplicador.

---

## 3. Migraciones

- Versión en `PRAGMA user_version` (entero). `001_init.sql` deja `user_version = 1`,
  `002_seed.sql` → 2, etc. Un fichero = una versión = un salto de 1.
- Runner (`src/main/db/migrate.ts`), pseudocódigo:

```
current = db.pragma('user_version')
files   = readdir('migrations').sort()          // 001_, 002_, ...
for f of files where versionOf(f) > current:
    db.exec('BEGIN IMMEDIATE')
    try:
        db.exec(readFile(f))                    // el .sql NO lleva BEGIN/COMMIT
        db.pragma(`user_version = ${versionOf(f)}`)
        db.exec('COMMIT')
    catch e:
        db.exec('ROLLBACK'); throw MigrationError(f, e)
```

- Los `.sql` deben ser idempotentes en lo posible (`IF NOT EXISTS`, `INSERT OR IGNORE`) para
  que un fallo a mitad no deje la BD irrecuperable.
- **Antes de migrar**, si `user_version > 0`, copiar el `.db` a
  `orbix.db.bak-v<current>` (una sola copia por versión, se sobrescribe). Con esto un
  downgrade de la app siempre tiene salida.
- Si `user_version > máxima versión conocida` (el usuario abrió una app más vieja):
  **no tocar nada**, arrancar en modo solo lectura y emitir `app:notice` de nivel `error`.

---

## 4. Cálculo del coste

### 4.1 Fórmula

```
cost_usd = ( input_tok      * p.input_per_mtok
           + output_tok     * p.output_per_mtok
           + cache_write_5m * p.cache_write_5m_per_mtok
           + cache_write_1h * p.cache_write_1h_per_mtok
           + cache_read     * p.cache_read_per_mtok ) / 1e6
```

`thinking_tok` **no entra**: es un desglose informativo que ya está incluido dentro de
`output_tokens` (verificado: línea con `output_tokens: 183` y `thinking_tokens: 0`;
`output_tokens_details` es un *details* de `output_tokens`). Se guarda solo para mostrarlo.

Igualmente, `cache_creation_input_tokens` **no entra**: es la suma de
`ephemeral_5m + ephemeral_1h`, que sí entran por separado y a tarifas distintas. Se usa solo
como control de integridad (§8, invariante I3).

### 4.2 Normalización de modelo → `model_key`

Modelos observados en los transcripts reales: `claude-opus-5`, `claude-sonnet-5`,
`claude-haiku-4-5-20251001`, `<synthetic>`.

```
normalizeModel(raw):
    if raw is null or raw == '' -> '__unknown__'
    s = raw.toLowerCase().trim()
    if s == '<synthetic>' -> '__synthetic__'
    s = s.replace(/-\d{8}$/, '')          // quita el sufijo de fecha
    s = s.replace(/^anthropic\./, '')     // por si aparece con prefijo de proveedor
    return s
```

Las peticiones con `model_key = '__synthetic__'` se ingieren con **coste 0** y no se cuentan
en `requests`. Nunca se les busca tarifa. (Solo 9 apariciones en 368 MB, pero el parser no
debe reventar con ellas.)

### 4.3 Resolución de tarifa

```sql
SELECT id, input_per_mtok, output_per_mtok, cache_write_5m_per_mtok,
       cache_write_1h_per_mtok, cache_read_per_mtok
FROM model_prices
WHERE model_key = :model_key AND valid_from <= :ts
ORDER BY valid_from DESC
LIMIT 1;
```

Si no devuelve fila, repetir con `model_key = '__default__'`. La resolución se **cachea en
memoria** en un `Map<model_key, PriceRow[]>` cargado al arrancar y recargado tras
`prices:upsert`; no se va a SQLite por cada petición.

---

## 5. Ingestor incremental

### 5.1 Descubrimiento de ficheros

Raíz: `$CLAUDE_CONFIG_DIR ?? ~/.claude` → `<raíz>/projects/`.

Patrón: **recursivo**, `**/*.jsonl`. No basta con un nivel: los subagentes escriben en
`<projects>/<project_key>/<session_uuid>/subagents/agent-*.jsonl` (verificado). Ese consumo
es real y cuesta dinero, así que **se ingiere**, marcado con `is_sidechain = 1`.

```
project_key  = primer segmento de ruta bajo projects/
is_sidechain = la ruta contiene '/subagents/'
session_id   = del contenido de la línea (campo sessionId); el nombre de fichero
               solo se usa como respaldo si la línea no lo trae
project_path = del campo cwd de la línea (no se deduce del project_key: los guiones
               del nombre de directorio son ambiguos, '/Users/a/b-c' y '/Users/a/b/c'
               colisionan)
```

Watcher: `chokidar` sobre `<raíz>/projects` con
`{ ignoreInitial: false, depth: 4, awaitWriteFinish: false, usePolling: false }`.
Eventos `add` y `change` encolan el fichero. Además, un **barrido completo de seguridad**
(`readdir` recursivo + `stat`) cada 60 s y al despertar de suspensión, porque FSEvents pierde
eventos tras dormir el equipo.

Los eventos se **debouncean 300 ms por fichero** y se procesan en una única cola serie.
Intervalo mínimo entre ciclos: `prefs.ingestIntervalMs` (3 s por defecto).

### 5.2 Identidad y estado de un fichero

`stat()` da `dev`, `ino`, `size`, `mtimeMs`. La decisión de cómo leer:

| Situación detectada | Cómo se detecta | Qué se hace |
|---|---|---|
| **Fichero nuevo** | No hay fila en `ingest_files` con ese `path` | Insertar fila con `byte_offset = 0` y leer entero |
| **Fichero renombrado/movido** | Hay fila con mismo `(dev, inode)` y otro `path` | `UPDATE ingest_files SET path = :new WHERE dev=:d AND inode=:i` y **conservar el offset** |
| **Crecimiento normal** | `size > byte_offset` y `(dev, inode)` iguales | Leer desde `byte_offset` |
| **Sin cambios** | `size == byte_offset` y `mtime_ms` igual | No hacer nada (ni abrir el fichero) |
| **Truncado** | `size < byte_offset` | `byte_offset = 0`, `partial = ''`, releer entero. La dedup por PK evita duplicar |
| **Reescrito en sitio (rotación)** | `(dev, inode)` distintos del guardado, **o** `head_sig` distinto | `byte_offset = 0`, `partial = ''`, releer entero |
| **Desaparecido** | `stat` da `ENOENT` | `state = 'gone'`, se conserva la fila. **No se borra nada de `usage_requests`**: ese es justo el histórico que Claude Code destruye a los 30 días |
| **Ilegible** | `EACCES`/`EISDIR`/etc. | `state = 'error'`, `last_error`, reintento en el siguiente barrido completo; máximo 5 reintentos y luego `skipped` |

`head_sig` = SHA-1 de los primeros 4096 bytes. Es la red de seguridad contra el caso
"mismo path, mismo inode, contenido nuevo" (que macOS puede producir al reescribir en sitio).
Se recalcula en cada lectura efectiva.

### 5.3 Lectura de un fichero

```
readSlice(file):
    st = stat(file.path)                       # si falla -> tabla de §5.2
    if st.size == file.byte_offset and st.mtimeMs == file.mtime_ms: return DONE

    if st.size < file.byte_offset: reset(file)          # truncado
    if (st.dev, st.ino) != (file.dev, file.inode): reset(file)

    if file.byte_offset == 0:
        head = readBytes(file.path, 0, 4096); file.head_sig = sha1(head)
    else:
        head = readBytes(file.path, 0, 4096)
        if sha1(head) != file.head_sig: reset(file)      # reescrito en sitio

    to = min(st.size, file.byte_offset + SLICE_BYTES)    # SLICE_BYTES = 8 MiB
    buf = readBytes(file.path, file.byte_offset, to - file.byte_offset)
    text = file.partial + buf.toString('utf8')

    lastNl = text.lastIndexOf('\n')
    if lastNl == -1:                                     # ni una línea completa
        file.partial = text
        file.byte_offset = to
        # guardia: si partial > 4 MiB, la línea está corrupta -> descartar hasta el
        # siguiente \n y registrar last_error
        return (to < st.size) ? MORE : DONE

    complete = text.slice(0, lastNl)
    file.partial = text.slice(lastNl + 1)                # cola sin \n
    file.byte_offset = to
    file.mtime_ms = st.mtimeMs; file.size = st.size

    for line of complete.split('\n'):
        if line.trim() == '': continue
        try:  handleLine(parseJson(line), file)
        catch: countSkipped()                            # NUNCA propagar
    return (to < st.size) ? MORE : DONE
```

**Regla de oro:** el `byte_offset` y las filas insertadas se persisten **en la misma
transacción**. Si el proceso muere a mitad, se reprocesa la rodaja entera y la dedup por
clave primaria la absorbe sin duplicar. El `partial` viaja en la misma fila, así que también
sobrevive a un cierre.

`SLICE_BYTES = 8 MiB` y corte adicional por tiempo: si la rodaja lleva > 200 ms, se cierra la
transacción y se cede el event loop con `setImmediate` (§1 de `01-arquitectura.md`).

### 5.4 Parseo de una línea (`handleLine`)

Tolerante por diseño: cualquier campo que falte se ignora, nunca se lanza.

```
if obj.type != 'assistant'          -> return          # user, summary, mode, hooks...
u = obj.message?.usage
if !u                               -> return
rid = obj.requestId
if !rid                             -> return          # sin identidad facturable
abi = obj.apiBlockIndex ?? 0

model = obj.message?.model ?? obj.model ?? '__unknown__'
ts    = obj.timestamp                                   # ISO 8601 UTC
if !ts or isNaN(Date.parse(ts))     -> return

line = {
  request_id: rid, api_block_index: abi, line_uuid: obj.uuid,
  ts, ts_epoch: Date.parse(ts),
  session_id: obj.sessionId ?? file.session_id,
  project_key: file.project_key, source_path: file.path,
  is_sidechain: (obj.isSidechain ? 1 : file.is_sidechain),
  model_raw: model,
  input_tok:      int(u.input_tokens),
  output_tok:     int(u.output_tokens),
  thinking_tok:   int(u.output_tokens_details?.thinking_tokens),
  cache_write_5m: int(u.cache_creation?.ephemeral_5m_input_tokens),
  cache_write_1h: int(u.cache_creation?.ephemeral_1h_input_tokens),
  cache_read:     int(u.cache_read_input_tokens),
}
int(x) = (Number.isFinite(x) && x >= 0 && x <= MAX_TOKEN_COUNT) ? Math.trunc(x) : 0
         # MAX_TOKEN_COUNT = 1e9. Ver el techo de cordura más abajo.
```

**Techo de cordura (`MAX_TOKEN_COUNT = 1_000_000_000`).** El parser es tolerante, pero la
tolerancia no puede permitir que una línea corrupta se lleve por delante la cifra principal
de la app. Un solo `ephemeral_1h_input_tokens: 1e30` metía un coste de 1e25 $ en
`rollup_daily`, y de forma permanente. Cualquier contador por encima del techo se descarta
(queda a 0, el resto de la línea se ingiere igual) y se cuenta en
`ParseWarnings.absurdCounter`, para que quede rastro en vez de desaparecer en silencio.

El umbral sale de los datos: sobre las 24 389 líneas con `usage` de la máquina de
referencia, el valor más alto de cualquier contador es **997 672** (`cache_read`), y no es
casualidad —un contador de una petición no puede pasar de la ventana de contexto del
modelo, hoy 1 M de tokens—. 1e9 deja **1 000×** de margen sobre ambas cifras. Verificado:
descarta 0 valores sobre el corpus real completo. El mismo techo se aplica al importador de
`snapshot_rollups`, que tiene idéntico poder de destrucción sobre `rollup_daily`.

Compatibilidad hacia atrás: si `u.cache_creation` no existe pero sí
`u.cache_creation_input_tokens`, se asigna todo a `cache_write_5m` (es el valor por defecto
del ttl de caché) y se registra una advertencia contada, no una excepción.

Luego, en la misma transacción:

```sql
INSERT INTO usage_lines (...) VALUES (...)
ON CONFLICT(request_id, api_block_index) DO UPDATE SET
  output_tok   = MAX(usage_lines.output_tok,   excluded.output_tok),
  thinking_tok = MAX(usage_lines.thinking_tok, excluded.thinking_tok),
  ts           = MAX(usage_lines.ts,           excluded.ts);
```

y el **upsert facturable**, que es el corazón de todo:

```sql
INSERT INTO usage_requests
  (request_id, ts, ts_epoch, day_local, session_id, project_key, project_path,
   is_sidechain, model_raw, model_key, blocks,
   input_tok, output_tok, thinking_tok, cache_write_5m, cache_write_1h, cache_read,
   cost_usd, price_id, cost_stale, first_seen_at, updated_at)
VALUES (:request_id, :ts, :ts_epoch, :day_local, :session_id, :project_key, :project_path,
   :is_sidechain, :model_raw, :model_key, 1,
   :input_tok, :output_tok, :thinking_tok, :cw5m, :cw1h, :cread,
   :cost_usd, :price_id, 0, :now, :now)
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
  cost_stale     = 1,                   -- los contadores han cambiado: recalcular coste
  updated_at     = excluded.updated_at
WHERE excluded.input_tok      > usage_requests.input_tok
   OR excluded.output_tok     > usage_requests.output_tok
   OR excluded.cache_write_5m > usage_requests.cache_write_5m
   OR excluded.cache_write_1h > usage_requests.cache_write_1h
   OR excluded.cache_read     > usage_requests.cache_read
   OR excluded.ts_epoch       > usage_requests.ts_epoch;
```

> ⚠️ `blocks` solo se incrementa cuando la cláusula `WHERE` deja pasar el UPDATE, así que es
> un conteo aproximado de bloques, no exacto. Si se quiere exacto (útil para QA), sacarlo de
> `SELECT COUNT(*) FROM usage_lines WHERE request_id = ?` al recalcular el rollup. **No
> usar `blocks` para ninguna cifra que se muestre al usuario.**

Tras el upsert, si la fila quedó `cost_stale = 1` (o es nueva), se recalcula el coste con
§4.1 y se marca el `day_local` en `rollup_dirty`.

**`day_local` sigue siempre a `ts`.** El `ON CONFLICT` avanza `ts`/`ts_epoch` al bloque más
tardío, así que una petición a caballo de la medianoche cambia de día cuando llega su
último bloque. El upsert deja `day_local` como estaba a propósito —así el `RETURNING`
devuelve el día ANTERIOR— y el ingestor lo mueve después, marcando sucios **los dos** días
implicados. Sin esto la cifra deja de cuadrar con un escaneo independiente de los
transcripts (medido: 1 petición de 12 858, $0,38 en el día equivocado).

`day_local` se calcula en JS con
`Intl.DateTimeFormat('sv-SE', { timeZone: tz }).format(new Date(ts_epoch))` (el locale `sv-SE`
da `YYYY-MM-DD` sin trucos). Se hace en el ingestor, no en SQL, porque SQLite no sabe de
zonas horarias IANA.

### 5.5 Backfill inicial

1. Barrido completo de `<raíz>/projects/**/*.jsonl`, ordenado por `mtime` **descendente**:
   los datos recientes son los que el usuario quiere ver primero y los que Claude Code va a
   borrar antes.
2. Se procesan por rodajas emitiendo `ingest:progress` (`backfillProgress` = bytes
   procesados / bytes totales).
3. Al terminar: `meta.backfill_done = '1'`, `stats:updated`.
4. Si la app se cierra a mitad, en el siguiente arranque se retoma por los cursores; no hay
   estado especial que gestionar.

Coste estimado: 368 MB, ~33 000 líneas. Con rodajas de 8 MB deberían ser ~46 rodajas y unos
segundos en total. **Si el backfill supera 30 s, hay un bug**, casi seguro que se está
haciendo un `INSERT` fuera de transacción.

### 5.6 Recálculo de rollups

```
recomputeDirtyDays():
  days = SELECT day_local FROM rollup_dirty ORDER BY day_local LIMIT 50
  for day in days:                       # cada día en su propia transacción
    BEGIN IMMEDIATE
    DELETE FROM rollup_daily WHERE day_local = :day;
    INSERT INTO rollup_daily
      (day_local, project_key, model_key, requests, input_tok, output_tok, thinking_tok,
       cache_write_5m, cache_write_1h, cache_read, cost_usd, updated_at)
    SELECT day_local, project_key, model_key, COUNT(*),
           SUM(input_tok), SUM(output_tok), SUM(thinking_tok),
           SUM(cache_write_5m), SUM(cache_write_1h), SUM(cache_read),
           SUM(cost_usd), :now
    FROM usage_requests
    WHERE day_local = :day AND model_key <> '__synthetic__'
    GROUP BY day_local, project_key, model_key;
    DELETE FROM rollup_dirty WHERE day_local = :day;
    COMMIT
```

Se ejecuta al final de cada ciclo de ingesta. `rollup_daily` es **siempre derivable**: se
puede borrar entera y reconstruir con `INSERT INTO rollup_dirty SELECT DISTINCT day_local ...`.
Existe por eso un comando de mantenimiento `ingest:runNow { full: true }` que hace justo eso.

### 5.6.1 De dónde salen las cifras de un día: el snapshot SOLO rellena huecos

> Decisión de producto del 2026-09-03, tras el rechazo de QA (BUG-2).

`rollup_daily` se alimenta de dos fuentes: `usage_requests` (transcripts vivos) y
`snapshot_rollups` (el histórico que Claude Code ya borró). La regla, para cada
`day_local`:

```
si el día tiene ALGUNA fila en usage_requests  -> mandan los transcripts, y el
                                                  snapshot de ese día ni se mira
si no tiene ninguna                            -> se usa el snapshot entero
```

Es un criterio de **presencia, no de volumen**: las dos fuentes nunca compiten, nunca se
comparan tokens, nunca gana la que más tenga. La fila resultante lleva
`source = 'live' | 'snapshot'`.

**Por qué:** el criterio que manda es que la cifra sea **reproducible**. Con esta regla el
usuario puede escanear él mismo `~/.claude/projects` y obtener exactamente lo que ve en el
menubar, más los días rescatados que ya no existen en disco. Verificado el 2026-09-03
contra un escaneo independiente: los 9 días cerrados cuadran **al céntimo y petición a
petición**; solo el día en curso difiere, y por los segundos que pasan entre la ingesta y
el escaneo.

**Qué cuesta:** se pierde el rescate parcial de los días mixtos, **$55,30** medidos entre
el 25 de agosto y el 2 de septiembre (incluidos 364 requests de worktrees ya borrados del
día 2). Es consumo real que se descarta. Se acepta a conciencia: el principio del diseño es
*nada de mentiras*, y una cifra más alta que no cuadra con ninguna fuente lo incumple. La
regla anterior ("gana el día con más tokens") daba 10,23× donde lo reproducible eran 9,96×.

**Por qué tampoco se fusionan clave a clave:** las dos fuentes agrupan por proyectos
distintos —el ingestor por el directorio bajo `projects/` (§5.1) y el snapshot por el `cwd`
de cada línea—, así que mezclarlas duplica el consumo de los subagentes que corren en
worktrees o subdirectorios (medido: +21 % a 30 días).

Los días rescatados se consultan con `rescuedDays(db, from?, to?)`.

### 5.7 Recálculo cuando cambian los precios

`prices:upsert` recibe una tarifa nueva con su `valid_from`:

```
upsertPrice(p):
  BEGIN IMMEDIATE
  INSERT INTO model_prices (...) VALUES (...)
    ON CONFLICT(model_key, valid_from) DO UPDATE SET ... , source='user';
  -- todo lo afectado: ese modelo (o todos si es __default__) desde valid_from
  UPDATE usage_requests SET cost_stale = 1
   WHERE ts >= :valid_from
     AND (:model_key = '__default__' OR model_key = :model_key);
  INSERT OR IGNORE INTO rollup_dirty (day_local, marked_at)
    SELECT DISTINCT day_local, :now FROM usage_requests WHERE cost_stale = 1;
  COMMIT
  reloadPriceCache()
  recomputeStaleCosts()      # por lotes de 5000, cada lote en su transacción
  recomputeDirtyDays()
  push('stats:updated', { reason: 'prices' })
```

`recomputeStaleCosts()`:

```
loop:
  rows = SELECT request_id, ts, model_key, input_tok, output_tok,
                cache_write_5m, cache_write_1h, cache_read
         FROM usage_requests WHERE cost_stale = 1 LIMIT 5000
  if rows empty: break
  BEGIN IMMEDIATE
  for r in rows:
     p = resolvePrice(r.model_key, r.ts)
     UPDATE usage_requests SET cost_usd = :c, price_id = :pid, cost_stale = 0
      WHERE request_id = :rid
  COMMIT
```

Mismo mecanismo si el usuario cambia `prefs.timezone`: se marca **todo** con
`UPDATE usage_requests SET cost_stale = 1` y además se recalcula `day_local` fila a fila,
se vacía `rollup_daily` y se reconstruye. Es una operación explícita y con confirmación en
preferencias ("recalcular histórico"), no algo que ocurra sola.

### 5.8 Retención

- `usage_requests`, `usage_lines`, `rollup_daily`: **nunca se borran**. Es el activo de la app.
  Volumen estimado: ~9 000 peticiones/mes ≈ 108 000 filas/año en `usage_requests`, unos pocos
  MB. No hay problema de tamaño en una década.
- `hook_events`: purga de lo anterior a **90 días**, una vez al día al arrancar.
- `limits_snapshots`: purga de lo anterior a **180 días**.
- `ingest_files` en estado `gone`: se conservan **365 días** desde `last_seen_at` (permiten
  saber que un fichero ya se leyó si vuelve a aparecer por una restauración de backup).
- `VACUUM` manual desde preferencias, nunca automático.

---

## 6. Lectura de plan y límites (`~/.claude.json`)

Fichero grande y pretty-printed (>7 000 líneas). **No se parsea en el hilo crítico con
`JSON.parse` de todo el fichero en cada tick**: se lee con `chokidar` sobre el fichero,
debounce de 1 s, y solo se re-parsea cuando cambia `mtime`. Coste medido: aceptable, pero
si el fichero supera 8 MB se salta el parseo y se emite `app:notice`.

Extracción (todos los campos son opcionales; ausencia = `null`, nunca excepción):

```
oauthAccount.organizationType           -> meta.org_type          / PlanInfo.organizationType
oauthAccount.organizationRateLimitTier  -> meta.rate_limit_tier   / PlanInfo.tierId
oauthAccount.emailAddress               -> meta.account_email
oauthAccount.accountUuid                -> meta.account_uuid
oauthAccount.organizationUuid           -> meta.org_uuid
cachedUsageUtilization.fetchedAtMs      -> limits_snapshots.fetched_at_ms
cachedUsageUtilization.utilization      -> limits_snapshots.payload_json
```

`PlanInfo` se resuelve haciendo `SELECT * FROM plans WHERE tier_id = :tier`. Si no hay fila:
`displayName = 'Plan no reconocido'`, `monthlyUsd = null`, `detected = false`.

Construcción de `LimitsView.bars` a partir de `utilization.limits[]` (formato verificado):

```
para cada l en utilization.limits:
   kind      = l.kind                         # 'session' | 'weekly_all' | 'weekly_scoped'
   percent   = clamp(l.percent ?? 0, 0, 100)
   resetsAt  = l.resets_at                    # ISO con offset; normalizar a UTC 'Z'
   scopeLabel= l.scope?.model?.display_name ?? null
   isActive  = !!l.is_active
   severity  = mapSeverity(l.severity, percent)
   label     = kind == 'session'      -> 'Ventana 5 h'
               kind == 'weekly_all'   -> 'Semanal total'
               kind == 'weekly_scoped'-> 'Semanal · ' + (scopeLabel ?? 'modelo')
orden: session, weekly_all, weekly_scoped (por percent desc entre los scoped)

mapSeverity(s, pct):
   if s in ('normal','warning','critical') -> s
   # el servidor manda 'normal' incluso al 63 %; derivamos por porcentaje
   if pct >= 85 -> 'critical'
   if pct >= 60 -> 'warning'
   return 'normal'
```

**`utilization.limits[]` es la única fuente de las barras.** Los campos hermanos
(`five_hour`, `seven_day`, `seven_day_opus`, y la retahíla de nombres en clave —
`nimbus_quill`, `tangelo`, `iguana_necktie`, `cinder_cove`, `amber_ladder`,
`omelette_promotional`— que hoy salen a `null`) son experimentos internos de Anthropic y
**se ignoran salvo `five_hour`/`seven_day` como respaldo si `limits[]` viniera vacío**.
Se guarda el `payload_json` íntegro por si en el futuro hay que mirar dentro.

Antigüedad: `ageSeconds = (Date.now() - fetched_at_ms) / 1000`.
`stale = age > 3600`, `veryStale = age > 86400`. En la máquina de referencia el bloque
llevaba **7 días** sin refrescar, así que este camino es el habitual, no el excepcional.

### 6.1 Nivel B (opt-in)

```
token = exec('security find-generic-password -s "Claude Code-credentials" -w')
        # el llavero pregunta una vez y el usuario marca "Permitir siempre"
        # se espera un JSON: { claudeAiOauth: { accessToken, refreshToken, expiresAt, ... } }
```

- Se ejecuta con `execFile` (nunca `exec` con cadena) y timeout de 10 s.
- El token **jamás** se guarda en la BD, ni en prefs, ni en logs. Vive en memoria y se
  descarta al parar el Nivel B.
- Fallo (usuario deniega, cuenta inexistente, JSON inesperado, HTTP != 200, esquema
  distinto): se registra `levelB.lastResult = 'failed'` + `lastError`, se **degrada
  silenciosamente al Nivel A** y se reintenta como mucho cada 30 min. Nunca un diálogo modal.
- Cada respuesta buena se guarda como `limits_snapshots(source = 'live')` y `LimitsView`
  pasa a `source: 'live'` con `fetchedAt = ahora`.

> **PUNTO ABIERTO B2 — URL del endpoint de uso.** No la invento. Hay que descubrirla
> observando el tráfico de Claude Code (`mitmproxy` con `NODE_EXTRA_CA_CERTS`, o
> `HTTPS_PROXY` + certificado propio) y comprobar qué petición rellena
> `cachedUsageUtilization`. El contrato que el backend debe implementar contra ella es:
> `GET <URL>` con `Authorization: Bearer <accessToken>` y las cabeceras
> `anthropic-beta`/`User-Agent` que use Claude Code, respuesta JSON con **la misma forma que
> `cachedUsageUtilization.utilization`**. Toda la capa de arriba (normalización a
> `LimitBar[]`, §6) se reutiliza tal cual. *Recomendación:* implementar `live-usage.ts`
> con la URL en una constante de configuración, dejarla vacía en F1 y que el Nivel B se
> muestre en preferencias como "no disponible todavía". La app debe estar 100 % terminada
> sin él.

> **PUNTO ABIERTO B3 — Forma exacta del secreto del llavero.** Se ha verificado que la
> entrada `Claude Code-credentials` existe para la cuenta `icatala`, pero no su contenido.
> *Recomendación:* parsear como JSON y buscar, en este orden,
> `claudeAiOauth.accessToken` → `accessToken` → `access_token`; si nada casa y la cadena
> empieza por `sk-ant-`, usarla tal cual como token.

---

## 7. Consultas que alimentan el menubar

Todas parten de `rollup_daily` salvo la de sesión actual, que necesita grano fino.
Se implementan como sentencias preparadas en `src/main/db/queries.ts`.

**Parámetros de fecha:** `main` calcula en JS, con `prefs.timezone`, las cadenas
`:today`, `:d7from` (hoy − 6 días, ventana de 7 días **incluyendo hoy**), `:d30from`
(hoy − 29 días) y `:mtdFrom` (día 1 del mes local). Ninguna consulta usa `date('now')` de
SQLite: no sabe de zonas horarias.

### Q1 · Totales de un periodo

```sql
SELECT COALESCE(SUM(requests),0)       AS requests,
       COALESCE(SUM(input_tok),0)      AS input_tok,
       COALESCE(SUM(output_tok),0)     AS output_tok,
       COALESCE(SUM(thinking_tok),0)   AS thinking_tok,
       COALESCE(SUM(cache_write_5m),0) AS cache_write_5m,
       COALESCE(SUM(cache_write_1h),0) AS cache_write_1h,
       COALESCE(SUM(cache_read),0)     AS cache_read,
       COALESCE(SUM(cost_usd),0.0)     AS cost_usd
FROM rollup_daily
WHERE day_local BETWEEN :from AND :to;
```

Se invoca cuatro veces (`today`, `7d`, `30d`, `mtd`). Para `allTime` se omite el `WHERE`.

### Q2 · Sesión actual

Definición: la sesión actual es el `session_id` con actividad más reciente, sea de un hook o
de una petición, **si esa actividad ocurrió hace menos de 30 minutos**. Si no, no hay sesión
actual (`isActive: false`) pero se sigue mostrando la última conocida en gris.

```sql
-- 2a. candidato por hooks (excluyendo el cierre)
SELECT session_id, project_key, project_path, MAX(ts_epoch) AS last_epoch
FROM hook_events
WHERE session_id IS NOT NULL AND event <> 'SessionEnd'
GROUP BY session_id ORDER BY last_epoch DESC LIMIT 1;

-- 2b. candidato por consumo
SELECT session_id, project_key, project_path, MAX(ts_epoch) AS last_epoch
FROM usage_requests
WHERE session_id IS NOT NULL
GROUP BY session_id ORDER BY last_epoch DESC LIMIT 1;

-- gana el de last_epoch mayor  ->  :sid

-- 2c. cifras de esa sesión (incluye subagentes: comparten sessionId)
SELECT COUNT(*) AS requests,
       COALESCE(SUM(input_tok),0), COALESCE(SUM(output_tok),0),
       COALESCE(SUM(thinking_tok),0), COALESCE(SUM(cache_write_5m),0),
       COALESCE(SUM(cache_write_1h),0), COALESCE(SUM(cache_read),0),
       COALESCE(SUM(cost_usd),0.0),
       MIN(ts) AS started_at, MAX(ts) AS last_activity_at
FROM usage_requests
WHERE session_id = :sid AND model_key <> '__synthetic__';
```

### Q3 · Desglose por proyecto

```sql
SELECT project_key,
       SUM(requests) AS requests,
       SUM(input_tok), SUM(output_tok), SUM(thinking_tok),
       SUM(cache_write_5m), SUM(cache_write_1h), SUM(cache_read),
       SUM(cost_usd) AS cost_usd
FROM rollup_daily
WHERE day_local BETWEEN :from AND :to
GROUP BY project_key
ORDER BY cost_usd DESC
LIMIT :limit;
```

La etiqueta legible del proyecto (`label`) se resuelve en `main`, no en SQL:
`project_path` conocido → `basename(project_path)`; si no, último segmento del `project_key`
tras el último `-` que produzca algo no vacío. Se cachea un
`Map<project_key, {path, label}>` alimentado con
`SELECT project_key, project_path FROM usage_requests WHERE project_path IS NOT NULL GROUP BY project_key`.

### Q4 · Desglose por modelo

Idéntica a Q3 cambiando `project_key` por `model_key`. La etiqueta bonita
(`claude-opus-5` → `Opus 5`) se hace en `shared/format.ts` con una tabla de presentación,
no en la BD.

### Q5 · Serie diaria (panel de stats, F2)

```sql
SELECT day_local, SUM(cost_usd) AS cost_usd,
       SUM(input_tok + output_tok + cache_write_5m + cache_write_1h + cache_read) AS total_tokens
FROM rollup_daily
WHERE day_local BETWEEN :from AND :to
GROUP BY day_local ORDER BY day_local;
```

Los días sin datos se rellenan con ceros en `main`, no en SQL.

### Q6 · Multiplicador

```
cost30 = Q1(:d30from, :today).cost_usd
plan   = PlanInfo del §6
value  = plan.monthlyUsd ? cost30 / plan.monthlyUsd : null
coveredDays = SELECT COUNT(DISTINCT day_local) FROM rollup_daily
              WHERE day_local BETWEEN :d30from AND :today
isFloor = coveredDays < 30
```

`isFloor` es importante: con ~10 días de transcripts supervivientes, el multiplicador de las
primeras semanas es un **suelo**, no la cifra real. La UI lo marca (ver `04-frontal.md` §7).

### Q7 · `totalTokens`

Siempre `input + output + cache_write_5m + cache_write_1h + cache_read`.
**`thinking` nunca se suma** (ya está dentro de `output`). Se calcula en `main` para que
frontend y backend no puedan divergir.

---

## 8. Validación y tests (para QA y para el backend)

### Invariantes que deben cumplirse siempre

- **I1** `SELECT COUNT(*) FROM usage_requests` = `SELECT COUNT(DISTINCT request_id) FROM usage_lines`.
- **I2** Para todo `request_id`: cada contador de `usage_requests` = `MAX()` del mismo
  contador en sus `usage_lines`.
- **I3** Para toda línea con `cache_creation_input_tokens` presente:
  `cache_creation_input_tokens == ephemeral_5m + ephemeral_1h`. Si falla, hay un ttl de
  caché nuevo que no estamos contando; se cuenta el desajuste en un contador de
  advertencias y se emite `app:notice`.
- **I4** `SUM(cost_usd)` de `rollup_daily` para un día = `SUM(cost_usd)` de
  `usage_requests` de ese día, con tolerancia de 1e-6.
- **I5** Ninguna consulta del menubar tarda más de 20 ms con 5 años de datos simulados.

### Test de calibración del parser (el importante)

> ⚠️ **CIFRAS CADUCADAS.** La tabla que había aquí ($166,74 hoy · $616,83 en 7 días ·
> $1 178,15 en 30 días) se calculó **sumando a nivel de línea y sin incluir los
> transcripts de subagentes**. Ya no sirve ni como techo: con el glob recursivo, esa misma
> suma por línea daría hoy **$3 459,96** a 30 días. No se use para nada.

**PUNTO ABIERTO B4 — CERRADO** el 2026-09-03 ejecutando el ingestor sobre los transcripts
reales. Cifras oficiales de referencia (zona `Europe/Madrid`, tarifas de la semilla):

| Métrica | Valor medido |
|---|---|
| Ficheros `.jsonl` (recursivo, con subagentes) | 207 |
| Líneas con `usage` leídas | 24 494 |
| Bloques distintos `(request_id, api_block_index)` | 18 727 |
| **Peticiones facturables** | **12 858** |
| **Ratio línea/petición** | **1,91** |
| Duplicados absorbidos por la dedup | 5 767 (23,5 % de las líneas) |
| Peticiones de subagente | 63,7 % del total |
| Backfill completo | ~2,0 s |
| Ronda completa de consultas del menubar | ~4,5 ms |

El ratio real es **1,91**, no "entre 2,5 y 4" como se estimaba: la media de bloques por
petición es menor de lo que sugería la muestra del §0. Dos advertencias sobre cómo se mide,
porque es fácil equivocarse:

- `COUNT(*) FROM usage_lines` **no** son las líneas leídas, son los bloques *distintos*: la
  dedup ya ha absorbido los duplicados de las sesiones reanudadas. El ratio del §0 se mide
  con las líneas leídas del fichero (`IngestRunResult.linesIngested`), no con la tabla.
- Las cifras de coste dependen de la tarifa por modelo. Aplicando Opus 5 a todo el corpus
  (que es como se calcularon las referencias antiguas) sale **más alto**: la mezcla real
  lleva sonnet-5 y haiku-4-5, que cuestan bastante menos.

Las cifras de dinero no se fijan aquí a propósito: cambian cada hora. Lo que sí es
invariante y debe comprobarse es que **el total de la app coincide con un escaneo
independiente de `~/.claude/projects`** en todos los días con transcripts vivos (§5.6.1).
Ese cuadre está automatizado en `tests/integration/real-ingest.test.ts`
(`ORBIX_REAL=1 npm test`).

### Fixtures obligatorios en `tests/fixtures/`

1. `multi-block.jsonl` — una petición con 4 bloques repitiendo `usage` (el caso del §0).
2. `resumed-session.jsonl` — las mismas `request_id` en dos ficheros distintos.
3. `growing-output.jsonl` — `output_tokens` 1 → 1 → 183 entre bloques.
4. `synthetic.jsonl` — línea con `"model": "<synthetic>"`.
5. `truncated-tail.jsonl` — última línea sin `\n`.
6. `garbage.jsonl` — línea con JSON inválido en medio de líneas válidas.
7. `sidechain/agent-x.jsonl` — transcript de subagente con `isSidechain: true`.
8. `unknown-model.jsonl` — modelo que no está en `model_prices`.
9. `old-format.jsonl` — `cache_creation_input_tokens` sin desglose `cache_creation`.

Los fixtures se recortan de los transcripts reales y se anonimizan (rutas y contenidos de
mensajes sustituidos; **los números de `usage` se dejan intactos**).
</content>
</invoke>
