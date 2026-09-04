import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

/**
 * Configuración de los tests unitarios.
 *
 * Existe aparte de `electron.vite.config.ts` porque vitest no lee esa configuración ni
 * las rutas (`paths`) de los tsconfig: el alias `@shared` hay que declararlo aquí.
 */
export default defineConfig({
  resolve: {
    alias: { '@shared': resolve(__dirname, 'src/shared') }
  },
  test: {
    environment: 'node',
    // tests/integration solo corre con MINICLAUDIO_REAL=1 (usa ~/.claude real)
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    // Los tests del servidor HTTP y del instalador tocan puertos y ficheros temporales.
    fileParallelism: false,
    testTimeout: 15_000
  }
})
