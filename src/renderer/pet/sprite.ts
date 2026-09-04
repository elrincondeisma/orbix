/**
 * miniClaudio — arte de la mascota: núcleo de IA.
 *
 * Fuente: `resources/pet/` (arte definitivo de Ismael, ya recortado y alineado).
 * Metadatos y ciclo de reposo: `resources/pet/frames.json`.
 *
 * Este fichero, `sprite.css` y `SpriteRenderer.ts` son los ÚNICOS que conocen
 * formas, colores y píxeles. Todo lo demás habla en `PetState` / `PetAnim`.
 *
 * GEOMETRÍA MEDIDA sobre el PNG de 160×160 (centroide ponderado por luz y perfil
 * radial del alfa):
 *   - centro del orbe: (79, 77)
 *   - disco sólido:    r ≈ 54
 *   - órbitas y partículas: hasta r ≈ 78; nada más allá
 * La capa de efectos usa ese mismo sistema de coordenadas.
 */

import coreA1x from '../../../resources/pet/core-a.png'
import coreA2x from '../../../resources/pet/core-a@2x.png'
import coreA3x from '../../../resources/pet/core-a@3x.png'
import coreB1x from '../../../resources/pet/core-b.png'
import coreB2x from '../../../resources/pet/core-b@2x.png'
import coreB3x from '../../../resources/pet/core-b@3x.png'
import coreC1x from '../../../resources/pet/core-c.png'
import coreC2x from '../../../resources/pet/core-c@2x.png'
import coreC3x from '../../../resources/pet/core-c@3x.png'
import corePeak1x from '../../../resources/pet/core-peak.png'
import corePeak2x from '../../../resources/pet/core-peak@2x.png'
import corePeak3x from '../../../resources/pet/core-peak@3x.png'

export type FrameId = 'a' | 'b' | 'c' | 'peak'

/** Las tres escalas de cada frame. Se elige una por `devicePixelRatio`. */
const FRAMES: Readonly<Record<FrameId, readonly [string, string, string]>> = Object.freeze({
  a: [coreA1x, coreA2x, coreA3x],
  b: [coreB1x, coreB2x, coreB3x],
  c: [coreC1x, coreC2x, coreC3x],
  peak: [corePeak1x, corePeak2x, corePeak3x]
})

/** Tamaño lógico de la mascota en pantalla, a escala 1. */
export const PET_SIZE = 160

/** Lado del viewBox de la capa de efectos: 1 unidad = 1 px lógico a escala 1. */
export const FX_BOX = 160

/** Centro del orbe dentro del encuadre. */
export const ORB = { x: 79, y: 77 } as const

/** URL del frame en la escala más adecuada para la pantalla actual. */
export function frameUrl(id: FrameId, dpr: number): string {
  const scales = FRAMES[id]
  if (dpr > 2) return scales[2]
  if (dpr > 1) return scales[1]
  return scales[0]
}

/** Rombo (partícula de la familia del arte) centrado en (cx, cy). */
function diamond(cx: number, cy: number, r: number): string {
  return `M ${cx} ${cy - r} L ${cx + r} ${cy} L ${cx} ${cy + r} L ${cx - r} ${cy} Z`
}

/** Cruz fina, la otra partícula del arte. */
function cross(cx: number, cy: number, r: number): string {
  return `M ${cx - r} ${cy} L ${cx + r} ${cy} M ${cx} ${cy - r} L ${cx} ${cy + r}`
}

/** Marcas radiales del aro de alerta. */
function ticks(r: number, len: number): string {
  let out = ''
  for (let i = 0; i < 4; i++) {
    out +=
      `<path class="tick" d="M ${ORB.x} ${ORB.y - r} L ${ORB.x} ${ORB.y - r - len}"` +
      ` transform="rotate(${45 + i * 90} ${ORB.x} ${ORB.y})"/>`
  }
  return out
}

/**
 * Capa de efectos superpuesta al PNG.
 *
 * NO la afecta el tinte del núcleo: cada estado le da su propio `color` y todos
 * los trazos usan `currentColor`, para que el aro de alerta siga siendo ámbar
 * aunque el núcleo esté a medio camino de otro tono.
 *
 * Familia visual: trazo fino, geometría simple (anillos, cuadraditos, cruces,
 * rombos) y los mismos azules del arte salvo cuando el estado pide otro color.
 */
export const FX_SVG = `
<svg id="mc-fx" viewBox="0 0 ${FX_BOX} ${FX_BOX}" xmlns="http://www.w3.org/2000/svg"
     aria-hidden="true" role="presentation" focusable="false">

  <!-- NEEDS_YOU · aro de alerta girando -->
  <g id="fx-alert">
    <g class="spin">
      <circle class="ring-dashed" cx="${ORB.x}" cy="${ORB.y}" r="70"/>
      ${ticks(70, 6)}
    </g>
  </g>

  <!-- DONE · chispas ascendentes -->
  <g id="fx-sparks">
    <path class="spark spark-1" d="${diamond(46, 112, 4)}"/>
    <path class="spark spark-2" d="${diamond(70, 122, 5.5)}"/>
    <path class="spark spark-3" d="${diamond(96, 118, 4)}"/>
    <path class="spark spark-4" d="${diamond(118, 108, 5)}"/>
    <path class="spark spark-5" d="${diamond(60, 104, 3)}"/>
  </g>

  <!-- PUZZLED · satélite descolgado y órbita rota -->
  <g id="fx-loose">
    <path class="arc-broken" d="M 12 62 A 70 70 0 0 1 62 10"/>
    <g class="faller">
      <circle class="sat-ring" cx="126" cy="34" r="7.5"/>
      <circle class="sat-dot" cx="126" cy="34" r="2.6"/>
    </g>
  </g>

  <!-- THINKING · órbita extra con su punto -->
  <g id="fx-orbit">
    <g class="spin">
      <ellipse class="orbit-line" cx="${ORB.x}" cy="${ORB.y}" rx="75" ry="26"/>
      <circle class="orbit-dot" cx="${ORB.x + 75}" cy="${ORB.y}" r="3.4"/>
    </g>
  </g>

  <!-- SLEEPING · partículas caídas -->
  <g id="fx-fallen">
    <path class="settled s-1" d="${diamond(38, 142, 3.5)}"/>
    <path class="settled s-2" d="${diamond(56, 147, 2.8)}"/>
    <path class="settled s-3" d="${diamond(104, 146, 3.2)}"/>
    <path class="settled s-4" d="${diamond(124, 140, 2.6)}"/>
    <path class="dropping d-1" d="${diamond(70, 30, 3)}"/>
    <path class="dropping d-2" d="${diamond(112, 22, 2.6)}"/>
  </g>

  <!-- CODING · bits en secuencia -->
  <g id="fx-bits">
    <rect class="bit bit-1" x="34" y="132" width="9" height="9" rx="1.5"/>
    <rect class="bit bit-2" x="50" y="132" width="9" height="9" rx="1.5"/>
    <rect class="bit bit-3" x="66" y="132" width="9" height="9" rx="1.5"/>
    <path class="bit-cross" d="${cross(92, 136, 5)}"/>
  </g>

  <!-- RUNNING · anillo de proceso -->
  <g id="fx-progress">
    <g class="spin">
      <circle class="ring-progress" cx="${ORB.x}" cy="${ORB.y}" r="66"/>
    </g>
  </g>

  <!-- COMPACTING · partículas convergiendo -->
  <g id="fx-implode">
    <path class="imp imp-1" d="${diamond(ORB.x, ORB.y - 74, 4)}"/>
    <path class="imp imp-2" d="${diamond(ORB.x + 74, ORB.y, 4)}"/>
    <path class="imp imp-3" d="${diamond(ORB.x, ORB.y + 74, 4)}"/>
    <path class="imp imp-4" d="${diamond(ORB.x - 74, ORB.y, 4)}"/>
  </g>

  <!-- WAKING · onda de encendido -->
  <g id="fx-wave">
    <circle class="wave wave-1" cx="${ORB.x}" cy="${ORB.y}" r="40"/>
    <circle class="wave wave-2" cx="${ORB.x}" cy="${ORB.y}" r="40"/>
  </g>

  <!-- SUBAGENT_DONE · satélite dando una vuelta -->
  <g id="fx-lap">
    <g class="spin">
      <circle class="sat-ring" cx="${ORB.x + 72}" cy="${ORB.y}" r="7"/>
      <circle class="sat-dot" cx="${ORB.x + 72}" cy="${ORB.y}" r="2.4"/>
    </g>
  </g>

  <!-- WORRIED · arco de aviso y partículas inestables -->
  <g id="fx-warn">
    <circle class="ring-warn" cx="${ORB.x}" cy="${ORB.y}" r="68"/>
    <path class="jitter j-1" d="${cross(24, 46, 5)}"/>
    <path class="jitter j-2" d="${cross(134, 104, 5)}"/>
  </g>
</svg>
`.trim()
