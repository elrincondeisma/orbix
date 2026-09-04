/**
 * miniClaudio — resolución de rutas de renderers y preloads.
 *
 * En desarrollo, `electron-vite` sirve los renderers por HTTP y deja los preloads
 * ya compilados en `out/preload`. En producción todo vive dentro del asar.
 *
 * La extensión del preload depende del formato de salida (`.cjs` con `sandbox: true`,
 * `.mjs`/`.js` en otro caso), así que se resuelve por existencia en lugar de darla
 * por supuesta: un preload que no carga deja la ventana muda y sin error visible.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

export type WindowId = 'pet' | 'menubar' | 'stats' | 'prefs'

const PRELOAD_EXTENSIONS = ['.cjs', '.js', '.mjs'] as const

function outDir(): string {
  return join(app.getAppPath(), 'out')
}

/** Ruta absoluta al script de preload de una ventana. */
export function preloadPath(id: WindowId): string {
  const base = join(outDir(), 'preload', id)
  for (const ext of PRELOAD_EXTENSIONS) {
    const candidate = base + ext
    if (existsSync(candidate)) return candidate
  }
  // Si no existe ninguno todavía (primer arranque de `dev`), se devuelve el más
  // probable: Electron avisará por consola y la ventana quedará sin puente.
  return `${base}.cjs`
}

/** URL de desarrollo o fichero de producción del HTML de una ventana. */
export function rendererTarget(id: WindowId): { url: string } | { file: string } {
  const devServer = process.env['ELECTRON_RENDERER_URL']
  if (devServer !== undefined && devServer !== '') {
    return { url: `${devServer}/${id}/index.html` }
  }
  return { file: join(outDir(), 'renderer', id, 'index.html') }
}

/** Carga el HTML correspondiente en un `BrowserWindow`. */
export function loadRenderer(
  win: { loadURL(url: string): Promise<void>; loadFile(file: string): Promise<void> },
  id: WindowId
): void {
  const target = rendererTarget(id)
  const promise = 'url' in target ? win.loadURL(target.url) : win.loadFile(target.file)
  promise.catch((error: unknown) => {
    console.error(`[windows] no se pudo cargar el renderer "${id}"`, error)
  })
}
