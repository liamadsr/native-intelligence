import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTools } from '../tools'
import {
  ALL_TOOL_NAMES,
  TOOL_REGISTRY_MAP,
  LIVE_AGENT_RESOLVER_TOOL_NAMES,
  LIVE_AGENT_ONLY_RESOLVER_TOOLS,
  getLiveAgentResolverDefinition,
  isReadShapedToolName,
} from '../tool-registry'
import { CORE_TOOL_NAMES } from '../tool-discovery'
import { LIVE_AGENT_READ_TOOLS } from '@/lib/live-agent/read-tool-names'
import { createLiveAgentTools } from '@/lib/live-agent/tools'

/**
 * The tool REGISTRY (tool-registry.ts) is the index that `search_tools` searches.
 * It is decoupled from the actual tool implementations in `src/lib/ai/tools/*`,
 * so the two can silently drift:
 *
 *   - A registry name with NO matching tool → search_tools advertises a tool the
 *     model can never call (prepareStep filters it out): "tools aren't resolving".
 *   - A real tool MISSING from the registry → search_tools can never surface it,
 *     so any code path that relies on discovery (cloud chat, the live agent's
 *     research-before-propose reads) can't reach it.
 *
 * These tests lock the registry to reality. They are the guard that the
 * 2026-06 registry-drift bug (2 phantom contact tools + 10 undiscoverable reads)
 * can never come back unnoticed.
 *
 * The builders capture `supabase` in their `execute` closures but never touch it
 * at construction time, so a stub client is enough to enumerate the real keys.
 */
const stubSupabase = {} as unknown as SupabaseClient
const realToolKeys = new Set([
  // The chat route assembles the live tool set as
  //   { search_tools: createSearchToolsTool(), ...createTools(...), ...externalMcp }
  // search_tools is the always-present discovery meta-tool, added at the route
  // level rather than inside createTools — include it so CORE_TOOL_NAMES (which
  // lists it) validates against the real, assembled tool set.
  'search_tools',
  ...Object.keys(createTools('test-user', stubSupabase, 'test-workspace')),
])

/**
 * Tools that are intentionally NOT in the registry. These are exposed directly
 * (in CORE_TOOL_NAMES / always-active) and never need to be discovered via
 * search_tools, so leaving them out of the searchable index is correct.
 */
const NOT_IN_REGISTRY_BY_DESIGN = new Set<string>([
  'ask_user', // core clarifying-question tool, always available, resolved client-side
  'search_tools', // the discovery meta-tool itself — never a search_tools result
])

describe('tool registry ↔ implementation sync', () => {
  it('every registry tool name maps to a real tool (no phantom entries)', () => {
    const phantom = ALL_TOOL_NAMES.filter((name) => !realToolKeys.has(name))
    expect(phantom).toEqual([])
  })

  it('every real tool is in the registry (discoverable via search_tools)', () => {
    const undiscoverable = [...realToolKeys].filter(
      (name) => !TOOL_REGISTRY_MAP.has(name) && !NOT_IN_REGISTRY_BY_DESIGN.has(name),
    )
    expect(undiscoverable).toEqual([])
  })

  it('every CORE_TOOL_NAME is a real tool', () => {
    const missing = CORE_TOOL_NAMES.filter((name) => !realToolKeys.has(name))
    expect(missing).toEqual([])
  })
})

describe('live-agent read allowlist is fully discoverable', () => {
  it('every allowlisted read tool exists as a real tool', () => {
    const missing = [...LIVE_AGENT_READ_TOOLS].filter((name) => !realToolKeys.has(name))
    expect(missing).toEqual([])
  })

  it('every allowlisted read tool is in the registry (search_tools can surface it)', () => {
    // The live agent is prompted to discover its reads via search_tools. A read
    // that is allowlisted but absent from the registry can never be surfaced —
    // exactly the failure that made the agent appear to "not resolve" tools.
    const undiscoverable = [...LIVE_AGENT_READ_TOOLS].filter(
      (name) => !TOOL_REGISTRY_MAP.has(name),
    )
    expect(undiscoverable).toEqual([])
  })
})

/**
 * The live agent's five hand-rolled READ resolvers (createLiveAgentTools), promoted
 * into the registry as LIVE_AGENT_RESOLVER_TOOL_NAMES (LIVE-AGENT-DESIGN §4.6) —
 * kept OUT of TOOL_CATEGORIES (the per-agent allowlist every other runtime grants
 * from). Two of them share a name with a registry read tool; for those the
 * registry entry is the one definition.
 */
describe('live-agent resolver tools are registered', () => {
  const liveKeys = new Set(Object.keys(createLiveAgentTools('test-user', stubSupabase, 'test-workspace', 'test-capture', null, null)))

  it('every promoted resolver is a real tool — hand-rolled (live-only) or the registry’s (shared name)', () => {
    const phantom = LIVE_AGENT_RESOLVER_TOOL_NAMES.filter((name) => !liveKeys.has(name) && !realToolKeys.has(name))
    expect(phantom).toEqual([])
  })

  it('the shared-name resolvers are NOT re-implemented in createLiveAgentTools (no shadowed duplicate)', () => {
    for (const name of ['list_workspace_members', 'list_labels']) {
      expect(liveKeys.has(name), `${name} is hand-rolled again in createLiveAgentTools`).toBe(false)
    }
    for (const { name } of LIVE_AGENT_ONLY_RESOLVER_TOOLS) expect(liveKeys.has(name), name).toBe(true)
  })

  it('every promoted resolver has exactly one registry definition, and it is read-shaped', () => {
    for (const name of LIVE_AGENT_RESOLVER_TOOL_NAMES) {
      const def = getLiveAgentResolverDefinition(name)
      expect(def?.name, name).toBe(name)
      expect(isReadShapedToolName(name), name).toBe(true)
    }
  })

  it('the shared-name resolvers resolve to the REGISTRY tool (the one that runs)', () => {
    for (const name of ['list_workspace_members', 'list_labels']) {
      expect(ALL_TOOL_NAMES).toContain(name)
      expect(realToolKeys.has(name)).toBe(true)
      expect(LIVE_AGENT_READ_TOOLS.has(name)).toBe(true)
      expect(getLiveAgentResolverDefinition(name)).toBe(TOOL_REGISTRY_MAP.get(name)?.tool)
      expect(LIVE_AGENT_ONLY_RESOLVER_TOOLS.some((t) => t.name === name), `${name} has a second definition`).toBe(false)
    }
  })

  it('the live-only resolvers stay out of the per-agent categories and out of createTools', () => {
    for (const { name } of LIVE_AGENT_ONLY_RESOLVER_TOOLS) {
      expect(ALL_TOOL_NAMES, name).not.toContain(name)
      expect(realToolKeys.has(name), name).toBe(false)
      expect(LIVE_AGENT_RESOLVER_TOOL_NAMES as readonly string[]).toContain(name)
    }
    // Exactly the three with no registry twin.
    expect(LIVE_AGENT_ONLY_RESOLVER_TOOLS.map((t) => t.name).sort()).toEqual(
      ['get_project_details', 'search_contacts', 'search_projects'],
    )
  })

  it('a name that is not a resolver has no resolver definition', () => {
    expect(getLiveAgentResolverDefinition('propose_change')).toBeUndefined()
    expect(getLiveAgentResolverDefinition('create_action')).toBeUndefined()
  })
})
