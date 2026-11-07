/**
 * The tools a guest can be given (src/lib/guests/presets.ts): every name is
 * real, the presets are what the owner was told, stored values are cleaned
 * fail-closed, and nothing offered is a tool a guest could never use.
 */
import { describe, expect, it } from 'vitest'
import {
  GUEST_NATIVE_TOOLS,
  GUEST_OFFERABLE_TOOLS,
  GUEST_PRESETS,
  GUEST_NEVER_TOOLS,
  GUEST_TOOL_GROUPS,
  GUEST_TOOL_SECTIONS,
  guestToolAsksByDefault,
  guestToolLabel,
  normalizeAskBefore,
  askToolsWithDefaults,
  normalizeAskTools,
  normalizeGuestTools,
  presetOf,
  presetSettings,
  toolsForGroups,
} from '../presets'
import { GUEST_ALWAYS_TOOLS, GUEST_ONLY_TOOL_NAMES } from '../tools'
import { ATTENDED_ONLY_TOOL_NAMES, CHAT_NATIVE_TOOL_NAMES, TOOL_REGISTRY_MAP } from '@/lib/ai/tool-registry'
import { callerMayCall } from '@/lib/safety/caller'

describe('the tools a guest can be given', () => {
  it('each is a registry tool, a guest-only tool, or one of the agent’s own', () => {
    for (const name of GUEST_OFFERABLE_TOOLS) {
      const known = TOOL_REGISTRY_MAP.has(name) || GUEST_ONLY_TOOL_NAMES.has(name) || GUEST_NATIVE_TOOLS.includes(name)
      expect(known, name).toBe(true)
    }
  })

  it('none is attended-only or main-chat only, and the guest class may call every registry one', () => {
    for (const name of GUEST_OFFERABLE_TOOLS) {
      expect(ATTENDED_ONLY_TOOL_NAMES.has(name), name).toBe(false)
      expect(CHAT_NATIVE_TOOL_NAMES.has(name), name).toBe(false)
      if (!GUEST_NATIVE_TOOLS.includes(name)) expect(callerMayCall('guest', name, { guest: { askBefore: [] } }), name).toBe(true)
    }
  })

  it('every tool a guest could hold is offered, in sections, each once; the never set and main-chat tools are not', () => {
    const listed = GUEST_TOOL_SECTIONS.flatMap((s) => s.tools)
    expect(new Set(listed).size).toBe(listed.length)
    expect(new Set(GUEST_TOOL_SECTIONS.map((s) => s.id)).size).toBe(GUEST_TOOL_SECTIONS.length)
    expect(GUEST_TOOL_SECTIONS[0]).toMatchObject({ id: 'calendar', label: 'Calendar' })
    expect(GUEST_TOOL_SECTIONS[0].tools[0]).toBe('get_free_busy')
    expect(GUEST_TOOL_SECTIONS.find((s) => s.id === 'web')?.tools).toEqual(['web_search', 'web_fetch'])
    for (const name of ['list_emails', 'read_email', 'create_document', 'list_claims', 'push_action_to_linear', 'delete_action']) expect(listed, name).toContain(name)
    for (const name of [...GUEST_NEVER_TOOLS, 'start_helper', 'remember', 'create_flow', 'settle_card', 'lint_post', 'create_eval_suite', 'answer_guest']) expect(listed, name).not.toContain(name)
    // The always-on ones are fixed rows, not in a section.
    for (const name of GUEST_ALWAYS_TOOLS) expect(listed, name).not.toContain(name)
  })

  it('group ids are unique and every group has a tool', () => {
    expect(new Set(GUEST_TOOL_GROUPS.map((g) => g.id)).size).toBe(GUEST_TOOL_GROUPS.length)
    for (const group of GUEST_TOOL_GROUPS) expect(group.tools.length, group.id).toBeGreaterThan(0)
  })

  it('every label reads as words, not a tool name', () => {
    for (const name of GUEST_OFFERABLE_TOOLS) expect(guestToolLabel(name), name).not.toBe(name)
  })
})

describe('the presets', () => {
  it('Household: the calendar, tasks, contacts, drafts, web and bookings; payments and deletes ask, and what is outward shows as Needs approval', () => {
    const { tools, askTools, askBefore } = presetSettings('household')
    for (const name of ['get_calendar_events', 'create_calendar_event', 'delete_calendar_event', 'create_action', 'list_contacts', 'create_email_draft', 'web_search', 'run_browser_task', 'get_free_busy']) {
      expect(tools, name).toContain(name)
    }
    expect(askTools).toEqual(['create_calendar_event', 'update_calendar_event', 'delete_calendar_event', 'run_browser_task'])
    expect(askBefore).toEqual(['payments', 'deletes'])
  })

  it('Colleague: free/busy and meeting requests only, and every change asks', () => {
    const { tools, askTools, askBefore } = presetSettings('colleague')
    expect(tools).toEqual(['get_free_busy', 'create_calendar_event', ...GUEST_ALWAYS_TOOLS])
    expect(tools).not.toContain('get_calendar_events')
    expect(askTools).toEqual(['create_calendar_event'])
    expect(askBefore).toEqual(['payments', 'deletes', 'changes'])
  })

  it('every preset can reach the owner', () => {
    for (const preset of Object.values(GUEST_PRESETS)) {
      for (const name of GUEST_ALWAYS_TOOLS) expect(presetSettings(preset.id).tools, preset.id).toContain(name)
    }
  })

  it('presetOf names a preset exactly, and anything changed is custom', () => {
    const household = presetSettings('household')
    expect(presetOf(household)).toBe('household')
    expect(presetOf({ ...household, tools: [...household.tools].reverse() })).toBe('household')
    expect(presetOf({ ...household, askBefore: ['payments'] })).toBe('custom')
    expect(presetOf({ ...household, tools: household.tools.filter((t) => t !== 'run_browser_task') })).toBe('custom')
    expect(presetOf({ ...household, askTools: [...household.askTools, 'create_action'] })).toBe('custom')
    // An outward tool set to Always allow is the owner's own pick (2026-11-02): no longer the preset.
    expect(presetOf({ ...household, askTools: [] })).toBe('custom')
    const colleague = presetSettings('colleague')
    expect(presetOf(colleague)).toBe('colleague')
  })
})

describe('stored values are cleaned, failing closed', () => {
  it('tools: only offerable names, always the owner tools, in offer order', () => {
    expect(normalizeGuestTools(['create_flow', 'mcp__x__y', 42, 'get_free_busy', 'get_free_busy'])).toEqual(['get_free_busy', ...GUEST_ALWAYS_TOOLS])
    expect(normalizeGuestTools(null)).toEqual([...GUEST_ALWAYS_TOOLS])
    expect(normalizeGuestTools('get_free_busy')).toEqual([...GUEST_ALWAYS_TOOLS])
  })

  it('asks: missing or malformed is every ask; unknown words drop', () => {
    expect(normalizeAskBefore(undefined)).toEqual(['payments', 'deletes', 'changes'])
    expect(normalizeAskBefore('deletes')).toEqual(['payments', 'deletes', 'changes'])
    expect(normalizeAskBefore(['deletes', 'everything'])).toEqual(['deletes'])
    expect(normalizeAskBefore([])).toEqual([])
  })

  // Liam, 2026-11-02: "they can have a default but I get to control who can do that".
  it('Needs approval: only held tools, never an always-on one; a saved list is the owner’s word, a missing one each tool’s default', () => {
    const tools = normalizeGuestTools(['get_calendar_events', 'create_action', 'create_calendar_event', 'delete_action'])
    expect(normalizeAskTools(['create_action', 'list_emails', 'message_owner', 7], tools)).toEqual(['create_action'])
    // The owner set every outward and delete tool to Always allow.
    expect(normalizeAskTools([], tools)).toEqual([])
    // Never saved (null, a malformed value): each tool's default under the asks (missing asks: every ask).
    expect(normalizeAskTools(null, tools)).toEqual(['create_calendar_event', 'create_action', 'delete_action'])
    expect(normalizeAskTools('create_action', tools, ['payments', 'deletes'])).toEqual(['create_calendar_event', 'delete_action'])
    expect(guestToolAsksByDefault('create_action', ['changes'])).toBe(true)
    expect(guestToolAsksByDefault('create_calendar_event')).toBe(true)
    expect(guestToolAsksByDefault('delete_action')).toBe(true)
    // Missing asks are every ask, "any change at all" included: a write starts on Needs approval too.
    expect(guestToolAsksByDefault('create_action')).toBe(true)
    expect(guestToolAsksByDefault('create_action', ['payments', 'deletes'])).toBe(false)
    expect(guestToolAsksByDefault('get_free_busy')).toBe(false)
    // Deletes ask per person by default; outward always starts on Needs approval.
    expect(guestToolAsksByDefault('delete_action', ['payments'])).toBe(false)
    expect(guestToolAsksByDefault('delete_action', ['changes'])).toBe(true)
    expect(guestToolAsksByDefault('create_calendar_event', [])).toBe(true)
    expect(normalizeAskTools(null, tools, ['payments'])).toEqual(['create_calendar_event'])
  })

  it('a save with no asks of its own keeps the owner’s settings and starts only the newly given tools on their default', () => {
    const tools = normalizeGuestTools(['create_calendar_event', 'update_calendar_event', 'create_action'])
    // create_calendar_event was set to Always allow before; update_calendar_event is new.
    expect(askToolsWithDefaults([], ['update_calendar_event', 'create_action'], tools, ['payments', 'deletes'])).toEqual(['update_calendar_event'])
  })

  it('toolsForGroups ignores unknown groups', () => {
    expect(toolsForGroups(['nope'])).toEqual([...GUEST_ALWAYS_TOOLS])
  })
})
