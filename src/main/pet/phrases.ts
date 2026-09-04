/**
 * miniClaudio — textos del bocadillo.
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
  [PetState.PUZZLED]: ['Hmm… {t} ha fallado', 'Algo ha petado en {t}'],
  [PetState.COMPACTING]: ['Memoria llena, compactando…'],
  [PetState.SUBAGENT_DONE]: ['Agente listo', 'Subagente terminado'],
  [PetState.WORRIED]: ['Semanal al {n} %', 'Ojo, semanal al {n} %']
})

/** Respaldo de `NEEDS_YOU` cuando Claude Code no manda `message`. */
export const NEEDS_YOU_FALLBACK = '{p} te necesita'

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
