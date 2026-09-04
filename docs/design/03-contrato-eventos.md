# Orbix — 03. Contrato del servidor de eventos, hooks y mapa de estados

> Fecha: 2026-09-03. Implementa `backend-dev`; `frontend-dev` solo consume `PetCommand`.

---

## 1. Regla dura

**El hook nunca puede bloquear ni ralentizar a Claude Code.** Todo lo demás es negociable;
esto no. Se materializa en cuatro sitios y los cuatro son obligatorios:

1. `"async": true` en la entrada de `~/.claude/settings.json`.
2. `"timeout": 2` en esa misma entrada (red de seguridad de Claude Code).
3. `curl -m 1 --connect-timeout 0.3 ... || true` dentro del script.
4. `exit 0` incondicional al final del script.

Con Orbix cerrado, `curl` falla en < 5 ms con `Connection refused` y el hook sale 0.
Claude Code no percibe absolutamente nada.

---

## 2. Servidor HTTP local

| Propiedad | Valor |
|---|---|
| Implementación | `node:http` de la librería estándar. Sin Express ni dependencias |
| Interfaz | **`127.0.0.1` únicamente** (`server.listen(port, '127.0.0.1')`). Nunca `0.0.0.0` |
| Puerto preferido | `41414` |
| Puertos de reserva | `41415`–`41424` |
| Body máximo | 64 KiB. Más → `413` y se corta la conexión |
| Timeouts | `headersTimeout: 2000`, `requestTimeout: 3000`, `keepAliveTimeout: 1000` |
| Concurrencia | `maxConnections: 32` |
| CORS | **Ninguna cabecera CORS.** Un navegador no debe poder leer nunca la respuesta |

### 2.1 Rutas

| Método | Ruta | Descripción |
|---|---|---|
| `POST` | `/event` | Recibe el payload de un hook de Claude Code |
| `GET` | `/health` | Sonda de vida y de identidad de instancia |

Cualquier otra ruta o método → `404` con cuerpo vacío.

#### `POST /event`

Petición:
- `Content-Type: application/json` (obligatorio; si falta → `415`).
- `X-Orbix-Token: <token>` (obligatorio; ver §2.3).
- Cuerpo: el JSON tal cual lo entrega Claude Code por stdin.

Respuestas:

| Código | Cuándo | Cuerpo |
|---|---|---|
| `204` | Aceptado y encolado | vacío |
| `400` | JSON inválido o sin `hook_event_name` | vacío |
| `401` | Token ausente o incorrecto | vacío |
| `403` | Petición con cabecera `Origin` o `Referer`, o `Host` no loopback | vacío |
| `413` | Cuerpo > 64 KiB | vacío |
| `415` | `Content-Type` no es JSON | vacío |
| `503` | La app aún no ha terminado de arrancar | vacío |

**El manejador responde antes de trabajar.** Orden obligatorio: validar → `res.writeHead(204); res.end()` → `queueMicrotask(() => procesar(payload))`. Escribir en `hook_events`
y mover la máquina de estados ocurre siempre después de haber cerrado la respuesta.

#### `GET /health`

```json
{ "app": "Orbix", "version": "0.1.0", "pid": 12345,
  "port": 41414, "ready": true, "instanceId": "b3f1…" }
```

Sirve para dos cosas: que el instalador compruebe que el servidor está vivo, y que al
arrancar podamos distinguir "el puerto lo ocupa otra instancia de Orbix" de "el puerto
lo ocupa otro programa cualquiera".

### 2.2 Seguridad

El modelo de amenaza real es una página web abierta en el navegador del usuario haciendo
peticiones a `localhost` (CSRF de DNS rebinding). Mitigaciones, todas obligatorias:

1. **Bind solo a `127.0.0.1`.** Nada desde la red.
2. **`req.socket.remoteAddress` debe ser `127.0.0.1` o `::ffff:127.0.0.1`.** Si no, cortar
   el socket sin responder.
3. **Cabecera `Host` debe ser `127.0.0.1:<puerto>` o `localhost:<puerto>`.** Esto rompe el
   DNS rebinding. Si no → `403`.
4. **Rechazar cualquier petición con `Origin` o `Referer`.** Un hook nunca las manda; un
   navegador siempre.
5. **Token compartido** en `X-Orbix-Token`, comparado con
   `crypto.timingSafeEqual`. Se genera en la instalación (32 bytes aleatorios en hex) y se
   guarda en `~/.claude/orbix/token` con permisos `0600`.
6. **Sin CORS.** Aunque un navegador consiguiera enviar la petición, no podría leer nada.
7. **Rate limit**: 50 eventos/segundo. Por encima se descartan y se cuenta el exceso.
8. Nada de lo recibido se ejecuta, interpola en un shell ni se escribe en disco fuera de la
   columna `raw_json` (recortada a 8 KiB).

### 2.3 Ficheros de coordinación

Directorio `~/.claude/orbix/` (creado con `0700` en la instalación):

| Fichero | Permisos | Contenido |
|---|---|---|
| `hook.sh` | `0755` | El script del §4 |
| `token` | `0600` | Token hex de 64 caracteres |
| `port` | `0644` | El puerto en el que está escuchando ahora mismo, en texto plano |

`port` se **reescribe en cada arranque**, en cuanto el `listen` tiene éxito, con escritura
atómica (temp + `rename`). No se borra al salir: si la app está cerrada, `curl` fallará por
conexión rechazada, que es exactamente el comportamiento deseado.

### 2.4 Puerto ocupado

```
listen(41414):
  EADDRINUSE ->
     r = GET http://127.0.0.1:41414/health   (timeout 500 ms)
     si r.app == 'Orbix' y r.instanceId != el nuestro:
         # ya hay otra instancia. El single-instance-lock de Electron
         # debería habernos parado antes; salimos limpiamente.
         mostrar el popover de la instancia viva y app.quit()
     si no:
         # el puerto lo tiene otro programa
         probar 41415, 41416, … 41424
         al primero que enganche: escribir ~/.claude/orbix/port
         emitir app:notice { level: 'warn', code: 'PORT_FALLBACK',
                             message: 'El puerto 41414 estaba ocupado; usando 41417.' }
     agotados los 11 puertos:
         EventServer queda 'off'; ingestión y menubar siguen funcionando
         emitir app:notice { level: 'error', code: 'PORT_UNAVAILABLE' }
         HookStatus.serverListening = false  ->  preferencias lo muestran en rojo
```

Como el hook lee el puerto del fichero en cada invocación, el cambio de puerto es
transparente y no requiere reescribir `settings.json`.

---

## 3. Esquema de los payloads de entrada

Campos comunes a todos los eventos (Claude Code 2.1.x):

```ts
interface HookPayloadBase {
  hook_event_name: string          // 'Stop' | 'Notification' | ...   OBLIGATORIO
  session_id?: string
  transcript_path?: string
  cwd?: string
  permission_mode?: string
}
```

Por evento (todo lo específico es opcional: el parser nunca falla por un campo ausente):

| `hook_event_name` | Campos adicionales esperados |
|---|---|
| `SessionStart` | `source?: 'startup' \| 'resume' \| 'clear' \| 'compact'` |
| `UserPromptSubmit` | `prompt?: string` |
| `PreToolUse` | `tool_name: string`, `tool_input?: object` |
| `PostToolUse` | `tool_name: string`, `tool_input?: object`, `tool_response?: unknown` |
| `Notification` | `message?: string` |
| `SubagentStop` | `stop_hook_active?: boolean` |
| `PreCompact` | `trigger?: 'manual' \| 'auto'`, `custom_instructions?: string` |
| `Stop` | `stop_hook_active?: boolean` |
| `SessionEnd` | `reason?: string` |

Validación en `events/schema.ts`:

```
1. body debe parsear como objeto JSON (no array, no primitivo)     -> si no, 400
2. hook_event_name debe ser string no vacío de ≤ 64 caracteres     -> si no, 400
3. si hook_event_name no está en la lista conocida:
      se guarda en hook_events con pet_state = NULL y NO produce estado
      (compatibilidad hacia adelante con eventos futuros)
4. todo string se recorta: message/prompt a 500 caracteres,
   tool_name a 64, reason a 128, cwd a 512
5. se eliminan caracteres de control (\x00-\x08, \x0B, \x0C, \x0E-\x1F)
6. raw_json = JSON.stringify(payload) recortado a 8 KiB
```

**Derivados que calcula el servidor, no el hook:**

```
project_path = payload.cwd ?? null
project_key  = project_path ? project_path.replaceAll('/', '-') : null
project_name = project_path ? basename(project_path) : 'Claude'
ts           = new Date().toISOString()          # hora de recepción
```

> El `project_key` derivado del `cwd` coincide con el nombre del directorio de
> `~/.claude/projects/` (verificado: `/Users/icatala/Projects/propios/Orbix` →
> `-Users-icatala-Projects-propios-Orbix`). Esto permite cruzar hooks y consumo.

---

## 4. El script del hook

Ruta de instalación: `~/.claude/orbix/hook.sh` (modo `0755`).
Origen en el repo: `scripts/hook/orbix-hook.sh`, copiado literalmente en la instalación
(el fichero debe ir en `asarUnpack`, ver `01-arquitectura.md` §7).

```sh
#!/bin/sh
# orbix-hook-version: 1
# Orbix — reenvía el payload del hook al servidor local de la mascota.
# Diseñado para no fallar, no bloquear y no imprimir nada. Sale 0 siempre.

DIR="${HOME}/.claude/orbix"
PORT=$(cat "${DIR}/port" 2>/dev/null) || PORT=41414
[ -z "${PORT}" ] && PORT=41414
TOKEN=$(cat "${DIR}/token" 2>/dev/null) || TOKEN=""

curl -s -m 1 --connect-timeout 0.3 \
     -X POST \
     -H 'Content-Type: application/json' \
     -H "X-Orbix-Token: ${TOKEN}" \
     --data-binary @- \
     "http://127.0.0.1:${PORT}/event" >/dev/null 2>&1

exit 0
```

Notas de diseño, todas deliberadas:

- **`/bin/sh`, no bash.** Menos que cargar, arranca antes.
- **Sin `jq`.** El script no mira el payload: lo reenvía tal cual con `--data-binary @-`.
  Cero parseo, cero dependencias, y el servidor ya tiene que validar de todas formas.
  (El hook de ntfy sí usa `jq`; es otro script y sigue igual.)
- **Sin `set -e`.** Un fallo intermedio no debe abortar antes del `exit 0`.
- **`--data-binary` y no `-d`.** `-d` normaliza saltos de línea; el payload va intacto.
- **Sin `-f`.** No queremos que curl escriba en stderr por un 4xx.
- El `|| true` del plan es innecesario aquí porque no hay `set -e` y hay `exit 0` explícito;
  se mantiene el efecto, que es lo que importa.

---

## 5. Instalación en `~/.claude/settings.json`

### 5.1 Lo que hay ahora (verificado, hay que preservarlo intacto)

`~/.claude/settings.json` ya contiene hooks de Ismael:

- `Stop` → dos grupos: `~/.claude/hooks/ntfy-notify.sh` y `/Users/icatala/.local/bin/cerebro hook cierre`
- `Notification` → `~/.claude/hooks/ntfy-notify.sh`
- `SessionEnd` → `~/.claude/hooks/ntfy-notify.sh`
- `SessionStart` → `/Users/icatala/.local/bin/cerebro hook arranque`

Además de `permissions`, `model`, `enabledPlugins`, `extraKnownMarketplaces`, `voice`, y una
docena de ajustes más. **Nada de eso se toca.**

La estructura de Claude Code es `hooks[<Evento>]` = array de *grupos*, cada grupo con
`matcher?` y `hooks[]`. Añadir un grupo propio al array es el patrón que ya usa el fichero
(`Stop` tiene dos grupos independientes) y es la forma no destructiva de coexistir.

### 5.2 Lo que instala Orbix

Para cada uno de estos nueve eventos se añade **un grupo propio**:

```jsonc
// SessionStart, UserPromptSubmit, Notification, SubagentStop, PreCompact, Stop, SessionEnd
{
  "hooks": [
    { "type": "command",
      "command": "~/.claude/orbix/hook.sh",
      "timeout": 2,
      "async": true }
  ]
}

// PreToolUse, PostToolUse  → con matcher para capturar todas las herramientas
{
  "matcher": "*",
  "hooks": [
    { "type": "command",
      "command": "~/.claude/orbix/hook.sh",
      "timeout": 2,
      "async": true }
  ]
}
```

**Marca de identidad:** una entrada es "nuestra" si y solo si
`typeof h.command === 'string' && h.command.includes('orbix/hook.sh')`.
Nada más. No se usan claves extra en el JSON (Claude Code podría rechazarlas).

**Coste de `PreToolUse`/`PostToolUse`:** son los eventos más frecuentes (dos `sh` + dos
`curl` por cada llamada a herramienta). Medido en el orden de 5-10 ms asíncronos por
invocación, irrelevante. Aun así, la preferencia **"estados detallados de herramientas"**
(activada por defecto) permite desinstalar solo esos dos si el usuario nota ruido; sin ellos
la mascota pierde `CODING`, `RUNNING` y `PUZZLED` pero todo lo demás sigue.

### 5.3 Algoritmo de instalación (idempotente y con backup)

```
install():
  1. mkdir -p ~/.claude/orbix            (0700)
  2. si no existe token: escribir crypto.randomBytes(32).toString('hex')   (0600)
  3. copiar scripts/hook/orbix-hook.sh -> ~/.claude/orbix/hook.sh, chmod 0755
     (siempre se sobrescribe: así una actualización de la app actualiza el hook)
  4. escribir ~/.claude/orbix/port con el puerto activo

  5. leer ~/.claude/settings.json
       - si no existe            -> raw = '{}'
       - si existe pero no parsea -> ABORTAR con HOOK_WRITE_FAILED y no tocar nada.
                                     Jamás sobrescribir un settings.json ilegible.
  6. backup: copiar a ~/.claude/settings.json.orbix-bak-<YYYYMMDD-HHmmss>
       - conservar como mucho los 5 backups más recientes, borrar el resto
       - guardar la ruta en HookStatus.lastBackupPath
  7. cfg = JSON.parse(raw)
     cfg.hooks ??= {}
     para cada evento E de los nueve:
         cfg.hooks[E] ??= []
         # limpiar cualquier entrada nuestra previa (idempotencia)
         para cada grupo G de cfg.hooks[E]:
             G.hooks = (G.hooks ?? []).filter(h => !esNuestro(h))
         cfg.hooks[E] = cfg.hooks[E].filter(G => (G.hooks ?? []).length > 0)
         # añadir el grupo nuevo al final
         cfg.hooks[E].push(grupoDe(E))
  8. escribir con JSON.stringify(cfg, null, 2) + '\n'
       - a ~/.claude/settings.json.orbix-tmp
       - fsync
       - rename() sobre el original   (atómico en el mismo volumen)
  9. releer y verificar que parsea y que los nueve eventos tienen nuestra entrada.
     Si la verificación falla -> restaurar el backup y devolver HOOK_WRITE_FAILED.
 10. devolver HookStatus
```

Detalles que importan:

- **Orden de claves preservado.** `JSON.parse` → objeto JS → `JSON.stringify` mantiene el
  orden de inserción de las claves de texto, así que el diff en git del usuario (si lo
  versiona) es mínimo: solo el bloque `hooks`.
- **Indentación de 2 espacios**, que es la que ya usa el fichero.
- `settings.json` es JSON estricto (sin comentarios), verificado. No hace falta un parser
  tolerante tipo JSON5.
- Los pasos 5-9 se ejecutan **bajo un lock de fichero** (`~/.claude/orbix/.lock`
  creado con `wx`) con timeout de 5 s, por si el usuario abre preferencias dos veces.
- La operación **no requiere que Claude Code esté cerrado**: Claude Code relee
  `settings.json` en cada arranque de sesión. Los cambios aplican a partir de la siguiente.

### 5.4 Desinstalación

```
uninstall():
  1. backup igual que en install (paso 6)
  2. para cada evento de cfg.hooks:
        filtrar entradas nuestras
        eliminar grupos que se queden sin hooks
        eliminar el array del evento si se queda vacío
     eliminar cfg.hooks si se queda como objeto vacío
  3. escritura atómica + verificación
  4. NO se borra ~/.claude/orbix/ (token y port son inocuos y facilitan reinstalar)
  5. devolver HookStatus { installed: false }
```

### 5.5 Detección de estado (`hook:getStatus`)

```
leer settings.json; para cada uno de los 9 eventos, buscar entrada nuestra
installed             = al menos 1 evento con entrada nuestra
events / missingEvents= listas correspondientes
scriptPath            = ~/.claude/orbix/hook.sh
scriptVersion         = leer la línea '# orbix-hook-version: N' del script instalado
foreignHooksPreserved = nº de entradas de comando NO nuestras en todo el objeto hooks
serverPort / serverListening = del EventServer
```

Se recalcula al abrir preferencias y cada vez que `chokidar` detecta un cambio en
`~/.claude/settings.json` (por si otro programa —o el propio Ismael— quita nuestro hook:
entonces se emite `app:notice` de nivel `warn`, pero **nunca se reinstala solo**).

---

## 6. Mapa evento → `PetState`

Enum completo y definitivo en `04-frontal.md` §4. Aquí, la resolución.

| # | Disparador | `PetState` | Prioridad | Duración mínima | Vuelta automática | Bocadillo | Sonido |
|---|---|---|---|---|---|---|---|
| 1 | `SessionStart` | `WAKING` | 40 | 1 500 ms | → `IDLE` a los 3 s | «Hola 👋 <proyecto>» | — |
| 2 | `UserPromptSubmit` | `THINKING` | 50 | 800 ms | → `IDLE` a los 90 s sin eventos | — | — |
| 3 | `PreToolUse` con `tool_name` de escritura | `CODING` | 50 | 800 ms | → `THINKING` a los 20 s | — | — |
| 4 | `PreToolUse` con `tool_name` de ejecución | `RUNNING` | 50 | 800 ms | → `THINKING` a los 20 s | — | — |
| 5 | `PreToolUse` con cualquier otra herramienta | `THINKING` | 45 | 500 ms | → `IDLE` a los 90 s | — | — |
| 6 | `PostToolUse` con error | `PUZZLED` | 65 | 2 000 ms | → `THINKING` a los 4 s | «Hmm… <herramienta> ha fallado» | — |
| 7 | `PostToolUse` sin error | *no cambia de estado* | — | — | — | — | — |
| 8 | `SubagentStop` | `SUBAGENT_DONE` | 55 | 1 500 ms | → `THINKING` a los 3 s | «Agente listo» | `blip` (si «sonidos de agente» activo; **off** por defecto) |
| 9 | `PreCompact` | `COMPACTING` | 60 | 2 000 ms | → `THINKING` a los 6 s | «Memoria llena, compactando…» | — |
| 10 | **`Notification`** | **`NEEDS_YOU`** | **100** | 4 000 ms | **no vuelve sola**: se queda hasta el siguiente evento de prioridad ≥ 50 | el `message` real, recortado a 120 caracteres; si viene vacío: «<proyecto> te necesita» | `attention` |
| 11 | **`Stop`** | **`DONE`** | **90** | 3 000 ms | → `IDLE` a los 15 s | «<proyecto> — listo» | `done` |
| 12 | `SessionEnd` | `SLEEPING` | 30 | 2 000 ms | permanece | — | — |
| 13 | Límite semanal cruza el 80 % hacia arriba | `WORRIED` | 85 | 4 000 ms | → estado anterior a los 8 s | «Semanal al <N> %» | — |
| 14 | Sin eventos durante 5 min estando en `IDLE` | `SLEEPING` | 15 | — | permanece | — | — |
| 15 | Arranque de la app | `IDLE` | 20 | — | — | — | — |

### 6.1 Clasificación de herramientas

```
ESCRITURA (→ CODING):   Edit  Write  NotebookEdit  MultiEdit  Update
EJECUCIÓN (→ RUNNING):  Bash  BashOutput  KillShell  KillBash
LECTURA/BÚSQUEDA:       Read Grep Glob WebFetch WebSearch Task TodoWrite  → regla 5
DESCONOCIDA:            cualquier otra, incluidas mcp__*                  → regla 5
```

La lista vive en `src/main/pet/tool-classes.ts` y el emparejamiento es **exacto y sin
distinguir mayúsculas**; una herramienta nueva cae en la regla 5 y no rompe nada.

### 6.2 Detección de error en `PostToolUse`

> **PUNTO ABIERTO C1.** La forma exacta de `tool_response` en el payload de `PostToolUse`
> no está verificada sobre esta versión de Claude Code (2.1.259). *Recomendación:*
> implementar la heurística tolerante de abajo y, en `devMode`, volcar los `PostToolUse`
> recibidos a `hook_events.raw_json` durante unos días para confirmarla y cerrar el punto.

```
esError(payload):
  r = payload.tool_response
  if r == null: return false
  if typeof r == 'object':
      if r.is_error === true or r.isError === true          -> true
      if typeof r.error == 'string' && r.error.length > 0    -> true
      if r.success === false                                 -> true
      if typeof r.exit_code == 'number' && r.exit_code != 0  -> true
      if typeof r.interrupted == 'boolean' && r.interrupted  -> false   # no es error
  if typeof r == 'string' && /^(error|<tool_use_error>)/i.test(r.trim()) -> true
  return false
```

Falso negativo (no detectar un error) es aceptable: la mascota simplemente no reacciona.
Falso positivo es peor: la mascota se pone `PUZZLED` sin motivo. Ante la duda, `false`.

### 6.3 Resolución de eventos que se pisan

La máquina de estados (`src/main/pet/state-machine.ts`) mantiene:

```ts
interface PetRuntime {
  state: PetState
  priority: number
  enteredAt: number          // ms epoch monotónico
  minUntil: number           // enteredAt + minDuration
  returnTo: PetState | null  // estado al que volver
  returnAt: number | null
  lastSessionId: string | null
  lastProjectName: string | null
}
```

**Algoritmo de admisión de un evento nuevo con prioridad `p` y estado `s`:**

```
now = performance.now()
efectiva = (now < rt.minUntil) ? rt.priority : 0     # la prioridad decae al cumplirse
                                                     # la duración mínima
si s == rt.state:
    # mismo estado repetido: no reiniciar la animación, solo alargar
    rt.returnAt = now + duracionDeVuelta(s)
    si el evento trae bocadillo -> encolar bocadillo
    return   # NO se emite pet:command salvo por el bocadillo

si p >= efectiva:
    aplicar(s, p)          # emite pet:command
si no:
    # el evento pierde, pero no se tira: se guarda como "pendiente"
    rt.pending = { s, p, bubble, expiresAt: now + 5000 }
    # al vencer minUntil, si pending sigue vigente, se aplica
```

Reglas adicionales, todas necesarias en la práctica:

- **Ráfagas de herramientas.** `PreToolUse` llega muchas veces por segundo en tandas de
  llamadas paralelas. Se aplica un **debounce de 250 ms**: dentro de la ventana solo se
  queda el de mayor prioridad, y si empatan, el último.
- **`NEEDS_YOU` es pegajoso.** Es el aviso que más importa. No vuelve solo a `IDLE`; se
  mantiene hasta que llegue un evento de prioridad ≥ 50 (típicamente el
  `UserPromptSubmit` de cuando el usuario contesta). Así, si el usuario está en otra
  pantalla, la mascota sigue reclamando cuando vuelve.
- **`DONE` no puede pisar a `NEEDS_YOU` reciente.** Prioridad 90 < 100 mientras dure el
  mínimo de 4 s; después sí, porque la prioridad efectiva decae.
- **`WORRIED` se dispara una sola vez por cruce.** Se guarda el último porcentaje visto; solo
  se emite al pasar de `<80` a `≥80`. Al bajar del 75 % (histéresis de 5 puntos) se rearma.
- **Multiproyecto.** Si llegan eventos de dos sesiones a la vez, **gana el más reciente** y
  el bocadillo siempre lleva el nombre de proyecto. No hay una mascota por proyecto.
- **App recién arrancada.** Los eventos que llegan en los primeros 2 s se procesan pero no
  producen sonido, para no chillar al iniciar sesión en el Mac.

### 6.4 Textos del bocadillo

Viven en `src/main/pet/phrases.ts`, en español, con variantes elegidas al azar para que no
canse. Uno por línea, `{p}` = nombre del proyecto, `{m}` = mensaje real, `{t}` = herramienta.

```
WAKING:        "Hola 👋 {p}"            "A trabajar en {p}"      "Aquí estamos, {p}"
DONE:          "{p} — listo"            "Terminado en {p}"       "Ya está, {p}"
NEEDS_YOU:     "{m}"                    (respaldo: "{p} te necesita")
PUZZLED:       "Hmm… {t} ha fallado"    "Algo ha petado en {t}"
COMPACTING:    "Memoria llena, compactando…"
SUBAGENT_DONE: "Agente listo"           "Subagente terminado"
WORRIED:       "Semanal al {n} %"       "Ojo, semanal al {n} %"
```

Regla: **el bocadillo de `NEEDS_YOU` nunca se sustituye por una frase inventada si hay
`message` real.** El mensaje de Claude Code es la información valiosa.

### 6.5 Contrato `PetCommand`

```ts
// src/shared/pet.ts
export interface PetCommand {
  state: PetState
  priority: number
  bubble?: { text: string; ms: number }   // ms ya resuelto con prefs.bubbleMs
  sound?: SoundId                          // ya filtrado por prefs (silencio, horas)
  intensity?: number                       // 0-1, para variar la animación
  sticky?: boolean                         // true solo en NEEDS_YOU
  issuedAt: string                         // ISO UTC
  seq: number                              // monótono, para descartar desorden
}
export type SoundId = 'attention' | 'done' | 'blip'
```

El renderer **descarta** cualquier `PetCommand` con `seq` menor que el último aplicado.
El filtrado por preferencias (silencio, horas de silencio, volumen 0, pantalla bloqueada)
se hace en `main`: si no debe sonar, `sound` simplemente no viene. El renderer no decide.

### 6.6 Persistencia

Todo evento recibido y validado se escribe en `hook_events` (§2 de `02-esquema-bd.md`),
**incluidos los que no producen cambio de estado** (`pet_state = NULL`). Sirve para depurar,
para el punto abierto C1 y para un futuro historial de avisos. La escritura es un `INSERT`
único fuera del camino de la respuesta HTTP.
</content>
</invoke>
