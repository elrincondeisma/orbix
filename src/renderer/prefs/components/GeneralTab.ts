/**
 * Orbix — pestaña «General».
 * Fuente de verdad: docs/design/04-frontal.md §11.
 */

import type { AppInfo, HookStatus, IngestStatus, Prefs } from '@shared/types'
import { button, buttonBar, fromHtml, infoRow, section, setText, switchRow } from './controls'

type Patch = (patch: Partial<Prefs>) => void

export class GeneralTab {
  readonly element: HTMLElement

  readonly #cost
  readonly #launch
  readonly #launchNote: HTMLElement
  readonly #version = infoRow('Versión')
  readonly #runtime = infoRow('Electron / Node')
  readonly #copyResult: HTMLElement

  /** `AppInfo.launchAtLoginAvailable`: falso en desarrollo, a propósito. */
  #launchAvailable = false

  #info: AppInfo | null = null
  #hooks: HookStatus | null = null
  #ingest: IngestStatus | null = null

  constructor(patch: Patch) {
    this.#cost = switchRow(
      'Mostrar el coste en la barra de menús',
      'Desactivado por defecto: un título que cambia cada pocos segundos ensancha y ' +
        'estrecha la barra y acaba molestando. Se refresca como mucho una vez por minuto.',
      (v) => patch({ showCostInMenubar: v })
    )

    /*
     * El estado que se enseña es el REAL del sistema: `prefs.launchAtLogin` lo
     * rellena `main` releyendo `getLoginItemSettings()` en cada consulta, no una
     * copia de `prefs.json`. Y `prefs:set` devuelve el estado RESULTANTE, así que
     * si macOS rechaza el cambio el interruptor vuelve solo a su sitio.
     * Aquí no se pinta nada de forma optimista.
     */
    this.#launch = switchRow(
      'Abrir al iniciar sesión',
      'Orbix vive en la barra de menús, sin ventana propia. Con esto activado ' +
        'la mascota aparece sola al encender el Mac y la contabilidad no se salta ningún día.',
      (v) => patch({ launchAtLogin: v })
    )
    this.#launchNote = fromHtml<HTMLElement>('<p class="note" hidden></p>')

    this.#copyResult = fromHtml<HTMLElement>('<p class="note" hidden></p>')

    this.element = document.createElement('div')
    this.element.className = 'pane'
    this.element.append(
      section('Sistema', this.#cost.element, this.#launch.element, this.#launchNote),
      section(
        'Acerca de',
        this.#version.element,
        this.#runtime.element,
        buttonBar(button('Copiar diagnóstico', 'default', () => void this.#copyDiagnostics())),
        this.#copyResult
      )
    )
  }

  render(prefs: Prefs): void {
    this.#cost.set(prefs.showCostInMenubar)
    // Si macOS rechazó el cambio, `prefs.launchAtLogin` vuelve en `false` y el
    // interruptor rebota aquí. Es la misma regla que en el resto de la ventana.
    this.#launch.set(prefs.launchAtLogin)
    this.#launch.setDisabled(!this.#launchAvailable)
  }

  renderInfo(info: AppInfo): void {
    this.#info = info
    this.#version.set(`${info.version} · ${info.platform}-${info.arch}`)
    this.#runtime.set(`Electron ${info.electron} · Node ${info.node}`)

    this.#launchAvailable = info.launchAtLoginAvailable
    this.#launch.setDisabled(!info.launchAtLoginAvailable)

    /*
     * En desarrollo esto NO es un fallo, es una protección, y así se cuenta:
     * activarlo desde el proyecto registraría el Electron de `node_modules` en los
     * Elementos de inicio del usuario. Se dice qué pasa y por qué, sin alarmar.
     */
    this.#launchNote.hidden = info.launchAtLoginAvailable
    if (!info.launchAtLoginAvailable) {
      this.#launchNote.className = 'note'
      setText(
        this.#launchNote,
        'Solo se puede activar en la app instalada. Ahora mismo Orbix corre desde ' +
          'el proyecto, y registrar el arranque dejaría en tus Elementos de inicio una ' +
          'entrada apuntando al Electron de node_modules. Se deja desactivado a propósito ' +
          'para no tocarte esa lista.'
      )
    }
  }

  setHookStatus(status: HookStatus): void {
    this.#hooks = status
  }

  setIngestStatus(status: IngestStatus): void {
    this.#ingest = status
  }

  /**
   * Copia `AppInfo` + `HookStatus` + `IngestStatus` al portapapeles.
   * Sin token, sin correo y sin rutas de proyecto: §11 lo pide explícitamente.
   */
  async #copyDiagnostics(): Promise<void> {
    const home = /^\/Users\/[^/]+/
    const anon = (value: string): string => value.replace(home, '~')

    const payload = {
      app: this.#info === null ? null : { ...this.#info, dbPath: anon(this.#info.dbPath) },
      hooks:
        this.#hooks === null
          ? null
          : {
              ...this.#hooks,
              scriptPath: anon(this.#hooks.scriptPath),
              settingsPath: anon(this.#hooks.settingsPath),
              lastBackupPath:
                this.#hooks.lastBackupPath === null ? null : anon(this.#hooks.lastBackupPath)
            },
      ingest: this.#ingest
    }

    this.#copyResult.hidden = false
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2))
      this.#copyResult.className = 'note note-ok'
      setText(this.#copyResult, 'Diagnóstico copiado al portapapeles.')
    } catch {
      this.#copyResult.className = 'note note-warn'
      setText(this.#copyResult, 'No se ha podido copiar al portapapeles.')
    }
  }
}
