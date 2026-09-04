/**
 * Tests de `src/shared`: formateo de cifras y la REGLA DURA de pureza.
 *
 * `src/shared` compila en dos contextos (main con `tsconfig.node.json` y renderers con
 * `tsconfig.web.json`). Si alguien cuela un `import 'node:fs'` o `import 'electron'`, el
 * frontal deja de compilar. Este test lo impide.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  EM_DASH,
  THIN_SPACE,
  formatAge,
  formatCost,
  formatCostShort,
  formatMultiplier,
  formatPercent,
  formatReset,
  formatTokens,
  pluralize,
  truncate
} from '../../src/shared/format'
import {
  DEFAULT_PREFS_BASE,
  EVENT_PORT_CANDIDATES,
  HOOK_EVENTS_ALL,
  createDefaultPrefs
} from '../../src/shared/constants'
import { ALL_PET_STATES, PetState, isPetState, isSoundId } from '../../src/shared/pet'
import { INVOKE_CHANNELS, PUSH_CHANNELS, ipcFail, ipcOk, unwrap } from '../../src/shared/ipc'

const SHARED_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../src/shared')

// ---------------------------------------------------------------------------
// Regla dura de pureza
// ---------------------------------------------------------------------------

describe('src/shared es código neutro', () => {
  const files = readdirSync(SHARED_DIR).filter((f) => f.endsWith('.ts'))

  it('hay ficheros que comprobar', () => {
    expect(files).toEqual(
      expect.arrayContaining(['constants.ts', 'format.ts', 'ipc.ts', 'pet.ts', 'types.ts'])
    )
  })

  it.each(files)('%s no importa de node:* ni de electron', (file) => {
    const source = readFileSync(join(SHARED_DIR, file), 'utf8')
    const imports = [...source.matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!)
    for (const specifier of imports) {
      expect(specifier.startsWith('node:')).toBe(false)
      expect(specifier).not.toBe('electron')
      expect(specifier.startsWith('electron/')).toBe(false)
    }
  })

  it.each(files)('%s no usa globales exclusivos de Node', (file) => {
    const source = readFileSync(join(SHARED_DIR, file), 'utf8')
    // `process`, `Buffer` y `__dirname` no existen en el renderer con sandbox.
    expect(/\bBuffer\b/.test(source)).toBe(false)
    expect(/\b__dirname\b/.test(source)).toBe(false)
    expect(/\bprocess\.\w/.test(source)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Formato (04-frontal.md §10.4)
// ---------------------------------------------------------------------------

describe('formatCost', () => {
  it('usa el formato es-ES con dos decimales', () => {
    expect(formatCost(0)).toBe('$0,00')
    expect(formatCost(12.84)).toBe('$12,84')
    expect(formatCost(166.735)).toBe('$166,74')
    expect(formatCost(1178.15)).toBe('$1.178,15')
  })

  it('marca los importes por debajo de un céntimo', () => {
    expect(formatCost(0.004)).toBe('<$0,01')
    expect(formatCost(0.01)).toBe('$0,01')
  })

  it('respeta el símbolo de moneda de las preferencias', () => {
    expect(formatCost(5, '€')).toBe('€5,00')
  })

  it('no rompe con valores no finitos', () => {
    expect(formatCost(Number.NaN)).toBe(EM_DASH)
    expect(formatCost(Number.POSITIVE_INFINITY)).toBe(EM_DASH)
  })
})

describe('formatCostShort (título del tray)', () => {
  it('un decimal por debajo de 10 y entero por encima', () => {
    expect(formatCostShort(8.34)).toBe('$8,3')
    expect(formatCostShort(56.21)).toBe('$56')
    expect(formatCostShort(0)).toBe('$0,0')
  })
})

describe('formatTokens', () => {
  it('escala hasta M y deja que el separador de miles haga el resto', () => {
    expect(formatTokens(586)).toBe('586')
    expect(formatTokens(274_000)).toBe(`274,0${THIN_SPACE}K`)
    expect(formatTokens(1_200_000)).toBe(`1,20${THIN_SPACE}M`)
    expect(formatTokens(183_000_000)).toBe(`183${THIN_SPACE}M`)
    expect(formatTokens(1_568_000_000)).toBe(`1.568${THIN_SPACE}M`)
  })

  it('nunca usa B ni G', () => {
    expect(formatTokens(5_000_000_000)).not.toMatch(/[BG]/)
  })
})

describe('formatPercent y formatMultiplier', () => {
  it('el porcentaje lleva espacio fino', () => {
    expect(formatPercent(63)).toBe(`63${THIN_SPACE}%`)
    expect(formatPercent(62.6)).toBe(`63${THIN_SPACE}%`)
  })

  it('el multiplicador cambia de precisión en el 10', () => {
    expect(formatMultiplier(6.14)).toBe('6,1×')
    expect(formatMultiplier(14.2)).toBe('14×')
    expect(formatMultiplier(null)).toBe(EM_DASH)
  })
})

describe('formatAge', () => {
  it('cubre toda la escala hasta los días', () => {
    expect(formatAge(3)).toBe('ahora mismo')
    expect(formatAge(42)).toBe('hace 42 s')
    expect(formatAge(600)).toBe('hace 10 min')
    expect(formatAge(7200)).toBe('hace 2 h')
    expect(formatAge(90_000)).toBe('ayer')
    expect(formatAge(7 * 86_400)).toBe('hace 7 días')
    expect(formatAge(null)).toBe(EM_DASH)
  })
})

describe('formatReset', () => {
  const ahora = new Date('2026-09-03T09:00:00.000Z')
  const tz = 'UTC'

  it('distingue hoy, mañana, esta semana y el resto', () => {
    expect(formatReset('2026-09-03T10:00:00Z', tz, ahora)).toBe('↺ hoy 10:00')
    expect(formatReset('2026-09-04T10:00:00Z', tz, ahora)).toBe('↺ mañana 10:00')
    expect(formatReset('2026-09-06T10:00:00Z', tz, ahora)).toBe('↺ dom 10:00')
    expect(formatReset('2026-09-12T10:00:00Z', tz, ahora)).toBe('↺ 12 sep 10:00')
  })

  it('BUG-6: una hora ya pasada dice que venció, y sin el glifo ↺', () => {
    // El caso real: dato de `cachedUsageUtilization` de hace siete días.
    const hoy3sep = new Date('2026-09-03T09:00:00.000Z')
    expect(formatReset('2026-08-27T12:00:00Z', tz, hoy3sep)).toBe('venció el 27 ago 12:00')
    expect(formatReset('2026-08-30T10:00:00Z', tz, hoy3sep)).toBe('venció el 30 ago 10:00')
    expect(formatReset('2026-09-02T10:00:00Z', tz, hoy3sep)).toBe('venció ayer 10:00')
    // Mismo día pero hora ya pasada: también venció.
    expect(formatReset('2026-09-03T08:00:00Z', tz, hoy3sep)).toBe('venció hoy 08:00')
    // Y nada de prometer un reinicio que ya ocurrió.
    for (const pasado of ['2026-08-27T12:00:00Z', '2026-09-03T08:00:00Z']) {
      expect(formatReset(pasado, tz, hoy3sep)).not.toContain('↺')
    }
  })

  it('el futuro sigue llevando ↺', () => {
    const ahora2 = new Date('2026-09-03T09:00:00.000Z')
    expect(formatReset('2026-09-03T09:00:01Z', tz, ahora2)).toBe('↺ hoy 09:00')
    expect(formatReset('2026-09-04T10:00:00Z', tz, ahora2)).toBe('↺ mañana 10:00')
  })

  it('devuelve cadena vacía si no hay dato: no se inventa una hora', () => {
    expect(formatReset(null, tz, ahora)).toBe('')
    expect(formatReset('no es fecha', tz, ahora)).toBe('')
  })

  it('respeta la zona horaria pedida', () => {
    // 22:00 UTC son las 00:00 del día siguiente en Madrid: la zona manda.
    expect(formatReset('2026-09-03T22:00:00Z', 'Europe/Madrid', ahora)).toBe('↺ mañana 00:00')
    expect(formatReset('2026-09-03T22:00:00Z', 'UTC', ahora)).toBe('↺ hoy 22:00')
  })
})

describe('auxiliares de formato', () => {
  it('pluralize y truncate', () => {
    expect(pluralize(1, 'fichero', 'ficheros')).toBe('1 fichero')
    expect(pluralize(184, 'fichero', 'ficheros')).toBe('184 ficheros')
    expect(truncate('abcdef', 4)).toBe('abc…')
    expect(truncate('abc', 10)).toBe('abc')
  })
})

// ---------------------------------------------------------------------------
// Contratos
// ---------------------------------------------------------------------------

describe('constantes compartidas', () => {
  it('los once puertos van del 41414 al 41424', () => {
    expect(EVENT_PORT_CANDIDATES[0]).toBe(41414)
    expect(EVENT_PORT_CANDIDATES.at(-1)).toBe(41424)
    expect(EVENT_PORT_CANDIDATES).toHaveLength(11)
  })

  it('son exactamente los nueve eventos del contrato', () => {
    expect(HOOK_EVENTS_ALL).toEqual([
      'SessionStart',
      'UserPromptSubmit',
      'Notification',
      'SubagentStop',
      'PreCompact',
      'Stop',
      'SessionEnd',
      'PreToolUse',
      'PostToolUse'
    ])
  })

  it('las preferencias por defecto son las del diseño', () => {
    const prefs = createDefaultPrefs()
    expect(prefs.corner).toBe('bottom-right')
    expect(prefs.clickThrough).toBe(true)
    expect(prefs.bubbleMs).toBe(5000)
    expect(prefs.soundOnSubagentStop).toBe(false)
    expect(prefs.detailedToolStates).toBe(true)
    expect(prefs.levelBEnabled).toBe(false)
    expect(prefs.showCostInMenubar).toBe(false)
    expect(typeof prefs.timezone).toBe('string')
    // Las defaults no se pueden mutar por accidente desde fuera.
    expect(Object.isFrozen(DEFAULT_PREFS_BASE)).toBe(true)
  })
})

describe('contrato de la mascota', () => {
  it('los doce estados están completos', () => {
    expect(ALL_PET_STATES).toHaveLength(12)
    expect(new Set(ALL_PET_STATES).size).toBe(12)
    expect(isPetState('needs_you')).toBe(true)
    expect(isPetState(PetState.IDLE)).toBe(true)
    expect(isPetState('inventado')).toBe(false)
    expect(isSoundId('attention')).toBe(true)
    expect(isSoundId('trompeta')).toBe(false)
  })
})

describe('contrato IPC', () => {
  it('no hay canales duplicados', () => {
    expect(new Set(INVOKE_CHANNELS).size).toBe(INVOKE_CHANNELS.length)
    expect(new Set(PUSH_CHANNELS).size).toBe(PUSH_CHANNELS.length)
  })

  it('todos los canales siguen el formato kebab:camelCase', () => {
    for (const channel of [...INVOKE_CHANNELS, ...PUSH_CHANNELS]) {
      expect(channel).toMatch(/^[a-zA-Z]+:[a-zA-Z]+$/)
    }
  })

  it('los helpers de resultado nunca lanzan al construir', () => {
    expect(ipcOk(42)).toEqual({ ok: true, data: 42 })
    expect(ipcFail('DB_ERROR', 'ups')).toEqual({ ok: false, error: { code: 'DB_ERROR', message: 'ups' } })
    expect(unwrap(ipcOk('x'))).toBe('x')
    expect(() => unwrap(ipcFail('INTERNAL', 'boom'))).toThrow(/INTERNAL/)
  })

  it('ipcFail respeta exactOptionalPropertyTypes: sin detail, no hay clave detail', () => {
    const result = ipcFail('BAD_INPUT', 'mal')
    if (result.ok) throw new Error('debería fallar')
    expect('detail' in result.error).toBe(false)
  })
})
