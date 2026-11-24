/**
 * Who may call the Dreamer's tools (docs/plans/dreamer.md "Who may call
 * what"): the four Dreamer-only tools (read_parent_thread, write_agent_notes,
 * delete_agent_notes, notify_parent) are refused in every other ceiling (main
 * chat, channel turns, team chat, teammates, guests, other helpers and work
 * runs, skill runs, home turns, the check-in, the Mac body), by the trust
 * authority too; the main chat and its home turns hold the three reads; the
 * Dreamer's own ceiling holds its seven tools and no draft or document write.
 */
import { describe, expect, it } from 'vitest'
import {
  AGENT_NOTES_READ_TOOL_NAMES,
  ALL_TOOL_NAMES,
  DREAMER_ONLY_TOOL_NAMES,
  NON_CHAT_TOOL_NAMES,
  PARENT_NOTES_TOOL_NAMES,
  getToolDefinition,
} from '@/lib/ai/tool-registry'
import {
  DREAMER_RUN_TOOL_NAMES,
  SERVER_HELPER_WRITE_TOOLS,
  ceilingForWorkRun,
  ceilingForWorkRunTurn,
  computeDraftingCeiling,
  computeWorkRunCeiling,
  dreamerChatCeiling,
  runStartSection,
  serverHelperChatCeiling,
} from '@/lib/agent-run/run-work-spec-rebuild'
import {
  HOME_TURN_ACTING_REASONS,
  SERVER_TURN_EXCLUDED_TOOLS,
  TEAMMATE_CHAT_EXCLUDED_TOOLS,
  composeTeammateChatCeiling,
  isToolExcludedForSurface,
  serverTurnMayCall,
} from '@/lib/chat/chat-ceiling'
import { HOME_TURN_TOKEN_REASONS, type HomeTurnTokenReason } from '@/lib/chat/chat-run-token'
import { CALLER_CLASSES, callerMayCall } from '@/lib/safety/caller'
import { macCeiling } from '@/lib/local-agent/agent-access'
import { GUEST_OFFERABLE_TOOLS } from '@/lib/guests/presets'
import { computeSkillCeiling } from '@/lib/flows/run-skill'
import { mcpToolName } from '@/lib/mcp/tool-names'

const DREAMER_ONLY = [...DREAMER_ONLY_TOOL_NAMES]
const READS = [...AGENT_NOTES_READ_TOOL_NAMES]
const ALL_SEVEN = [...PARENT_NOTES_TOOL_NAMES]

describe('the registry', () => {
  it('holds the seven tools, the reads classed read', () => {
    expect(ALL_SEVEN.sort()).toEqual(['delete_agent_notes', 'list_agent_notes', 'notify_parent', 'read_agent_notes', 'read_parent_thread', 'search_agent_notes', 'write_agent_notes'])
    for (const name of ALL_SEVEN) expect(ALL_TOOL_NAMES, name).toContain(name)
    for (const name of [...READS, 'read_parent_thread']) expect(getToolDefinition(name)?.sideEffect, name).toBe('read')
    expect(getToolDefinition('write_agent_notes')?.sideEffect).toBe('internal-write')
    expect(getToolDefinition('notify_parent')?.sideEffect).toBe('internal-write')
    // Every delete_* tool is classed delete (tool-side-effects.test.ts).
    expect(getToolDefinition('delete_agent_notes')?.sideEffect).toBe('delete')
  })
})

describe("the Dreamer's own ceiling", () => {
  const bound = dreamerChatCeiling()
  const ceiling = ceilingForWorkRun('chat', null, bound, 'dreamer')

  it('holds its seven tools and the server helper reads, and no draft, document or proposed edit', () => {
    for (const name of ALL_SEVEN) expect(ceiling.has(name), name).toBe(true)
    for (const name of SERVER_HELPER_WRITE_TOOLS) {
      expect(bound, name).not.toContain(name)
      expect(ceiling.has(name), name).toBe(false)
    }
    const helperReads = serverHelperChatCeiling().filter((n) => !SERVER_HELPER_WRITE_TOOLS.includes(n))
    expect(bound).toEqual([...new Set([...helperReads, ...DREAMER_RUN_TOOL_NAMES])].sort())
    // Beyond its own tools, nothing but reads.
    for (const name of ceiling) if (!PARENT_NOTES_TOOL_NAMES.has(name)) expect(getToolDefinition(name)?.sideEffect, name).toBe('read')
    // Even a row whose bound names a review-pile write gets none: its profile is reads and its own tools.
    const wide = ceilingForWorkRun('chat', null, [...bound, ...SERVER_HELPER_WRITE_TOOLS], 'dreamer')
    for (const name of SERVER_HELPER_WRITE_TOOLS) expect(wide.has(name), name).toBe(false)
  })

  it('a follow-up chat turn on its run never holds the four Dreamer-only tools', async () => {
    const run = { id: 'r', kind: 'workspace', origin: 'chat', chat_ceiling: bound, server_helper: 'dreamer', ai_team_member_id: null, teammate: null }
    const own = await ceilingForWorkRunTurn({} as never, run, { workspaceId: 'w', chat: undefined })
    for (const name of ALL_SEVEN) expect(own.has(name), name).toBe(true)
    const chat = await ceilingForWorkRunTurn({ from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) }) }) }) } as never, run, { workspaceId: 'w', chat: true })
    for (const name of DREAMER_ONLY) expect(chat.has(name), name).toBe(false)
  })

  it('its run starts by saying nobody asked and nobody answers', () => {
    const section = runStartSection('chat', 'dreamer')
    expect(section).toContain('Native Intelligence started this run on a schedule. Nobody is watching and nobody will answer a question: never ask one.')
    expect(section).not.toMatch(/A person asked/)
    expect(runStartSection('chat', 'home_turn')).toMatch(/A person asked/)
  })
})

describe('every other work run', () => {
  it('holds none of the seven, whatever its origin or stored bound', () => {
    for (const ceiling of [
      computeWorkRunCeiling(),
      computeDraftingCeiling(),
      ceilingForWorkRun('user'),
      ceilingForWorkRun('attempt'),
      ceilingForWorkRun('chat', null, serverHelperChatCeiling(), 'meeting_prep'),
      ceilingForWorkRun('chat', null, serverHelperChatCeiling(), 'home_turn'),
      ceilingForWorkRun('chat', null, serverHelperChatCeiling(), 'check_in'),
      // A bound that names them is not enough: only a Dreamer run's profile has them.
      ceilingForWorkRun('chat', null, dreamerChatCeiling(), null),
      ceilingForWorkRun('user', null, dreamerChatCeiling(), 'dreamer'),
    ]) {
      for (const name of ALL_SEVEN) expect(ceiling.has(name), name).toBe(false)
    }
  })

  it('nor a skill run, inherit-all or a skill selecting their category', () => {
    for (const name of ALL_SEVEN) expect(NON_CHAT_TOOL_NAMES, name).not.toContain(name)
    for (const mode of ['act', 'report'] as const) {
      const ceiling = computeSkillCeiling({ enabled_tools: ['library'] }, mode, false)
      for (const name of ALL_SEVEN) expect(ceiling?.has(name) ?? false, `${mode} ${name}`).toBe(false)
    }
  })
})

describe('the chat ceilings', () => {
  it("the main chat holds the three reads and never the Dreamer's own four (both halves read isToolExcludedForSurface)", () => {
    for (const name of DREAMER_ONLY) expect(isToolExcludedForSurface(name, undefined), name).toBe(true)
    for (const name of READS) expect(isToolExcludedForSurface(name, undefined), name).toBe(false)
  })

  it("every surface refuses the Dreamer's own four; Slack (DMs and channel threads alike), team chat and a linked agent refuse the reads too", () => {
    for (const surface of ['device_ask', 'slack', 'sms', 'call', 'team_chat', 'dial8'] as const) {
      for (const name of DREAMER_ONLY) expect(isToolExcludedForSurface(name, surface), `${surface} ${name}`).toBe(true)
    }
    // A Slack channel thread's reply is read by the channel: the person's notes, Now file and profile never go there.
    for (const surface of ['slack', 'team_chat', 'dial8'] as const) {
      for (const name of READS) expect(isToolExcludedForSurface(name, surface), `${surface} ${name}`).toBe(true)
    }
    // The person's own text, call or desk device answers them alone: the reads stay.
    for (const surface of ['sms', 'call', 'device_ask'] as const) {
      for (const name of READS) expect(isToolExcludedForSurface(name, surface), `${surface} ${name}`).toBe(false)
    }
  })

  it('a teammate chat holds none of the seven, whatever its persona selects', () => {
    for (const name of ALL_SEVEN) expect(TEAMMATE_CHAT_EXCLUDED_TOOLS.has(name), name).toBe(true)
    const ceiling = composeTeammateChatCeiling(null, { allowed_side_effects: ['read', 'internal-write', 'delete'], tool_allowlist: null, agentConfig: { enabled_tools: ['library'] } })
    for (const name of ALL_SEVEN) expect(ceiling.has(name), name).toBe(false)
  })

  it("no server turn holds the Dreamer's own four: every home turn reason, the check-in, idle compaction", () => {
    for (const name of DREAMER_ONLY) expect(SERVER_TURN_EXCLUDED_TOOLS.has(name), name).toBe(true)
    for (const reason of [...HOME_TURN_TOKEN_REASONS] as HomeTurnTokenReason[]) {
      for (const name of DREAMER_ONLY) expect(serverTurnMayCall(name, 'home_turn', reason), `${reason} ${name}`).toBe(false)
    }
    for (const name of DREAMER_ONLY) {
      expect(serverTurnMayCall(name, 'home_turn', undefined), name).toBe(false)
      expect(serverTurnMayCall(name, 'idle_compaction', undefined), name).toBe(false)
    }
  })

  it("the Dreamer's home turn opens the notes, acts, and may start a helper (a helper's report may not)", () => {
    expect(HOME_TURN_TOKEN_REASONS.has('dreamer')).toBe(true)
    expect(HOME_TURN_ACTING_REASONS.has('dreamer')).toBe(true)
    for (const name of READS) expect(serverTurnMayCall(name, 'home_turn', 'dreamer'), name).toBe(true)
    expect(serverTurnMayCall('start_helper', 'home_turn', 'dreamer')).toBe(true)
    expect(serverTurnMayCall('start_helper', 'home_turn', 'helper_report')).toBe(false)
    // The check-in never reads them (its reads are internal text by name; notes quote outside sources).
    for (const name of READS) expect(serverTurnMayCall(name, 'home_turn', 'check_in'), name).toBe(false)
  })
})

describe('the trust authority', () => {
  it("runs the Dreamer's own four only on a Dreamer run's own turn", () => {
    for (const name of DREAMER_ONLY) {
      for (const caller of CALLER_CLASSES) expect(callerMayCall(caller, name), `${caller} ${name}`).toBe(false)
      expect(callerMayCall('agent_unattended', name, { dreamerRun: true }), name).toBe(true)
      expect(callerMayCall('person', name, { dreamerRun: true }), name).toBe(false)
      // Its MCP spelling is the same tool.
      expect(callerMayCall('person', mcpToolName(name)), name).toBe(false)
    }
  })

  it("the notes' reads are the owner's: never another person's or a guest's", () => {
    for (const name of READS) {
      expect(callerMayCall('person', name), name).toBe(true)
      expect(callerMayCall('agent_unattended', name), name).toBe(true)
      expect(callerMayCall('other_person', name), name).toBe(false)
      expect(callerMayCall('guest', name), name).toBe(false)
    }
  })
})

describe('the other doors', () => {
  it('the Mac body holds none of the seven', () => {
    for (const caller of ['person', 'agent_unattended'] as const) {
      const ceiling = macCeiling(null, [], { caller, localModel: false })
      for (const name of ALL_SEVEN) expect(ceiling.has(name), `${caller} ${name}`).toBe(false)
    }
  })

  it('the People tab never offers one to a guest', () => {
    for (const name of ALL_SEVEN) expect(GUEST_OFFERABLE_TOOLS, name).not.toContain(name)
  })
})
