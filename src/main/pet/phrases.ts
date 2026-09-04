/**
 * Orbix — textos del bocadillo.
 *
 * Fuente de verdad: `docs/design/03-contrato-eventos.md` §6.4.
 * En español, con variantes elegidas al azar para que no canse.
 *
 * Marcadores: `{p}` nombre de proyecto · `{m}` mensaje real · `{t}` herramienta ·
 * `{n}` porcentaje.
 *
 * REGLA: el bocadillo de `NEEDS_YOU` **nunca** se sustituye por una frase inventada si
 * hay `message` real. El mensaje de Claude Code es la información valiosa.
 */

import { MAX_BUBBLE_LEN } from '@shared/constants'
import { PetState } from '@shared/pet'

/** Variantes por estado. Un estado sin entrada aquí simplemente no habla. */
export const PHRASES: Readonly<Partial<Record<PetState, readonly string[]>>> = Object.freeze({
  [PetState.WAKING]: ['Hola 👋 {p}', 'A trabajar en {p}', 'Aquí estamos, {p}'],
  [PetState.DONE]: ['{p} — listo', 'Terminado en {p}', 'Ya está, {p}'],
  [PetState.NEEDS_YOU]: ['{m}'],
  // CODING y RUNNING solo tienen una herramienta de verdad relevante cada uno
  // (escribir / ejecutar), así que un único verbo basta. THINKING es distinto:
  // agrupa lectura, búsqueda, coordinación de agentes y "acabo de recibir un
  // prompt", así que su texto se decide por herramienta en `phraseFor` — ver
  // `THINKING_VERBS` más abajo.
  [PetState.CODING]: ['{p}: escribiendo código…'],
  [PetState.RUNNING]: ['{p}: ejecutando comandos…'],
  [PetState.PUZZLED]: ['Hmm… {t} ha fallado', 'Algo ha petado en {t}'],
  [PetState.COMPACTING]: ['Memoria llena, compactando…'],
  // SUBAGENT_DONE: sin entrada a propósito, no habla. El tinte esmeralda y el
  // satélite dando la vuelta ya lo reflejan de forma ambiental; un subagente
  // terminando su turno no merece bocadillo (ver [[preferencia sobre ruido de
  // notificaciones]] — Ismael, 2026-09-04: solo NEEDS_YOU y DONE del agente
  // principal deben "avisar" de verdad).
  [PetState.WORRIED]: ['Semanal al {n} %', 'Ojo, semanal al {n} %']
})

/** Respaldo de `NEEDS_YOU` cuando Claude Code no manda `message`. */
export const NEEDS_YOU_FALLBACK = '{p} te necesita'

/**
 * Verbo de `THINKING` según la herramienta en curso (Ismael, 2026-09-04: quería
 * mensajes tipo «PROYECTO: inspeccionando código…», con la herramienta real detrás
 * del verbo, no un «pensando…» genérico todo el rato).
 *
 * Claves en minúscula, igual que `classifyTool` de `tool-classes.ts`. Sin entrada
 * (prompt recién recibido, o una herramienta desconocida/MCP) → `THINKING_FALLBACK`.
 */
const THINKING_VERBS: Readonly<Record<string, string>> = Object.freeze({
  read: 'inspeccionando código…',
  grep: 'buscando…',
  glob: 'buscando…',
  webfetch: 'buscando en la web…',
  websearch: 'buscando en la web…',
  task: 'coordinando un agente…',
  todowrite: 'actualizando tareas…'
})

const THINKING_FALLBACK = 'pensando…'

export interface PhraseVars {
  /** Nombre del proyecto. Siempre hay uno: `'Claude'` como último recurso. */
  project?: string
  /** Mensaje real de `Notification`. */
  message?: string | null
  /** Nombre de la herramienta que ha fallado. */
  tool?: string | null
  /** Porcentaje del límite semanal. */
  percent?: number | null
}

/** Elección aleatoria inyectable para que los tests sean deterministas. */
export type RandomFn = () => number

function fill(template: string, vars: PhraseVars): string {
  return template
    .replaceAll('{p}', vars.project ?? 'Claude')
    .replaceAll('{m}', vars.message ?? '')
    .replaceAll('{t}', vars.tool ?? 'la herramienta')
    .replaceAll('{n}', vars.percent === null || vars.percent === undefined
      ? '?'
      : String(Math.round(vars.percent)))
}

/**
 * Devuelve el texto del bocadillo para un estado, o `null` si ese estado no habla.
 * El resultado va siempre recortado a `MAX_BUBBLE_LEN` (120) caracteres.
 */
export function phraseFor(
  state: PetState,
  vars: PhraseVars = {},
  random: RandomFn = Math.random
): string | null {
  // NEEDS_YOU: el mensaje real manda; la frase inventada es solo el respaldo.
  if (state === PetState.NEEDS_YOU) {
    const real = (vars.message ?? '').trim()
    const text = real.length > 0 ? real : fill(NEEDS_YOU_FALLBACK, vars)
    return clip(text)
  }

  // THINKING: el verbo depende de qué herramienta lo disparó, no del estado en sí.
  if (state === PetState.THINKING) {
    const verb = vars.tool ? (THINKING_VERBS[vars.tool.toLowerCase()] ?? THINKING_FALLBACK) : THINKING_FALLBACK
    return clip(fill(`{p}: ${verb}`, vars))
  }

  const variants = PHRASES[state]
  if (!variants || variants.length === 0) return null
  const idx = Math.min(variants.length - 1, Math.max(0, Math.floor(random() * variants.length)))
  const template = variants[idx] ?? variants[0]
  if (template === undefined) return null
  const text = fill(template, vars).trim()
  return text.length > 0 ? clip(text) : null
}

function clip(text: string): string {
  return text.length <= MAX_BUBBLE_LEN ? text : `${text.slice(0, MAX_BUBBLE_LEN - 1)}…`
}
