/**
 * Orbix — superficie IPC de la ventana de la mascota.
 *
 * Espejo en tiempo de compilación de la lista blanca de `src/preload/pet.ts`.
 * Si se añade un canal aquí, hay que añadirlo allí (y al revés).
 */

import type { PetCommand } from '@shared/pet'
import type { PetVisualPrefs } from '@shared/types'

/**
 * Lo que `main` empuja por `pet:prefs`.
 *
 * DESVIACIÓN DEL CONTRATO (reportada): `01-arquitectura.md` §3.3 declara el payload
 * como `PetVisualPrefs`, pero el pseudocódigo de `04-frontal.md` §3.2 envía
 * `{ ...visualPrefs, anchor: prefs.corner }`. Además el renderer necesita
 * `clickThrough` para saber si debe hacer hit-testing (§3.5) y tampoco está en
 * `PetVisualPrefs`. Aquí se leen como opcionales y con valor por defecto seguro.
 */
export type PetPrefsPush = PetVisualPrefs & {
  anchor?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
  clickThrough?: boolean
}

function bridge(): NonNullable<Window['Orbix']> | null {
  return window.Orbix ?? null
}

export function onPetCommand(cb: (cmd: PetCommand) => void): () => void {
  return bridge()?.on('pet:command', cb) ?? ((): void => {})
}

export function onPetPrefs(cb: (prefs: PetPrefsPush) => void): () => void {
  return bridge()?.on('pet:prefs', (payload) => cb(payload as PetPrefsPush)) ?? ((): void => {})
}

/** Solo se llama con `prefs.clickThrough === false` (§3.5). */
export function setInteractive(interactive: boolean): void {
  void bridge()?.invoke('pet:setInteractive', { interactive })
}

/** Clic sobre la mascota: `main` abre el popover del menubar. */
export function activate(): void {
  void bridge()?.invoke('pet:activate', undefined)
}
