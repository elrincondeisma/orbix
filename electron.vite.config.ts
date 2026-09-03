import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

const shared = { '@shared': resolve('src/shared') }

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: shared },
    build: { rollupOptions: { input: resolve('src/main/index.ts') } }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: shared },
    build: {
      rollupOptions: {
        input: {
          pet: resolve('src/preload/pet.ts'),
          menubar: resolve('src/preload/menubar.ts'),
          stats: resolve('src/preload/stats.ts'),
          prefs: resolve('src/preload/prefs.ts')
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
