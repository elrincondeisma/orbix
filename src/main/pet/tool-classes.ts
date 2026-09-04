/**
 * Orbix — clasificación de herramientas de Claude Code.
 *
 * Fuente de verdad: `docs/design/03-contrato-eventos.md` §6.1.
 *
 * El emparejamiento es **exacto y sin distinguir mayúsculas**. Una herramienta nueva
 * (incluidas las `mcp__*`) cae en `'other'` y no rompe nada: se trata con la regla 5.
 */

export type ToolClass = 'write' | 'exec' | 'other'

/** ESCRITURA → CODING. */
const WRITE_TOOLS: ReadonlySet<string> = new Set(
  ['Edit', 'Write', 'NotebookEdit', 'MultiEdit', 'Update'].map((t) => t.toLowerCase())
)

/** EJECUCIÓN → RUNNING. */
const EXEC_TOOLS: ReadonlySet<string> = new Set(
  ['Bash', 'BashOutput', 'KillShell', 'KillBash'].map((t) => t.toLowerCase())
)

/**
 * Lectura/búsqueda conocidas (Read, Grep, Glob, WebFetch, WebSearch, Task, TodoWrite).
 * No necesitan lista propia porque comparten destino con las desconocidas (regla 5),
 * pero se dejan documentadas aquí para que el mapa sea legible.
 */
export const READ_TOOLS: readonly string[] = Object.freeze([
  'Read',
  'Grep',
  'Glob',
  'WebFetch',
  'WebSearch',
  'Task',
  'TodoWrite'
])

export function classifyTool(toolName: string | null | undefined): ToolClass {
  if (!toolName) return 'other'
  const key = toolName.toLowerCase()
  if (WRITE_TOOLS.has(key)) return 'write'
  if (EXEC_TOOLS.has(key)) return 'exec'
  return 'other'
}
