import { basename, resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import type { Plugin } from 'vite'

const shared = { '@shared': resolve('src/shared') }

/**
 * Los cuatro preloads corren con `sandbox: true` (01-arquitectura.md §3.1) y en el
 * sandbox de Electron `require()` solo resuelve unos pocos módulos internos: una
 * ruta relativa como `require('./common.cjs')` lanza «module not found» y el
 * preload muere EN SILENCIO, dejando `window.Orbix` sin definir.
 *
 * Como `common.ts` lo importan las cuatro entradas, Rollup lo saca por defecto a
 * un chunk compartido. Este plugin le da un id distinto por cada preload que lo
 * importa, de modo que se incrusta dentro de cada entrada y no queda ningún
 * `require` relativo en la salida.
 */
function selfContainedPreloads(): Plugin {
  const commonFile = resolve('src/preload/common.ts')
  return {
    name: 'orbix:self-contained-preloads',
    enforce: 'pre',
    resolveId(source, importer) {
      if (importer === undefined || source !== './common') return null
      const owner = basename(importer).replace(/\.ts$/, '')
      return `${commonFile}?owner=${owner}`
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: shared },
    build: { rollupOptions: { input: resolve('src/main/index.ts') } }
  },
  preload: {
    plugins: [externalizeDepsPlugin(), selfContainedPreloads()],
    resolve: { alias: shared },
    build: {
      rollupOptions: {
        input: {
          pet: resolve('src/preload/pet.ts'),
          menubar: resolve('src/preload/menubar.ts'),
          stats: resolve('src/preload/stats.ts'),
          prefs: resolve('src/preload/prefs.ts')
        },
        /*
         * Las cuatro ventanas corren con `sandbox: true` (01-arquitectura.md §3.1)
         * y Electron NO carga preloads ESM en un renderer aislado: tienen que ser
         * CommonJS. Con `"type": "module"` en package.json, el formato por defecto
         * de electron-vite es ESM (`.mjs`) y `window.Orbix` no llega a existir.
         * Verificado en Electron 37: sin esto, el puente queda `undefined`.
         */
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs',
          chunkFileNames: '[name].cjs'
        }
      }
    }
  },
  renderer: {
    root: 'src/renderer',
    resolve: { alias: shared },
    build: {
      rollupOptions: {
        input: {
          pet: resolve('src/renderer/pet/index.html'),
          menubar: resolve('src/renderer/menubar/index.html'),
          stats: resolve('src/renderer/stats/index.html'),
          prefs: resolve('src/renderer/prefs/index.html')
        }
      }
    }
  }
})
