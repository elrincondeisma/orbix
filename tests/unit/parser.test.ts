import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  emptyWarnings,
  MAX_TOKEN_COUNT,
  parseJsonlLine,
  parseUsageLine,
  type FileContext
} from '../../src/main/ingest/parser'
import { JSONL_FIXTURES } from '../helpers/db'

const FILE: FileContext = {
  path: '/tmp/projects/-Users-tester-Projects-demo/sesion.jsonl',
  projectKey: '-Users-tester-Projects-demo',
  sessionId: 'sesion',
  isSidechain: 0
}

function lines(fixture: string): string[] {
  return readFileSync(join(JSONL_FIXTURES, fixture), 'utf8').split('\n')
}

describe('parser tolerante', () => {
  it('lee los contadores de una línea real sin tocarlos', () => {
    const w = emptyWarnings()
    const parsed = parseJsonlLine(lines('multi-block.jsonl')[0] as string, FILE, w)
    expect(parsed).not.toBeNull()
    expect(parsed?.requestId).toBe('req_011CegDJVd7cPRt2svHYRMeo')
    expect(parsed?.apiBlockIndex).toBe(0)
    expect(parsed?.outputTok).toBe(1388)
    expect(parsed?.cacheRead).toBe(26354)
    expect(parsed?.cacheWrite1h).toBe(22975)
    expect(parsed?.cacheWrite5m).toBe(0)
    expect(parsed?.thinkingTok).toBe(681)
    expect(parsed?.modelKey).toBe('claude-opus-5')
    expect(w.cacheMismatch).toBe(0)
  })

  it('las cuatro líneas de la misma petición repiten el usage entero', () => {
    const parsed = lines('multi-block.jsonl')
      .filter((l) => l.trim() !== '')
      .map((l) => parseJsonlLine(l, FILE))
    expect(parsed).toHaveLength(4)
    expect(new Set(parsed.map((p) => p?.requestId)).size).toBe(1)
    expect(parsed.map((p) => p?.apiBlockIndex)).toEqual([0, 1, 2, 3])
    for (const p of parsed) {
      expect(p?.outputTok).toBe(1388)
      expect(p?.cacheRead).toBe(26354)
    }
  })

  it('no revienta con JSON inválido y lo cuenta', () => {
    const w = emptyWarnings()
    const parsed = lines('garbage.jsonl')
      .filter((l) => l.trim() !== '')
      .map((l) => parseJsonlLine(l, FILE, w))
    expect(w.badJson).toBe(1)
    expect(parsed.filter((p) => p !== null)).toHaveLength(2)
  })

  it('acepta el formato antiguo sin desglose de cache_creation', () => {
    const w = emptyWarnings()
    const parsed = parseJsonlLine(lines('old-format.jsonl')[0] as string, FILE, w)
    expect(w.legacyCacheCreation).toBe(1)
    // sin desglose, todo va al ttl por defecto de 5 minutos
    expect(parsed?.cacheWrite5m).toBe(22975)
    expect(parsed?.cacheWrite1h).toBe(0)
  })

  it('cuenta <synthetic> y lo descarta: no trae requestId', () => {
    const w = emptyWarnings()
    const parsed = lines('synthetic.jsonl')
      .filter((l) => l.trim() !== '')
      .map((l) => parseJsonlLine(l, FILE, w))
    expect(w.synthetic).toBe(1)
    // Hallazgo sobre datos reales: las 8 líneas `<synthetic>` de 368 MB son
    // errores de API sin requestId, así que nunca llegan a la BD.
    expect(parsed[1]).toBeNull()
    expect(parsed[0]).not.toBeNull()
  })

  it('una petición sintética con requestId se ingiere a coste 0', () => {
    const w = emptyWarnings()
    const parsed = parseUsageLine(
      {
        type: 'assistant',
        requestId: 'req_synth',
        timestamp: '2026-09-03T10:00:00.000Z',
        message: { model: '<synthetic>', usage: { output_tokens: 0 } }
      },
      FILE,
      w
    )
    expect(parsed?.modelKey).toBe('__synthetic__')
    expect(w.synthetic).toBe(1)
  })

  it('normaliza el modelo desconocido pero lo ingiere igual', () => {
    const parsed = parseJsonlLine(lines('unknown-model.jsonl')[0] as string, FILE)
    expect(parsed?.modelRaw).toBe('claude-fable-1-20261201')
    expect(parsed?.modelKey).toBe('claude-fable-1')
  })

  it('hereda is_sidechain del fichero y lo respeta si la línea lo dice', () => {
    const line = lines('sidechain/agent-x.jsonl')[0] as string
    const desdeFichero = parseJsonlLine(line, { ...FILE, isSidechain: 1 })
    expect(desdeFichero?.isSidechain).toBe(1)
    const desdeLinea = parseJsonlLine(line, FILE)
    expect(desdeLinea?.isSidechain).toBe(1) // la propia línea trae isSidechain: true
  })

  it('descarta lo que no es facturable sin lanzar', () => {
    const w = emptyWarnings()
    expect(parseUsageLine({ type: 'user', message: {} }, FILE, w)).toBeNull()
    expect(parseUsageLine({ type: 'summary' }, FILE, w)).toBeNull()
    expect(parseUsageLine(null, FILE, w)).toBeNull()
    expect(parseUsageLine(42, FILE, w)).toBeNull()
    expect(parseUsageLine({ type: 'assistant' }, FILE, w)).toBeNull()
    // assistant con usage pero sin requestId: no hay identidad facturable
    expect(
      parseUsageLine(
        { type: 'assistant', message: { usage: { output_tokens: 5 } }, timestamp: '2026-09-03T00:00:00Z' },
        FILE,
        w
      )
    ).toBeNull()
    // timestamp inválido
    expect(
      parseUsageLine(
        {
          type: 'assistant',
          requestId: 'req_x',
          timestamp: 'ayer por la tarde',
          message: { usage: { output_tokens: 5 } }
        },
        FILE,
        w
      )
    ).toBeNull()
  })

  it('sanea contadores absurdos a 0', () => {
    const parsed = parseUsageLine(
      {
        type: 'assistant',
        requestId: 'req_x',
        timestamp: '2026-09-03T10:00:00.000Z',
        message: {
          model: 'claude-opus-5',
          usage: {
            input_tokens: -5,
            output_tokens: 'muchos',
            cache_read_input_tokens: null,
            cache_creation: { ephemeral_5m_input_tokens: 12.7 }
          }
        }
      },
      FILE
    )
    expect(parsed?.inputTok).toBe(0)
    expect(parsed?.outputTok).toBe(0)
    expect(parsed?.cacheRead).toBe(0)
    expect(parsed?.cacheWrite5m).toBe(12)
  })

  it('BUG-5: un contador absurdo se descarta y deja rastro', () => {
    const w = emptyWarnings()
    const parsed = parseUsageLine(
      {
        type: 'assistant',
        requestId: 'neg',
        timestamp: '2026-09-03T10:00:00.000Z',
        message: {
          model: 'claude-opus-5',
          usage: {
            input_tokens: 2,
            output_tokens: 1388,
            cache_read_input_tokens: 26354,
            cache_creation: { ephemeral_1h_input_tokens: 1e30, ephemeral_5m_input_tokens: 0 }
          }
        }
      },
      FILE,
      w
    )
    // el contador corrupto se va a 0...
    expect(parsed?.cacheWrite1h).toBe(0)
    expect(w.absurdCounter).toBe(1)
    // ...y el resto de la línea se ingiere igual: la tolerancia se mantiene
    expect(parsed?.outputTok).toBe(1388)
    expect(parsed?.cacheRead).toBe(26354)
    expect(parsed?.inputTok).toBe(2)
  })

  it('el techo deja pasar cualquier valor legítimo imaginable', () => {
    const w = emptyWarnings()
    // el máximo real medido en 24.389 líneas de la máquina de Ismael
    const maxReal = 997_672
    const legitimo = parseUsageLine(
      {
        type: 'assistant',
        requestId: 'r1',
        timestamp: '2026-09-03T10:00:00.000Z',
        message: {
          model: 'claude-opus-5',
          usage: { cache_read_input_tokens: maxReal, output_tokens: MAX_TOKEN_COUNT }
        }
      },
      FILE,
      w
    )
    expect(legitimo?.cacheRead).toBe(maxReal)
    expect(legitimo?.outputTok).toBe(MAX_TOKEN_COUNT) // el techo justo es válido
    expect(w.absurdCounter).toBe(0)
    // 1.000× por encima del máximo real y de la ventana de contexto de 1 M
    expect(MAX_TOKEN_COUNT / maxReal).toBeGreaterThan(1000)

    const pasado = parseUsageLine(
      {
        type: 'assistant',
        requestId: 'r2',
        timestamp: '2026-09-03T10:00:00.000Z',
        message: { model: 'claude-opus-5', usage: { output_tokens: MAX_TOKEN_COUNT + 1 } }
      },
      FILE,
      w
    )
    expect(pasado?.outputTok).toBe(0)
    expect(w.absurdCounter).toBe(1)
  })

  it('Infinity y notación exponencial en cualquier contador valen 0', () => {
    const w = emptyWarnings()
    const parsed = parseUsageLine(
      {
        type: 'assistant',
        requestId: 'r3',
        timestamp: '2026-09-03T10:00:00.000Z',
        message: {
          model: 'claude-opus-5',
          usage: {
            input_tokens: Number.MAX_VALUE,
            output_tokens: 9e15,
            cache_read_input_tokens: 1e13,
            output_tokens_details: { thinking_tokens: 1e20 },
            cache_creation: { ephemeral_5m_input_tokens: 1e12, ephemeral_1h_input_tokens: 5e9 }
          }
        }
      },
      FILE,
      w
    )
    expect(parsed?.inputTok).toBe(0)
    expect(parsed?.outputTok).toBe(0)
    expect(parsed?.cacheRead).toBe(0)
    expect(parsed?.thinkingTok).toBe(0)
    expect(parsed?.cacheWrite5m).toBe(0)
    expect(parsed?.cacheWrite1h).toBe(0)
    expect(w.absurdCounter).toBe(6)
  })

  it('apiBlockIndex ausente equivale a 0', () => {
    const parsed = parseUsageLine(
      {
        type: 'assistant',
        requestId: 'req_x',
        timestamp: '2026-09-03T10:00:00.000Z',
        message: { model: 'claude-opus-5', usage: { output_tokens: 1 } }
      },
      FILE
    )
    expect(parsed?.apiBlockIndex).toBe(0)
  })
})
