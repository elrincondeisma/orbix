/**
 * miniClaudio — arranque al iniciar sesión.
 *
 * Regla que impone el diseño: **el estado que se enseña es el REAL del sistema**, nunca
 * una copia guardada en `prefs.json`. El usuario puede quitar el elemento de inicio desde
 * Ajustes del Sistema > General > Elementos de inicio sin que la app se entere, y una
 * copia local se quedaría mintiendo para siempre.
 *
 * Por eso `prefs.launchAtLogin` se rellena SIEMPRE leyendo `getLoginItemSettings()` antes
 * de responder, y lo que hay en `prefs.json` es solo el último valor conocido.
 */

import { app } from 'electron'

/**
 * ¿Se puede registrar el arranque automático?
 *
 * En desarrollo NO: `setLoginItemSettings` registraría el binario de Electron de
 * `node_modules`, dejando en los Elementos de inicio del usuario una entrada rota que
 * además arrancaría una copia de desarrollo en cada sesión. Se declara no disponible y
 * la interfaz puede deshabilitar el interruptor con una explicación.
 */
export function isLaunchAtLoginAvailable(): boolean {
  return process.platform === 'darwin' && app.isPackaged
}

/** Lee el estado REAL del sistema. Nunca lanza. */
export function getLaunchAtLogin(): boolean {
  if (process.platform !== 'darwin') return false
  try {
    return app.getLoginItemSettings().openAtLogin
  } catch {
    return false
  }
}

/**
 * Aplica el cambio y devuelve el estado REAL resultante, releyéndolo del sistema.
 *
 * Si macOS lo rechaza (permisos, perfil gestionado…), el valor devuelto no coincidirá con
 * el pedido y el interruptor de Preferencias volverá solo a su sitio. Es lo correcto:
 * más vale un interruptor que rebota que uno que miente.
 */
export function setLaunchAtLogin(enabled: boolean): boolean {
  if (!isLaunchAtLoginAvailable()) return getLaunchAtLogin()
  try {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      // Es una app de barra de menús: al arrancar con la sesión no debe robar el foco.
      openAsHidden: true
    })
  } catch {
    // Se ignora: lo que manda es lo que diga la relectura de abajo.
  }
  return getLaunchAtLogin()
}
