import { existsSync, mkdtempSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { closeDatabase, openDatabase, type Db } from '../../src/main/db/connection'
import { migrate } from '../../src/main/db/migrate'
import { PriceCache, upsertPrice } from '../../src/main/db/prices'
import {
  recomputeDay,
  recomputeDirtyDays,
  recomputeStaleCosts,
  rescuedDays
} from '../../src/main/db/rollups'
import { Queries } from '../../src/main/db/queries'
import { importSnapshotAndRecompute } from '../../src/main/db/snapshot-import'
import { Ingestor } from '../../src/main/ingest/ingestor'
import { projectsRoot } from '../../src/main/ingest/scanner'

/**
 * Verificación contra los transcripts REALES de la máquina.
 *
 * No corre por defecto (toca el `~/.claude` del usuario y las cifras cambian
 * cada día). Para lanzarla:
 *
 *   MINICLAUDIO_REAL=1 npx vitest run tests/integration/real-ingest.test.ts
 *
 * Publica las cifras a grano de petición y el ratio línea/petición: es el
 * PUNTO ABIERTO B4 de 02-esquema-bd.md §8.
 */

const ENABLED = process.env['MINICLAUDIO_REAL'] === '1'
const TZ = 'Europe/Madrid'
const PLAN = {
  tierId: 'default_claude_max_20x',
  organizationType: 'claude_max',
  displayName: 'Max 20×',
  monthlyUsd: 200,
  accountEmail: null,
  detected: true
}

function money(n: number): string {
  return `$${n.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function num(n: number): string {
  return n.toLocaleString('es-ES')
}

describe.skipIf(!ENABLED)('ingesta real de ~/.claude/projects', () => {
  it(
    'reproduce las cifras de calibración y cumple los invariantes',
    { timeout: 300_000 },
    async () => {
      const root = projectsRoot()
      expect(existsSync(root)).toBe(true)

      const dir = mkdtempSync(join(tmpdir(), 'miniclaudio-real-'))
      const dbPath = join(dir, 'miniclaudio.db')
      // se imprime para poder auditar la cifra con un escaneo independiente
      // eslint-disable-next-line no-console
      console.log(`BD de la prueba: ${dbPath}`)
      const db: Db = openDatabase(dbPath)
      migrate(db)
      const prices = new PriceCache(db)

      const ingestor = new Ingestor({ db, prices, timezone: TZ, root })
      const t0 = Date.now()
      const result = await ingestor.runOnce({ backfill: true })
      const ms = Date.now() - t0

      // OJO: COUNT(*) de usage_lines son bloques DISTINTOS (rid, apiBlockIndex);
      // `result.linesIngested` son las líneas leídas del fichero, duplicados incluidos.
      const lines = result.linesIngested
      const blocks = scalar(db, 'SELECT COUNT(*) FROM usage_lines')
      const requests = scalar(db, 'SELECT COUNT(*) FROM usage_requests')
      const sidechain = scalar(db, 'SELECT COUNT(*) FROM usage_requests WHERE is_sidechain = 1')

      // ---- I1: una petición por request_id distinto -------------------------
      expect(requests).toBe(scalar(db, 'SELECT COUNT(DISTINCT request_id) FROM usage_lines'))

      // ---- I2: cada contador es el MAX de sus bloques -----------------------
      const desviados = db
        .prepare(
          `SELECT COUNT(*) AS n FROM usage_requests r
             JOIN (SELECT request_id, MAX(input_tok) i, MAX(output_tok) o,
                          MAX(cache_write_5m) w5, MAX(cache_write_1h) w1, MAX(cache_read) c
                     FROM usage_lines GROUP BY request_id) l ON l.request_id = r.request_id
            WHERE r.input_tok <> l.i OR r.output_tok <> l.o OR r.cache_write_5m <> l.w5
               OR r.cache_write_1h <> l.w1 OR r.cache_read <> l.c`
        )
        .get() as { n: number }
      expect(desviados.n).toBe(0)

      // ---- I4: rollup == suma de peticiones ---------------------------------
      const porRollup = scalar(db, 'SELECT COALESCE(SUM(cost_usd),0) FROM rollup_daily')
      const porPeticion = scalar(
        db,
        `SELECT COALESCE(SUM(cost_usd),0) FROM usage_requests WHERE model_key <> '__synthetic__'`
      )
      expect(Math.abs(porRollup - porPeticion)).toBeLessThan(1e-6)

      const q = new Queries(db, TZ)
      const hoy = q.periodStats('today')
      const d7 = q.periodStats('7d')
      const d30 = q.periodStats('30d')
      const mult = q.multiplier(PLAN)

      // ---- I5: las consultas del menubar son instantáneas --------------------
      const tq = Date.now()
      for (let i = 0; i < 20; i += 1) {
        q.periodStats('30d')
        q.currentSession()
        q.breakdown('project', '30d')
        q.breakdown('model', '30d')
      }
      const msPorSnapshot = (Date.now() - tq) / 20

      /* eslint-disable no-console */
      console.log(`
=== INGESTA REAL · ${new Date().toISOString()} ===
ficheros                ${result.files}   (subagentes incluidos, glob recursivo)
líneas con usage leídas ${num(lines)}
bloques distintos       ${num(blocks)}  (rid, apiBlockIndex)
peticiones facturables  ${num(requests)}
ratio línea/petición    ${(lines / requests).toFixed(3)}   <- PUNTO ABIERTO B4
ratio bloque/petición   ${(blocks / requests).toFixed(3)}
duplicados absorbidos   ${num(lines - blocks)}  (${(((lines - blocks) / lines) * 100).toFixed(1)} % de las líneas)
peticiones de subagente ${num(sidechain)}  (${((sidechain / requests) * 100).toFixed(1)} %)
duración backfill       ${ms} ms
avisos                  ${JSON.stringify(result.warnings)}

periodo   peticiones        output        cache read     coste
hoy       ${String(hoy.requests).padStart(8)}  ${num(hoy.tokens.output).padStart(12)}  ${num(hoy.tokens.cacheRead).padStart(16)}  ${money(hoy.costUsd)}
7 días    ${String(d7.requests).padStart(8)}  ${num(d7.tokens.output).padStart(12)}  ${num(d7.tokens.cacheRead).padStart(16)}  ${money(d7.costUsd)}
30 días   ${String(d30.requests).padStart(8)}  ${num(d30.tokens.output).padStart(12)}  ${num(d30.tokens.cacheRead).padStart(16)}  ${money(d30.costUsd)}

multiplicador           ${mult.value?.toFixed(2)}× (suelo: ${mult.isFloor}, ${mult.coveredDays} días con datos)
consultas del menubar   ${msPorSnapshot.toFixed(2)} ms por ronda completa
`)
      /* eslint-enable no-console */

      // Órdenes de magnitud medidos el 2026-09-03 (ver resumen de la tarea)
      expect(lines).toBeGreaterThan(20_000)
      expect(blocks).toBeLessThan(lines) // hay duplicados de sesiones reanudadas
      expect(requests).toBeGreaterThan(10_000)
      expect(lines / requests).toBeGreaterThan(1.5)
      expect(sidechain).toBeGreaterThan(0)
      // BUG-5: el techo de cordura no puede descartar nada legítimo. Sobre el
      // corpus real entero tiene que ser exactamente 0.
      expect(result.warnings.absurdCounter).toBe(0)
      expect(d30.costUsd).toBeGreaterThan(1000)
      expect(msPorSnapshot).toBeLessThan(200)

      // ---- segunda pasada: idempotencia sobre datos reales -------------------
      // Claude Code está escribiendo en la sesión viva mientras corre el test, así
      // que puede aparecer alguna línea nueva; lo que NO puede es reprocesar lo ya
      // consumido ni bajar el coste.
      const antes = scalar(db, 'SELECT SUM(cost_usd) FROM rollup_daily')
      const requestsAntes = scalar(db, 'SELECT COUNT(*) FROM usage_requests')
      const segunda = await ingestor.runOnce()
      expect(segunda.linesIngested).toBeLessThan(200)
      expect(scalar(db, 'SELECT SUM(cost_usd) FROM rollup_daily')).toBeGreaterThanOrEqual(antes)
      expect(scalar(db, 'SELECT COUNT(*) FROM usage_requests')).toBeGreaterThanOrEqual(
        requestsAntes
      )

      // ---- recálculo por cambio de precios sobre 10.000+ peticiones reales ---
      // Con TODOS los modelos a tarifa Opus 5, la cifra tiene que coincidir con la
      // calibración manual del encargo (que aplicó Opus 5 a todo el corpus).
      const tOpus = Date.now()
      for (const modelKey of ['__default__', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5']) {
        upsertPrice(db, {
          modelKey,
          inputPerMtok: 5,
          outputPerMtok: 25,
          cacheWrite5mPerMtok: 6.25,
          cacheWrite1hPerMtok: 10,
          cacheReadPerMtok: 0.5,
          validFrom: '2000-01-01T00:00:00Z',
          note: 'calibración: tarifa Opus 5 plana'
        })
      }
      prices.reload()
      const stale = recomputeStaleCosts(db, prices)
      let quedan = 0
      do {
        quedan = recomputeDirtyDays(db, prices, { limit: 200 })
      } while (quedan > 0)
      const d30Opus = q.periodStats('30d')
      /* eslint-disable no-console */
      console.log(`
=== RECÁLCULO CON TARIFA OPUS 5 PLANA (comparable a la calibración) ===
peticiones recalculadas ${num(stale.updated)} en ${stale.batches} lotes · ${Date.now() - tOpus} ms
30 días                 ${money(d30Opus.costUsd)}   (con tarifas por modelo: ${money(d30.costUsd)})
7 días                  ${money(q.periodStats('7d').costUsd)}
hoy                     ${money(q.periodStats('today').costUsd)}
`)
      /* eslint-enable no-console */
      expect(stale.updated).toBeGreaterThan(10_000)
      expect(d30Opus.costUsd).toBeGreaterThan(d30.costUsd) // opus es más caro que sonnet/haiku

      // se restauran las tarifas reales antes de seguir
      for (const [modelKey, p] of [
        ['claude-sonnet-5', [2, 10, 2.5, 4, 0.2]],
        ['claude-haiku-4-5', [1, 5, 1.25, 2, 0.1]]
      ] as Array<[string, number[]]>) {
        upsertPrice(db, {
          modelKey,
          inputPerMtok: p[0] as number,
          outputPerMtok: p[1] as number,
          cacheWrite5mPerMtok: p[2] as number,
          cacheWrite1hPerMtok: p[3] as number,
          cacheReadPerMtok: p[4] as number,
          validFrom: '2000-01-01T00:00:00Z'
        })
      }
      prices.reload()
      recomputeStaleCosts(db, prices)
      do {
        quedan = recomputeDirtyDays(db, prices, { limit: 200 })
      } while (quedan > 0)
      // margen del 0,5 %: la sesión viva sigue escribiendo mientras corre el test
      const restaurado = q.periodStats('30d').costUsd
      expect(Math.abs(restaurado - d30.costUsd) / d30.costUsd).toBeLessThan(0.005)

      // ---- snapshot de rescate: no puede duplicar el histórico vivo ----------
      const snapshotPath = resolve(__dirname, '../../data/snapshot-2026-09-03.json')
      if (existsSync(snapshotPath)) {
        const imported = importSnapshotAndRecompute(db, snapshotPath, prices)
        const d30Snap = q.periodStats('30d')
        const allSnap = q.periodStats('all')
        /* eslint-disable no-console */
        console.log(`
=== TRAS IMPORTAR EL SNAPSHOT DE RESCATE ===
filas importadas        ${imported.rowsWritten} (de ${imported.rowsRead}) · ${imported.days} días
30 días                 ${money(d30Snap.costUsd)}  (antes ${money(d30.costUsd)})
histórico completo      ${money(allSnap.costUsd)}
`)
        /* eslint-enable no-console */
        // ---- BUG-2: el snapshot SOLO rellena huecos ------------------------
        // Los días con transcripts vivos no se tocan: la cifra de esos días es
        // exactamente la que da escanear `~/.claude/projects`.
        const porDia = db
          .prepare(
            `SELECT d.day_local,
                    COALESCE((SELECT SUM(cost_usd) FROM rollup_daily r
                               WHERE r.day_local = d.day_local), 0) AS elegido,
                    (SELECT COUNT(*) FROM usage_requests u
                      WHERE u.day_local = d.day_local) AS peticiones_vivas,
                    COALESCE((SELECT SUM(input_tok+output_tok+cache_write_5m+cache_write_1h+cache_read)
                                FROM snapshot_rollups s WHERE s.day_local = d.day_local), 0) AS snap_tokens,
                    COALESCE((SELECT source FROM rollup_daily r
                               WHERE r.day_local = d.day_local LIMIT 1), '-') AS fuente
               FROM (SELECT day_local FROM usage_requests
                     UNION SELECT day_local FROM snapshot_rollups) d
              ORDER BY d.day_local`
          )
          .all() as Array<Record<string, number | string>>

        const rescatados = rescuedDays(db)
        /* eslint-disable no-console */
        console.log(`
=== REGLA NUEVA: EL SNAPSHOT SOLO RELLENA HUECOS ===
día          fuente     peticiones vivas   coste elegido
${porDia
  .map(
    (d) =>
      `${String(d['day_local'])}   ${String(d['fuente']).padEnd(9)}  ${String(d['peticiones_vivas']).padStart(9)}   ${money(Number(d['elegido']))}`
  )
  .join('\n')}

días rescatados         ${rescatados.length === 0 ? '(ninguno)' : rescatados.join(', ')}
`)
        /* eslint-enable no-console */

        // ni un solo día con transcripts vivos puede venir del snapshot
        for (const d of porDia) {
          if (Number(d['peticiones_vivas']) > 0) expect(d['fuente']).not.toBe('snapshot')
          if (d['fuente'] === 'snapshot') expect(Number(d['peticiones_vivas'])).toBe(0)
        }

        // los días vivos valen EXACTAMENTE lo que suman sus peticiones: la cifra
        // del menubar es reproducible escaneando ~/.claude/projects
        const vivoRollup = scalar(
          db,
          `SELECT COALESCE(SUM(cost_usd),0) FROM rollup_daily WHERE source = 'live'`
        )
        const vivoDirecto = scalar(
          db,
          `SELECT COALESCE(SUM(cost_usd),0) FROM usage_requests
            WHERE model_key <> '__synthetic__'
              AND day_local IN (SELECT DISTINCT day_local FROM rollup_daily WHERE source = 'live')`
        )
        expect(Math.abs(vivoRollup - vivoDirecto)).toBeLessThan(1e-6)

        // y el snapshot ya no puede inflar los días mixtos
        expect(d30Snap.costUsd).toBeGreaterThanOrEqual(d30.costUsd - 1e-6)

        // ---- el rescate, que hoy no se puede observar --------------------
        // Mientras el snapshot y los transcripts cubren los mismos días, el
        // rescate no entra nunca. Se simula la retención de 30 días de Claude
        // Code borrando de la BD un día entero y comprobando que entonces sí.
        const diaSacrificado = '2026-08-25'
        const costeVivo = scalar(
          db,
          `SELECT COALESCE(SUM(cost_usd),0) FROM rollup_daily WHERE day_local = '${diaSacrificado}'`
        )
        expect(rescuedDays(db)).not.toContain(diaSacrificado)

        db.prepare(`DELETE FROM usage_requests WHERE day_local = ?`).run(diaSacrificado)
        recomputeDay(db, prices, diaSacrificado)

        const costeRescatado = scalar(
          db,
          `SELECT COALESCE(SUM(cost_usd),0) FROM rollup_daily WHERE day_local = '${diaSacrificado}'`
        )
        /* eslint-disable no-console */
        console.log(`
=== RESCATE (simulando que Claude Code borra el ${diaSacrificado}) ===
con transcripts vivos   ${money(costeVivo)}
tras borrarlos          ${money(costeRescatado)}  <- lo aporta el snapshot
`)
        /* eslint-enable no-console */
        expect(rescuedDays(db)).toContain(diaSacrificado)
        expect(costeRescatado).toBeGreaterThan(0)
        // el snapshot recupera prácticamente todo lo que se perdió
        expect(costeRescatado).toBeGreaterThan(costeVivo * 0.95)
      }

      closeDatabase(db)
    }
  )

  it('el directorio de proyectos existe y trae subagentes anidados', () => {
    const root = projectsRoot()
    expect(root).toContain(join(homedir(), '.claude'))
  })
})

function scalar(db: Db, sql: string): number {
  const row = db.prepare(sql).get() as Record<string, number>
  return Object.values(row)[0] as number
}
