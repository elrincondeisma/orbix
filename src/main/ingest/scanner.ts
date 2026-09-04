import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'

/**
 * Descubrimiento de transcripts (02-esquema-bd.md §5.1).
 *
 * El glob es RECURSIVO a propósito: los subagentes escriben en
 * `<projects>/<project_key>/<session_uuid>/subagents/agent-*.jsonl` y ese consumo
 * es real y se paga. Quedarse en el primer nivel pierde ~el 43 % del gasto.
 */

/** Raíz de configuración de Claude Code. */
export function claudeRoot(): string {
  const configured = process.env['CLAUDE_CONFIG_DIR']
  return configured && configured.trim() !== '' ? configured : join(homedir(), '.claude')
}

export function projectsRoot(): string {
  return join(claudeRoot(), 'projects')
}

export interface DiscoveredFile {
  readonly path: string
  /** Primer segmento bajo `projects/`. */
  readonly projectKey: string
  /** uuid de sesión deducido de la ruta; el contenido de la línea manda sobre esto. */
  readonly sessionId: string | null
  readonly isSidechain: 0 | 1
  readonly size: number
  readonly mtimeMs: number
}

const SUBAGENTS_DIR = 'subagents'

/**
 * Deriva projectKey / sessionId / isSidechain de una ruta absoluta.
 * Devuelve null si la ruta no cuelga de `projects/` o no es un `.jsonl`.
 */
export function describeTranscript(path: string, root = projectsRoot()): Omit<
  DiscoveredFile,
  'size' | 'mtimeMs'
> | null {
  if (!path.endsWith('.jsonl')) return null
  const rootWithSep = root.endsWith(sep) ? root : root + sep
  if (!path.startsWith(rootWithSep)) return null

  const rel = path.slice(rootWithSep.length)
  const parts = rel.split(sep).filter((p) => p !== '')
  if (parts.length < 2) return null

  const projectKey = parts[0] as string
  const fileName = parts[parts.length - 1] as string
  const isSidechain: 0 | 1 = parts.includes(SUBAGENTS_DIR) ? 1 : 0

  let sessionId: string | null = null
  if (isSidechain) {
    // .../<session_uuid>/subagents/agent-xxx.jsonl
    const idx = parts.lastIndexOf(SUBAGENTS_DIR)
    sessionId = idx > 0 ? (parts[idx - 1] as string) : null
  } else {
    sessionId = fileName.slice(0, -'.jsonl'.length) || null
  }

  return { path, projectKey, sessionId, isSidechain }
}

/**
 * Profundidad máxima bajo `projects/`.
 *
 * DISCREPANCIA CON EL DISEÑO: 02-esquema-bd.md §5.1 dice `depth: 4`. Medido
 * sobre la máquina real, hay transcripts a 5 niveles:
 * `<project>/<session>/subagents/workflows/<wf_id>/agent-*.jsonl` (34 ficheros,
 * 5.567 líneas). Con profundidad 4 se pierden enteros. Se sube a 6.
 */
export const MAX_SCAN_DEPTH = 6

export interface DiscoverOptions {
  /** Profundidad máxima bajo `projects/`. Por defecto `MAX_SCAN_DEPTH`. */
  readonly maxDepth?: number
}

/**
 * Barrido completo del árbol. Síncrono y barato (0,45 s medidos sobre 368 MB
 * en el `stat`, no en la lectura), se ejecuta cada 60 s como red de seguridad
 * porque FSEvents pierde eventos tras suspender el equipo.
 */
export function discoverFiles(
  root: string = projectsRoot(),
  options: DiscoverOptions = {}
): DiscoveredFile[] {
  const maxDepth = options.maxDepth ?? MAX_SCAN_DEPTH
  const out: DiscoveredFile[] = []
  walk(root, root, 0, maxDepth, out)
  // mtime descendente: lo reciente es lo que el usuario quiere ver primero y lo
  // primero que Claude Code va a borrar (§5.5)
  out.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return out
}

/** `readdirSync` que nunca lanza. */
function safeReaddir(dir: string) {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return null
  }
}

function walk(
  dir: string,
  root: string,
  depth: number,
  maxDepth: number,
  out: DiscoveredFile[]
): void {
  if (depth > maxDepth) return
  const entries = safeReaddir(dir)
  if (!entries) return // permisos, carrera con un borrado... nunca se propaga
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(full, root, depth + 1, maxDepth, out)
      continue
    }
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
    const described = describeTranscript(full, root)
    if (!described) continue
    try {
      const st = statSync(full)
      out.push({ ...described, size: st.size, mtimeMs: st.mtimeMs })
    } catch {
      /* desapareció entre el readdir y el stat */
    }
  }
}

/* ------------------------------------------------------------------------- */
/* Watcher                                                                    */
/* ------------------------------------------------------------------------- */

/** Interfaz mínima de chokidar que usamos, para poder testear sin watcher real. */
interface WatcherLike {
  on(event: string, cb: (path: string) => void): WatcherLike
  close(): Promise<void>
}

export interface WatcherOptions {
  readonly root?: string
  /** ms de espera por fichero antes de encolarlo. */
  readonly debounceMs?: number
  /** ms entre barridos completos de seguridad. */
  readonly fullSweepMs?: number
  /** Se llama con las rutas que hay que releer. */
  readonly onFiles: (paths: string[]) => void
}

/**
 * Vigila `<raíz>/projects`. Debounce de 300 ms por fichero y barrido completo
 * cada 60 s (§5.1). El watcher solo señala rutas: quien decide qué leer es el
 * ingestor.
 */
export class ProjectsWatcher {
  private watcher: WatcherLike | null = null
  private timer: NodeJS.Timeout | null = null
  private sweepTimer: NodeJS.Timeout | null = null
  private readonly pending = new Set<string>()
  private readonly root: string
  private readonly debounceMs: number
  private readonly fullSweepMs: number
  private readonly onFiles: (paths: string[]) => void

  constructor(options: WatcherOptions) {
    this.root = options.root ?? projectsRoot()
    this.debounceMs = options.debounceMs ?? 300
    this.fullSweepMs = options.fullSweepMs ?? 60_000
    this.onFiles = options.onFiles
  }

  async start(): Promise<void> {
    const { watch } = await import('chokidar')
    this.watcher = watch(this.root, {
      ignoreInitial: false,
      depth: MAX_SCAN_DEPTH,
      awaitWriteFinish: false,
      usePolling: false
    }) as unknown as WatcherLike

    const enqueue = (path: string): void => {
      if (!path.endsWith('.jsonl')) return
      this.pending.add(path)
      this.schedule()
    }
    this.watcher.on('add', enqueue).on('change', enqueue)

    this.sweepTimer = setInterval(() => this.fullSweep(), this.fullSweepMs)
    this.sweepTimer.unref?.()
  }

  /** Barrido completo: lo que FSEvents no contó (suspensión, eventos perdidos). */
  fullSweep(): void {
    for (const f of discoverFiles(this.root)) this.pending.add(f.path)
    this.schedule()
  }

  private schedule(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      const paths = [...this.pending]
      this.pending.clear()
      if (paths.length > 0) this.onFiles(paths)
    }, this.debounceMs)
    this.timer.unref?.()
  }

  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    this.timer = null
    this.sweepTimer = null
    if (this.watcher) {
      await this.watcher.close()
      this.watcher = null
    }
  }
}
