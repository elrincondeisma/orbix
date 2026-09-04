/**
 * Orbix — pestaña «Integración»: instalar y desinstalar los hooks.
 * Fuente de verdad: docs/design/04-frontal.md §11.
 *
 * Es la pantalla que hace que la app sirva de algo: sin hooks se cuentan tokens
 * pero la mascota no reacciona a nada.
 *
 * Y es la pantalla donde hay que ganarse la confianza. `~/.claude/settings.json`
 * es el fichero de trabajo diario del usuario, así que:
 *   - se dice ANTES de tocar nada que se va a modificar, y se pide confirmación;
 *   - se enseña cuántos hooks de otros programas se han detectado y conservado;
 *   - se enseña dónde queda la copia de seguridad;
 *   - si falla, se dice qué hacer, no solo que ha fallado.
 */

import type { HookStatus, IpcError } from '@shared/types'
import * as api from '../api'
import { button, buttonBar, fromHtml, infoRow, must, section, setText } from './controls'

/** Traduce un fallo de escritura en instrucciones, no en un volcado de error. */
function explain(error: IpcError): { title: string; advice: string } {
  switch (error.code) {
    case 'HOOK_WRITE_FAILED':
      return {
        title: 'No se ha podido escribir en settings.json',
        advice:
          'Tu fichero no se ha tocado. Comprueba que ~/.claude/settings.json existe y ' +
          'tiene permiso de escritura, cierra cualquier editor que lo tenga abierto y ' +
          'vuelve a intentarlo. Si el fichero tiene un error de sintaxis JSON, ' +
          'arréglalo primero: Orbix no sobrescribe un fichero que no entiende.'
      }
    case 'PORT_UNAVAILABLE':
      return {
        title: 'No hay puerto libre para el servidor de eventos',
        advice:
          'Los hooks necesitan un puerto local para avisar a Orbix. Cierra la otra ' +
          'copia de Orbix que pueda estar abierta y vuelve a intentarlo.'
      }
    case 'NOT_READY':
      return {
        title: 'La aplicación todavía está arrancando',
        advice: 'Espera unos segundos y vuelve a intentarlo.'
      }
    default:
      return {
        title: 'No se ha podido completar la operación',
        advice: error.message + (error.detail === undefined ? '' : ` (${error.detail})`)
      }
  }
}

const CONFIRM_HTML = `
<div class="confirm" hidden>
  <p class="confirm-title">Orbix va a modificar <code>~/.claude/settings.json</code></p>
  <ul class="confirm-list">
    <li>Antes de tocar nada se guarda una copia de seguridad del fichero.</li>
    <li data-f="foreign">Tus hooks de otros programas se conservan tal cual.</li>
    <li>Se añade una sola orden: <code>~/.claude/orbix/hook.sh</code>.</li>
    <li>Puedes deshacerlo desde aquí mismo con «Desinstalar».</li>
  </ul>
  <div class="btn-bar">
    <button type="button" class="btn btn-primary" data-act="confirm">Sí, instalar</button>
    <button type="button" class="btn btn-default" data-act="cancel">Cancelar</button>
  </div>
</div>`

const RESULT_HTML = `
<div class="result" hidden>
  <p class="result-title"></p>
  <p class="result-advice"></p>
</div>`

export class IntegrationTab {
  readonly element: HTMLElement

  readonly #state: HTMLElement
  readonly #headline: HTMLElement
  readonly #sub: HTMLElement
  readonly #foreign: HTMLElement
  readonly #confirm: HTMLElement
  readonly #confirmForeign: HTMLElement
  readonly #result: HTMLElement
  readonly #install: HTMLButtonElement
  readonly #reinstall: HTMLButtonElement
  readonly #uninstall: HTMLButtonElement

  readonly #events = infoRow('Eventos cubiertos')
  readonly #missing = infoRow('Eventos que faltan')
  readonly #script = infoRow('Script del hook')
  readonly #settings = infoRow('Fichero de ajustes')
  readonly #server = infoRow('Servidor de eventos')
  readonly #backup = infoRow('Última copia de seguridad')

  #busy = false
  #onChange: (status: HookStatus) => void

  constructor(onChange: (status: HookStatus) => void) {
    this.#onChange = onChange
    this.#state = fromHtml<HTMLElement>(`
      <div class="hook-state" data-installed="false">
        <p class="hook-headline"><span class="dot"></span><span data-f="headline"></span></p>
        <p class="hook-sub" data-f="sub"></p>
      </div>`)
    this.#headline = must(this.#state, '[data-f="headline"]')
    this.#sub = must(this.#state, '[data-f="sub"]')

    this.#foreign = fromHtml<HTMLElement>('<p class="note note-ok" hidden></p>')
    this.#confirm = fromHtml<HTMLElement>(CONFIRM_HTML)
    this.#confirmForeign = must(this.#confirm, '[data-f="foreign"]')
    this.#result = fromHtml<HTMLElement>(RESULT_HTML)

    this.#install = button('Instalar hooks', 'primary', () => this.#askConfirm())
    this.#reinstall = button('Reinstalar', 'default', () => this.#askConfirm())
    this.#uninstall = button('Desinstalar', 'danger', () => void this.#run('uninstall'))

    must<HTMLButtonElement>(this.#confirm, '[data-act="confirm"]').addEventListener('click', () => {
      this.#confirm.hidden = true
      void this.#run('install')
    })
    must<HTMLButtonElement>(this.#confirm, '[data-act="cancel"]').addEventListener('click', () => {
      this.#confirm.hidden = true
    })

    this.element = document.createElement('div')
    this.element.className = 'pane'
    this.element.append(
      section(
        'Hooks de Claude Code',
        this.#state,
        fromHtml<HTMLElement>(
          `<p class="note">Los hooks son lo que le cuenta a Orbix qué está haciendo
           Claude Code. Sin ellos las cifras siguen saliendo, pero la mascota no reacciona.</p>`
        ),
        this.#foreign,
        buttonBar(this.#install, this.#reinstall, this.#uninstall),
        this.#confirm,
        this.#result
      ),
      section(
        'Detalle',
        this.#events.element,
        this.#missing.element,
        this.#script.element,
        this.#settings.element,
        this.#server.element,
        this.#backup.element
      )
    )
  }

  async refresh(): Promise<void> {
    const result = await api.getHookStatus()
    if (result.ok) this.render(result.data)
    else this.#showError(result.error)
  }

  render(status: HookStatus): void {
    this.#state.dataset['installed'] = String(status.installed)
    setText(
      this.#headline,
      status.installed ? 'Hooks instalados' : 'Hooks no instalados'
    )
    setText(
      this.#sub,
      status.installed
        ? `${status.events.length} eventos conectados. Los cambios se aplican en la próxima sesión de Claude Code.`
        : 'La mascota no va a reaccionar hasta que los instales.'
    )

    // El dato que da confianza: sus hooks siguen ahí.
    const n = status.foreignHooksPreserved
    this.#foreign.hidden = n <= 0
    if (n > 0) {
      const texto =
        n === 1
          ? 'Se ha detectado 1 hook de otro programa y se conserva intacto.'
          : `Se han detectado ${n} hooks de otros programas y se conservan intactos.`
      setText(this.#foreign, texto)
      setText(
        this.#confirmForeign,
        n === 1
          ? 'Tu 1 hook de otro programa se conserva tal cual.'
          : `Tus ${n} hooks de otros programas se conservan tal cual.`
      )
    }

    this.#install.hidden = status.installed
    this.#reinstall.hidden = !status.installed
    this.#uninstall.hidden = !status.installed

    this.#events.set(status.events.length > 0 ? status.events.join(', ') : '—')
    this.#missing.set(status.missingEvents.length > 0 ? status.missingEvents.join(', ') : 'ninguno')
    this.#script.set(
      status.scriptVersion === null
        ? status.scriptPath
        : `${status.scriptPath}  ·  v${status.scriptVersion}`
    )
    this.#settings.set(status.settingsPath)
    this.#server.set(
      status.serverPort === null
        ? 'sin puerto asignado'
        : `127.0.0.1:${status.serverPort} · ${status.serverListening ? 'escuchando' : 'parado'}`
    )
    this.#backup.set(status.lastBackupPath ?? 'todavía no se ha hecho ninguna')

    this.#onChange(status)
  }

  // -----------------------------------------------------------------

  #askConfirm(): void {
    this.#result.hidden = true
    this.#confirm.hidden = false
  }

  async #run(action: 'install' | 'uninstall'): Promise<void> {
    if (this.#busy) return
    this.#busy = true
    this.#setBusy(true)
    const result = action === 'install' ? await api.installHooks() : await api.uninstallHooks()
    this.#busy = false
    this.#setBusy(false)

    if (result.ok) {
      this.render(result.data)
      this.#showOk(
        action === 'install'
          ? 'Hooks instalados. Se aplican en la próxima sesión de Claude Code.'
          : 'Hooks retirados. Tu settings.json vuelve a estar como estaba.'
      )
    } else {
      this.#showError(result.error)
      // El estado puede haber cambiado a medias: se relee de la fuente.
      const fresh = await api.getHookStatus()
      if (fresh.ok) this.render(fresh.data)
    }
  }

  #setBusy(busy: boolean): void {
    for (const b of [this.#install, this.#reinstall, this.#uninstall]) b.disabled = busy
  }

  #showOk(message: string): void {
    this.#result.hidden = false
    this.#result.dataset['tone'] = 'ok'
    setText(must(this.#result, '.result-title'), message)
    setText(must(this.#result, '.result-advice'), '')
  }

  #showError(error: IpcError): void {
    const { title, advice } = explain(error)
    this.#result.hidden = false
    this.#result.dataset['tone'] = 'error'
    setText(must(this.#result, '.result-title'), title)
    setText(must(this.#result, '.result-advice'), advice)
  }
}
