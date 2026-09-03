# miniClaudio — 04. Diseño de frontal

> Especificación visual y de comportamiento. La implementa `frontend-dev`.
> Todo lo que aquí se dibuja se alimenta de los contratos de `01-arquitectura.md` §3.
> Fecha: 2026-09-03.

---

## 1. Principios

1. **La mascota es el canal de aviso.** No hay notificaciones del sistema. Si el usuario no
   la ve, no se entera: por eso el estado tiene que leerse **a un metro de distancia**, de
   un vistazo, sin fijar la vista.
2. **Discreta por defecto, evidente cuando toca.** En reposo casi no se nota (opacidad 0,85,
   respiración lenta). Cuando Claude te necesita, salta y suena.
3. **Nada de mentiras.** Un porcentaje de hace 7 días se muestra siempre con su antigüedad
   al lado. Un multiplicador calculado con 10 días de datos se marca como suelo.
4. **Cero CPU en reposo.** Ver §9. Es una app que vive 24/7 en la pantalla de alguien.
5. **El renderer no piensa.** Recibe `PetCommand` y lo dibuja. Toda decisión está en `main`.

---

## 2. Sistema visual

### 2.1 Paleta (tokens CSS en `src/renderer/shared/tokens.css`)

```css
:root {
  /* Mascota — naranja de la marca Claude */
  --mc-body:        #D97757;
  --mc-body-light:  #E89B7F;
  --mc-body-dark:   #B85C3E;
  --mc-ink:         #1F1B18;   /* ojos, cejas, boca */
  --mc-white:       #FFFFFF;   /* brillo de los ojos */
  --mc-sleep:       #7C8AA0;   /* tinte frío del estado dormida */

  /* Semántica */
  --mc-ok:          #5A9E6F;
  --mc-warn:        #E8A33D;
  --mc-crit:        #D14D41;
  --mc-muted:       #8A8580;

  /* Bocadillo */
  --mc-bubble-bg:   rgba(26, 24, 22, 0.94);
  --mc-bubble-fg:   #F5F0E8;
  --mc-bubble-edge: rgba(255, 255, 255, 0.10);

  /* Menubar (tema claro) */
  --ui-bg:          rgba(250, 249, 247, 0.80);
  --ui-surface:     #FFFFFF;
  --ui-border:      rgba(0, 0, 0, 0.08);
  --ui-fg:          #1F1B18;
  --ui-fg-dim:      #6B6560;
  --ui-accent:      #D97757;
}
@media (prefers-color-scheme: dark) {
  :root {
    --ui-bg:      rgba(30, 29, 27, 0.80);
    --ui-surface: #262523;
    --ui-border:  rgba(255, 255, 255, 0.10);
    --ui-fg:      #F5F0E8;
    --ui-fg-dim:  #A09A94;
  }
}
```

### 2.2 Tipografía

- Familia única: `-apple-system, "SF Pro Text", system-ui, sans-serif`. Ninguna webfont
  (peso, licencia y FOUT innecesarios).
- Cifras: **siempre** `font-variant-numeric: tabular-nums`. Sin esto, los números bailan al
  actualizarse cada 2 segundos y es insoportable.
- Escala del menubar: 11 / 12 / 13 / 17 / 28 px. `line-height` 1,35.
- Escala del bocadillo: 13 px, `font-weight: 500`.

### 2.3 Movimiento

- Todo el movimiento usa **solo `transform` y `opacity`** (compuestas por GPU). Prohibido
  animar `width`, `top`, `filter`, `box-shadow` o atributos SVG geométricos.
- Curvas: `--ease-out: cubic-bezier(0.16, 1, 0.3, 1)`,
  `--ease-soft: cubic-bezier(0.4, 0, 0.2, 1)`.
- Si `prefers-reduced-motion: reduce`: todas las animaciones cíclicas se desactivan; los
  cambios de estado se resuelven con un *cross-fade* de 150 ms. El bocadillo aparece sin
  desplazamiento.

---

## 3. Ventana de la mascota

### 3.1 Creación (`src/main/windows/pet.ts`)

```ts
new BrowserWindow({
  width: 320, height: 220,            // lógicos, a escala 1 (ver §3.3)
  transparent: true,
  frame: false,
  hasShadow: false,                   // la sombra del sistema delataría el rectángulo
  resizable: false, movable: false, minimizable: false, maximizable: false,
  fullscreenable: false, focusable: false,
  skipTaskbar: true,
  acceptFirstMouse: false,
  roundedCorners: false,
  backgroundColor: '#00000000',
  webPreferences: {
    preload: petPreload, sandbox: true, contextIsolation: true,
    nodeIntegration: false, backgroundThrottling: false,
  },
})
win.setAlwaysOnTop(true, 'screen-saver')          // por encima de apps a pantalla completa
win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
win.setHiddenInMissionControl(true)
win.setIgnoreMouseEvents(true, { forward: true })
win.setWindowButtonVisibility?.(false)
```

`backgroundThrottling: false` es necesario porque la ventana no tiene foco nunca y macOS
podría bajarla a 1 fps justo cuando tiene que saltar.

### 3.2 Posición y multi-pantalla

```
colocar():
  d = prefs.followActiveDisplay
        ? screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
        : (screen.getAllDisplays().find(x => x.id === prefs.displayId) ?? screen.getPrimaryDisplay())
  wa = d.workArea                       # respeta Dock y barra de menús
  M  = 16                               # margen
  W, H = tamaño de la ventana a la escala actual
  según prefs.corner:
    'bottom-right' -> x = wa.x + wa.width  - W - M ; y = wa.y + wa.height - H - M
    'bottom-left'  -> x = wa.x + M         ;         y = wa.y + wa.height - H - M
    'top-right'    -> x = wa.x + wa.width  - W - M ; y = wa.y + M
    'top-left'     -> x = wa.x + M         ;         y = wa.y + M
  win.setBounds({ x: round(x), y: round(y), width: W, height: H })
  push('pet:prefs', { ...visualPrefs, anchor: prefs.corner })
```

- Recolocar en: `display-added`, `display-removed`, `display-metrics-changed`,
  `powerMonitor.on('resume')`, cambio de `prefs.corner`/`petScale`, y —si
  `followActiveDisplay`— cuando el cursor cambia de pantalla (sondeo cada 2 s con
  `screen.getCursorScreenPoint()`, comparando solo el `display.id`; **no** un listener por
  movimiento del ratón).
- Si la pantalla guardada desaparece, se cae a la principal sin avisar.
- Nunca se guarda una posición absoluta en prefs: solo esquina + pantalla. Así un cambio de
  monitor nunca deja la mascota fuera de la vista.

### 3.3 Escala

`prefs.petScale` ∈ {0,75 · 1 · 1,25 · 1,5}. Se aplica en **dos** sitios:

- El tamaño de la ventana: `W = 320 * scale`, `H = 220 * scale`.
- El `<svg>` y el bocadillo, vía `--mc-scale` en `:root` del renderer.

No se usa `zoomFactor` de Electron: desdibuja el SVG y descoloca el hit-testing.

### 3.4 Anclaje interno del contenido

La ventana es un rectángulo de 320×220. Dentro:

```
 esquina 'bottom-right'                 esquina 'bottom-left'
 ┌──────────────────────────┐           ┌──────────────────────────┐
 │  ┌────────────────────┐  │           │  ┌────────────────────┐  │
 │  │     BOCADILLO      │◄─┤ 280 máx   │  ├─►     BOCADILLO     │  │
 │  └──────────────────▼─┘  │           │  └─▼──────────────────┘  │
 │                  ┌─────┐ │           │ ┌─────┐                  │
 │                  │ PET │ │ 128×128   │ │ PET │                  │
 │                  └─────┘ │           │ └─────┘                  │
 └──────────────────────────┘           └──────────────────────────┘
```

En las esquinas superiores todo se invierte verticalmente: la mascota arriba y el bocadillo
debajo, con el pico apuntando hacia arriba. El renderer recibe el ancla en `pet:prefs` y lo
aplica con `data-anchor="bottom-right"` en el `<body>`; el resto es CSS.

La mascota **mira hacia el centro de la pantalla**: `setFacing('left')` en las esquinas
derechas y `'right'` en las izquierdas. Se implementa con `transform: scaleX(-1)` sobre el
grupo del cuerpo (nunca sobre el texto).

### 3.5 Interacción

- Por defecto (`prefs.clickThrough === true`) la ventana es **completamente inerte**: los
  clics atraviesan a la app de debajo. Es lo que pide el plan.
- Con `prefs.clickThrough === false`, el renderer usa el patrón estándar de Electron:
  recibe `mousemove` gracias a `forward: true`, comprueba si el cursor está dentro del
  rectángulo del SVG y llama a `pet:setInteractive({ interactive })`. `main` responde con
  `setIgnoreMouseEvents(!interactive, { forward: true })`. Con la mascota interactiva:
  - clic simple → `pet:activate` → `main` abre el popover del menubar;
  - clic derecho → menú contextual nativo (Estadísticas, Preferencias, Silenciar, Salir).
- La mascota **nunca roba el foco** (`focusable: false`).

---

## 4. `PetRenderer` y `PetState`

`src/shared/pet.ts` — contrato cerrado, compartido con `main`.

```ts
export enum PetState {
  IDLE          = 'idle',
  WAKING        = 'waking',
  THINKING      = 'thinking',
  CODING        = 'coding',
  RUNNING       = 'running',
  PUZZLED       = 'puzzled',
  SUBAGENT_DONE = 'subagent_done',
  COMPACTING    = 'compacting',
  NEEDS_YOU     = 'needs_you',
  DONE          = 'done',
  SLEEPING      = 'sleeping',
  WORRIED       = 'worried',
}

export enum PetAnim {
  BLINK   = 'blink',
  BOUNCE  = 'bounce',
  SHAKE   = 'shake',
  WAVE    = 'wave',
  STRETCH = 'stretch',
  POP     = 'pop',
  NOD     = 'nod',
}

export interface PetRenderer {
  mount(root: HTMLElement): void
  setState(state: PetState, opts?: { intensity?: number }): void
  say(text: string, ms?: number): void
  play(anim: PetAnim): void
  setScale(scale: number): void
  setFacing(facing: 'left' | 'right'): void
  setReducedMotion(enabled: boolean): void
  destroy(): void
}
```

**Regla de oro del plan, formalizada:** el único módulo que conoce formas, colores, píxeles o
keyframes es la implementación de `PetRenderer`. `src/renderer/pet/main.ts` solo hace:

```
window.miniClaudio.onPetCommand(cmd => {
  if (cmd.seq <= lastSeq) return
  lastSeq = cmd.seq
  renderer.setState(cmd.state, { intensity: cmd.intensity })
  if (cmd.bubble) renderer.say(cmd.bubble.text, cmd.bubble.ms)
  if (cmd.sound)  sound.play(cmd.sound)
})
```

En F3, `SvgRenderer` se cambia por `SpriteRenderer` y esta línea no se toca.

---

## 5. Anatomía SVG de la mascota

### 5.1 Estructura (fija, la misma para los 12 estados)

`viewBox="0 0 200 200"`, `width/height` 128 px a escala 1. **Todos los `id` son contrato:**
las animaciones son CSS que selecciona por `id` bajo `[data-state]`.

```
<svg id="mc-pet" viewBox="0 0 200 200" data-state="idle" data-facing="left">
  <defs>
    <radialGradient id="mc-grad">           <!-- 0%: --mc-body-light  100%: --mc-body -->
    <clipPath id="mc-body-clip">            <!-- silueta del cuerpo, para el rubor -->
  </defs>

  <ellipse id="mc-shadow"  cx="100" cy="176" rx="46" ry="8"/>       <!-- negro 14% -->

  <g id="mc-rig">                            <!-- todo lo que se mueve como un bloque -->
    <g id="mc-arm-l"/>                       <!-- brazo izq.: cápsula r=7, largo 26 -->
    <g id="mc-arm-r"/>                       <!-- brazo der. -->

    <path id="mc-body"                       <!-- gota redondeada, ver 5.2 -->
          fill="url(#mc-grad)"/>

    <g id="mc-face">
      <g id="mc-eye-l">                      <!-- centro (78, 104) -->
        <ellipse class="eye-ball"  rx="9" ry="11"/>   <!-- --mc-ink -->
        <circle  class="eye-shine" r="3" cx="-3" cy="-4"/>  <!-- blanco 85% -->
        <rect    class="eye-lid"/>           <!-- párpado: se escala en Y al parpadear -->
      </g>
      <g id="mc-eye-r">                      <!-- centro (122, 104) -->
      <path id="mc-brow-l"/>                 <!-- ceja: oculta salvo en puzzled/worried -->
      <path id="mc-brow-r"/>
      <path id="mc-mouth"/>                  <!-- oculta salvo en done/waking/worried -->
    </g>
  </g>

  <g id="mc-fx">                             <!-- efectos; todos display:none por defecto -->
    <g id="fx-dots"/>    <!-- 3 círculos r=4 en (150,72) (164,72) (178,72) -->
    <g id="fx-keys"/>    <!-- 3 rectángulos 10x7 rx=2 bajo las manos -->
    <g id="fx-gear"/>    <!-- engranaje 8 dientes, r=14, centro (156,66) -->
    <g id="fx-sweat"/>   <!-- gota: path lágrima 10x14 en (146,74) -->
    <g id="fx-zzz"/>     <!-- 3 "Z" de 10/13/16 px en diagonal desde (140,72) -->
    <g id="fx-spark"/>   <!-- 4 destellos de 4 puntas alrededor de la cabeza -->
    <g id="fx-bang"/>    <!-- "!" de 22 px en (150,60), color --mc-crit -->
  </g>
</svg>
```

### 5.2 El cuerpo

Gota simétrica: base ancha y redondeada, cúpula más estrecha. Path exacto de referencia
(el implementador puede afinarlo, pero debe mantener las proporciones):

```
M 100 34
C 138 34 160 62 160 100
C 160 140 136 166 100 166
C 64 166 40 140 40 100
C 40 62 62 34 100 34
Z
```

Es decir: un óvalo de 120×132 centrado en (100, 100), ligeramente más ancho abajo. Encima,
un mechón: `path M 92 34 C 96 20 106 18 112 26 C 106 28 100 31 96 36 Z` en `--mc-body-dark`.

Los brazos son cápsulas (`rect rx=7 height=14 width=30`) ancladas en (44,124) y (156,124),
con `transform-origin` en el hombro. En reposo cuelgan a −80° / +80°; se animan girando.

**Sin boca en reposo.** La expresividad está en los ojos y en las cejas; una boca permanente
hace que todos los estados parezcan iguales. La boca solo aparece donde se indica.

---

## 6. Los doce estados

Formato de cada ficha: qué se ve · qué se anima · duración/ciclo.
`data-state` es el atributo que cambia; **nada más**.

| — | `IDLE` — reposo |
|---|---|
| Se ve | Cuerpo naranja completo. Ojos abiertos mirando al frente. Sin efectos. Opacidad global `prefs.petOpacityIdle` (0,85). |
| Anima | **Respiración**: `#mc-rig` `scale(1, 1)` → `scale(1.015, 0.985)` → vuelta, 4 s, `ease-soft`, infinita. **Parpadeo**: `.eye-lid scaleY(0)` → `1` → `0` en 140 ms, con `animation-delay` aleatorio y periodo 5,5 s (ojo derecho +40 ms para que no sea robótico). |
| Ciclo | Infinito, pero se **pausa** tras 5 min sin eventos (→ `SLEEPING`). |

| — | `WAKING` — despierta |
|---|---|
| Se ve | Igual que IDLE + boca sonriente (`#mc-mouth` arco de 24 px hacia arriba) + `#fx-spark` visible 600 ms + brazo derecho levantado. |
| Anima | `STRETCH`: `#mc-rig` `scaleY(0.9)` → `scaleY(1.12)` → `1`, 700 ms `ease-out`; a la vez, brazos giran a −140°/+140° y vuelven. Destellos: `opacity 0→1→0` + `scale 0.6→1.2`, 600 ms. |
| Ciclo | Una vez, 1 500 ms. Luego IDLE. |

| — | `THINKING` — pensando |
|---|---|
| Se ve | Ojos desplazados **arriba** (`#mc-face translateY(-5px)`, pupilas `translateY(-3px)`) y ligeramente hacia el lado contrario a la esquina. `#fx-dots` visible. |
| Anima | Los tres puntos suben y bajan 4 px en secuencia (`translateY`), 1 200 ms, desfase 0/150/300 ms, infinita. Respiración un 30 % más rápida (2,8 s). |
| Ciclo | Infinito mientras dure el estado. |

| — | `CODING` — picando código |
|---|---|
| Se ve | Cuerpo inclinado 4° hacia delante. Brazos hacia abajo-delante. `#fx-keys` visible bajo las manos. Ojos entornados (`.eye-lid scaleY(0.35)` fijo). |
| Anima | Brazos alternan ±10° cada 180 ms (`steps(2)` para que sea seco, no fluido: teclear no es un vaivén). Las tres teclas hacen `translateY(0→2px)` y `opacity 1→0.5` en secuencia, 540 ms, infinita. |
| Ciclo | Infinito. |

| — | `RUNNING` — ejecutando |
|---|---|
| Se ve | Cuerpo normal. `#fx-gear` visible junto a la cabeza, color `--mc-body-dark`. Ojos siguiendo al engranaje (pupilas `translateX(+4px)`). |
| Anima | Engranaje `rotate(0 → 360deg)`, 2 400 ms, `linear`, infinita. Rebote muy sutil del cuerpo, 1 200 ms. |
| Ciclo | Infinito. |

| — | `PUZZLED` — extrañada |
|---|---|
| Se ve | Ceja izquierda levantada (`#mc-brow-l` visible, `rotate(-18deg) translateY(-5px)`), ceja derecha visible plana. Ojo izquierdo un 15 % más grande. Boca en línea corta ondulada. |
| Anima | `NOD` lateral: cabeza (`#mc-face`) `rotate(0 → -6deg → 0)`, 900 ms. Una sola vez y se queda quieta. |
| Ciclo | Una vez. Estado se mantiene 4 s. |

| — | `SUBAGENT_DONE` — agente terminado |
|---|---|
| Se ve | Brazo del lado que mira levantado saludando. Boca sonriente pequeña. |
| Anima | `WAVE`: brazo `rotate(-150deg → -110deg → -150deg)` ×2, 800 ms, `ease-soft`. |
| Ciclo | Una vez. 1 500 ms. |

| — | `COMPACTING` — memoria llena |
|---|---|
| Se ve | `#fx-sweat` visible. Ojos entornados. Cuerpo levemente aplastado (`scaleY(0.96)`). |
| Anima | La gota de sudor: `translateY(0 → 16px)` + `opacity 1 → 0`, 1 400 ms, infinita. Cuerpo con un temblor de 1 px, 200 ms, infinita. |
| Ciclo | Infinito mientras dure el estado (máx. 6 s). |

| — | **`NEEDS_YOU` — te necesita** ⭐ |
|---|---|
| Se ve | Ojos **muy abiertos** (`ry` de 11 → 14), pupilas al frente. `#fx-bang` visible en rojo `--mc-crit`. Opacidad global **1,0** (sale del atenuado de reposo). Halo: `#mc-body` gana un `stroke` de 3 px `--mc-crit` a opacidad 0,5. |
| Anima | `BOUNCE`: `#mc-rig` `translateY(0 → -18px → 0)` con squash&stretch (`scale(0.94,1.06)` en el aire, `scale(1.08,0.92)` al caer), 520 ms, `ease-out`, **3 repeticiones** y luego cada 3 s mientras siga pegajoso. El `!` pulsa `scale(1 → 1.25 → 1)` a 700 ms, infinita. |
| Ciclo | **Pegajoso**: no vuelve solo. Ver `03-contrato-eventos.md` §6.3. |
| Sonido | `attention`. |

| — | **`DONE` — terminado** ⭐ |
|---|---|
| Se ve | Ojos en arco feliz (`.eye-ball` sustituido por `path` de arco `^ ^` mediante `data-state`), boca sonriente ancha, `#fx-spark` en verde `--mc-ok`. Opacidad 1,0. |
| Anima | `POP`: `scale(0.85 → 1.12 → 1)` en 420 ms `ease-out`, más un salto pequeño (`translateY -10px`). Destellos: aparecen escalando 0,4 → 1,1 y se desvanecen, 700 ms. |
| Ciclo | Una vez. Estado se mantiene 3 s, luego 15 s de "contento" (boca sonriente sobre IDLE) y vuelve a IDLE. |
| Sonido | `done`. |

| — | `SLEEPING` — dormida |
|---|---|
| Se ve | Ojos cerrados (dos arcos de 16 px hacia abajo). Cuerpo con un 25 % de mezcla hacia `--mc-sleep` (se consigue con un `<rect>` de ese color a opacidad 0,25 recortado con `#mc-body-clip`). `#fx-zzz` visible. Opacidad global 0,55. |
| Anima | Respiración lenta: 6 s, amplitud doble (`scale(1.03, 0.97)`). Las tres Z suben 14 px y se desvanecen en secuencia, 3 s, desfase 1 s, infinita. |
| Ciclo | Infinito, pero es el único ciclo que se permite en segundo plano indefinido (coste: 2 animaciones de transform, ver §9). |

| — | `WORRIED` — preocupada |
|---|---|
| Se ve | Ambas cejas visibles e inclinadas hacia dentro (`rotate(±14deg)`). Boca en línea recta corta. Rubor: dos elipses `--mc-crit` a opacidad 0,18 en las mejillas, recortadas por `#mc-body-clip`. Brazos subidos hacia la cabeza. |
| Anima | `SHAKE` lento: `rotate(-3deg → 3deg)`, 600 ms, 3 repeticiones. Después, quieta. |
| Ciclo | 8 s y vuelve al estado anterior. |

| — | `IDLE` tras `DONE` | Ver ficha de `DONE`. |

### 6.1 Transiciones entre estados

- Al cambiar `data-state`, los efectos entrantes hacen `opacity 0→1` + `scale 0.8→1` en
  180 ms; los salientes, lo inverso en 120 ms. Se consigue con dos clases
  (`.fx-in`, `.fx-out`) y un `transitionend`.
- Los estados con animación de una sola pasada (`WAKING`, `PUZZLED`, `SUBAGENT_DONE`,
  `DONE`, `WORRIED`) se reinician forzando *reflow* (`void el.offsetWidth`) antes de
  reasignar la clase, para que dos eventos seguidos vuelvan a animar.
- **Nunca hay dos estados a la vez.** `data-state` es un único valor.

---

## 7. Bocadillo

### 7.1 Aspecto

- Caja: `--mc-bubble-bg`, `border-radius: 14px`, borde de 1 px `--mc-bubble-edge`,
  `padding: 9px 13px`, `backdrop-filter: blur(12px)`.
- Texto: 13 px / 500, `--mc-bubble-fg`, `line-height: 1.35`, **máximo 3 líneas** con
  `-webkit-line-clamp: 3` y elipsis. Ancho máximo 280 px (a escala 1), mínimo 90 px.
- Pico: triángulo de 10×8 px del mismo color, apuntando a la cabeza de la mascota, pegado
  al borde del lado del ancla (16 px desde la esquina).
- El texto llega **ya recortado a 120 caracteres desde `main`**; el clamp visual es la
  segunda red de seguridad.

### 7.2 Comportamiento

| Aspecto | Valor |
|---|---|
| Entrada | `opacity 0→1` + `translateY(6px→0)` + `scale(0.96→1)`, 200 ms `ease-out` |
| Permanencia | `cmd.bubble.ms` (por defecto `prefs.bubbleMs` = 5 000 ms) |
| Salida | `opacity 1→0` + `translateY(0→-4px)`, 180 ms |
| Tiempo mínimo visible | **1 200 ms** — un bocadillo nunca se sustituye antes |
| Cola | Máximo **3** pendientes. Si llega un cuarto, se descarta el más antiguo de la cola (no el que se está mostrando) |
| Sustitución | Un bocadillo de un `PetCommand` con `priority ≥ 90` (`DONE`, `NEEDS_YOU`) **vacía la cola** y se muestra en cuanto el actual cumpla su mínimo de 1 200 ms |
| Repetido | Si el texto es idéntico al que se está mostrando, solo se reinicia el temporizador; no hay reanimación |
| Desactivado | Con `prefs.bubbleEnabled === false` no se muestra ninguno, pero el estado visual y el sonido siguen |

El bocadillo es un `<div>` HTML, no SVG: el texto en SVG no se ajusta ni se recorta.

---

## 8. Sonidos

### 8.1 Sin ficheros de audio

Los tres sonidos se **sintetizan con la Web Audio API** en `src/renderer/pet/sound.ts`.
Motivo: son tres pitidos de menos de 300 ms; un asset binario aporta peso, licencia y una
decisión de diseño sonoro que no tenemos. *Alternativa descartada:* WAV/AIFF en
`resources/sounds/` — se reconsidera en F3 junto con los sprites, cuando la mascota tenga
personalidad y merezca voz propia.

| `SoundId` | Cuándo | Receta |
|---|---|---|
| `done` | `Stop` | Dos notas `sine`: 1046,5 Hz (C6) y 1318,5 Hz (E6), 90 ms cada una, encadenadas sin silencio. Envolvente por nota: ataque 6 ms → sostenido 40 ms → caída 60 ms. Filtro `lowpass` a 4 000 Hz. Sensación: alegre y breve |
| `attention` | `Notification` | Tres notas `triangle`: 880 (A5) → 1108,7 (C#6) → 1318,5 (E6), 70 ms cada una con 25 ms de silencio entre ellas. Envolvente 4/30/50 ms. Filtro `lowpass` a 6 000 Hz. Sensación: llamada, sube, pide respuesta |
| `blip` | `SubagentStop` (desactivado por defecto) | Una nota `sine` a 1568 Hz (G6), 50 ms, ataque 3 ms, caída 40 ms, ganancia al 40 % del resto |

Cadena: `Oscillator → GainNode(envolvente) → BiquadFilter → GainNode(master) → destination`.
`masterGain = prefs.volume * 0.6`. El `AudioContext` se crea **una vez** y se deja
suspendido; se reanuda al primer `play()` y se vuelve a suspender 2 s después del último
sonido (un `AudioContext` activo mantiene despierto el subsistema de audio).

### 8.2 Cuándo NO suena

Todas estas comprobaciones se hacen en `main` (el renderer solo recibe o no recibe `sound`):

1. `prefs.soundEnabled === false` o `prefs.volume === 0`.
2. Dentro de `prefs.quietHours` (rango que puede cruzar la medianoche).
3. `prefs.muteWhenScreenLocked` y la pantalla está bloqueada
   (`powerMonitor.on('lock-screen')` / `'unlock-screen'`).
4. **Antirrepetición**: como máximo **un sonido cada 3 s**. Si dentro de la ventana llega
   otro de mayor jerarquía (`attention` > `done` > `blip`), se reemplaza el pendiente; si es
   de igual o menor, se descarta.
5. Durante los 2 primeros segundos de vida de la app.
6. Modo "no molestar" del sistema: **no se consulta.** No hay API pública fiable y no
   queremos silenciar por error el único canal de aviso que tiene el usuario.

Silencio rápido: en el menubar hay un interruptor **Silenciar** con las opciones
30 min / 2 h / hasta mañana / siempre. Escribe `prefs.soundEnabled` y un
`prefs.muteUntil` (ISO) que `main` respeta y limpia solo.

---

## 9. Presupuesto de rendimiento

Esta app está en pantalla mientras el Mac esté encendido. El presupuesto no es una
aspiración, es un requisito de aceptación.

| Situación | Objetivo | Cómo se consigue |
|---|---|---|
| `SLEEPING` o `IDLE` inactivo > 60 s | **0 % de CPU medida en Monitor de Actividad** para el proceso del renderer de la mascota | `animation-play-state: paused` sobre todo `#mc-pet` mediante la clase `.is-dormant`, que se pone con un `setTimeout` de 60 s sin comandos. El parpadeo se conserva pero pasa a periodo de 12 s |
| `IDLE` activo | < 1 % | Solo 2 animaciones CSS de `transform` (respiración + parpadeo), compuestas en GPU |
| Estados con ciclo (`THINKING`, `CODING`, `RUNNING`, `COMPACTING`) | < 3 % | Máximo **3 animaciones simultáneas**, todas de `transform`/`opacity` |
| Pico de transición | < 8 % durante < 700 ms | Animaciones de una pasada |

Reglas duras:

1. **Ningún `requestAnimationFrame` en bucle.** El único `rAF` permitido es el de un solo
   frame para forzar reflow al reiniciar una animación. Todo el movimiento es CSS.
2. **Ningún `setInterval` en el renderer de la mascota.** Solo `setTimeout` de un disparo
   (bocadillo, dormancia).
3. Techo de **30 fps**: todas las animaciones cíclicas usan periodos múltiplos de 33 ms y
   ningún keyframe intermedio innecesario. Se declara `will-change: transform` solo en
   `#mc-rig` y `#mc-fx` (nunca en más de 4 elementos: cada uno es una capa de GPU).
4. `#mc-pet` lleva `contain: layout paint style`.
5. **El menubar solo se refresca cuando está abierto.** Al cerrarse el popover, el renderer
   se da de baja de `stats:updated`. `main` deja de calcular snapshots si no hay ningún
   consumidor y el título del tray está desactivado.
6. `stats:updated` viene ya coalescido a 1 cada 2 s desde `main`; el renderer no debe
   añadir su propio *debounce*, pero sí **actualizar solo los nodos de texto cambiados**
   (comparación contra el último snapshot), no reconstruir el DOM.

Prueba de aceptación de QA: abrir la app, dejarla 10 minutos sin actividad de Claude Code,
y comprobar en Monitor de Actividad que el proceso del renderer de la mascota está en 0,0 %
y el `main` por debajo del 0,5 % (el ingestor despierta cada 3 s a hacer `stat`).

---

## 10. Menubar

### 10.1 Icono del Tray

- Imagen **plantilla** (`trayTemplate.png` 16×16 y `@2x` 32×32, negro puro + alfa), para que
  macOS la invierta sola en modo oscuro y al resaltar. Dibujo: la silueta de la mascota
  (gota con dos ojos calados).
- Título opcional al lado del icono (`prefs` → "Mostrar coste en la barra de menús",
  desactivado por defecto): el coste de hoy en formato corto, `$56` (sin decimales, sin
  separadores). Con `font-variant-numeric: tabular-nums` no aplica aquí; se usa
  `tray.setTitle(text, { fontType: 'monospacedDigit' })` para que no baile.
- **Estado en el icono:** cuando la mascota está en `NEEDS_YOU`, el título se sustituye por
  `●` en el color de acento durante todo el tiempo que dure el estado pegajoso. Es la única
  forma de enterarse si la mascota está oculta.
- Clic izquierdo → abre/cierra el popover. Clic derecho → menú nativo (Estadísticas,
  Preferencias, Silenciar, Ocultar mascota, Salir).

### 10.2 El popover

`BrowserWindow` de 340×(alto según contenido, máximo 620), `frame: false`,
`transparent: true`, `vibrancy: 'popover'`, `resizable: false`, `alwaysOnTop: true`,
`skipTaskbar: true`. Se posiciona bajo el icono del Tray con `tray.getBounds()`. Se cierra
con `blur`, con `Escape` y con un segundo clic en el icono.

### 10.3 Jerarquía de la información

**De un vistazo, sin desplegar nada** (lo que se ve en los primeros 200 px):

```
┌────────────────────────────────────────────┐
│ ● miniClaudio                     Max 20×  │  ← estado + plan
├────────────────────────────────────────────┤
│  SESIÓN ACTUAL · miniClaudio               │  ← 11px, mayúsculas, --ui-fg-dim
│  $12,84                        1,2 M tok   │  ← 28px / 12px
│  activa hace 2 min                         │  ← 11px, --ui-fg-dim
├────────────────────────────────────────────┤
│   HOY        7 DÍAS       30 DÍAS          │  ← 11px mayúsculas
│  $56,21      $214,60      $402,15          │  ← 17px, tabular
│  183 M tok   782 M tok    1.568 M tok      │  ← 11px dim
├────────────────────────────────────────────┤
│  6,1×  de tu plan Max 20×                  │  ← 28px acento + 12px
│  $402,15 en 30 días · $200/mes  (suelo)    │  ← 11px dim
├────────────────────────────────────────────┤
│  LÍMITES        actualizado hace 7 días ⚠  │
│  Ventana 5 h    ▓░░░░░░░░░░   0 %          │
│  Semanal total  ▓▓▓▓▓▓▓░░░░  63 %  ↺ dom 10:00│
│  Semanal · Opus ▓░░░░░░░░░░   3 %          │
├────────────────────────────────────────────┤
│  ▸ Por proyecto                            │  ← colapsados
│  ▸ Por modelo                              │
├────────────────────────────────────────────┤
│  Estadísticas   Preferencias        Salir  │
└────────────────────────────────────────────┘
```

**Al desplegar** `Por proyecto` / `Por modelo`: top 5 filas del periodo seleccionado
(selector de periodo Hoy/7d/30d encima, compartido por ambos bloques), cada fila con
nombre, barra proporcional del 0-100 % sobre el máximo, coste y tokens. Una sexta fila
"Otros (N)" agrupa el resto.

Pie: una línea de estado del ingestor de 11 px en `--ui-fg-dim`:
`184 ficheros · actualizado hace 3 s`. Durante el backfill, una barra de progreso fina.

### 10.4 Formato de cifras (`src/shared/format.ts`)

Locale fijo `es-ES`. **Ambas partes (menubar y stats) usan estas funciones; no se formatea
a mano en ningún sitio.**

```
formatCost(usd):
   usd === 0            -> '$0,00'
   0 < usd < 0.01       -> '<$0,01'
   resto                -> '$' + Intl.NumberFormat('es-ES',
                              { minimumFractionDigits: 2, maximumFractionDigits: 2 })
   # ejemplos: $166,74 · $1.178,15 · $12,84

formatCostShort(usd):   # solo para el título del tray
   < 10   -> '$' + 1 decimal      ('$8,3')
   >= 10  -> '$' + entero         ('$56')

formatTokens(n):
   n < 1000        -> entero                     ('586')
   n < 1e6         -> n/1e3 con 1 decimal + ' K' ('274,0 K')
   n >= 1e6        -> n/1e6 con separador de miles y 0 decimales + ' M'
                      salvo si n < 10e6, que lleva 2 decimales
   # ejemplos: 1,20 M · 183 M · 1.568 M
   # NO se usa 'B' ni 'G': en español confunden. Se escala hasta M y se
   # deja que el separador de miles haga el resto.

formatPercent(p):  Math.round(p) + ' %'          # espacio fino antes del %
formatMultiplier(x):
   x < 10  -> 1 decimal + '×'   ('6,1×')
   x >= 10 -> entero + '×'      ('14×')

formatAge(seconds):
   < 10        -> 'ahora mismo'
   < 60        -> 'hace {n} s'
   < 3600      -> 'hace {n} min'
   < 86400     -> 'hace {n} h'
   < 172800    -> 'ayer'
   resto       -> 'hace {n} días'

formatReset(iso):                                 # hora de reinicio del límite
   mismo día       -> '↺ hoy 10:00'
   día siguiente   -> '↺ mañana 10:00'
   dentro de 7 d   -> '↺ dom 10:00'   (día abreviado en minúsculas)
   resto           -> '↺ 12 sep 10:00'
```

### 10.5 Barras de límite

- Alto 6 px, `border-radius: 3px`, canal `--ui-border`, relleno del color de la severidad.
- Color por `severity`: `normal` → `--mc-ok`, `warning` → `--mc-warn`,
  `critical` → `--mc-crit`, `unknown` → `--ui-fg-dim`.
- El relleno **se anima** con una transición de 400 ms sobre `transform: scaleX()` (no sobre
  `width`).
- `isActive === false` → la fila entera baja a opacidad 0,55. Es un límite que ahora mismo
  no aplica.
- Junto al porcentaje, `formatReset(resetsAt)` en 11 px `--ui-fg-dim`. Si `resetsAt` es
  `null`, no se muestra nada (no se inventa).

**Antigüedad del dato — la parte que no se puede escatimar:**

| Estado | `ageSeconds` | Tratamiento visual |
|---|---|---|
| Fresco | ≤ 3 600 | Cabecera `LÍMITES` + `actualizado hace 12 min` en `--ui-fg-dim`. Barras a plena opacidad |
| Rancio (`stale`) | > 3 600 | Cabecera con `⚠ actualizado hace 4 h` en `--mc-warn`. Barras al 80 % de opacidad |
| Muy rancio (`veryStale`) | > 86 400 | Cabecera `⚠ dato de hace 7 días` en `--mc-warn` **y** una línea de 11 px bajo las barras: *«Claude Code no ha refrescado estos porcentajes desde entonces.»* Barras al 60 % de opacidad y los porcentajes en `--ui-fg-dim` en lugar del color de severidad |
| Sin dato (`source: 'none'`) | — | No se dibujan barras. En su lugar: *«Sin datos de límites todavía.»* |

Con `source: 'live'` (Nivel B activo y funcionando) se añade un punto verde y el texto
`en vivo · hace 1 min`, y aparece un botón de refrescar. Si el Nivel B está activado pero su
último resultado fue `failed`, **no se muestra ningún error en el menubar**: se vuelve a
pintar el Nivel A tal cual y el fallo solo se ve en Preferencias. Degradación silenciosa,
como manda el plan.

### 10.6 Estados de carga, error y vacío

Cada bloque del popover tiene sus tres estados definidos:

| Bloque | Cargando | Vacío | Error |
|---|---|---|---|
| Sesión actual | Esqueleto: barras grises de 28 px y 12 px con `opacity` pulsando 1,6 s | «Sin sesión activa» + última sesión conocida en gris | «No se pudo leer la sesión» + botón Reintentar |
| Periodos | Esqueleto de 3 columnas | Todo a `$0,00` / `0` (es un dato válido, no un vacío) | Misma fila con `—` y tooltip con el mensaje |
| Multiplicador | Esqueleto | Si `planMonthlyUsd === null`: «Plan no reconocido» + enlace a Preferencias para introducir el precio | `—` |
| Límites | Esqueleto de 3 barras | Ver `source: 'none'` arriba | Igual que vacío |
| Desglose | No se carga hasta desplegar; entonces esqueleto de 5 filas | «Sin actividad en este periodo» | Fila de error con Reintentar |
| Ingesta | «Analizando histórico… 34 %» + barra | — | «Error de ingesta» en `--mc-crit` + Reintentar |

**Primer arranque** (backfill en curso): el popover se abre mostrando el bloque de ingesta
arriba del todo con su barra de progreso, y el resto en esqueleto. Al terminar, transición
de 200 ms al contenido real.

### 10.7 Responsive

El popover tiene ancho fijo de 340 px: no hay *responsive* que valga. Lo que sí hay:

- **Altura adaptable** al contenido, con máximo del 70 % de la altura del `workArea` de la
  pantalla del Tray. Si se supera, el cuerpo hace scroll pero la cabecera y el pie quedan
  fijos.
- **Texto largo**: los nombres de proyecto se truncan con elipsis **por el principio**
  (`direction: rtl` + `text-overflow: ellipsis`), porque el final del nombre es lo que
  distingue (`…/sl-factoria-backend`).
- La ventana de estadísticas (F2) sí es redimensionable, mínimo 720×480.

---

## 11. Preferencias

Ventana normal de 520×620, no redimensionable, con pestañas de texto en la parte superior.

**Mascota**
- Mostrar mascota (interruptor)
- Esquina (cuatro botones con un diagrama de pantalla)
- Pantalla (desplegable + «seguir a la pantalla activa»)
- Tamaño (segmentado 0,75× / 1× / 1,25× / 1,5×) — con vista previa en vivo
- Opacidad en reposo (deslizador 35-100 %)
- Dejar pasar los clics (interruptor, activado)

**Avisos**
- Bocadillos (interruptor) + duración (deslizador 2-15 s)
- Sonido (interruptor) + volumen (deslizador)
- Sonido al terminar un subagente (interruptor, desactivado)
- Horas de silencio (interruptor + dos horas)
- Silenciar con la pantalla bloqueada (interruptor, activado)
- Estados detallados de herramientas (interruptor, activado) → instala/desinstala
  `PreToolUse` y `PostToolUse`

**Integración**
- Estado del hook: instalado/no instalado, eventos cubiertos, ruta del script, versión
- Botones **Instalar** / **Desinstalar** / **Reinstalar**
- Aviso en verde: *«Se han conservado N hooks de otros programas»* (el de ntfy y el de
  cerebro). Esto es importante para que Ismael confíe en el botón.
- Ruta del último backup de `settings.json`, con botón «Mostrar en el Finder»
- Servidor de eventos: puerto y estado

**Datos**
- Plan detectado (solo lectura) + precio mensual (editable si `detected === false`)
- Zona horaria (solo lectura, con botón «recalcular histórico» si se cambia)
- Tabla de precios por modelo, editable, con `valid_from` (F2)
- Nivel B: interruptor «Refrescar límites por mi cuenta», con el texto exacto:
  *«miniClaudio leerá tu token de Claude Code del llavero para consultar tu uso real. Usa
  una API interna no documentada: si deja de funcionar, se volverá al dato en caché sin
  avisar.»* Debajo, el último resultado y su error si lo hubo.
- Estado de la BD: ruta, tamaño, nº de peticiones, versión de esquema, botones
  «Reanalizar todo» y «Compactar base de datos»

**General**
- Abrir al iniciar sesión (F2)
- Mostrar coste en la barra de menús
- Versión, y un botón «Copiar diagnóstico» que copia al portapapeles `AppInfo` +
  `HookStatus` + `IngestStatus` (sin token, sin correo, sin rutas de proyecto)

---

## 12. Accesibilidad

- La ventana de la mascota es **puramente decorativa**: `aria-hidden="true"` en el SVG y
  `role="presentation"`. Un lector de pantalla no debe leerla en bucle.
- El bocadillo sí es contenido: `role="status"` + `aria-live="polite"` en su contenedor, para
  que VoiceOver lo anuncie una vez.
- El popover del menubar es navegable con teclado: `Tab` recorre los botones y los
  desplegables, `Escape` cierra, `Enter`/`Espacio` activa. Foco visible con un contorno de
  2 px `--ui-accent`.
- Contraste mínimo AA (4,5:1) para todo el texto del menubar. `--ui-fg-dim` sobre
  `--ui-surface` cumple; verificar tras cualquier cambio de paleta.
- `prefers-reduced-motion` respetado en toda la app (§2.3).
- Los estados de la mascota **nunca se distinguen solo por color**: cada uno tiene una forma
  o un efecto propio (`!`, engranaje, Z, gota, destellos).

---

## 13. Puntos abiertos del frontal

> **PUNTO ABIERTO D1 — Icono de la app (`icon.icns`) y del Tray.** Hacen falta los assets.
> *Recomendación:* generar el `icns` a partir del propio SVG de la mascota en estado `IDLE`
> sobre un fondo redondeado crema (`#F5F0E8`), con `iconutil`; y el `trayTemplate.png`
> exportando solo la silueta en negro a 16 y 32 px. Es media hora de trabajo y evita
> depender de un diseñador externo en F1.

> **PUNTO ABIERTO D2 — `setHiddenInMissionControl` y `'screen-saver'` sobre macOS 26.**
> El comportamiento de las ventanas siempre visibles ha cambiado en versiones recientes de
> macOS. *Recomendación:* verificarlo el primer día con una ventana de prueba (encima de una
> app a pantalla completa, en Mission Control y en un segundo Espacio) antes de construir
> nada encima. Si `'screen-saver'` resultara agresivo de más, el orden de preferencia es
> `'screen-saver'` → `'pop-up-menu'` → `'floating'`.

> **PUNTO ABIERTO D3 — Título del Tray con el coste.** Un `setTitle` que cambia cada pocos
> segundos ensancha y estrecha la barra de menús y es molesto. *Recomendación:* dejarlo
> desactivado por defecto (ya está así en el diseño) y, si se activa, actualizarlo como
> mucho **una vez por minuto**, nunca con cada `stats:updated`.
</content>
</invoke>
