import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDatabase, type Db } from '../../src/main/db/connection'
import { migrate } from '../../src/main/db/migrate'
import { PriceCache } from '../../src/main/db/prices'

const here = dirname(fileURLToPath(import.meta.url))

export const FIXTURES = resolve(here, '..', 'fixtures')
export const JSONL_FIXTURES = join(FIXTURES, 'jsonl')

/** BD en memoria, migrada y sembrada. */
export function freshDb(): { db: Db; prices: PriceCache } {
  const db = openDatabase(':memory:')
  migrate(db)
  return { db, prices: new PriceCache(db) }
}

/** Directorio temporal con la forma de `~/.claude/projects`. */
export function makeProjectsRoot(): string {
  return mkdtempSync(join(tmpdir(), 'miniclaudio-projects-'))
}

/**
 * Copia un fixture dentro de un `projects/` falso.
 * `dest` es relativo a la raíz: '<project_key>/<sesión>.jsonl'.
 */
export function placeFixture(root: string, fixture: string, dest: string): string {
  const target = join(root, dest)
  mkdirSync(dirname(target), { recursive: true })
  cpSync(join(JSONL_FIXTURES, fixture), target)
  return target
}

/** Escribe contenido literal (para probar crecimiento y truncados). */
export function writeTranscript(root: string, dest: string, content: string): string {
  const target = join(root, dest)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content, 'utf8')
  return target
}
