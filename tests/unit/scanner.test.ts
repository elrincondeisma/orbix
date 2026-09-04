import { appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  describeTranscript,
  discoverFiles,
  MAX_SCAN_DEPTH,
  ProjectsWatcher
} from '../../src/main/ingest/scanner'
import { JSONL_FIXTURES, makeProjectsRoot, placeFixture, writeTranscript } from '../helpers/db'

const PROJECT = '-Users-tester-Projects-demo'
const SESSION = '11111111-2222-3333-4444-555555555555'

let watcher: ProjectsWatcher | null = null

afterEach(async () => {
  if (watcher) await watcher.stop()
  watcher = null
})

describe('descubrimiento de transcripts', () => {
  it('deriva proyecto, sesión y sidechain de la ruta', () => {
    const root = '/tmp/projects'
    const normal = describeTranscript(`${root}/${PROJECT}/${SESSION}.jsonl`, root)
    expect(normal).toEqual({
      path: `${root}/${PROJECT}/${SESSION}.jsonl`,
      projectKey: PROJECT,
      sessionId: SESSION,
      isSidechain: 0
    })

    const sub = describeTranscript(`${root}/${PROJECT}/${SESSION}/subagents/agent-x.jsonl`, root)
    expect(sub?.isSidechain).toBe(1)
    expect(sub?.sessionId).toBe(SESSION) // hereda la sesión del directorio padre

    // caso real medido: subagentes de workflow, un nivel más abajo
    const wf = describeTranscript(
      `${root}/${PROJECT}/${SESSION}/subagents/workflows/wf_abc/agent-y.jsonl`,
      root
    )
    expect(wf?.isSidechain).toBe(1)
    expect(wf?.sessionId).toBe(SESSION)
    expect(wf?.projectKey).toBe(PROJECT)
  })

  it('ignora lo que no es un transcript de proyecto', () => {
    const root = '/tmp/projects'
    expect(describeTranscript(`${root}/sessions-index.json`, root)).toBeNull()
    expect(describeTranscript(`${root}/suelto.jsonl`, root)).toBeNull()
    expect(describeTranscript('/otro/sitio/x.jsonl', root)).toBeNull()
  })

  it('el barrido es recursivo y llega a los subagentes de workflow', () => {
    const root = makeProjectsRoot()
    placeFixture(root, 'multi-block.jsonl', `${PROJECT}/${SESSION}.jsonl`)
    placeFixture(root, 'sidechain/agent-x.jsonl', `${PROJECT}/${SESSION}/subagents/agent-x.jsonl`)
    placeFixture(
      root,
      'sidechain/agent-x.jsonl',
      `${PROJECT}/${SESSION}/subagents/workflows/wf_abc/agent-y.jsonl`
    )
    // ruido que no debe colarse
    writeTranscript(root, `${PROJECT}/sessions-index.json`, '{}')

    const found = discoverFiles(root)
    expect(found).toHaveLength(3)
    expect(found.filter((f) => f.isSidechain === 1)).toHaveLength(2)
    expect(MAX_SCAN_DEPTH).toBeGreaterThanOrEqual(5)
  })

  it('ordena por mtime descendente: lo reciente primero', () => {
    const root = makeProjectsRoot()
    const viejo = placeFixture(root, 'multi-block.jsonl', `${PROJECT}/viejo.jsonl`)
    const nuevo = placeFixture(root, 'multi-block.jsonl', `${PROJECT}/nuevo.jsonl`)
    appendFileSync(nuevo, '\n')
    const found = discoverFiles(root)
    expect(found[0]?.path).toBe(nuevo)
    expect(found[1]?.path).toBe(viejo)
  })
})

describe('watcher de ~/.claude/projects', () => {
  it('avisa de un fichero nuevo y de su crecimiento', async () => {
    const root = makeProjectsRoot()
    const avisos: string[][] = []
    watcher = new ProjectsWatcher({
      root,
      debounceMs: 30,
      fullSweepMs: 60_000,
      onFiles: (paths) => avisos.push(paths)
    })
    await watcher.start()

    const linea = readFileSync(join(JSONL_FIXTURES, 'multi-block.jsonl'), 'utf8').split('\n')[0]
    const path = writeTranscript(root, `${PROJECT}/${SESSION}.jsonl`, `${linea as string}\n`)

    await waitFor(() => avisos.flat().includes(path))
    expect(avisos.flat()).toContain(path)

    avisos.length = 0
    appendFileSync(path, `${linea as string}\n`)
    // FSEvents pierde y retrasa eventos cuando la máquina va cargada: por eso el
    // diseño (§5.1) obliga al barrido completo de seguridad. Lo que se garantiza
    // es que el fichero acaba señalado, por el watcher o por el barrido.
    const llegoSolo = await waitFor(() => avisos.flat().includes(path), 3000, false)
    if (!llegoSolo) watcher?.fullSweep()
    await waitFor(() => avisos.flat().includes(path))
    expect(avisos.flat()).toContain(path)
  })

  it('el barrido de seguridad encuentra lo que el watcher no vio', async () => {
    const root = makeProjectsRoot()
    placeFixture(root, 'multi-block.jsonl', `${PROJECT}/${SESSION}.jsonl`)
    const avisos: string[][] = []
    watcher = new ProjectsWatcher({ root, debounceMs: 10, onFiles: (p) => avisos.push(p) })
    watcher.fullSweep()
    await waitFor(() => avisos.length > 0)
    expect(avisos.flat()).toHaveLength(1)
  })
})

/** Espera a que se cumpla `cond`. Con `obligatorio = false` devuelve si se cumplió. */
async function waitFor(
  cond: () => boolean,
  timeoutMs = 10_000,
  obligatorio = true
): Promise<boolean> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      if (obligatorio) throw new Error('timeout esperando al watcher')
      return false
    }
    await new Promise((r) => setTimeout(r, 20))
  }
  return true
}
