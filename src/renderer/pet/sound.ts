/**
 * miniClaudio — sonidos sintetizados con la Web Audio API.
 * Fuente de verdad: docs/design/04-frontal.md §8.
 *
 * Sin ficheros de audio: son tres pitidos de menos de 300 ms. Un asset binario
 * aportaría peso, licencia y una decisión de diseño sonoro que no tenemos.
 *
 * El filtrado (silencio, horas de silencio, volumen 0, pantalla bloqueada,
 * antirrepetición) se hace en `main` (§8.2). Aquí, si llega un `SoundId`, suena.
 *
 * Cadena: Oscillator → Gain(envolvente) → BiquadFilter → Gain(master) → destination.
 */

import type { SoundId } from '@shared/pet'

/** Una nota de la receta: frecuencia, forma de onda y envolvente en segundos. */
interface Note {
  freq: number
  /** Desplazamiento desde el inicio del sonido, en segundos. */
  at: number
  attack: number
  sustain: number
  release: number
  /** Ganancia relativa de la nota, 0-1. */
  gain: number
}

interface Recipe {
  type: OscillatorType
  /** Corte del filtro paso bajo, en Hz. */
  lowpass: number
  notes: Note[]
}

/** Las tres recetas de §8.1, literales. */
const RECIPES: Readonly<Record<SoundId, Recipe>> = Object.freeze({
  // Dos notas encadenadas sin silencio: C6 y E6. Alegre y breve.
  done: {
    type: 'sine',
    lowpass: 4000,
    notes: [
      { freq: 1046.5, at: 0, attack: 0.006, sustain: 0.04, release: 0.06, gain: 1 },
      { freq: 1318.5, at: 0.09, attack: 0.006, sustain: 0.04, release: 0.06, gain: 1 }
    ]
  },
  // Tres notas ascendentes con 25 ms de silencio: llamada, sube, pide respuesta.
  attention: {
    type: 'triangle',
    lowpass: 6000,
    notes: [
      { freq: 880, at: 0, attack: 0.004, sustain: 0.03, release: 0.05, gain: 1 },
      { freq: 1108.7, at: 0.095, attack: 0.004, sustain: 0.03, release: 0.05, gain: 1 },
      { freq: 1318.5, at: 0.19, attack: 0.004, sustain: 0.03, release: 0.05, gain: 1 }
    ]
  },
  // Una sola nota G6 al 40 % de ganancia.
  blip: {
    type: 'sine',
    lowpass: 6000,
    notes: [{ freq: 1568, at: 0, attack: 0.003, sustain: 0.01, release: 0.04, gain: 0.4 }]
  }
})

/** Un `AudioContext` activo mantiene despierto el subsistema de audio (§8.1). */
const SUSPEND_AFTER_MS = 2000

export class SoundPlayer {
  #ctx: AudioContext | null = null
  #master: GainNode | null = null
  #suspendTimer: number | null = null
  /** `prefs.volume`; la ganancia real es `volume * 0.6`. */
  #volume = 0.5

  setVolume(volume: number): void {
    if (!Number.isFinite(volume)) return
    this.#volume = Math.min(1, Math.max(0, volume))
    if (this.#master !== null && this.#ctx !== null) {
      this.#master.gain.setValueAtTime(this.#volume * 0.6, this.#ctx.currentTime)
    }
  }

  play(id: SoundId): void {
    const recipe = RECIPES[id]
    if (this.#volume <= 0) return

    const ctx = this.#ensureContext()
    const master = this.#master
    if (ctx === null || master === null) return

    // El contexto se crea suspendido; se reanuda al primer play().
    if (ctx.state === 'suspended') void ctx.resume()

    const filter = ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.setValueAtTime(recipe.lowpass, ctx.currentTime)
    filter.connect(master)

    const t0 = ctx.currentTime + 0.01
    let endsAt = t0

    for (const note of recipe.notes) {
      const start = t0 + note.at
      const env = ctx.createGain()
      env.gain.setValueAtTime(0, start)
      env.gain.linearRampToValueAtTime(note.gain, start + note.attack)
      env.gain.setValueAtTime(note.gain, start + note.attack + note.sustain)
      // Caída exponencial: suena mucho más natural que la lineal.
      env.gain.exponentialRampToValueAtTime(
        0.0001,
        start + note.attack + note.sustain + note.release
      )
      env.connect(filter)

      const osc = ctx.createOscillator()
      osc.type = recipe.type
      osc.frequency.setValueAtTime(note.freq, start)
      osc.connect(env)

      const stop = start + note.attack + note.sustain + note.release
      osc.start(start)
      osc.stop(stop)
      osc.onended = (): void => {
        osc.disconnect()
        env.disconnect()
      }
      if (stop > endsAt) endsAt = stop
    }

    const tailMs = Math.ceil((endsAt - ctx.currentTime) * 1000)
    this.#scheduleSuspend(tailMs + SUSPEND_AFTER_MS, filter)
  }

  destroy(): void {
    if (this.#suspendTimer !== null) {
      window.clearTimeout(this.#suspendTimer)
      this.#suspendTimer = null
    }
    void this.#ctx?.close()
    this.#ctx = null
    this.#master = null
  }

  // -----------------------------------------------------------------

  #ensureContext(): AudioContext | null {
    if (this.#ctx !== null) return this.#ctx
    try {
      // `latencyHint: 'interactive'` mantiene el buffer pequeño: son pitidos cortos.
      const ctx = new AudioContext({ latencyHint: 'interactive' })
      const master = ctx.createGain()
      master.gain.setValueAtTime(this.#volume * 0.6, ctx.currentTime)
      master.connect(ctx.destination)
      this.#ctx = ctx
      this.#master = master
      return ctx
    } catch {
      // Sin audio disponible la app sigue funcionando: el aviso visual es el principal.
      return null
    }
  }

  #scheduleSuspend(delayMs: number, filter: BiquadFilterNode): void {
    if (this.#suspendTimer !== null) window.clearTimeout(this.#suspendTimer)
    this.#suspendTimer = window.setTimeout(() => {
      this.#suspendTimer = null
      filter.disconnect()
      const ctx = this.#ctx
      if (ctx !== null && ctx.state === 'running') void ctx.suspend()
    }, delayMs)
  }
}
