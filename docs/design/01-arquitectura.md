# Orbix — 01. Arquitectura

> Fuente de verdad para backend y frontend. Deriva de `00-plan.md`, no lo contradice.
> Fecha: 2026-09-03.
>
> ⚠️ **Antes de tocar nada del ingestor, lee `02-esquema-bd.md` §0.** Hay una corrección
> verificada sobre el plan en la unidad de agregación del coste.

---

## 1. Principios

1. **Un solo proceso escribe en SQLite.** El proceso `main` es el único dueño de la base de
   datos. Los renderers nunca tocan disco: piden datos por IPC.
2. **El renderer de la mascota no sabe nada.** Recibe órdenes ya resueltas (`PetCommand`) y
   las dibuja. Toda la lógica de máquina de estados vive en `main`.
3. **Nada bloquea a Claude Code.** El servidor de eventos responde y corta; el trabajo real
   se hace después, fuera del ciclo de la petición.
4. **La app funciona degradada.** Sin hooks instalados sigue contabilizando. Sin Nivel B
   sigue mostrando límites (con su antigüedad). Sin `~/.claude.json` sigue mostrando coste.
5. **Presupuesto de CPU en reposo: ~0 %.** Ver `04-frontal.md` §9.

---

## 2. Mapa de procesos

```
┌──────────────────────────────────────────────────────────────────────────┐
│ MAIN  (Node · único escritor de SQLite · sin ventana propia)             │
│                                                                          │
│  ┌────────────┐  ┌──────────────┐  ┌─────────────┐  ┌────────────────┐  │
│  │ EventServer│  │  Ingestor    │  │ ClaudeConfig│  │ PetStateMachine│  │
│  │ 127.0.0.1  │  │  JSONL       │  │ plan+limits │  │  prioridades   │  │
│  │ :41414     │  │  incremental │  │             │  │  + cola        │  │
│  └─────┬──────┘  └──────┬───────┘  └──────┬──────┘  └───────┬────────┘  │
│        │                │                 │                 │           │
│        └────────────────┴────────┬────────┴─────────────────┘           │
│                                  ▼                                       │
│                        ┌───────────────────┐                             │
│                        │  Db (better-sqlite3)│  WAL · un writer          │
│                        └───────────────────┘                             │
│                                  │                                       │
│                        ┌───────────────────┐                             │
│                        │   IpcRouter       │  invoke + push              │
│                        └─────────┬─────────┘                             │
└──────────────────────────────────┼───────────────────────────────────────┘
                                   │  contextBridge (sandbox: true)
        ┌──────────────┬───────────┴──────────┬───────────────┐
        ▼              ▼                      ▼               ▼
  ┌───────────┐  ┌───────────┐        ┌────────────┐   ┌───────────┐
  │ RENDERER  │  │ RENDERER  │        │ RENDERER   │   │ RENDERER  │
  │   pet     │  │  menubar  │        │   stats    │   │   prefs   │
  │transparent│  │ popover   │        │  ventana   │   │  ventana  │
  │click-thru │  │ del Tray  │        │  normal F2 │   │  normal   │
  └───────────┘  └───────────┘        └────────────┘   └───────────┘
```

### 2.1 Qué vive en cada sitio

| Proceso | Responsabilidades | NO hace |
|---|---|---|
| `main` | SQLite, migraciones, ingestor, rollups, cálculo de coste, servidor HTTP de eventos, instalador de hooks, lectura de `~/.claude.json` y del llavero, máquina de estados de la mascota, Tray, ciclo de vida de ventanas, preferencias | Render, animación, formateo de cifras para pantalla |
| `renderer/pet` | `SvgRenderer`, bocadillo, sonidos, animaciones CSS | Decidir qué estado tocar, leer ficheros, hablar con la BD |
| `renderer/menubar` | Pintar el popover con datos ya calculados, formateo i18n de cifras, barras de límite | Calcular agregados, consultar SQL |
| `renderer/stats` | Gráficas y tablas (F2) | Igual que arriba |
| `renderer/prefs` | Formulario de preferencias, editor de precios (F2) | Escribir a disco |
| `preload/*` | `contextBridge` con la API tipada de `shared/ipc.ts` | Lógica |

**Decisión: un único proceso para BD + ingestor (no `utilityProcess`, no `worker_threads`).**
El escaneo completo de 368 MB es de 0,45 s en Python y ~4-8 s en Node; el incremental es de
milisegundos. Un segundo proceso obligaría a dos conexiones escritoras, coordinación de
transacciones y un canal extra, a cambio de nada. Se mitiga el bloqueo del event loop con
**ingesta cooperativa por rodajas** (§2.2). *Alternativa descartada:* `utilityProcess`
dedicado — se reconsiderará solo si el backfill inicial supera los 10 s medidos.

### 2.2 Ingesta cooperativa (regla de no bloqueo del main)

El ingestor procesa como máximo **8 MB o 200 ms de trabajo** por rodaja y cede el control
con `setImmediate`. Cada rodaja es una transacción SQLite propia. El backfill inicial emite
`ingest:progress` para que el menubar muestre una barra. Consecuencia contractual: **el
backfill NO es atómico**; puede quedar a medias si se cierra la app, y se retoma por el
cursor de `ingest_files` (ver `02-esquema-bd.md` §5).

---

## 3. Contrato IPC (cerrado — backend y frontend dependen de esto)

Todo vive en `src/shared/ipc.ts` y `src/shared/types.ts`. Los nombres de canal son
literales, en `kebab:camelCase`, y **no se inventan canales nuevos sin actualizar este
documento**.

### 3.1 Reglas

- Renderer → main: **siempre** `ipcRenderer.invoke` (promesa). Nunca `send` síncrono.
- Main → renderer: `webContents.send`, expuesto en preload como `on<Evento>(cb): () => void`
  que devuelve la función de baja.
- Toda respuesta de `invoke` es `{ ok: true, data: T }` o `{ ok: false, error: IpcError }`.
  Nunca se lanza una excepción cruda al renderer.
- `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false` en las cuatro ventanas.

```ts
export interface IpcError { code: IpcErrorCode; message: string; detail?: string }
export type IpcErrorCode =
  | 'DB_ERROR' | 'NOT_READY' | 'NOT_FOUND' | 'BAD_INPUT'
  | 'CLAUDE_CONFIG_MISSING' | 'KEYCHAIN_DENIED' | 'LIVE_API_FAILED'
  | 'HOOK_WRITE_FAILED' | 'PORT_UNAVAILABLE' | 'INTERNAL'
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: IpcError }
```

### 3.2 Canales `invoke` (renderer → main)

| Canal | Petición | Respuesta | Consumidor |
|---|---|---|---|
| `stats:getSnapshot` | `void` | `StatsSnapshot` | menubar, stats |
| `stats:getBreakdown` | `{ by: 'project' \| 'model'; period: PeriodKey; limit?: number }` | `Breakdown` | menubar, stats |
| `stats:getSeries` | `{ period: PeriodKey; groupBy: 'day'; by?: 'project' \| 'model' \| null }` | `Series` | stats (F2) |
| `limits:get` | `void` | `LimitsView` | menubar |
| `limits:refreshLive` | `void` | `LimitsView` | menubar (botón, solo si Nivel B activo) |
| `plan:get` | `void` | `PlanInfo` | menubar, prefs |
| `prefs:get` | `void` | `Prefs` | todos |
| `prefs:set` | `Partial<Prefs>` | `Prefs` | prefs, menubar |
| `hook:getStatus` | `void` | `HookStatus` | prefs, menubar |
| `hook:install` | `void` | `HookStatus` | prefs |
| `hook:uninstall` | `void` | `HookStatus` | prefs |
| `ingest:getStatus` | `void` | `IngestStatus` | menubar, prefs |
| `ingest:runNow` | `{ full?: boolean }` | `IngestStatus` | prefs |
| `prices:list` | `void` | `ModelPrice[]` | prefs (F2) |
| `prices:upsert` | `ModelPriceInput` | `{ affectedDays: number }` | prefs (F2) |
| `levelB:setEnabled` | `{ enabled: boolean }` | `{ enabled: boolean; verified: boolean }` | prefs |
| `pet:setCorner` | `{ corner: Corner; displayId?: number }` | `Prefs` | prefs, menubar |
| `pet:setInteractive` | `{ interactive: boolean }` | `void` | pet (solo si `prefs.clickThrough === false`; ver `04-frontal.md` §3.5) |
| `pet:activate` | `void` | `void` | pet (clic sobre la mascota → abre el popover) |
| `pet:poke` | `{ state: PetState; bubble?: string }` | `void` | **solo dev**, para probar estados |
| `sound:mute` | `{ minutes: number \| null }` | `Prefs` | menubar (`null` = silencio indefinido) |
| `window:open` | `{ target: 'stats' \| 'prefs' }` | `void` | menubar |
| `window:closeSelf` | `void` | `void` | stats, prefs |
| `app:quit` | `void` | `void` | menubar |
| `app:getInfo` | `void` | `AppInfo` | prefs |

### 3.3 Canales `push` (main → renderer)

| Canal | Payload | Destino | Cuándo |
|---|---|---|---|
| `pet:command` | `PetCommand` | pet | Cada vez que la máquina de estados resuelve un cambio |
| `pet:prefs` | `PetVisualPrefs` | pet | Al arrancar y al cambiar preferencias visuales/sonido |
| `stats:updated` | `{ reason: 'ingest' \| 'prices' \| 'manual'; snapshot: StatsSnapshot }` | menubar, stats | Tras cada ciclo de ingesta que insertó filas, o recálculo de precios. **Coalescido a máximo 1 cada 2 s** |
| `limits:updated` | `LimitsView` | menubar | Al detectar cambio en `~/.claude.json` o tras refresco Nivel B |
| `ingest:progress` | `IngestStatus` | menubar, prefs | Solo durante backfill; máximo 2/s |
| `prefs:changed` | `Prefs` | todos | Tras `prefs:set` |
| `app:notice` | `{ level: 'info'\|'warn'\|'error'; code: string; message: string }` | menubar | Errores no fatales (puerto ocupado, Nivel B caído, hook desinstalado por terceros) |

### 3.4 Tipos compartidos (`src/shared/types.ts`)

```ts
export type PeriodKey = 'today' | '7d' | '30d' | 'mtd' | 'all'
export type Corner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

export interface TokenTotals {
  input: number
  output: number
  thinking: number        // subconjunto informativo de output, NO se suma aparte
  cacheWrite5m: number
  cacheWrite1h: number
  cacheRead: number
}

export interface PeriodStats {
  tokens: TokenTotals
  totalTokens: number     // input + output + cw5m + cw1h + cacheRead  (thinking excluido)
  costUsd: number
  requests: number        // nº de request_id distintos
}

export interface SessionStats extends PeriodStats {
  sessionId: string | null
  projectKey: string | null      // "-Users-icatala-Projects-propios-Orbix"
  projectName: string | null     // "Orbix"
  projectPath: string | null     // "/Users/icatala/Projects/propios/Orbix"
  startedAt: string | null       // ISO UTC
  lastActivityAt: string | null  // ISO UTC
  isActive: boolean              // última actividad < 30 min
}

export interface PlanInfo {
  tierId: string | null            // "default_claude_max_20x"
  organizationType: string | null  // "claude_max"
  displayName: string              // "Max 20×"  |  "Plan desconocido"
  monthlyUsd: number | null        // 200
  accountEmail: string | null
  detected: boolean
}

export interface Multiplier {
  value: number | null    // costUsd(last30d) / monthlyUsd
  basis: 'last30d'
  planMonthlyUsd: number | null
  costUsd: number
  isFloor: boolean        // true si hay menos de 30 días de histórico en BD
  coveredDays: number     // días distintos con datos dentro de la ventana
}

export interface StatsSnapshot {
  generatedAt: string       // ISO UTC
  session: SessionStats
  today: PeriodStats
  last7d: PeriodStats
  last30d: PeriodStats
  monthToDate: PeriodStats
  allTime: PeriodStats
  plan: PlanInfo
  multiplier: Multiplier
  ingest: IngestStatus
}

export type LimitSeverity = 'normal' | 'warning' | 'critical' | 'unknown'

export interface LimitBar {
  kind: 'session' | 'weekly_all' | 'weekly_scoped'
  group: 'session' | 'weekly'
  label: string             // "Ventana 5 h" | "Semanal total" | "Semanal · Opus"
  percent: number           // 0-100, ya clampado
  severity: LimitSeverity
  resetsAt: string | null   // ISO UTC
  scopeLabel: string | null // "Opus" | null
  isActive: boolean
}

export interface LimitsView {
  source: 'live' | 'cache' | 'none'
  fetchedAt: string | null     // ISO UTC
  ageSeconds: number | null
  stale: boolean               // ageSeconds > 3600
  veryStale: boolean           // ageSeconds > 86400
  bars: LimitBar[]
  extraUsageEnabled: boolean
  spendUsedUsd: number | null
  levelB: { enabled: boolean; lastResult: 'ok' | 'failed' | 'never'; lastError: string | null }
}

export interface BreakdownRow {
  key: string; label: string
  tokens: TokenTotals; totalTokens: number; costUsd: number
  requests: number; share: number   // 0-1 sobre el coste del periodo
}
export interface Breakdown { by: 'project' | 'model'; period: PeriodKey; rows: BreakdownRow[]; totalCostUsd: number }

export interface SeriesPoint { day: string; costUsd: number; totalTokens: number; key?: string }
export interface Series { period: PeriodKey; by: 'project' | 'model' | null; points: SeriesPoint[] }

export interface IngestStatus {
  state: 'idle' | 'scanning' | 'backfilling' | 'error'
  filesTracked: number
  lastRunAt: string | null
  lastDurationMs: number | null
  backfillProgress: number | null   // 0-1 o null si no hay backfill
  linesIngestedTotal: number
  lastError: string | null
}

export interface HookStatus {
  installed: boolean
  events: string[]                  // eventos con nuestro hook presente
  missingEvents: string[]
  scriptPath: string
  scriptVersion: string | null
  settingsPath: string
  serverPort: number | null
  serverListening: boolean
  foreignHooksPreserved: number     // hooks de terceros detectados y respetados
  lastBackupPath: string | null
}

export interface AppInfo {
  version: string; electron: string; node: string
  dbPath: string; dbSizeBytes: number; schemaVersion: number
  platform: string; arch: string
}
```

### 3.5 Preferencias (`Prefs`)

```ts
export interface Prefs {
  // Mascota
  petVisible: boolean            // default true
  corner: Corner                 // default 'bottom-right'
  displayId: number | null       // null = pantalla con el cursor/activa
  followActiveDisplay: boolean   // default true
  petScale: number               // 0.75 | 1 | 1.25 | 1.5   default 1
  petOpacityIdle: number         // 0.35-1  default 0.85
  clickThrough: boolean          // default true
  // Bocadillo
  bubbleEnabled: boolean         // default true
  bubbleMs: number               // default 5000, rango 2000-15000
  // Sonido
  soundEnabled: boolean          // default true
  volume: number                 // 0-1 default 0.5
  soundOnSubagentStop: boolean   // default false
  quietHours: { enabled: boolean; from: string; to: string } // "23:00" / "08:00"
  muteWhenScreenLocked: boolean  // default true
  muteUntil: string | null       // ISO UTC; main lo limpia solo al vencer
  // Datos
  timezone: string               // IANA, default = Intl.DateTimeFormat().resolvedOptions().timeZone
  currencySymbol: string         // default "$"
  ingestIntervalMs: number       // default 3000, mínimo 1000
  // Nivel B
  levelBEnabled: boolean         // default false
  levelBIntervalMs: number       // default 300000 (5 min)
  // Hooks
  detailedToolStates: boolean    // default true → instala PreToolUse/PostToolUse
  // Sistema
  showCostInMenubar: boolean     // default false (ver 04-frontal.md §10.1 y D3)
  showSessionPercentInMenubar: boolean  // default false (% de la ventana de 5 h, §10.1)
  launchAtLogin: boolean         // default false (F2)
  devMode: boolean               // default false
}
export interface PetVisualPrefs {
  petScale: number; petOpacityIdle: number
  bubbleEnabled: boolean; bubbleMs: number
  soundEnabled: boolean; volume: number
  reducedMotion: boolean         // derivado del sistema, no editable
}
```

Persistencia: fichero JSON `~/Library/Application Support/Orbix/prefs.json`, escritura
atómica (temp + `rename`). *Alternativa descartada:* tabla en SQLite — las prefs deben poder
leerse antes de que la BD esté migrada.

---

## 4. Estructura del repositorio

```
Orbix/
├── package.json
├── electron.vite.config.ts
├── electron-builder.yml
├── tsconfig.json                 # solo "references"
├── tsconfig.node.json            # main + preload
├── tsconfig.web.json             # renderers
├── .editorconfig  .gitignore  .nvmrc
├── docs/design/                  # 00..04 (este directorio)
├── resources/
│   ├── icon.icns                 # icono de la app (DMG)
│   ├── trayTemplate.png  trayTemplate@2x.png
│   └── sounds/                   # ver 04-frontal.md §8
├── scripts/
│   └── hook/orbix-hook.sh  # se copia a ~/.claude/orbix/ al instalar
├── src/
│   ├── shared/
│   │   ├── ipc.ts                # nombres de canal + firmas
│   │   ├── types.ts              # los tipos de §3.4
│   │   ├── pet.ts                # PetState, PetAnim, PetCommand, SoundId
│   │   ├── format.ts             # formateo de cifras (usado por renderers)
│   │   └── constants.ts          # puerto, rutas, ventanas de tiempo
│   ├── main/
│   │   ├── index.ts              # bootstrap y ciclo de vida
│   │   ├── db/
│   │   │   ├── connection.ts
│   │   │   ├── migrations/001_init.sql … 00N_*.sql
│   │   │   ├── migrate.ts
│   │   │   ├── queries.ts        # las consultas de 02-esquema-bd.md §7
│   │   │   ├── rollups.ts
│   │   │   └── prices.ts
│   │   ├── ingest/
│   │   │   ├── scanner.ts        # descubrimiento de ficheros + watcher
│   │   │   ├── cursor.ts         # ingest_files: offset, inode, truncado
│   │   │   ├── parser.ts         # JSONL → UsageLine (tolerante)
│   │   │   └── ingestor.ts       # orquestación por rodajas
│   │   ├── events/
│   │   │   ├── server.ts         # HTTP 127.0.0.1
│   │   │   ├── schema.ts         # validación de payloads
│   │   │   ├── hook-installer.ts # merge seguro de settings.json
│   │   │   └── router.ts         # evento → PetStateMachine + hook_events
│   │   ├── claude/
│   │   │   ├── config-reader.ts  # ~/.claude.json (plan + cachedUsageUtilization)
│   │   │   ├── keychain.ts       # Nivel B: lectura del token
│   │   │   └── live-usage.ts     # Nivel B: refresco contra la API interna
│   │   ├── pet/
│   │   │   ├── state-machine.ts  # prioridades, colas, timeouts
│   │   │   └── phrases.ts        # textos de bocadillo
│   │   ├── windows/{pet,menubar,stats,prefs}.ts
│   │   ├── tray.ts
│   │   ├── prefs/store.ts
│   │   └── ipc/{handlers.ts,push.ts}
│   ├── preload/
│   │   ├── common.ts             # helper invoke/on tipado
│   │   ├── pet.ts  menubar.ts  stats.ts  prefs.ts
│   └── renderer/
│       ├── pet/{index.html,main.ts,SvgRenderer.ts,Bubble.ts,sound.ts,pet.css}
│       ├── menubar/{index.html,main.ts,menubar.css,components/*}
│       ├── stats/{index.html,main.ts,stats.css}
│       └── prefs/{index.html,main.ts,prefs.css}
└── tests/
    ├── fixtures/                 # JSONL reales recortados y anonimizados
    └── unit/                     # parser, dedup, coste, merge de settings
```

---

## 5. Dependencias

| Paquete | Rango | Para qué | Nota |
|---|---|---|---|
| `electron` | `^37.0.0` | Runtime | Debe traer Node ≥ 22 y soportar macOS 26 |
| `better-sqlite3` | `^12.0.0` | BD síncrona | Requiere rebuild contra el ABI de Electron |
| `chokidar` | `^4.0.0` | Watcher de `~/.claude/projects` y `~/.claude.json` | |
| `typescript` | `^5.7.0` | | `strict: true` |
| `electron-vite` | `^4.0.0` | Build de main/preload/renderer + HMR | *Alternativa descartada:* `tsc` + `esbuild` a mano; más control, más fontanería |
| `vite` | `^7.0.0` | Peer de electron-vite | |
| `@electron/rebuild` | `^4.0.0` | Recompilar better-sqlite3 | `postinstall` |
| `electron-builder` | `^26.0.0` | DMG arm64 | |
| `vitest` | `^3.0.0` | Tests unitarios | |
| `uplot` | `^1.6.0` | Gráficas del panel de stats | **Solo F2**, no entra en F1 |

**Sin framework de UI.** La mascota es SVG+CSS y el menubar es una lista de ~15 filas; React
o Svelte añadirían peso y un runtime extra a un proceso que vive 24/7 sin aportar nada.
Se usan plantillas con *template literals* y actualización puntual por `data-*`.
*Alternativa descartada:* Preact (3 KB) — se reconsiderará si el panel de stats de F2 crece.

**Sin ORM.** SQL a mano con sentencias preparadas de `better-sqlite3`. Drizzle/Prisma
añadirían generación de código y un runtime para 9 tablas conocidas y fijas.

`package.json` (fragmento contractual):

```jsonc
{
  "name": "orbix",
  "productName": "Orbix",
  "version": "0.1.0",
  "main": "./out/main/index.js",
  "scripts": {
    "dev": "electron-vite dev",
    "build": "tsc --noEmit -p tsconfig.node.json && tsc --noEmit -p tsconfig.web.json && electron-vite build",
    "postinstall": "electron-rebuild -f -w better-sqlite3",
    "dist": "npm run build && electron-builder --mac --arm64",
    "test": "vitest run"
  }
}
```

---

## 6. TypeScript

`tsconfig.node.json` (main + preload):

```jsonc
{
  "compilerOptions": {
    "target": "ES2023", "lib": ["ES2023"], "module": "ESNext",
    "moduleResolution": "Bundler", "types": ["node", "electron-vite/node"],
    "strict": true, "noUncheckedIndexedAccess": true, "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true, "noFallthroughCasesInSwitch": true,
    "verbatimModuleSyntax": true, "isolatedModules": true,
    "resolveJsonModule": true, "skipLibCheck": true, "noEmit": true,
    "baseUrl": ".", "paths": { "@shared/*": ["src/shared/*"] }
  },
  "include": ["src/main/**/*", "src/preload/**/*", "src/shared/**/*", "electron.vite.config.ts"]
}
```

`tsconfig.web.json` (renderers): igual pero `"lib": ["ES2023", "DOM", "DOM.Iterable"]`,
`"types": []`, `include: ["src/renderer/**/*", "src/shared/**/*"]`.

Regla: `src/shared` **no puede importar** de `node:*` ni de `electron`. Es código neutro que
compila en ambos contextos. Se verifica con un test de lint.

---

## 7. electron-builder

```yaml
# electron-builder.yml
appId: com.icatala.orbix
productName: Orbix
copyright: © 2026 Ismael Catalá
directories:
  output: release
  buildResources: resources
files:
  - out/**/*
  - resources/sounds/**/*
  - resources/trayTemplate*.png
  - scripts/hook/orbix-hook.sh
asarUnpack:
  - "**/*.node"                 # better-sqlite3
  - "scripts/hook/**"           # el hook debe ser un fichero real, no dentro de asar
mac:
  category: public.app-category.developer-tools
  target:
    - target: dmg
      arch: [arm64]
  icon: resources/icon.icns
  hardenedRuntime: true
  gatekeeperAssess: false
  entitlements: build/entitlements.mac.plist
  entitlementsInherit: build/entitlements.mac.plist
  extendInfo:
    LSUIElement: 1              # app de barra de menús: sin icono en el Dock
    NSHumanReadableCopyright: © 2026 Ismael Catalá
dmg:
  title: Orbix ${version}
  contents:
    - { x: 130, y: 220, type: file }
    - { x: 410, y: 220, type: link, path: /Applications }
```

`build/entitlements.mac.plist` necesita `com.apple.security.cs.allow-jit` (V8) y
`com.apple.security.cs.allow-unsigned-executable-memory`. **No** se activa App Sandbox: la
app tiene que leer `~/.claude`, escribir `~/.claude/settings.json` y ejecutar `security`.

> **PUNTO ABIERTO A1 — Firma y notarización.** Para distribuir el DMG fuera del Mac de
> Ismael hace falta un Developer ID Application y notarización (`notarize: true` +
> `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID`). *Recomendación:* en F1 y F2
> compilar sin firmar (`identity: null`) y abrir con clic derecho → Abrir; abordar la
> notarización en devops cuando se decida distribuir.

---

## 8. Arranque y ciclo de vida

```
app.requestSingleInstanceLock()            # si falla: segundo intento abre el menubar del primero y sale
  └─ app.whenReady()
       1. Prefs.load()                     # crea defaults si no existe
       2. Db.open()  → PRAGMA journal_mode=WAL, foreign_keys=ON, busy_timeout=5000
       3. Db.migrate()                     # user_version, transaccional
       4. Prices.seedIfEmpty()             # tarifas de 02-esquema-bd.md §4
       5. Plans.seedIfEmpty()
       6. ClaudeConfig.read()              # plan + límites cacheados → limits:updated
       7. Tray.create()                    # icono plantilla + popover
       8. PetWindow.create()               # si prefs.petVisible
       9. EventServer.listen()             # 41414, con fallback (03 §3)
      10. Ingestor.start()                 # backfill si es la primera vez, luego watcher
      11. PetStateMachine.set(IDLE)
      12. LevelB.start()                   # solo si prefs.levelBEnabled
```

- `app.dock.hide()` es implícito por `LSUIElement: 1`.
- `window-all-closed`: **no** cerrar la app (es una app de barra de menús).
- `before-quit`: parar watcher, cerrar servidor HTTP, `db.pragma('wal_checkpoint(TRUNCATE)')`,
  `db.close()`. Timeout duro de 3 s y salida forzada.
- Suspensión / reanudación (`powerMonitor`): al `resume`, forzar un ciclo de ingesta completo
  (`full: false` pero re-`stat` de todos los ficheros) y refrescar `~/.claude.json`.
- Cambio de pantallas (`screen` `display-added` / `display-removed` /
  `display-metrics-changed`): reposicionar la ventana de la mascota (ver `04-frontal.md` §3).
- Rutas: BD y prefs en `app.getPath('userData')` =
  `~/Library/Application Support/Orbix/`. En `devMode` se usa
  `~/Library/Application Support/Orbix-dev/` para no ensuciar los datos buenos.

### 8.1 Orden de trabajo sugerido

Backend puede arrancar por §8 pasos 1-5 + `02-esquema-bd.md` sin depender de nada del
frontend. Frontend puede arrancar por `04-frontal.md` con un **mock de la API de preload**
que devuelva `StatsSnapshot`/`LimitsView` de ejemplo; los fixtures de mock viven en
`tests/fixtures/ipc/*.json` y los crea el backend en su primer día para desbloquear.

---

## 9. Suposiciones

1. Solo macOS arm64. No hay código condicionado por plataforma más allá de lo trivial.
2. Un único usuario y una única instalación de Claude Code (`~/.claude`). No se soportan
   instalaciones múltiples ni `CLAUDE_CONFIG_DIR` personalizado (se lee la variable de
   entorno si existe, pero no se prueba).
3. La app no necesita red para su función principal. Solo el Nivel B sale a Internet.
4. El histórico anterior a la instalación es el que sobreviva en los JSONL (~10 días). A
   partir de ahí, la BD acumula.
</content>
</invoke>
