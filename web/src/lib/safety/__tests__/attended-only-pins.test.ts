/**
 * Where the attended-only tools (ATTENDED_ONLY_TOOL_NAMES) are kept out today,
 * pinned before the move onto the one trust authority (caller.ts): the device
 * ask, a server turn, an unattended loop run and a work run's own turns never
 * hold one. A person's own chat does (its ceiling is not narrowed here).
 */
import { describe, it, expect } from 'vitest'
import { ATTENDED_ONLY_TOOL_NAMES, ALL_CATEGORY_IDS, NON_CHAT_TOOL_NAMES } from '@/lib/ai/tool-registry'
import { SERVER_TURN_EXCLUDED_TOOLS, SURFACE_EXCLUDED_TOOLS, isServerTurnTool } from '@/lib/chat/chat-ceiling'
import { computeSkillCeiling } from '@/lib/flows/run-skill'
import { ceilingForWorkRun } from '@/lib/agent-run/run-work-spec-rebuild'

const attendedOnly = [...ATTENDED_ONLY_TOOL_NAMES]

describe('attended-only tools: where they are kept out', () => {
  it('the device ask never reaches one', () => {
    for (const name of attendedOnly) expect(SURFACE_EXCLUDED_TOOLS.device_ask.has(name)).toBe(true)
  })

  it('a server turn never reaches one', () => {
    for (const name of attendedOnly) {
      expect(SERVER_TURN_EXCLUDED_TOOLS.has(name)).toBe(true)
      expect(isServerTurnTool(name)).toBe(false)
    }
  })

  it('an unattended loop run never holds one, in either mode, nor through inherit-all', () => {
    const configs = [{ enabled_tools: [...ALL_CATEGORY_IDS] }, { enabled_tools: [] }, null]
    for (const config of configs) {
      for (const mode of ['act', 'report'] as const) {
        const ceiling = computeSkillCeiling(config as never, mode, true)
        for (const name of attendedOnly) expect(ceiling ? ceiling.has(name) : NON_CHAT_TOOL_NAMES.includes(name)).toBe(false)
      }
    }
  })

  it('a work run’s own turns never hold one, whoever started it', () => {
    for (const origin of ['user', 'attempt', 'loop', 'chat', 'delegation', null]) {
      const ceiling = ceilingForWorkRun(origin)
      for (const name of attendedOnly) expect(ceiling.has(name)).toBe(false)
    }
  })
})
