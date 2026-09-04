/**
 * Orbix — hook `afterPack` de electron-builder.
 *
 * Descubierto el 2026-09-04 empaquetando el primer release público: el binario de
 * Electron llega ya firmado ad-hoc de fábrica, pero solo cubre el ejecutable
 * (`Sealed Resources=none`). electron-builder añade recursos después (icono, asar,
 * Info.plist) sin volver a sellar el conjunto, así que la firma queda a medias:
 * `spctl` la marca como "code has no resources but signature indicates they must be
 * present" — no "sin firmar", sino corrupta. Bajo cuarentena real (probado
 * instalando con Homebrew Cask) macOS no se limita a avisar: **borra la app entera**
 * en el primer arranque.
 *
 * Sin `identity` (punto abierto A1: sin Developer ID todavía), la única forma de que
 * quede una firma internamente consistente es volver a firmar ad-hoc el .app
 * COMPLETO después de que electron-builder termine de montarlo, antes de que lo
 * empaquete en el DMG. `--deep` cubre Frameworks/Helpers anidados.
 */

const { execFileSync, spawnSync } = require('node:child_process')
const { join } = require('node:path')

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return

  const appName = `${context.packager.appInfo.productFilename}.app`
  const appPath = join(context.appOutDir, appName)

  console.log(`[after-pack] firmando ad-hoc (consistente) ${appPath}`)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' })

  // `codesign -dv` escribe en stderr, no en stdout.
  const verify = spawnSync('codesign', ['-dv', appPath], { encoding: 'utf8' })
  const output = `${verify.stdout}${verify.stderr}`
  if (!output.includes('Sealed Resources')) {
    throw new Error('[after-pack] la re-firma no dejó recursos sellados: revisar a mano.')
  }
  console.log('[after-pack] recursos sellados correctamente.')
}
