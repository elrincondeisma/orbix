/**
 * Orbix — errores fatales de arranque.
 *
 * ⚠️ BUG-1. Una app de barra de menús que falla al arrancar es **invisible**: no tiene
 * ventana, no tiene icono en el Dock y, si nadie lo remedia, se queda como proceso zombi
 * ocupando el lock de instancia única, sin contar nada y sin forma de cerrarla salvo el
 * Monitor de Actividad.
 *
 * Regla: si el arranque falla, el usuario **lo ve** (diálogo nativo) y el proceso **se
 * muere**. Nunca se queda a medias.
 */

import { BrowserWindow, app, dialog, shell } from 'electron'

import { logSync } from './log'

export type FatalKind =
  | 'DB_CORRUPT'
  | 'DB_INCOMPATIBLE'
  | 'DB_LOCKED'
  | 'DB_PERMISSION'
  | 'NATIVE_ABI'
  | 'MIGRATION'
  | 'UNKNOWN'

export interface FatalDescription {
  kind: FatalKind
  /** Titular corto, en lenguaje de persona. */
  message: string
  /** Qué puede hacer el usuario. */
  detail: string
  /** Fichero que conviene enseñarle en el Finder, si lo hay. */
  revealPath?: string
}

function text(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

/**
 * Traduce el error técnico a algo accionable. Los casos cubiertos son los plausibles de
 * verdad: base de datos corrupta (corte de luz con el WAL abierto), `userData` sin
 * permiso de escritura, módulo nativo compilado para otro ABI y migración fallida.
 */
export function describeFatal(error: unknown, dbPath: string): FatalDescription {
  const raw = text(error)
  const code = (error as NodeJS.ErrnoException | undefined)?.code

  if (/not a database|malformed|file is encrypted|corrupt/i.test(raw)) {
    return {
      kind: 'DB_CORRUPT',
      message: 'La base de datos de Orbix está dañada.',
      detail:
        'No se ha podido abrir el fichero de datos, probablemente por un cierre brusco ' +
        'del ordenador.\n\nSi lo mueves de sitio y vuelves a abrir Orbix, se creará ' +
        'uno nuevo y se reconstruirá lo que quede en los transcripts de Claude Code.\n\n' +
        'OJO: Claude Code borra sus transcripts a los 30 días, así que lo anterior a eso ' +
        'NO se recupera (salvo lo que traiga el snapshot de rescate). Muévelo en vez de ' +
        `borrarlo: es la única copia que hay de tu histórico.\n\n${dbPath}\n\n${raw}`,
      revealPath: dbPath
    }
  }

  if (/NODE_MODULE_VERSION|ERR_DLOPEN_FAILED|was compiled against a different/i.test(raw)) {
    return {
      kind: 'NATIVE_ABI',
      message: 'Orbix no puede cargar su motor de base de datos.',
      detail:
        'El módulo nativo `better-sqlite3` está compilado para otra versión de Node o de ' +
        'Electron.\n\nSi has instalado la app desde el DMG, reinstálala. Si estás en ' +
        `desarrollo, ejecuta \`npm run rebuild:electron\`.\n\n${raw}`
    }
  }

  if (/no such table|no such column/i.test(raw)) {
    return {
      kind: 'DB_INCOMPATIBLE',
      message: 'La base de datos de Orbix no tiene la forma esperada.',
      detail:
        'El fichero de datos existe pero le faltan tablas: puede venir de otra aplicación ' +
        'o de una versión incompatible.\n\nMuévelo de sitio y vuelve a abrir Orbix ' +
        `para empezar de cero.\n\n${dbPath}\n\n${raw}`,
      revealPath: dbPath
    }
  }

  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS' || /SQLITE_READONLY/i.test(raw)) {
    return {
      kind: 'DB_PERMISSION',
      message: 'Orbix no tiene permiso para escribir sus datos.',
      detail:
        'No se ha podido escribir en la carpeta de datos de la aplicación.\n\nRevisa los ' +
        `permisos de esta carpeta o de sus ficheros.\n\n${dbPath}\n\n${raw}`,
      revealPath: dbPath
    }
  }

  if (/SQLITE_BUSY|database is locked/i.test(raw)) {
    return {
      kind: 'DB_LOCKED',
      message: 'La base de datos de Orbix está bloqueada por otro proceso.',
      detail:
        'Puede que haya quedado una copia anterior de Orbix abierta.\n\nCiérrala ' +
        `desde el Monitor de Actividad y vuelve a intentarlo.\n\n${raw}`
    }
  }

  if (/migraci|migration/i.test(raw)) {
    return {
      kind: 'MIGRATION',
      message: 'Orbix no ha podido actualizar su base de datos.',
      detail:
        'La migración del esquema ha fallado y no se ha aplicado ningún cambio (es ' +
        'transaccional: tus datos siguen como estaban).\n\nSi el problema persiste, mueve ' +
        `el fichero de datos de sitio para empezar de cero.\n\n${dbPath}\n\n${raw}`,
      revealPath: dbPath
    }
  }

  return {
    kind: 'UNKNOWN',
    message: 'Orbix no ha podido arrancar.',
    detail: `Se ha producido un error inesperado durante el arranque.\n\n${raw}`
  }
}

let alreadyFatal = false

/**
 * Tope de vida del diálogo. Pasado esto se sale igualmente.
 *
 * No es por impaciencia: es para que el proceso NUNCA sobreviva a la atención del
 * usuario. Con el autoarranque activado y una base de datos corrupta, esto ocurriría en
 * cada inicio de sesión, y un proceso vivo indefinidamente esperando un clic que nadie
 * va a dar es exactamente el zombi que se arregló en el BUG-1.
 */
const DIALOG_TIMEOUT_MS = 120_000

/** Permite a QA comprobar la guillotina sin esperar dos minutos. */
function dialogTimeoutMs(): number {
  const raw = Number(process.env['ORBIX_DIALOG_TIMEOUT_MS'])
  return Number.isFinite(raw) && raw > 0 ? raw : DIALOG_TIMEOUT_MS
}

/**
 * Deja el proceso en primer plano para que la alerta sea IMPOSIBLE de no ver.
 *
 * ⚠️ `app.dock.hide()` se ejecuta antes que `bootstrap()`, así que al fallar el arranque
 * no hay icono ni en el Dock ni en la barra de menús: si la alerta no se trae al frente
 * sola (arranque al iniciar sesión, otro Espacio, una app a pantalla completa), el
 * usuario no ve absolutamente nada.
 */
function bringToFront(): void {
  try {
    // Devuelve una promesa en macOS; no hace falta esperarla.
    void app.dock?.show()
  } catch {
    // Sin Dock (o fuera de macOS): seguimos, el `focus` puede bastar.
  }
  try {
    app.focus({ steal: true })
  } catch {
    // Si no se puede robar el foco, el diálogo saldrá igual, solo que quizá detrás.
  }
}

/**
 * Ventana anfitriona de la alerta.
 *
 * ⚠️ Esto NO es decorativo: es lo que hace que el proceso siga siendo matable.
 *
 * Un `dialog.showMessageBox` SIN ventana padre abre un `NSAlert` de aplicación que se
 * queda con el bucle de eventos del hilo principal. Medido: con esa forma no corre ni un
 * `setTimeout`, y ni `app.exit()`, ni `process.exit()`, ni `process.kill(SIGKILL)` desde
 * un manejador de señal consiguen terminar el proceso; solo un `SIGKILL` desde fuera. Es
 * decir, el zombi del BUG-1 otra vez, y encima capaz de colgar el cierre de sesión.
 *
 * Con ventana padre la alerta pasa a ser una lámina (sheet) colgada de la ventana, el
 * bucle de eventos sigue corriendo y todo lo demás —temporizador de seguridad, señales,
 * salida ordenada— vuelve a funcionar. Verificado con las dos variantes.
 */
function createHostWindow(message: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 460,
    height: 160,
    center: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    title: 'Orbix',
    backgroundColor: '#1f1b18',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
  })

  const html = `<!doctype html><meta charset="utf-8">
<style>
  html,body{margin:0;height:100%;font:13px -apple-system,system-ui,sans-serif;
    background:#1f1b18;color:#f5f0e8;display:flex;align-items:center;
    justify-content:center;text-align:center;-webkit-user-select:none}
  div{padding:0 24px;line-height:1.45}
  strong{display:block;font-size:15px;margin-bottom:6px;color:#d97757}
</style>
<div><strong>Orbix</strong>${escapeHtml(message)}</div>`
  void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)

  win.setAlwaysOnTop(true, 'modal-panel')
  win.show()
  win.focus()
  return win
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/**
 * Se sale al recibir una señal en vez de ignorarla.
 *
 * Con el diálogo síncrono el hilo principal quedaba bloqueado y el proceso no atendía
 * `SIGTERM` ni `SIGINT`: solo moría con `SIGKILL`, y de paso podía colgar el cierre de
 * sesión o el reinicio de macOS. Con el diálogo asíncrono el bucle de eventos sigue
 * vivo y estos manejadores se ejecutan de verdad.
 */
function exitOnSignals(): void {
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    try {
      process.once(signal, () => {
        logSync(`[arranque] ${signal} recibida con la alerta abierta: se sale`)
        app.exit(1)
      })
    } catch {
      // Plataforma sin esa señal: nada que hacer.
    }
  }
}

/**
 * Enseña el error y mata el proceso. Es idempotente: un segundo fallo mientras se está
 * gestionando el primero no abre dos diálogos ni entra en bucle.
 *
 * No bloquea el hilo principal: el diálogo es asíncrono a propósito, para que sigan
 * corriendo el temporizador de seguridad y los manejadores de señal.
 */
export function fatal(error: unknown, dbPath: string, scope = 'arranque'): void {
  if (alreadyFatal) return
  alreadyFatal = true

  const info = describeFatal(error, dbPath)
  // Al log siempre, con la traza entera: es lo que se pega en un informe de fallo.
  logSync(`[${scope}] FATAL (${info.kind}) ${info.message}`)
  logSync(error instanceof Error && error.stack !== undefined ? error.stack : text(error))

  // Escotilla para QA automatizado y CI: comprobar la SALIDA sin una persona delante.
  if (process.env['ORBIX_NO_DIALOG'] === '1') {
    app.exit(1)
    return
  }

  exitOnSignals()

  // Red de seguridad: pase lo que pase con la alerta, este proceso se muere.
  const guillotine = setTimeout(() => {
    logSync('[arranque] nadie ha atendido la alerta: se sale por tiempo')
    app.exit(1)
  }, dialogTimeoutMs())

  bringToFront()

  const buttons = info.revealPath === undefined ? ['Salir'] : ['Salir', 'Mostrar en el Finder']

  let host: BrowserWindow | null = null
  try {
    host = createHostWindow(info.message)
    // Cerrar la ventana equivale a pulsar «Salir».
    host.on('closed', () => {
      clearTimeout(guillotine)
      app.exit(1)
    })
  } catch (windowError) {
    // Sin ventana anfitriona la alerta volvería a bloquear el proceso, que es peor que
    // no enseñarla: se deja constancia en el log y se sale.
    logSync(`[arranque] no se pudo crear la ventana de la alerta: ${text(windowError)}`)
    clearTimeout(guillotine)
    app.exit(1)
    return
  }

  void dialog
    .showMessageBox(host, {
      type: 'error',
      title: 'Orbix',
      message: info.message,
      detail: info.detail,
      buttons,
      defaultId: 0,
      cancelId: 0,
      noLink: true
    })
    .then(({ response }) => {
      if (response === 1 && info.revealPath !== undefined) {
        shell.showItemInFolder(info.revealPath)
      }
    })
    .catch((dialogError: unknown) => {
      logSync(`[arranque] fallo al mostrar la alerta: ${text(dialogError)}`)
    })
    .finally(() => {
      clearTimeout(guillotine)
      // `exit` y no `quit`: `quit` dispara `before-quit`, que intentaría un apagado
      // ordenado de servicios que en este punto puede que ni existan.
      app.exit(1)
    })
}

/** ¿Ya se ha gestionado un error fatal? Para no encadenar diálogos. */
export function isFatalHandled(): boolean {
  return alreadyFatal
}
