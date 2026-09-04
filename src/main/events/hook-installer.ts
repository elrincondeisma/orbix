/**
 * Orbix — instalación y desinstalación de los hooks en `~/.claude/settings.json`.
 *
 * Fuente de verdad: `docs/design/03-contrato-eventos.md` §5.
 *
 * ⚠️ Este fichero toca la configuración diaria del usuario. El `settings.json` real ya
 * contiene hooks suyos (`~/.claude/hooks/ntfy-notify.sh` para Stop/Notification/SessionEnd
 * y el binario `cerebro` para SessionStart/Stop). **Romperlos rompe su flujo de trabajo.**
 * Por eso:
 *   - el merge añade un GRUPO propio al array del evento y nunca toca los ajenos,
 *   - se hace backup antes de escribir (se conservan los 5 últimos),
 *   - la escritura es atómica (temp + fsync + rename),
 *   - se releé y verifica; si algo no cuadra, se restaura el backup,
 *   - si `settings.json` existe pero no parsea, se ABORTA sin tocar nada.
 */

import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'

import {
  BACKUP_PREFIX,
  CLAUDE_SETTINGS_REL,
  HOOK_COMMAND,
  HOOK_EVENTS_ALL,
  HOOK_EVENTS_PLAIN,
  HOOK_EVENTS_TOOL,
  HOOK_MARKER,
  HOOK_SCRIPT_FILE,
  HOOK_TIMEOUT_SECONDS,
  INSTALL_LOCK_TIMEOUT_MS,
  LOCK_FILE,
  MAX_BACKUPS,
  ORBIX_DIR_REL,
  MODE_DIR,
  MODE_PORT,
  MODE_SCRIPT,
  MODE_TOKEN,
  PORT_FILE,
  TMP_SETTINGS_SUFFIX,
  TOKEN_BYTES,
  TOKEN_FILE
} from '@shared/constants'
import type { HookStatus } from '@shared/types'

// ---------------------------------------------------------------------------
// Forma (parcial) de `settings.json`
// ---------------------------------------------------------------------------

export interface HookEntry {
  type?: string
  command?: string
  timeout?: number
  async?: boolean
  [key: string]: unknown
}

export interface HookGroup {
  matcher?: string
  hooks?: HookEntry[]
  [key: string]: unknown
}

export type HooksMap = Record<string, HookGroup[]>
export type SettingsObject = Record<string, unknown>

/** Error tipado; el manejador de IPC lo traduce a `HOOK_WRITE_FAILED`. */
export class HookWriteError extends Error {
  constructor(
    message: string,
    readonly detail?: string
  ) {
    super(message)
    this.name = 'HookWriteError'
  }
}

// ---------------------------------------------------------------------------
// Funciones puras de merge (testeables sin tocar disco)
// ---------------------------------------------------------------------------

/**
 * Marca de identidad: una entrada es nuestra si y solo si su `command` contiene
 * `orbix/hook.sh`. Nada más. No se usan claves extra en el JSON porque
 * Claude Code podría rechazarlas.
 */
export function isOurEntry(entry: unknown): boolean {
  if (entry === null || typeof entry !== 'object') return false
  const command = (entry as HookEntry).command
  return typeof command === 'string' && command.includes(HOOK_MARKER)
}

/** Una entrada de comando cualquiera que NO es nuestra: hay que respetarla intacta. */
function isForeignCommand(entry: unknown): boolean {
  if (entry === null || typeof entry !== 'object') return false
  const command = (entry as HookEntry).command
  return typeof command === 'string' && !command.includes(HOOK_MARKER)
}

/** El grupo que instalamos para un evento. `PreToolUse`/`PostToolUse` llevan `matcher`. */
export function groupFor(event: string): HookGroup {
  const entry: HookEntry = {
    type: 'command',
    command: HOOK_COMMAND,
    timeout: HOOK_TIMEOUT_SECONDS,
    async: true
  }
  return HOOK_EVENTS_TOOL.includes(event) ? { matcher: '*', hooks: [entry] } : { hooks: [entry] }
}

function asHooksMap(value: unknown): HooksMap {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as HooksMap
}

function asGroups(value: unknown): HookGroup[] {
  return Array.isArray(value) ? (value as HookGroup[]) : []
}

/** Quita nuestras entradas de un array de grupos, y los grupos que se queden vacíos. */
function stripOurEntries(groups: HookGroup[]): HookGroup[] {
  const cleaned: HookGroup[] = []
  for (const group of groups) {
    if (group === null || typeof group !== 'object') {
      // Basura ajena: se conserva tal cual, no nos corresponde limpiarla.
      cleaned.push(group)
      continue
    }
    const entries = Array.isArray(group.hooks) ? group.hooks : []
    const kept = entries.filter((h) => !isOurEntry(h))
    if (kept.length === 0 && entries.length > 0) continue // grupo que era solo nuestro
    if (kept.length === entries.length) {
      cleaned.push(group) // sin cambios: se preserva la referencia y el orden de claves
    } else {
      cleaned.push({ ...group, hooks: kept })
    }
  }
  return cleaned
}

/**
 * Añade nuestros hooks para `events`, de forma idempotente y sin destruir nada ajeno.
 * Devuelve una copia: no muta la entrada.
 */
export function mergeHooks(settings: SettingsObject, events: readonly string[]): SettingsObject {
  const cfg = structuredClone(settings)
  const hooks = asHooksMap(cfg['hooks'])
  cfg['hooks'] = hooks

  for (const event of events) {
    const groups = stripOurEntries(asGroups(hooks[event]))
    groups.push(groupFor(event))
    hooks[event] = groups
  }

  // Los eventos que ya no instalamos (p. ej. al desactivar "estados detallados") pierden
  // nuestra entrada, pero conservan íntegros los hooks de terceros.
  for (const event of Object.keys(hooks)) {
    if (events.includes(event)) continue
    const groups = stripOurEntries(asGroups(hooks[event]))
    if (groups.length === 0) delete hooks[event]
    else hooks[event] = groups
  }

  return cfg
}

/** Quita todas nuestras entradas. Devuelve una copia. */
export function stripHooks(settings: SettingsObject): SettingsObject {
  const cfg = structuredClone(settings)
  const raw = cfg['hooks']
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return cfg
  const hooks = raw as HooksMap

  for (const event of Object.keys(hooks)) {
    const groups = stripOurEntries(asGroups(hooks[event]))
    if (groups.length === 0) delete hooks[event]
    else hooks[event] = groups
  }
  if (Object.keys(hooks).length === 0) delete cfg['hooks']
  return cfg
}

/** Eventos en los que hay una entrada nuestra. */
export function installedEvents(settings: SettingsObject): string[] {
  const hooks = asHooksMap(settings['hooks'])
  const found: string[] = []
  for (const event of Object.keys(hooks)) {
    const has = asGroups(hooks[event]).some((g) =>
      (Array.isArray(g?.hooks) ? g.hooks : []).some(isOurEntry)
    )
    if (has) found.push(event)
  }
  return found
}

/** Número de entradas de comando de terceros en todo el objeto `hooks`. */
export function countForeignHooks(settings: SettingsObject): number {
  const hooks = asHooksMap(settings['hooks'])
  let count = 0
  for (const event of Object.keys(hooks)) {
    for (const group of asGroups(hooks[event])) {
      const entries = Array.isArray(group?.hooks) ? group.hooks : []
      count += entries.filter(isForeignCommand).length
    }
  }
  return count
}

// ---------------------------------------------------------------------------
// Instalador (con IO)
// ---------------------------------------------------------------------------

export interface HookInstallerOptions {
  /** Raíz alternativa. Los tests SIEMPRE pasan un directorio temporal. */
  home?: string
  /** Ruta del `orbix-hook.sh` de origen. */
  hookSourcePath?: string
  now?: () => Date
}

export interface ServerInfo {
  port: number | null
  listening: boolean
}

export class HookInstaller {
  private readonly home: string
  private readonly hookSource: string
  private readonly now: () => Date
  private lastBackupPath: string | null = null

  constructor(options: HookInstallerOptions = {}) {
    this.home = options.home ?? homedir()
    this.hookSource = options.hookSourcePath ?? defaultHookSourcePath()
    this.now = options.now ?? ((): Date => new Date())
  }

  /** Ruta declarada, la que ve el usuario: `~/.claude/settings.json`. */
  get settingsPath(): string {
    return join(this.home, CLAUDE_SETTINGS_REL)
  }

  /**
   * Ruta REAL sobre la que se escribe, resolviendo enlaces simbólicos.
   *
   * ⚠️ BUG-4. Tener `~/.claude` en un repo de dotfiles y enlazarlo es habitual. El
   * `rename()` de la escritura atómica **sustituye el enlace por un fichero normal**: a
   * partir de ahí el fichero versionado se queda huérfano, el usuario sigue editando el
   * del repo y no pasa nada, y no hay ni un aviso. Escribiendo sobre el destino real, el
   * enlace sigue siendo un enlace y los dotfiles siguen mandando.
   */
  get realSettingsPath(): string {
    const declared = this.settingsPath
    try {
      if (!lstatSync(declared).isSymbolicLink()) return declared
    } catch {
      // No existe todavía: se escribe en la ruta declarada.
      return declared
    }
    try {
      // `realpath` sigue toda la cadena de enlaces, no solo el primero.
      return realpathSync(declared)
    } catch {
      // Enlace roto (el destino aún no existe): se respeta la intención del usuario y
      // se escribe donde apunta, creando el destino. Así el enlace sigue vivo.
      try {
        const target = readlinkSync(declared)
        return isAbsolute(target) ? target : resolve(dirname(declared), target)
      } catch {
        return declared
      }
    }
  }

  get dir(): string {
    return join(this.home, ORBIX_DIR_REL)
  }

  get scriptPath(): string {
    return join(this.dir, HOOK_SCRIPT_FILE)
  }

  get tokenPath(): string {
    return join(this.dir, TOKEN_FILE)
  }

  get portPath(): string {
    return join(this.dir, PORT_FILE)
  }

  // -------------------------------------------------------------------------
  // Ficheros de coordinación (§2.3)
  // -------------------------------------------------------------------------

  /**
   * Crea `~/.claude/orbix/` (0700), el token (0600) y copia el script (0755).
   * Es idempotente y NO toca `settings.json`: se puede llamar en cada arranque.
   */
  ensureRuntimeFiles(): { token: string; scriptInstalled: boolean } {
    mkdirSync(this.dir, { recursive: true, mode: MODE_DIR })
    try {
      chmodSync(this.dir, MODE_DIR)
    } catch {
      // Si no podemos endurecer los permisos seguimos: no es motivo para abortar.
    }

    const token = this.ensureToken()

    let scriptInstalled = false
    try {
      // Siempre se sobrescribe: así una actualización de la app actualiza el hook.
      copyFileSync(this.hookSource, this.scriptPath)
      chmodSync(this.scriptPath, MODE_SCRIPT)
      scriptInstalled = true
    } catch (error) {
      throw new HookWriteError(
        'No se pudo copiar el script del hook',
        `${this.hookSource} → ${this.scriptPath}: ${errorText(error)}`
      )
    }

    return { token, scriptInstalled }
  }

  /** Token compartido de 64 caracteres hex. Se genera una sola vez. */
  ensureToken(): string {
    const existing = this.readToken()
    if (existing !== null) return existing
    const token = randomBytes(TOKEN_BYTES).toString('hex')
    mkdirSync(this.dir, { recursive: true, mode: MODE_DIR })
    writeFileSync(this.tokenPath, token, { mode: MODE_TOKEN })
    chmodSync(this.tokenPath, MODE_TOKEN)
    return token
  }

  readToken(): string | null {
    try {
      const raw = readFileSync(this.tokenPath, 'utf8').trim()
      return raw.length > 0 ? raw : null
    } catch {
      return null
    }
  }

  /**
   * Reescribe `~/.claude/orbix/port` con escritura atómica. Se llama en cuanto el
   * `listen` tiene éxito. NO se borra al salir: con la app cerrada, `curl` falla por
   * conexión rechazada, que es exactamente lo que queremos.
   */
  writePort(port: number): void {
    mkdirSync(this.dir, { recursive: true, mode: MODE_DIR })
    const tmp = `${this.portPath}.tmp`
    writeFileSync(tmp, `${port}\n`, { mode: MODE_PORT })
    renameSync(tmp, this.portPath)
  }

  readPort(): number | null {
    try {
      const raw = readFileSync(this.portPath, 'utf8').trim()
      const port = Number.parseInt(raw, 10)
      return Number.isInteger(port) && port > 0 && port < 65_536 ? port : null
    } catch {
      return null
    }
  }

  /** Versión del script instalado, leída de `# orbix-hook-version: N`. */
  readScriptVersion(): string | null {
    try {
      const head = readFileSync(this.scriptPath, 'utf8').slice(0, 512)
      const match = /^#\s*orbix-hook-version:\s*(\S+)\s*$/m.exec(head)
      return match?.[1] ?? null
    } catch {
      return null
    }
  }

  // -------------------------------------------------------------------------
  // Instalación / desinstalación
  // -------------------------------------------------------------------------

  /**
   * @param detailedToolStates si es `false`, no se instalan `PreToolUse`/`PostToolUse`
   *        (la mascota pierde CODING, RUNNING y PUZZLED; todo lo demás sigue).
   */
  async install(
    server: ServerInfo,
    detailedToolStates = true,
    port?: number
  ): Promise<HookStatus> {
    const events = detailedToolStates ? HOOK_EVENTS_ALL : HOOK_EVENTS_PLAIN

    this.ensureRuntimeFiles()
    if (port !== undefined) this.writePort(port)

    await this.withLock(() => {
      const current = this.readSettingsOrThrow()
      this.backupSettings()
      const merged = mergeHooks(current, events)
      this.writeSettingsAtomic(merged)
      this.verifyOrRestore(events)
    })

    return this.getStatus(server)
  }

  /** Quita nuestras entradas. NO borra `~/.claude/orbix/`: facilita reinstalar. */
  async uninstall(server: ServerInfo): Promise<HookStatus> {
    await this.withLock(() => {
      const current = this.readSettingsOrThrow()
      this.backupSettings()
      const stripped = stripHooks(current)
      this.writeSettingsAtomic(stripped)
      this.verifyOrRestore([])
    })

    return this.getStatus(server)
  }

  /** Estado actual, recalculado leyendo el disco. Nunca lanza. */
  getStatus(server: ServerInfo): HookStatus {
    let settings: SettingsObject = {}
    try {
      settings = this.readSettingsOrThrow()
    } catch {
      // `settings.json` ilegible: informamos de "no instalado" sin romper la UI.
      settings = {}
    }

    const events = installedEvents(settings).filter((e) => HOOK_EVENTS_ALL.includes(e))
    const missing = HOOK_EVENTS_ALL.filter((e) => !events.includes(e))

    return {
      installed: events.length > 0,
      events,
      missingEvents: missing,
      scriptPath: this.scriptPath,
      scriptVersion: this.readScriptVersion(),
      settingsPath: this.settingsPath,
      serverPort: server.port,
      serverListening: server.listening,
      foreignHooksPreserved: countForeignHooks(settings),
      lastBackupPath: this.lastBackupPath
    }
  }

  // -------------------------------------------------------------------------
  // Lectura / escritura de settings.json
  // -------------------------------------------------------------------------

  /** `{}` si no existe. Lanza si existe pero no parsea: jamás sobrescribirlo a ciegas. */
  readSettingsOrThrow(): SettingsObject {
    let raw: string
    try {
      raw = readFileSync(this.settingsPath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw new HookWriteError('No se pudo leer settings.json', errorText(error))
    }
    if (raw.trim().length === 0) return {}

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      throw new HookWriteError(
        'settings.json no es JSON válido; no se ha tocado nada',
        errorText(error)
      )
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new HookWriteError('settings.json no contiene un objeto JSON')
    }
    return parsed as SettingsObject
  }

  /**
   * Copia con marca de tiempo; conserva como mucho los 5 backups más recientes.
   * El backup se deja junto al fichero REAL, que es el que se va a modificar.
   */
  backupSettings(): string | null {
    const real = this.realSettingsPath
    if (!existsSync(real)) return null

    const stamp = timestamp(this.now())
    const target = join(dirname(real), `${BACKUP_PREFIX}${stamp}`)
    try {
      copyFileSync(real, target)
    } catch (error) {
      throw new HookWriteError('No se pudo hacer copia de seguridad de settings.json', errorText(error))
    }
    this.lastBackupPath = target
    this.pruneBackups()
    return target
  }

  private pruneBackups(): void {
    try {
      const dir = dirname(this.realSettingsPath)
      const backups = readdirSync(dir)
        .filter((name) => name.startsWith(BACKUP_PREFIX))
        .sort() // el sufijo YYYYMMDD-HHmmss ordena cronológicamente
      const excess = backups.slice(0, Math.max(0, backups.length - MAX_BACKUPS))
      for (const name of excess) rmSync(join(dir, name), { force: true })
    } catch {
      // Limpiar backups es cosmético: nunca debe hacer fracasar la instalación.
    }
  }

  /**
   * temp + fsync + rename, en el mismo volumen. Indentación de 2 espacios.
   *
   * Se escribe SOBRE EL DESTINO REAL del enlace (BUG-4): el temporal se crea en el mismo
   * directorio que el fichero real para que el `rename` siga siendo atómico, y el enlace
   * simbólico de `~/.claude/settings.json` se queda intacto.
   */
  private writeSettingsAtomic(settings: SettingsObject): void {
    const real = this.realSettingsPath
    const tmp = `${real}${TMP_SETTINGS_SUFFIX}`
    const text = `${JSON.stringify(settings, null, 2)}\n`
    let mode = 0o644
    try {
      mode = statSync(real).mode & 0o777
    } catch {
      // No existía: nos quedamos con 0644.
    }

    mkdirSync(dirname(real), { recursive: true })
    let fd: number | null = null
    try {
      fd = openSync(tmp, 'w', mode)
      writeSync(fd, text)
      fsyncSync(fd)
    } catch (error) {
      throw new HookWriteError('No se pudo escribir settings.json', errorText(error))
    } finally {
      if (fd !== null) {
        try {
          closeSync(fd)
        } catch {
          /* cerrado ya */
        }
      }
    }

    try {
      renameSync(tmp, real)
    } catch (error) {
      try {
        unlinkSync(tmp)
      } catch {
        /* nada que hacer */
      }
      throw new HookWriteError('No se pudo reemplazar settings.json', errorText(error))
    }
  }

  /** Relee, comprueba y, si algo falla, restaura el último backup. */
  private verifyOrRestore(expectedEvents: readonly string[]): void {
    try {
      const reread = this.readSettingsOrThrow()
      const present = installedEvents(reread)
      const missing = expectedEvents.filter((e) => !present.includes(e))
      const leftovers = expectedEvents.length === 0 ? present : []
      if (missing.length === 0 && leftovers.length === 0) return
      throw new HookWriteError(
        'La verificación posterior a la escritura falló',
        `faltan: ${missing.join(', ')} · sobran: ${leftovers.join(', ')}`
      )
    } catch (error) {
      this.restoreBackup()
      throw error instanceof HookWriteError
        ? error
        : new HookWriteError('Verificación fallida', errorText(error))
    }
  }

  private restoreBackup(): void {
    if (this.lastBackupPath === null || !existsSync(this.lastBackupPath)) return
    try {
      // `copyFileSync` sobre un enlace escribe en el destino: el enlace se conserva.
      copyFileSync(this.lastBackupPath, this.realSettingsPath)
    } catch {
      // Si ni siquiera se puede restaurar, el backup sigue en disco para el usuario.
    }
  }

  // -------------------------------------------------------------------------
  // Lock de fichero (§5.3): por si se abren las preferencias dos veces
  // -------------------------------------------------------------------------

  private async withLock<T>(fn: () => T): Promise<T> {
    const lockPath = join(this.dir, LOCK_FILE)
    mkdirSync(this.dir, { recursive: true, mode: MODE_DIR })

    const deadline = Date.now() + INSTALL_LOCK_TIMEOUT_MS
    let fd: number | null = null
    for (;;) {
      try {
        fd = openSync(lockPath, 'wx', 0o600)
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw new HookWriteError('No se pudo crear el lock de instalación', errorText(error))
        }
        // Lock huérfano de una ejecución que se murió: a los 30 s se considera muerto.
        if (isStaleLock(lockPath)) {
          try {
            rmSync(lockPath, { force: true })
          } catch {
            /* reintentamos igualmente */
          }
          continue
        }
        if (Date.now() > deadline) {
          throw new HookWriteError('Otra operación de hooks está en curso; inténtalo de nuevo')
        }
        await sleep(50)
      }
    }

    try {
      return fn()
    } finally {
      if (fd !== null) {
        try {
          closeSync(fd)
        } catch {
          /* ya cerrado */
        }
      }
      try {
        rmSync(lockPath, { force: true })
      } catch {
        /* el próximo lo tratará como huérfano */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Auxiliares
// ---------------------------------------------------------------------------

function isStaleLock(lockPath: string): boolean {
  try {
    return Date.now() - statSync(lockPath).mtimeMs > 30_000
  } catch {
    return false
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms))
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** `YYYYMMDD-HHmmss` en hora local. Ordena cronológicamente como texto. */
export function timestamp(date: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  )
}

/**
 * Localiza `orbix-hook.sh`. En desarrollo está en el repo; empaquetado va en
 * `asarUnpack` (ver `01-arquitectura.md` §7), fuera del asar, porque tiene que ser un
 * fichero real y ejecutable.
 */
export function defaultHookSourcePath(): string {
  const candidates: string[] = []

  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  if (typeof resourcesPath === 'string' && resourcesPath.length > 0) {
    candidates.push(join(resourcesPath, 'app.asar.unpacked', 'scripts', 'hook', 'orbix-hook.sh'))
    candidates.push(join(resourcesPath, 'scripts', 'hook', 'orbix-hook.sh'))
  }

  try {
    // `out/main/index.js` → raíz del proyecto empaquetado o del repo en dev.
    const here = dirname(fileURLToPath(import.meta.url))
    candidates.push(resolve(here, '../../scripts/hook/orbix-hook.sh'))
    candidates.push(resolve(here, '../../../scripts/hook/orbix-hook.sh'))
  } catch {
    // `import.meta.url` no disponible (CJS de test): seguimos con el cwd.
  }

  candidates.push(resolve(process.cwd(), 'scripts/hook/orbix-hook.sh'))

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  // Ninguno existe: devolvemos el más probable para que el error diga la ruta real.
  return candidates[candidates.length - 1] ?? 'scripts/hook/orbix-hook.sh'
}
