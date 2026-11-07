import { describe, it, expect } from 'vitest'
import {
  BUILTIN_ASSISTANT_TOOL_SELECTION,
  LIVE_AGENT_CORE_READ_TOOLS,
  LIVE_AGENT_READ_TOOLS,
  narrowReadToolsByAgent,
  agentInheritsAllTools,
  type AgentToolSelection,
} from '../read-tool-names'
import { ALL_CATEGORY_IDS, getToolNamesForCategories } from '@/lib/ai/tool-registry'

describe('narrowReadToolsByAgent', () => {
  const CORE = new Set(LIVE_AGENT_CORE_READ_TOOLS)

  it('inherit-all (the built-in Assistant selection) returns the full read set unchanged', () => {
    const out = narrowReadToolsByAgent(BUILTIN_ASSISTANT_TOOL_SELECTION, LIVE_AGENT_READ_TOOLS)
    expect(out).toEqual(new Set(LIVE_AGENT_READ_TOOLS))
    // A fresh Set, not the original reference.
    expect(out).not.toBe(LIVE_AGENT_READ_TOOLS)
  })

  it('a persona row with a NULL config is core-only (Sequence step 1) — never inherit-all', () => {
    // Before the D.1 lockdown a null config was inherit-all here and core-only
    // in chat; now every runtime reads it the same way.
    expect(narrowReadToolsByAgent(null, LIVE_AGENT_READ_TOOLS)).toEqual(CORE)
    expect(narrowReadToolsByAgent(undefined, LIVE_AGENT_READ_TOOLS)).toEqual(CORE)
  })

  it('an absent enabled_tools key (nothing disabled) is core-only too', () => {
    expect(narrowReadToolsByAgent({ disabled_tools: [] }, LIVE_AGENT_READ_TOOLS)).toEqual(CORE)
    expect(narrowReadToolsByAgent({}, LIVE_AGENT_READ_TOOLS)).toEqual(CORE)
  })

  it('present-but-empty enabled_tools: [] is core-only — the live core reads, not nothing', () => {
    // [] is NOT inherit-all — the user explicitly stripped every category — and
    // it is not "no tools" either: like computeToolCeiling's CORE seed, the
    // empty selection keeps the live core reads (find/search/list_actions…).
    const out = narrowReadToolsByAgent({ enabled_tools: [], disabled_tools: [] }, LIVE_AGENT_READ_TOOLS)
    expect(out).toEqual(CORE)
    expect(out.has('get_package')).toBe(false)
    expect(out.has('search_claims')).toBe(false)
  })

  it('present-but-empty enabled_tools: [] (no disabled key) is the same core set', () => {
    expect(narrowReadToolsByAgent({ enabled_tools: [] }, LIVE_AGENT_READ_TOOLS)).toEqual(CORE)
  })

  it('a disabled tool is dropped from the core-only seed', () => {
    const out = narrowReadToolsByAgent({ enabled_tools: [], disabled_tools: ['find'] }, LIVE_AGENT_READ_TOOLS)
    expect(out.has('find')).toBe(false)
    expect(out.has('search')).toBe(true)
  })

  it('narrows to a single enabled category — only that category\'s read tools survive', () => {
    const out = narrowReadToolsByAgent({ enabled_tools: ['captures'] }, LIVE_AGENT_READ_TOOLS)
    // Capture read tools that ARE in the live read allowlist survive.
    expect(out.has('get_capture_content')).toBe(true)
    expect(out.has('list_captures')).toBe(true)
    // An actions-category read tool (in the read set, not in captures) is dropped.
    expect(out.has('list_actions')).toBe(false)
    // A write tool from the captures category is never in the read set to begin with.
    expect(out.has('create_capture')).toBe(false)
  })

  it('every survivor is both in the read set AND in the enabled categories', () => {
    const out = narrowReadToolsByAgent({ enabled_tools: ['captures', 'actions'] }, LIVE_AGENT_READ_TOOLS)
    const enabledNames = new Set(getToolNamesForCategories(['captures', 'actions']))
    for (const name of out) {
      expect(LIVE_AGENT_READ_TOOLS.has(name)).toBe(true)
      expect(enabledNames.has(name)).toBe(true)
    }
    // Non-empty: captures/actions both contribute reads.
    expect(out.size).toBeGreaterThan(0)
  })

  it('never WIDENS — the result is always a subset of the input read set', () => {
    // Even with every category enabled, the intersection can only equal the read set.
    const out = narrowReadToolsByAgent({ enabled_tools: [...ALL_CATEGORY_IDS] }, LIVE_AGENT_READ_TOOLS)
    for (const name of out) expect(LIVE_AGENT_READ_TOOLS.has(name)).toBe(true)
    // With everything enabled and nothing disabled, the read set passes through whole.
    expect(out).toEqual(new Set(LIVE_AGENT_READ_TOOLS))
  })

  it('disabled_tools-only config narrows the read set by exactly the disabled read tool', () => {
    // All categories enabled, one read tool disabled → that read tool drops, the
    // rest of the read surface survives.
    const cfg: AgentToolSelection = { enabled_tools: [...ALL_CATEGORY_IDS], disabled_tools: ['list_actions'] }
    const out = narrowReadToolsByAgent(cfg, LIVE_AGENT_READ_TOOLS)
    expect(out.has('list_actions')).toBe(false)
    // A sibling read tool is untouched.
    expect(out.has('get_action')).toBe(true)
    // Exactly one tool was removed from the full read set.
    expect(out.size).toBe(LIVE_AGENT_READ_TOOLS.size - 1)
  })

  it('disabling a tool that is not a read tool leaves the read set intact', () => {
    // create_action is a write tool — not in the read set — so disabling it, with
    // all categories enabled, removes nothing from the (read-only) surface.
    const cfg: AgentToolSelection = { enabled_tools: [...ALL_CATEGORY_IDS], disabled_tools: ['create_action'] }
    const out = narrowReadToolsByAgent(cfg, LIVE_AGENT_READ_TOOLS)
    expect(out).toEqual(new Set(LIVE_AGENT_READ_TOOLS))
  })
})

describe('agentInheritsAllTools', () => {
  it('is FALSE for null / undefined config, or a config whose enabled_tools key is absent (core-only)', () => {
    // Sequence step 1 (the D.1 lockdown): a null config and an absent key are
    // no longer inherit-all — they read like [] on every runtime.
    expect(agentInheritsAllTools(null)).toBe(false)
    expect(agentInheritsAllTools(undefined)).toBe(false)
    expect(agentInheritsAllTools({})).toBe(false)
    expect(agentInheritsAllTools({ disabled_tools: [] })).toBe(false)
    expect(agentInheritsAllTools({ enabled_tools: null, disabled_tools: null })).toBe(false)
  })

  it('is true for the built-in Assistant selection (every category on)', () => {
    expect(agentInheritsAllTools(BUILTIN_ASSISTANT_TOOL_SELECTION)).toBe(true)
  })

  it('is FALSE for a present-but-empty enabled_tools: [] (core/essentials-only, NOT inherit-all)', () => {
    // The empty-selection inversion: [] means the user stripped every category,
    // so it must NOT be treated as inherit-all.
    expect(agentInheritsAllTools({ enabled_tools: [], disabled_tools: [] })).toBe(false)
    expect(agentInheritsAllTools({ enabled_tools: [] })).toBe(false)
  })

  it('is true when every category is enabled and nothing is disabled', () => {
    expect(agentInheritsAllTools({ enabled_tools: [...ALL_CATEGORY_IDS], disabled_tools: [] })).toBe(true)
  })

  it('is false for a scoped selection', () => {
    expect(agentInheritsAllTools({ enabled_tools: ['captures'] })).toBe(false)
  })

  it('is false when the enabled_tools key is absent but a tool is disabled', () => {
    // A pure disabled_tools restriction is a real restriction, not inherit-all.
    expect(agentInheritsAllTools({ disabled_tools: ['list_actions'] })).toBe(false)
  })

  it('is false when all categories are enabled but a tool is disabled', () => {
    expect(agentInheritsAllTools({ enabled_tools: [...ALL_CATEGORY_IDS], disabled_tools: ['list_actions'] })).toBe(false)
  })
})
