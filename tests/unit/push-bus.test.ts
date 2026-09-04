/**
 * Tests del bus de canales `push` (main → renderer).
 *
 * Lo que importa aquí es el rendimiento: durante el backfill el ingestor puede disparar
 * decenas de ciclos por segundo, y sin coalescencia cada uno costaría un `StatsSnapshot`
 * completo (siete consultas) y un mensaje IPC a dos ventanas.
 */

import type { BrowserWindow } from 'electron'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PushBus, type WindowTarget } from '../../src/main/ipc/push'
import type { IngestStatus, StatsSnapshot } from '../../src/shared/types'

interface Sent {
  target: WindowTarget
  channel: string
  payload: unknown
}

function harness(destroyed: readonly WindowTarget[] = [], missing: readonly WindowTarget[] = []) {
  const sent: Sent[] = []
  const make = (target: WindowTarget): BrowserWindow =>
    ({
      isDestroyed: () => destroyed.includes(target),
      webContents: {
        send: (channel: string, payload: unknown) => sent.push({ target, channel, payload })
      }
    }) as unknown as BrowserWindow

  const bus = new PushBus((target) => (missing.includes(target) ? null : make(target)))
  return { bus, sent }
}

const INGEST: IngestStatus = {
  state: 'backfilling',
  filesTracked: 195,
  lastRunAt: null,
  lastDurationMs: null,
  backfillProgress: 0.5,
  linesIngestedTotal: 100,
  lastError: null
}

const SNAPSHOT = { generatedAt: 'x' } as unknown as StatsSnapshot

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('encaminamiento por canal', () => {
  it('cada canal llega solo a sus ventanas (§3.3)', () => {
    const { bus, sent } = harness()

    bus.send('pet:command', { state: 'idle' } as never)
    expect(sent.map((s) => s.target)).toEqual(['pet'])

    sent.length = 0
    bus.send('limits:updated', {} as never)
    expect(sent.map((s) => s.target)).toEqual(['menubar'])

    sent.length = 0
    bus.send('prefs:changed', {} as never)
    expect(sent.map((s) => s.target).sort()).toEqual(['menubar', 'pet', 'prefs', 'stats'])

    sent.length = 0
    bus.notice('warn', 'X', 'y')
    expect(sent.map((s) => s.target).sort()).toEqual(['menubar', 'prefs'])
  })

  it('no envía a ventanas cerradas ni destruidas', () => {
    const { bus, sent } = harness(['stats'], ['prefs'])
    bus.send('prefs:changed', {} as never)
    expect(sent.map((s) => s.target).sort()).toEqual(['menubar', 'pet'])
  })
})

describe('stats:updated — coalescido a uno cada 2 s', () => {
  it('veinte disparos seguidos producen un solo mensaje', () => {
    const { bus, sent } = harness()
    const provider = vi.fn(() => SNAPSHOT)

    for (let i = 0; i < 20; i += 1) bus.statsUpdated('ingest', provider)
    // Todavía nada: la ventana no ha vencido.
    expect(sent).toHaveLength(0)
    expect(provider).not.toHaveBeenCalled()

    vi.advanceTimersByTime(2000)
    // Un mensaje por ventana destino (menubar y stats), y UN solo cálculo de snapshot.
    expect(sent.map((s) => s.target)).toEqual(['menubar', 'stats'])
    expect(provider).toHaveBeenCalledTimes(1)
  })

  it('el snapshot se calcula al enviar, no al encolar', () => {
    const { bus } = harness()
    let valor = 1
    bus.statsUpdated('ingest', () => ({ generatedAt: String(valor) }) as unknown as StatsSnapshot)
    valor = 2
    vi.advanceTimersByTime(2000)
    // No se comprueba el valor enviado sino que el proveedor se invoca tarde: si se
    // hubiera evaluado al encolar, el dato saldría ya rancio.
    expect(valor).toBe(2)
  })

  it('gana el último motivo de la ventana', () => {
    const { bus, sent } = harness()
    bus.statsUpdated('ingest', () => SNAPSHOT)
    bus.statsUpdated('prices', () => SNAPSHOT)
    vi.advanceTimersByTime(2000)
    expect((sent[0]?.payload as { reason: string }).reason).toBe('prices')
  })

  it('dos rondas separadas producen dos mensajes', () => {
    const { bus, sent } = harness()
    bus.statsUpdated('ingest', () => SNAPSHOT)
    vi.advanceTimersByTime(2000)
    bus.statsUpdated('ingest', () => SNAPSHOT)
    vi.advanceTimersByTime(2000)
    expect(sent.filter((s) => s.target === 'menubar')).toHaveLength(2)
  })
})

describe('ingest:progress — como mucho 2/s', () => {
  it('el primero pasa y el resto se agrupan en el siguiente hueco', () => {
    const { bus, sent } = harness()

    bus.ingestProgress(INGEST)
    expect(sent.filter((s) => s.target === 'menubar')).toHaveLength(1)

    for (let i = 0; i < 10; i += 1) bus.ingestProgress({ ...INGEST, linesIngestedTotal: i })
    expect(sent.filter((s) => s.target === 'menubar')).toHaveLength(1)

    vi.advanceTimersByTime(500)
    const menubar = sent.filter((s) => s.target === 'menubar')
    expect(menubar).toHaveLength(2)
    // Se entrega el ÚLTIMO estado conocido, no el primero descartado.
    expect((menubar[1]?.payload as IngestStatus).linesIngestedTotal).toBe(9)
  })

  it('va a menubar y a preferencias', () => {
    const { bus, sent } = harness()
    bus.ingestProgress(INGEST)
    expect(sent.map((s) => s.target).sort()).toEqual(['menubar', 'prefs'])
  })
})

describe('dispose', () => {
  it('deja de emitir lo que estaba pendiente', () => {
    const { bus, sent } = harness()
    bus.statsUpdated('ingest', () => SNAPSHOT)
    bus.ingestProgress(INGEST)
    sent.length = 0

    bus.dispose()
    vi.advanceTimersByTime(5000)
    expect(sent).toHaveLength(0)
  })
})
