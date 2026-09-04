/**
 * miniClaudio — tipo del puente expuesto por `preload` en los cuatro renderers.
 *
 * El puente es genérico (`MiniClaudioBridge` de `@shared/ipc`), pero la superficie
 * REAL de cada ventana es más estrecha: cada `src/preload/*.ts` lleva su propia
 * lista blanca de canales y rechaza en caliente cualquier otro.
 *
 * Para que eso también se note al compilar, cada renderer habla con su módulo
 * `api.ts`, que expone solo las llamadas que esa ventana tiene permitidas. Nadie
 * usa `window.miniClaudio` directamente fuera de `api.ts`.
 */

import type { MiniClaudioBridge } from '@shared/ipc'

declare global {
  interface Window {
    /** Puede no existir: en `npm run dev` sin `main`, los renderers caen a fixtures. */
    readonly miniClaudio?: MiniClaudioBridge
  }
}

export {}
