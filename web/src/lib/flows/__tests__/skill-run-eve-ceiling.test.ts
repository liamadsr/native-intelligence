/**
 * Ceiling PARITY tests for the eve run_skill runtime (Phase 2).
 *
 * The load-bearing security invariant: the eve path must permit EXACTLY the same
 * tools the gateway path does — no more, no less — in report, act, and verdict
 * modes, with and without a triggering capture. Both paths now derive the ceiling
 * from computeSkillCeiling (extracted from assembleSkillRun), so this asserts
 * that (a) computeSkillCeiling matches what the gateway path historically built
 * inline, and (b) the eve internal tool-route's permit decision (search_tools
 * always allowed; empty ceiling = inherit-all; else membership) matches
 * pickPermittedTools's decision for the same ceiling.
 */
import { describe, it, expect } from 'vitest'
import {
  computeSkillCeiling,
  computeReportModeCeiling,
} from '../run-skill'
import {
  computeToolCeiling,
  pickPermittedTools,
} from '@/lib/ai/tool-discovery'
import { ALL_CATEGORY_IDS, ALL_TOOL_NAMES, ATTENDED_ONLY_TOOL_NAMES, CHAT_NATIVE_TOOL_NAMES, NON_CHAT_TOOL_NAMES, getMutatingToolNames } from '@/lib/ai/tool-registry'

type AgentConfig = Parameters<typeof computeSkillCeiling>[0]

/** The full workspace tool surface the eve tool route uses for the inherit-all
 *  permit decision — mirrors FULL_REGISTRY_TOOLS in the route (never a
 *  chat-native tool). */
const FULL_REGISTRY_TOOLS = new Set<string>([...NON_CHAT_TOOL_NAMES, 'search_tools'])

/** The gateway path's ORIGINAL inline ceiling logic (pre-extraction), reproduced
 *  here so we assert computeSkillCeiling didn't change behavior — with the one
 *  deliberate change since: a chat-native tool (start_helper, migration 299's
 *  hardening) is never in a skill run's ceiling. */
function gatewayCeilingInline(
  agentConfig: AgentConfig,
  mode: 'report' | 'act',
  hasCapture: boolean,
): Set<string> | null {
  const skillCategories = agentConfig?.enabled_tools ?? []
  const skillDisabled = agentConfig?.disabled_tools ?? []
  const isVerdict = agentConfig?.output_contract === 'verdict'
  const ceiling =
    mode === 'act' && !isVerdict
      ? computeToolCeiling(
          skillCategories.length > 0 ? skillCategories : undefined,
          skillDisabled.length > 0 ? skillDisabled : undefined,
        )
      : computeReportModeCeiling(skillCategories)
  if (hasCapture) {
    for (const name of ['get_capture_content', 'get_capture_transcript', 'get_capture_extractions']) {
      ceiling?.add(name)
    }
  }
  if (isVerdict) ceiling?.add('submit_run_verdict')
  for (const name of CHAT_NATIVE_TOOL_NAMES) ceiling?.delete(name)
  // Bots v3 Phase 5: an unattended skill run never holds an attended-only tool.
  for (const name of ATTENDED_ONLY_TOOL_NAMES) ceiling?.delete(name)
  return ceiling
}

const CASES: Array<{ name: string; config: AgentConfig; mode: 'report' | 'act'; hasCapture: boolean }> = [
  { name: 'report / no categories / no capture', config: null, mode: 'report', hasCapture: false },
  { name: 'report / documents / capture', config: { enabled_tools: ['documents'] }, mode: 'report', hasCapture: true },
  // NB: 'no categories' in act mode is NOT inherit-all — computeToolCeiling only
  // returns null (inherit-all) when EVERY category is enabled. See the explicit
  // inherit-all case below.
  { name: 'act / no categories (core-only ceiling)', config: null, mode: 'act', hasCapture: false },
  { name: 'act / all categories (inherit-all → null ceiling)', config: { enabled_tools: [...ALL_CATEGORY_IDS] }, mode: 'act', hasCapture: false },
  { name: 'act / all categories + capture (still inherit-all)', config: { enabled_tools: [...ALL_CATEGORY_IDS] }, mode: 'act', hasCapture: true },
  { name: 'act / actions+documents / no capture', config: { enabled_tools: ['actions', 'documents'] }, mode: 'act', hasCapture: false },
  { name: 'act / actions disabled create_action', config: { enabled_tools: ['actions'], disabled_tools: ['create_action'] }, mode: 'act', hasCapture: false },
  { name: 'verdict (runs report ceiling regardless of act)', config: { enabled_tools: ['actions'], output_contract: 'verdict' }, mode: 'act', hasCapture: false },
  { name: 'verdict + capture', config: { output_contract: 'verdict' }, mode: 'report', hasCapture: true },
]

describe('computeSkillCeiling == gateway inline ceiling (no behavior drift)', () => {
  for (const c of CASES) {
    it(c.name, () => {
      const extracted = computeSkillCeiling(c.config, c.mode, c.hasCapture)
      const inline = gatewayCeilingInline(c.config, c.mode, c.hasCapture)
      // Both null (inherit-all) or both the same set.
      if (inline === null) {
        expect(extracted).toBeNull()
      } else {
        expect(extracted).not.toBeNull()
        expect([...extracted!].sort()).toEqual([...inline].sort())
      }
    })
  }
})

describe('eve tool-route permit decision == pickPermittedTools decision', () => {
  // A registry-faithful stand-in tools map: every REAL registry tool name (plus
  // search_tools). Using the real registry — not a hand-picked list — is what
  // makes the inherit-all (null) comparison meaningful: the gateway path's
  // pickPermittedTools(null) grants exactly the createTools() surface, which the
  // registry mirrors, so the eve route (which permits any tool in the full
  // registry when the ceiling is null) must agree name-for-name.
  const allNames = [...FULL_REGISTRY_TOOLS]
  const toolsMap = Object.fromEntries(allNames.map((n) => [n, { _tool: n }]))

  /**
   * The eve internal tool route's permit rule (mirrors the route EXACTLY):
   * search_tools always; a non-null ceiling gates by membership; a NULL ceiling
   * (inherit-all) permits any tool that EXISTS in the full registry — never any
   * string. `ceiling` is the raw computeSkillCeiling result (null OR a non-empty
   * Set — it never returns an empty Set).
   */
  function evePermits(ceiling: Set<string> | null, name: string): boolean {
    return name === 'search_tools' || (ceiling ? ceiling.has(name) : FULL_REGISTRY_TOOLS.has(name))
  }

  for (const c of CASES) {
    it(`${c.name}: permit set matches pickPermittedTools`, () => {
      const ceilingSet = computeSkillCeiling(c.config, c.mode, c.hasCapture)
      // The route passes the RAW ceilingSet (null = inherit-all) to its permit
      // check; pickPermittedTools takes undefined for inherit-all.
      const ceilingArg = ceilingSet ?? undefined
      // pickPermittedTools keeps search_tools + ceiling members; undefined = all.
      const picked = pickPermittedTools(toolsMap, ceilingArg)
      const pickedNames = new Set(Object.keys(picked))
      // The eve route permits exactly the names pickPermittedTools kept.
      for (const name of allNames) {
        expect(evePermits(ceilingSet, name), `${name} (${c.name})`).toBe(pickedNames.has(name))
      }
    })
  }

  it('inherit-all (null ceiling) permits real registry tools but NOT prototype-magic names', () => {
    const ceiling = computeSkillCeiling({ enabled_tools: [...ALL_CATEGORY_IDS] }, 'act', false)
    expect(ceiling).toBeNull() // this case IS inherit-all
    // A real registry tool is permitted.
    expect(evePermits(ceiling, 'list_actions')).toBe(true)
    expect(evePermits(ceiling, 'search_tools')).toBe(true)
    // Prototype-magic names and non-registry names are NOT permitted even under
    // inherit-all — the null ceiling means "any tool that exists", not "any string".
    for (const magic of ['__proto__', 'constructor', 'hasOwnProperty', 'toString', 'not_a_real_tool']) {
      expect(evePermits(ceiling, magic), magic).toBe(false)
    }
  })

  it('a chat-native tool (start_helper) is never in a skill ceiling nor permitted, inherit-all included', () => {
    expect(ALL_TOOL_NAMES).toContain('start_helper')
    for (const c of CASES) {
      const ceiling = computeSkillCeiling(c.config, c.mode, c.hasCapture)
      expect(ceiling?.has('start_helper') ?? false, c.name).toBe(false)
      expect(evePermits(ceiling, 'start_helper'), c.name).toBe(false)
    }
  })
})

describe('report/verdict ceilings never leak a mutating tool (eve path)', () => {
  const mutating = getMutatingToolNames()
  for (const c of CASES.filter((c) => c.mode === 'report' || c.config?.output_contract === 'verdict')) {
    it(`${c.name}: no mutating tool in the ceiling`, () => {
      const ceiling = computeSkillCeiling(c.config, c.mode, c.hasCapture)
      // Report + verdict always produce a non-null ceiling.
      expect(ceiling).not.toBeNull()
      const leaked = [...ceiling!].filter((n) => mutating.has(n))
      expect(leaked).toEqual([])
    })
  }
})
