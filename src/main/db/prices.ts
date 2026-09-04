import type { ModelPrice, ModelPriceInput } from '@shared/types'
import type { Db } from './connection'

/**
 * Precios de modelo. Nunca hardcodeados en el código: viven en `model_prices`,
 * se siembran en `002_seed.sql` y el usuario puede sobreescribirlos.
 * 02-esquema-bd.md §4.
 */

export const DEFAULT_MODEL_KEY = '__default__'
export const UNKNOWN_MODEL_KEY = '__unknown__'
export const SYNTHETIC_MODEL_KEY = '__synthetic__'

/**
 * `ModelPrice` y `ModelPriceInput` viven en `@shared/types` (los consume el
 * panel de preferencias por IPC). Aquí solo se añade el origen de la tarifa, que
 * es interno: la UI siempre da de alta tarifas de usuario.
 */
export type { ModelPrice, ModelPriceInput }
export type PriceUpsertInput = ModelPriceInput & {
  readonly source?: 'seed' | 'user' | 'import'
}

export interface PriceRow {
  readonly id: number
  readonly model_key: string
  readonly input_per_mtok: number
  readonly output_per_mtok: number
  readonly cache_write_5m_per_mtok: number
  readonly cache_write_1h_per_mtok: number
  readonly cache_read_per_mtok: number
  readonly valid_from: string
}

/**
 * Techo de cordura por contador y petición: 1.000 millones de tokens.
 *
 * Por qué ahí. Medido sobre las 24.389 líneas con `usage` de la máquina de
 * referencia, el valor más alto de cualquier contador es **997.672**
 * (`cache_read_input_tokens`), y no es casualidad: un contador de una petición
 * no puede pasar de la ventana de contexto del modelo, hoy 1 M de tokens. El
 * techo deja **1.000×** de margen sobre ambas cifras, así que ni multiplicando
 * por mil la ventana de contexto descartaría un valor legítimo.
 *
 * Hace falta porque un solo `1e30` en una línea corrupta mete un coste de 1e25 $
 * en `rollup_daily` y deja el total del día roto para siempre, que es justo lo
 * que esta app existe para no hacer. El contador que se pasa se descarta y se
 * cuenta como aviso: queda rastro, no desaparece en silencio.
 */
export const MAX_TOKEN_COUNT = 1_000_000_000

/** Contadores facturables de una petición. `thinking` no entra en el coste. */
export interface CostCounters {
  readonly input_tok: number
  readonly output_tok: number
  readonly cache_write_5m: number
  readonly cache_write_1h: number
  readonly cache_read: number
}

/**
 * Normalización de modelo (§4.2). Idempotente: normalizar dos veces da lo mismo.
 */
export function normalizeModel(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) return UNKNOWN_MODEL_KEY
  let s = raw.toLowerCase().trim()
  if (s === '') return UNKNOWN_MODEL_KEY
  if (s === '<synthetic>') return SYNTHETIC_MODEL_KEY
  s = s.replace(/-\d{8}$/, '') // sufijo de fecha: claude-haiku-4-5-20251001
  s = s.replace(/^anthropic\./, '') // prefijo de proveedor
  return s
}

/**
 * Fórmula de coste (§4.1). `thinking_tok` queda fuera a propósito: ya está
 * dentro de `output_tokens`. `cache_creation_input_tokens` también, porque es la
 * suma de los dos ephemeral que sí entran, a tarifas distintas.
 */
export function computeCost(c: CostCounters, p: PriceRow): number {
  return (
    (c.input_tok * p.input_per_mtok +
      c.output_tok * p.output_per_mtok +
      c.cache_write_5m * p.cache_write_5m_per_mtok +
      c.cache_write_1h * p.cache_write_1h_per_mtok +
      c.cache_read * p.cache_read_per_mtok) /
    1e6
  )
}

export interface ResolvedCost {
  readonly costUsd: number
  readonly priceId: number | null
}

/**
 * Caché en memoria de las tarifas. La resolución de precio ocurre una vez por
 * petición ingerida: no se puede ir a SQLite cada vez.
 */
export class PriceCache {
  /** model_key → tarifas ordenadas por valid_from descendente. */
  private byModel = new Map<string, PriceRow[]>()

  constructor(private readonly db: Db) {
    this.reload()
  }

  reload(): void {
    const rows = this.db
      .prepare(
        `SELECT id, model_key, input_per_mtok, output_per_mtok, cache_write_5m_per_mtok,
                cache_write_1h_per_mtok, cache_read_per_mtok, valid_from
           FROM model_prices
          ORDER BY model_key, valid_from DESC`
      )
      .all() as PriceRow[]

    const map = new Map<string, PriceRow[]>()
    for (const r of rows) {
      const list = map.get(r.model_key)
      if (list) list.push(r)
      else map.set(r.model_key, [r])
    }
    this.byModel = map
  }

  /** Tarifa vigente para (modelo, instante). `__default__` como respaldo. */
  resolve(modelKey: string, tsIso: string): PriceRow | null {
    return this.lookup(modelKey, tsIso) ?? this.lookup(DEFAULT_MODEL_KEY, tsIso)
  }

  private lookup(modelKey: string, tsIso: string): PriceRow | null {
    const list = this.byModel.get(modelKey)
    if (!list) return null
    for (const row of list) {
      // la lista viene ordenada descendente: la primera que cumple es la vigente
      if (row.valid_from <= tsIso) return row
    }
    return null
  }

  /**
   * Coste de una petición. Las sintéticas (`<synthetic>`) valen 0 y no se les
   * busca tarifa nunca (§4.2).
   */
  costOf(modelKey: string, tsIso: string, c: CostCounters): ResolvedCost {
    if (modelKey === SYNTHETIC_MODEL_KEY) return { costUsd: 0, priceId: null }
    const p = this.resolve(modelKey, tsIso)
    if (!p) return { costUsd: 0, priceId: null }
    return { costUsd: computeCost(c, p), priceId: p.id }
  }

  /** true si el modelo no tiene tarifa propia y tira del comodín. */
  usesDefault(modelKey: string, tsIso: string): boolean {
    return this.lookup(modelKey, tsIso) === null
  }
}

function toModelPrice(r: Record<string, unknown>): ModelPrice {
  return {
    id: r['id'] as number,
    modelKey: r['model_key'] as string,
    inputPerMtok: r['input_per_mtok'] as number,
    outputPerMtok: r['output_per_mtok'] as number,
    cacheWrite5mPerMtok: r['cache_write_5m_per_mtok'] as number,
    cacheWrite1hPerMtok: r['cache_write_1h_per_mtok'] as number,
    cacheReadPerMtok: r['cache_read_per_mtok'] as number,
    validFrom: r['valid_from'] as string,
    source: r['source'] as ModelPrice['source'],
    note: (r['note'] as string | null) ?? null
  }
}

/** `prices:list` */
export function listPrices(db: Db): ModelPrice[] {
  const rows = db
    .prepare(`SELECT * FROM model_prices ORDER BY model_key, valid_from DESC`)
    .all() as Array<Record<string, unknown>>
  return rows.map(toModelPrice)
}

export interface UpsertPriceResult {
  readonly priceId: number
  /** Peticiones marcadas para recalcular coste. */
  readonly affectedRequests: number
  /** Días marcados en `rollup_dirty`. */
  readonly affectedDays: number
}

/**
 * Alta o modificación de tarifa (§5.7). Marca como `cost_stale` todo lo afectado
 * y encola los días para recalcular; el recálculo en sí lo hace `rollups.ts`.
 */
export function upsertPrice(
  db: Db,
  input: PriceUpsertInput,
  now: string = new Date().toISOString()
): UpsertPriceResult {
  const modelKey = normalizeModel(input.modelKey)
  if (modelKey === SYNTHETIC_MODEL_KEY) {
    throw new Error('Las peticiones sintéticas no tienen tarifa: siempre cuestan 0')
  }
  const validFrom = input.validFrom || '2000-01-01T00:00:00Z'

  const run = db.transaction((): UpsertPriceResult => {
    db.prepare(
      `INSERT INTO model_prices
         (model_key, input_per_mtok, output_per_mtok, cache_write_5m_per_mtok,
          cache_write_1h_per_mtok, cache_read_per_mtok, valid_from, source, note)
       VALUES (@model_key, @input, @output, @cw5m, @cw1h, @cread, @valid_from, @source, @note)
       ON CONFLICT(model_key, valid_from) DO UPDATE SET
         input_per_mtok          = excluded.input_per_mtok,
         output_per_mtok         = excluded.output_per_mtok,
         cache_write_5m_per_mtok = excluded.cache_write_5m_per_mtok,
         cache_write_1h_per_mtok = excluded.cache_write_1h_per_mtok,
         cache_read_per_mtok     = excluded.cache_read_per_mtok,
         source                  = excluded.source,
         note                    = excluded.note`
    ).run({
      model_key: modelKey,
      input: input.inputPerMtok,
      output: input.outputPerMtok,
      cw5m: input.cacheWrite5mPerMtok,
      cw1h: input.cacheWrite1hPerMtok,
      cread: input.cacheReadPerMtok,
      valid_from: validFrom,
      source: input.source ?? 'user',
      note: input.note ?? null
    })

    const priceRow = db
      .prepare(`SELECT id FROM model_prices WHERE model_key = ? AND valid_from = ?`)
      .get(modelKey, validFrom) as { id: number } | undefined

    // Todo lo posterior a valid_from de ese modelo (o de todos si es el comodín)
    const marked = db
      .prepare(
        `UPDATE usage_requests SET cost_stale = 1
          WHERE ts >= @valid_from
            AND model_key <> '${SYNTHETIC_MODEL_KEY}'
            AND (@model_key = '${DEFAULT_MODEL_KEY}' OR model_key = @model_key)`
      )
      .run({ valid_from: validFrom, model_key: modelKey })

    const days = db
      .prepare(
        `INSERT OR IGNORE INTO rollup_dirty (day_local, marked_at)
         SELECT DISTINCT day_local, ? FROM usage_requests WHERE cost_stale = 1`
      )
      .run(now)

    return {
      priceId: priceRow?.id ?? 0,
      affectedRequests: marked.changes,
      affectedDays: days.changes
    }
  })

  return run()
}
