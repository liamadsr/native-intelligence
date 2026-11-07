import { afterEach, describe, expect, it } from 'vitest'
import {
  HELPERS_KILL_SWITCH_ENV,
  HELPER_EXCLUDED_TOOL_NAMES,
  helperSpecFields,
  helperToolNames,
  helpersGate,
  isHelperTool,
} from '../helpers-gate'
import { ALL_TOOL_NAMES, ATTENDED_ONLY_TOOL_NAMES, CHAT_NATIVE_TOOL_NAMES, getToolDefinition } from '@/lib/ai/tool-registry'

/**
 * Quick helpers (A4 slice 3): the gate the spec route computes from the
 * verified token, and the read-plus-drafts tool set a helper holds.
 */
describe('helpersGate: main chat only', () => {
  afterEach(() => {
    delete process.env[HELPERS_KILL_SWITCH_ENV]
  })

  it('allows the attended main chat, a side chat and an area-focused one', () => {
    expect(helpersGate({})).toEqual({ allowed: true })
    // focusArea is not a gate input at all: a focused conversation is the main agent's.
    expect(helpersGate({ surface: undefined, teammateId: undefined })).toEqual({ allowed: true })
  })

  it.each([
    ['a device ask', { surface: 'device_ask' as const }, /device ask/],
    ["a bot's thread or conversation", { teammateId: 'tm-1' }, /agent's conversation/],
    ['a relayed turn', { teammateId: 'tm-1', relay: 'r-1' }, /relayed turn/],
    ['a server-minted token (idle compaction)', { server: 'idle_compaction' as const }, /started by the server/],
  ])('refuses %s, with the reason', (_label, claims, reason) => {
    const gate = helpersGate(claims)
    expect(gate.allowed).toBe(false)
    if (!gate.allowed) expect(gate.reason).toMatch(reason)
  })

  it('the kill switch refuses every conversation', () => {
    process.env[HELPERS_KILL_SWITCH_ENV] = '1'
    expect(helpersGate({})).toMatchObject({ allowed: false, reason: expect.stringMatching(/switched off/) })
    process.env[HELPERS_KILL_SWITCH_ENV] = 'true'
    expect(helpersGate({}).allowed).toBe(false)
    process.env[HELPERS_KILL_SWITCH_ENV] = '0'
    expect(helpersGate({}).allowed).toBe(true)
  })

  it('helperSpecFields: no tools and a reason when refused', () => {
    const tools = [{ name: 'find' }, { name: 'show' }]
    expect(helperSpecFields({}, tools)).toEqual({ helpersAllowed: true, helperToolNames: ['find'] })
    expect(helperSpecFields({ surface: 'device_ask' }, tools)).toMatchObject({ helpersAllowed: false, helperToolNames: [] })
  })
})

describe('isHelperTool: read plus drafts', () => {
  it('admits reads and artifact writes (drafts, documents)', () => {
    for (const name of ['find', 'list_actions', 'get_capture_content', 'create_email_draft', 'create_document', 'propose_document_edit']) {
      expect(isHelperTool(name), name).toBe(true)
    }
  })

  it('never admits an external write, a delete, an automation write or a board/CRM write', () => {
    for (const name of ALL_TOOL_NAMES) {
      const def = getToolDefinition(name)
      if (!def) continue
      const draftable = def.sideEffect === 'read' || (def.sideEffect === 'internal-write' && def.writeTarget === 'artifact')
      if (!draftable) expect(isHelperTool(name), name).toBe(false)
    }
  })

  it('never admits a card, the browser, remember, an attended-only or chat-native tool, or an MCP tool', () => {
    for (const name of HELPER_EXCLUDED_TOOL_NAMES) expect(isHelperTool(name), name).toBe(false)
    for (const name of ATTENDED_ONLY_TOOL_NAMES) expect(isHelperTool(name), name).toBe(false)
    for (const name of CHAT_NATIVE_TOOL_NAMES) expect(isHelperTool(name), name).toBe(false)
    for (const name of ['show', 'read_card', 'suggest_changes', 'remember', 'update_now', 'read_browser_page', 'run_browser_task', 'screenshot_browser']) {
      expect(isHelperTool(name), name).toBe(false)
    }
    expect(isHelperTool('mcp__linear__create_issue')).toBe(false)
    expect(isHelperTool('mcp_confirm_call')).toBe(false)
    expect(isHelperTool('__proto__')).toBe(false)
  })

  it('helperToolNames keeps the spec order and drops the rest', () => {
    expect(helperToolNames([{ name: 'create_action' }, { name: 'find' }, { name: 'push_action_to_jira' }, { name: 'list_projects' }])).toEqual([
      'find',
      'list_projects',
    ])
  })
})
