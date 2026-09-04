import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Db } from '../../src/main/db/connection'
import type { PriceCache } from '../../src/main/db/prices'
import { Ingestor } from '../../src/main/ingest/ingestor'
import { freshDb, JSONL_FIXTURES, makeProjectsRoot, placeFixture, writeTranscript } from '../helpers/db'

const TZ = 'Europe/Madrid'
const PROJECT = '-Users-tester-Projects-demo'
const SESSION = '11111111-2222-3333-4444-555555555555'

let db: Db
let prices: PriceCache
let root: string

beforeEach(() => {
  const fresh = freshDb()
  db = fresh.db
  prices = fresh.prices
  root = makeProjectsRoot()
})

function ingestor(): Ingestor {
  return new Ingestor({ db, prices, timezone: TZ, root })
}

function requests(): Array<Record<string, number | string>> {
  return db.prepare('SELECT * FROM usage_requests ORDER BY request_id').all() as Array<
    Record<string, number | string>
  >
}

function scalar(sql: string): number {
  const row = db.prepare(sql).get() as Record<string, number>
  return Object.values(row)[0] as number
}

describe('ingesta: una petición es una petición, no un bloque', () => {
  it('funde los 4 bloques de una misma petición en una sola fila', async () => {
    placeFixture(root, 'multi-block.jsonl', `${PROJECT}/${SESSION}.jsonl`)
    const result = await ingestor().runOnce()

    expect(result.linesIngested).toBe(4)
    expect(scalar('SELECT COUNT(*) FROM usage_lines')).toBe(4)

    const rows = requests()
    expect(rows).toHaveLength(1)
    const r = rows[0] as Record<string, number | string>
    expect(r['request_id']).toBe('req_011CegDJVd7cPRt2svHYRMeo')
    // los 26 354 de caché leída son UNA lectura, no cuatro
    expect(r['cache_read']).toBe(26354)
    expect(r['output_tok']).toBe(1388)
    expect(r['cache_write_1h']).toBe(22975)
    expect(r['input_tok']).toBe(2)
    // (2*5 + 1388*25 + 22975*10 + 26354*0.5) / 1e6
    expect(r['cost_usd']).toBeCloseTo(0.277637, 9)
  })

  it('I1: una fila en usage_requests por request_id distinto en usage_lines', async () => {
    placeFixture(root, 'multi-block.jsonl', `${PROJECT}/${SESSION}.jsonl`)
    placeFixture(root, 'growing-output.jsonl', `${PROJECT}/otra.jsonl`)
    await ingestor().runOnce()
    expect(scalar('SELECT COUNT(*) FROM usage_requests')).toBe(
      scalar('SELECT COUNT(DISTINCT request_id) FROM usage_lines')
    )
  })

  it('I2: cada contador de la petición es el MAX de sus bloques', async () => {
    placeFixture(root, 'growing-output.jsonl', `${PROJECT}/${SESSION}.jsonl`)
    await ingestor().runOnce()
    const bad = db
      .prepare(
        `SELECT r.request_id FROM usage_requests r
           JOIN (SELECT request_id, MAX(output_tok) o, MAX(cache_read) c
                   FROM usage_lines GROUP BY request_id) l
             ON l.request_id = r.request_id
          WHERE r.output_tok <> l.o OR r.cache_read <> l.c`
      )
      .all()
    expect(bad).toEqual([])
    // output_tokens crece entre bloques (1 → 1 → 302): vale el máximo
    expect(scalar('SELECT output_tok FROM usage_requests')).toBe(302)
  })

  it('deduplica una sesión reanudada que reescribe las mismas peticiones', async () => {
    placeFixture(root, 'multi-block.jsonl', `${PROJECT}/${SESSION}.jsonl`)
    placeFixture(root, 'resumed-session.jsonl', `${PROJECT}/reanudada.jsonl`)
    await ingestor().runOnce()

    expect(scalar('SELECT COUNT(*) FROM usage_requests')).toBe(1)
    expect(scalar('SELECT cache_read FROM usage_requests')).toBe(26354)
    expect(scalar('SELECT ROUND(SUM(cost_usd), 6) FROM rollup_daily')).toBeCloseTo(0.277637, 6)
  })

  it('reingerir dos veces no cambia ni una cifra (idempotencia)', async () => {
    placeFixture(root, 'multi-block.jsonl', `${PROJECT}/${SESSION}.jsonl`)
    placeFixture(root, 'sidechain/agent-x.jsonl', `${PROJECT}/${SESSION}/subagents/agent-x.jsonl`)

    await ingestor().runOnce()
    const antes = requests()
    const costeAntes = scalar('SELECT ROUND(SUM(cost_usd), 9) FROM rollup_daily')

    // segunda pasada con un ingestor nuevo: el cursor está en la BD
    const segunda = await ingestor().runOnce()
    expect(segunda.linesIngested).toBe(0) // no relee lo ya consumido

    expect(requests()).toEqual(antes)
    expect(scalar('SELECT ROUND(SUM(cost_usd), 9) FROM rollup_daily')).toBe(costeAntes)
  })

  it('marca los transcripts de subagentes con is_sidechain', async () => {
    placeFixture(root, 'sidechain/agent-x.jsonl', `${PROJECT}/${SESSION}/subagents/agent-x.jsonl`)
    await ingestor().runOnce()
    expect(scalar('SELECT COUNT(*) FROM usage_requests WHERE is_sidechain = 1')).toBeGreaterThan(0)
    expect(scalar('SELECT COUNT(*) FROM usage_requests WHERE is_sidechain = 0')).toBe(0)
    // el sessionId de la ruta padre es el de la sesión principal
    expect(scalar(`SELECT COUNT(*) FROM usage_requests WHERE session_id = '${SESSION}'`)).toBe(
      scalar('SELECT COUNT(*) FROM usage_requests')
    )
  })

  it('no ingiere la última línea incompleta hasta que se cierra', async () => {
    const path = placeFixture(root, 'truncated-tail.jsonl', `${PROJECT}/${SESSION}.jsonl`)
    const contenido = readFileSync(path, 'utf8')
    expect(contenido.endsWith('\n')).toBe(false)

    await ingestor().runOnce()
    expect(scalar('SELECT COUNT(*) FROM usage_lines')).toBe(1) // solo la primera

    appendFileSync(path, '\n')
    await ingestor().runOnce()
    expect(scalar('SELECT COUNT(*) FROM usage_lines')).toBe(2)
  })

  it('relee entero un fichero truncado sin duplicar nada', async () => {
    const path = placeFixture(root, 'multi-block.jsonl', `${PROJECT}/${SESSION}.jsonl`)
    await ingestor().runOnce()
    const antes = requests()

    // truncado: se queda con las dos primeras líneas
    const primeras = readFileSync(path, 'utf8').split('\n').slice(0, 2).join('\n') + '\n'
    writeFileSync(path, primeras, 'utf8')

    await ingestor().runOnce()
    // el histórico NO se borra: lo que ya se contó, contado está
    expect(requests()).toEqual(antes)
    expect(scalar('SELECT COUNT(*) FROM usage_requests')).toBe(1)
  })

  it('sigue leyendo un fichero que crece entre ciclos', async () => {
    const todas = readFileSync(join(JSONL_FIXTURES, 'multi-block.jsonl'), 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
    const path = writeTranscript(root, `${PROJECT}/${SESSION}.jsonl`, `${todas[0] as string}\n`)

    await ingestor().runOnce()
    expect(scalar('SELECT COUNT(*) FROM usage_lines')).toBe(1)

    appendFileSync(path, `${todas.slice(1).join('\n')}\n`)
    const segunda = await ingestor().runOnce()
    expect(segunda.linesIngested).toBe(3)
    expect(scalar('SELECT COUNT(*) FROM usage_lines')).toBe(4)
    expect(scalar('SELECT COUNT(*) FROM usage_requests')).toBe(1)
  })

  it('rodajas pequeñas dan exactamente el mismo resultado que una grande', async () => {
    placeFixture(root, 'multi-block.jsonl', `${PROJECT}/${SESSION}.jsonl`)
    const troceado = new Ingestor({ db, prices, timezone: TZ, root, sliceBytes: 512, sliceMs: 0 })
    await troceado.runOnce()
    expect(scalar('SELECT COUNT(*) FROM usage_lines')).toBe(4)
    expect(scalar('SELECT COUNT(*) FROM usage_requests')).toBe(1)
    expect(scalar('SELECT cache_read FROM usage_requests')).toBe(26354)
  })

  it('un fichero que desaparece se marca gone y conserva su histórico', async () => {
    const path = placeFixture(root, 'multi-block.jsonl', `${PROJECT}/${SESSION}.jsonl`)
    await ingestor().runOnce()
    writeFileSync(path, '', 'utf8')
    const { rmSync } = await import('node:fs')
    rmSync(path)

    await ingestor().runOnce()
    expect(scalar(`SELECT COUNT(*) FROM ingest_files WHERE state = 'gone'`)).toBe(1)
    expect(scalar('SELECT COUNT(*) FROM usage_requests')).toBe(1)
  })

  it('BUG-5: una línea corrupta no puede destruir el total del día', async () => {
    const buena = readFileSync(join(JSONL_FIXTURES, 'multi-block.jsonl'), 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')[0] as string
    const corrupta = JSON.stringify({
      type: 'assistant',
      requestId: 'neg',
      apiBlockIndex: 0,
      timestamp: '2026-09-03T08:46:00.000Z',
      sessionId: SESSION,
      cwd: '/Users/tester/Projects/demo',
      message: {
        model: 'claude-opus-5',
        usage: {
          input_tokens: 1,
          output_tokens: 10,
          cache_read_input_tokens: 100,
          cache_creation: { ephemeral_1h_input_tokens: 1e30, ephemeral_5m_input_tokens: 0 }
        }
      }
    })
    writeTranscript(root, `${PROJECT}/${SESSION}.jsonl`, `${buena}\n${corrupta}\n`)

    const result = await ingestor().runOnce()
    expect(result.warnings.absurdCounter).toBe(1)

    // la petición corrupta entra, pero con el contador absurdo a 0
    const fila = db
      .prepare(`SELECT * FROM usage_requests WHERE request_id = 'neg'`)
      .get() as Record<string, number>
    expect(fila['cache_write_1h']).toBe(0)
    expect(fila['output_tok']).toBe(10) // el resto de la línea se conserva
    expect(fila['cost_usd']).toBeLessThan(0.001)

    // y el total del día sigue siendo una cifra de este planeta
    const coste = scalar('SELECT SUM(cost_usd) FROM rollup_daily')
    expect(coste).toBeLessThan(1)
    expect(coste).toBeGreaterThan(0.27) // la línea buena sí cuenta
  })

  it('una petición que cruza la medianoche acaba en el día de su último bloque', async () => {
    // Caso real: req_011CefN3bmLGCAKPKizKUzNj, con bloques a caballo del 2 y el
    // 3 de septiembre. `ts` avanza al bloque más tardío, así que `day_local`
    // tiene que seguirlo o la cifra deja de cuadrar con un escaneo directo.
    const base = {
      type: 'assistant',
      requestId: 'medianoche',
      sessionId: SESSION,
      cwd: '/Users/tester/Projects/demo',
      message: {
        model: 'claude-opus-5',
        usage: { input_tokens: 1, output_tokens: 100, cache_read_input_tokens: 1000 }
      }
    }
    const b0 = JSON.stringify({
      ...base,
      apiBlockIndex: 0,
      timestamp: '2026-09-02T21:59:59.000Z' // 23:59:59 en Madrid
    })
    const b1 = JSON.stringify({
      ...base,
      apiBlockIndex: 1,
      timestamp: '2026-09-02T22:00:03.000Z' // 00:00:03 del día siguiente
    })

    const path = writeTranscript(root, `${PROJECT}/${SESSION}.jsonl`, `${b0}\n`)
    await ingestor().runOnce()
    expect(scalar(`SELECT COUNT(*) FROM rollup_daily WHERE day_local = '2026-09-02'`)).toBe(1)

    // el segundo bloque llega en un ciclo posterior, como en la vida real
    appendFileSync(path, `${b1}\n`)
    await ingestor().runOnce()

    const fila = db.prepare(`SELECT * FROM usage_requests`).get() as Record<string, string | number>
    expect(fila['day_local']).toBe('2026-09-03')
    // y el día que abandona se recalcula: no puede quedarse la petición contada
    expect(scalar(`SELECT COUNT(*) FROM rollup_daily WHERE day_local = '2026-09-02'`)).toBe(0)
    expect(scalar(`SELECT COUNT(*) FROM rollup_daily WHERE day_local = '2026-09-03'`)).toBe(1)
    expect(scalar('SELECT COUNT(*) FROM usage_requests')).toBe(1)
  })

  it('el rollup diario cuadra con las peticiones (I4)', async () => {
    placeFixture(root, 'multi-block.jsonl', `${PROJECT}/${SESSION}.jsonl`)
    placeFixture(root, 'growing-output.jsonl', `${PROJECT}/otra.jsonl`)
    placeFixture(root, 'sidechain/agent-x.jsonl', `${PROJECT}/${SESSION}/subagents/agent-x.jsonl`)
    await ingestor().runOnce()

    const rollup = scalar('SELECT ROUND(SUM(cost_usd), 9) FROM rollup_daily')
    const directo = scalar(
      `SELECT ROUND(SUM(cost_usd), 9) FROM usage_requests WHERE model_key <> '__synthetic__'`
    )
    expect(Math.abs(rollup - directo)).toBeLessThan(1e-6)
  })
})
