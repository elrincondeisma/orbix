/**
 * Orbix — escritura de log garantizada.
 *
 * ⚠️ Existe por un motivo concreto y medido: `console.log`/`console.error` sobre un
 * **pipe** (que es lo que hay cuando alguien redirige la salida a un fichero, o cuando la
 * app la lanza un supervisor) escriben de forma ASÍNCRONA. Si justo después se sale con
 * `app.exit()` o `app.quit()`, el proceso muere antes de que se vacíe el búfer y el
 * mensaje se pierde — precisamente en los casos en los que ese mensaje es lo único que
 * queda para saber qué pasó.
 *
 * Regla: todo lo que se escriba **justo antes de terminar el proceso** va por aquí.
 */

import { writeSync } from 'node:fs'

/** Escribe una línea en stderr de forma síncrona. Nunca lanza. */
export function logSync(line: string): void {
  try {
    writeSync(2, `${line}\n`)
  } catch {
    // Si ni siquiera se puede escribir en stderr, no hay nada más que hacer.
  }
}

/** Varias líneas de una vez, con la misma garantía. */
export function logBlockSync(lines: readonly string[]): void {
  logSync(lines.join('\n'))
}
