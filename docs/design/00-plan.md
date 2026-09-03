# miniClaudio — Plan de proyecto

> Fuente de verdad para el equipo. Fecha: 2026-09-03.

## 1. Qué es

Mascota de escritorio para macOS que vive en una esquina de la pantalla, reacciona en
tiempo real a lo que hace Claude Code y lleva la contabilidad del consumo.

Dos trabajos:

- **Avisar** — cuando Claude termina, cuando te necesita para responder o dar permiso,
  cuando algo falla.
- **Contar** — tokens y coste equivalente de la sesión, la semana y el mes, más cuánto
  le estás sacando a la suscripción.

## 2. Decisiones tomadas

| Decisión | Elección |
|---|---|
| Base | App nueva desde cero |
| Stack | Electron + TypeScript + better-sqlite3 |
| Arte | SVG/CSS animado ahora, sprites pixel art más adelante |
| Canal de aviso | La propia mascota: estado visual + bocadillo + sonido. Sin banners del sistema |
| MVP | Avisos + contador de coste |
| ntfy | Convive. Mascota en el Mac, ntfy al móvil |
| Plan | Se detecta de la instalación de Claude Code, no se configura a mano |

## 3. Las tres fuentes de datos

### A. Eventos → hooks de Claude Code

Un hook por evento hace `POST http://127.0.0.1:41414/event` con el payload JSON que
Claude Code le pasa por stdin más el `cwd`. Latencia ~0 y sin depender de red.

Eventos aprovechables: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`,
`Notification`, `SubagentStop`, `PreCompact`, `Stop`, `SessionEnd`.

**Regla dura:** el hook nunca puede bloquear a Claude Code. `async: true`, timeout 2 s,
`curl --max-time 1 ... || true`. Si la mascota está cerrada, no pasa nada.

### B. Consumo → transcripts JSONL

`~/.claude/projects/<proyecto>/<sesión>.jsonl`. Cada línea con `type: "assistant"` trae
`message.usage` desglosado:

```
input_tokens
output_tokens                             (+ output_tokens_details.thinking_tokens)
cache_creation.ephemeral_5m_input_tokens
cache_creation.ephemeral_1h_input_tokens
cache_read_input_tokens
```

Más `message.model`, `timestamp`, `sessionId`, `cwd` y `requestId`.

Medido sobre los datos reales: **0,45 s** para escanear los 368 MB completos.

**Deduplicación obligatoria.** Las sesiones reanudadas o bifurcadas reescriben líneas: en
los datos actuales, 3.781 de 8.985 líneas (42 %) son duplicados. Sin dedup el coste sale
inflado. Clave única: `(request_id, api_block_index)`.

### C. Suscripción y límites → `~/.claude.json`

```
oauthAccount.organizationType            = "claude_max"
oauthAccount.organizationRateLimitTier   = "default_claude_max_20x"   → Max 20×
cachedUsageUtilization.utilization.limits[]
    kind: "session"        percent, resets_at, severity   → ventana de 5 h
    kind: "weekly_all"     percent, resets_at, severity   → semanal total
    kind: "weekly_scoped"  percent, scope.model           → semanal por modelo
```

**Problema:** ese bloque solo se refresca cuando Claude Code lo pide. El actual lleva
7 días sin actualizar. Estrategia en dos niveles:

- **Nivel A (siempre, gratis):** leer el caché y mostrar su antigüedad junto al dato.
  Honesto y sin permisos.
- **Nivel B (opt-in):** la mascota lee el token OAuth del llavero
  (`security find-generic-password -s "Claude Code-credentials" -w`) y refresca ella misma
  contra el endpoint de uso. Pide autorización del llavero una vez. Es API interna no
  documentada: puede romperse, así que degrada al Nivel A sin ruido.

## 4. Arquitectura

```
  Claude Code
      │
      ├─ hooks ──────► POST 127.0.0.1:41414/event ──┐
      │                (Stop, Notification, ...)     │
      │                                              ▼
      │                                    ┌──────────────────┐
      ├─ ~/.claude/projects/*.jsonl ──────►│                  │
      │  (watcher incremental por offset)  │   miniClaudio    │
      │                                    │    (Electron)    │
      └─ ~/.claude.json ──────────────────►│                  │
         (plan + límites)                  └────────┬─────────┘
                                                    │
                                    ┌───────────────┼───────────────┐
                                    ▼               ▼               ▼
                              SQLite local     Ventana         Menubar
                              (histórico)      mascota         (métricas)
                                               transparente
                                               click-through
```

## 5. Esquema de datos (SQLite)

```sql
-- control de ingesta incremental: solo leemos lo nuevo de cada fichero
ingest_files(path PRIMARY KEY, inode, offset, mtime, last_seen)

-- una fila por respuesta del modelo
usage_events(
  id, ts, session_id, project, request_id, api_block_index,
  model, input_tok, output_tok, thinking_tok,
  cache_write_5m, cache_write_1h, cache_read,
  cost_usd,
  UNIQUE(request_id, api_block_index)
)

-- agregados precalculados: el menubar no escanea nunca
rollup_daily(day, project, model, ...tokens..., cost_usd, PRIMARY KEY(day, project, model))

-- eventos de hooks, para la mascota y para el historial de avisos
hook_events(id, ts, event, project, session_id, message, tool_name)

-- precios en tabla, NO hardcodeados: cambian y necesitamos recalcular histórico
model_prices(model, input, output, cache_write_5m, cache_write_1h, cache_read, valid_from)

-- planes y su precio mensual, para el multiplicador
plans(tier_id, display_name, monthly_usd)   -- "default_claude_max_20x" → "Max 20×" → 200
```

Precios vigentes de Opus 5 ($/1M tokens): input 5,00 · output 25,00 · cache write 5m 6,25 ·
cache write 1h 10,00 · cache read 0,50.

## 6. Estados de la mascota

| Disparador | Estado | Qué hace |
|---|---|---|
| `SessionStart` | Despierta | Se despereza |
| `UserPromptSubmit` | Pensando | Ojos arriba, puntos suspensivos |
| `PreToolUse` Edit/Write | Picando código | Teclea |
| `PreToolUse` Bash | Ejecutando | Engranaje girando |
| `PostToolUse` con error | Extrañada | Ceja levantada |
| `SubagentStop` | Agente terminado | Saluda |
| `PreCompact` | Memoria llena | Gotita de sudor |
| **`Notification`** | **Te necesita** | Salta + bocadillo con el mensaje real + sonido |
| **`Stop`** | **Terminado** | Bocadillo con el proyecto + sonido |
| `SessionEnd` | Dormida | Zzz |
| Límite semanal > 80 % | Preocupada | Se agarra la cabeza |

**Capa de render abstracta** desde el primer día, para que los sprites de la fase 3 no
obliguen a reescribir nada:

```ts
interface PetRenderer {
  setState(state: PetState, opts?: { intensity?: number }): void
  say(text: string, ms?: number): void
  play(anim: PetAnim): void
}
// SvgRenderer (F1)  →  SpriteRenderer (F3)
```

`PetState` es un enum cerrado. Nadie fuera del renderer toca píxeles.

## 7. Qué muestra el menubar

- **Sesión actual** — proyecto, tokens, coste equivalente.
- **Hoy / 7 días / 30 días** — tokens y coste equivalente.
- **Multiplicador** — coste equivalente ÷ precio del plan detectado.
- **Barras de límite** — ventana de 5 h, semanal total, semanal por modelo, con la hora de
  reinicio y la antigüedad del dato.
- **Desglose** — por proyecto y por modelo.

Referencia real medida hoy (Opus 5, tarifas de API, tras deduplicar):

| Periodo | Output | Cache read | Coste equivalente |
|---|---|---|---|
| Hoy | 274 K | 183 M | $166,74 |
| 7 días | 2,96 M | 782 M | $616,83 |
| 30 días | 5,71 M | 1.568 M | $1.178,15 |

Contra los ~$200/mes de la Max 20×, el multiplicador ronda **6×**. Y es un suelo: solo
sobrevivieron ~10 días de transcripts a la limpieza de 30 días.

## 8. Fases

**F0 — Cimientos.** Esqueleto Electron + TS, SQLite, ingestor JSONL incremental con dedup,
rollups, comando de verificación por consola. Sin interfaz todavía.
*Resultado: ya estás salvando histórico aunque no veas nada. Cuanto antes, más se salva.*

**F1 — MVP usable.** Ventana transparente click-through con la mascota SVG, servidor local
de eventos, instalador del hook, máquina de estados, bocadillo, sonidos, y menubar con
tokens, coste, multiplicador y barras de límite.
*Resultado: la app que pediste, funcionando.*

**F2 — Pulido.** Panel de estadísticas con gráficas por día, proyecto y modelo.
Preferencias: posición, volumen, modo silencio, precios, plan. Autoarranque. DMG.

**F3 — Alma.** Sprites pixel art sustituyendo al SVG, personalidad y frases, y
gamificación si apetece (rachas, niveles, logros).

## 9. Riesgos y mitigaciones

| Riesgo | Impacto | Mitigación |
|---|---|---|
| Claude Code borra transcripts a los 30 días | Pierdes el histórico mensual y anual | SQLite propio desde F0 |
| Líneas duplicadas en JSONL (42 % hoy) | Coste inflado ~40 % | `UNIQUE(request_id, api_block_index)` |
| El hook bloquea Claude Code | Se te ralentiza todo el trabajo | `async: true`, timeout 2 s, fallo silencioso |
| Los precios cambian | Cifras erróneas | Tabla `model_prices` con `valid_from`, editable |
| El formato JSONL cambia de versión | Ingestor roto tras un update | Parser tolerante, ignora lo desconocido, fixtures en tests |
| `cachedUsageUtilization` rancio | Límites falsos en pantalla | Mostrar antigüedad + refresco opt-in vía llavero |
| API de uso no documentada | Puede dejar de funcionar | Opt-in, degradación silenciosa al caché |
| App 24/7 en pantalla | Ventilador y batería | Animación pausada en idle, techo de 30 fps |

## 10. Reparto del equipo

| Equipo | Trabajo |
|---|---|
| designer | Documentos de diseño: contrato del servidor de eventos, esquema SQLite definitivo, especificación visual de la mascota y del menubar |
| backend-dev | Ingestor JSONL, SQLite, rollups, cálculo de coste, servidor de eventos, lector de plan y límites |
| frontend-dev | Ventana de la mascota, `PetRenderer` SVG, bocadillo, sonidos, menubar, panel de stats |
| qa-tester | Verificación del ingestor contra los transcripts reales, pruebas de los hooks, no-bloqueo de Claude Code |
| devops | Repo, commits, empaquetado DMG |
