/**
 * miniClaudio — arranque del renderer de la mascota.
 * Fuente de verdad: docs/design/04-frontal.md §3.5 y §4.
 *
 * Este fichero NO piensa: recibe `PetCommand` ya resuelto y lo reparte entre el
 * pintor, el bocadillo y el sonido. Toda la decisión vive en `main`.
 *
 * F3 EJECUTADO: `new SvgRenderer()` pasó a `new SpriteRenderer()` y no se tocó nada
 * más de este fichero. El resto —bocadillo, sonidos, click-through— es el mismo.
 */

import '../shared/tokens.css'
import './sprite.css'

import type { PetCommand } from '@shared/pet'
import { activate, onPetCommand, onPetPrefs, setInteractive, type PetPrefsPush } from './api'
import { SoundPlayer } from './sound'
import { SpriteRenderer, type PetSkin } from './SpriteRenderer'

const stage = document.getElementById('stage')
if (stage === null) throw new Error('pet: falta #stage en index.html')

const renderer: PetSkin = new SpriteRenderer()
renderer.mount(stage)

const sound = new SoundPlayer()

// ---------------------------------------------------------------------------
// Comandos
// ---------------------------------------------------------------------------

let lastSeq = -1

onPetCommand((cmd: PetCommand) => {
  // Los comandos desordenados se descartan (03-contrato-eventos.md §6.5).
  if (cmd.seq <= lastSeq) return
  lastSeq = cmd.seq

  renderer.setState(cmd.state, cmd.intensity === undefined ? undefined : { intensity: cmd.intensity })
  if (cmd.bubble) renderer.say(cmd.bubble.text, cmd.bubble.ms)
  if (cmd.sound) sound.play(cmd.sound)
})

// ---------------------------------------------------------------------------
// Preferencias visuales
// ---------------------------------------------------------------------------

/** La mascota mira hacia el centro de la pantalla (§3.4). */
function facingFor(anchor: string): 'left' | 'right' {
  return anchor.endsWith('-right') ? 'left' : 'right'
}

let clickThrough = true

onPetPrefs((prefs: PetPrefsPush) => {
  renderer.applyVisualPrefs(prefs)
  sound.setVolume(prefs.soundEnabled ? prefs.volume : 0)

  const anchor = prefs.anchor ?? 'bottom-right'
  document.body.dataset['anchor'] = anchor
  renderer.setFacing(facingFor(anchor))

  clickThrough = prefs.clickThrough ?? true
  document.body.classList.toggle('is-interactive', !clickThrough)
  if (clickThrough) setInteractive(false)
})

// ---------------------------------------------------------------------------
// Interacción (§3.5)
// ---------------------------------------------------------------------------

/**
 * Patrón estándar de Electron: la ventana ignora el ratón pero recibe `mousemove`
 * gracias a `forward: true`. El renderer comprueba si el cursor está sobre el SVG
 * y pide a `main` que active o desactive el paso de clics.
 *
 * Con `clickThrough === true` (por defecto) esto no se usa: la ventana es inerte.
 */
let interactive = false

window.addEventListener('mousemove', (event) => {
  if (clickThrough) return
  const pet = document.getElementById('mc-pet')
  if (pet === null) return

  const r = pet.getBoundingClientRect()
  const over =
    event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom

  if (over !== interactive) {
    interactive = over
    setInteractive(over)
  }
})

window.addEventListener('click', () => {
  if (!clickThrough && interactive) activate()
})

// El menú contextual del botón derecho lo construye `main` escuchando el evento
// `context-menu` del `webContents`: no hace falta un canal IPC para eso.
window.addEventListener('contextmenu', (e) => {
  if (clickThrough) e.preventDefault()
})

window.addEventListener('beforeunload', () => {
  renderer.destroy()
  sound.destroy()
})
