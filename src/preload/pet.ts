/**
 * Orbix — preload de la ventana de la mascota.
 *
 * Superficie mínima: la mascota solo dibuja. No consulta estadísticas ni preferencias;
 * `main` le empuja todo lo que necesita.
 *
 * Espejo en el renderer: `src/renderer/pet/api.ts`.
 */

import { exposeBridge } from './common'

exposeBridge(['pet:setInteractive', 'pet:activate'], ['pet:command', 'pet:prefs'])
