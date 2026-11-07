/**
 * Web access is an ALWAYS-ON CAPABILITY, not a permission.
 *
 * The design contract, in three parts:
 *
 *   (a) `web_search` survives a narrow agent/edition ceiling — an allowlist
 *       cannot revoke web access, because it is not in the registry the
 *       allowlist is built from.
 *   (b) It is in the INITIAL activeTools, so the model can reach it from step
 *       one. It has to be: `search_tools` only ever surfaces REGISTRY tools, so
 *       nothing would ever discover it later.
 *   (c) It disappears cleanly when the Gateway kill switch is off (Exa is
 *       Gateway-only) — the run just has no web access, nothing throws.
 *
 * The COLLISION guard (web_search must never enter an eve spec's ceilingTools /
 * coreToolNames) lives in ./web-search-spec-collision.test.ts.
 */
import { describe, it, expect, afterEach } from 'vitest'
import {
  pickPermittedTools,
  computeInitialActiveTools,
  computeToolCeiling,
  ALWAYS_ON_CAPABILITY_TOOL_NAMES,
  CORE_TOOL_NAMES,
} from '../tool-discovery'
import { createWebSearchTool } from '../tools/web-search'

const ORIGINAL_USE_GATEWAY = process.env.USE_GATEWAY

afterEach(() => {
  if (ORIGINAL_USE_GATEWAY === undefined) delete process.env.USE_GATEWAY
  else process.env.USE_GATEWAY = ORIGINAL_USE_GATEWAY
})

/** Stand-in for a real tool impl — pickPermittedTools only moves references. */
const stub = () => ({ description: 'stub' })

describe('ALWAYS_ON_CAPABILITY_TOOL_NAMES', () => {
  it('is exactly web_search today', () => {
    expect(ALWAYS_ON_CAPABILITY_TOOL_NAMES).toEqual(['web_search'])
  })

  it('is DISJOINT from CORE_TOOL_NAMES — that separation is the collision guard', () => {
    // CORE_TOOL_NAMES flows into the eve specs' coreToolNames, where a
    // `web_search` entry would make eve build a workspace PROXY that shadows its
    // own native provider tool of the same name.
    for (const name of ALWAYS_ON_CAPABILITY_TOOL_NAMES) {
      expect(CORE_TOOL_NAMES).not.toContain(name)
    }
  })

  // THE SECURITY INVARIANT BEHIND THE EXEMPTION.
  //
  // pickPermittedTools is the single chokepoint that makes the live-agent
  // route's propose-only contract structural rather than advisory: the ceiling
  // gates the tools MAP, because the SDK will execute any model tool call that
  // exists in `tools` (see the comment at src/app/api/ai/live-agent/route.ts).
  // This list is a hole punched through that chokepoint, and it is only
  // legitimate while everything in it is READ-ONLY and PROVIDER-EXECUTED —
  // i.e. it has no `execute` we could be tricked into running, and it can only
  // ever return public search results. Adding a mutating tool to this list
  // would silently bypass propose-only on every one of the four call sites at
  // once, so assert the property over the LIST rather than over web_search
  // specifically.
  it('contains only read-only, provider-executed tools — the property that makes the ceiling exemption safe', () => {
    delete process.env.USE_GATEWAY
    const tools = createWebSearchTool() as Record<
      string,
      { execute?: unknown; isProviderExecuted?: unknown }
    >

    for (const name of ALWAYS_ON_CAPABILITY_TOOL_NAMES) {
      const impl = tools[name]
      // Every always-on name must actually be minted by the factory — a name
      // exempted from the ceiling but built nowhere is dead config.
      expect(impl, `${name} is exempt from the ceiling but not built by createWebSearchTool()`).toBeDefined()
      expect(impl.execute, `${name} must have no execute — it must not run in our process`).toBeUndefined()
      expect(impl.isProviderExecuted, `${name} must be provider-executed`).toBe(true)
    }
  })
})

describe('(a) web_search survives a narrow ceiling', () => {
  it('is kept by pickPermittedTools even when the ceiling excludes it', () => {
    // A deliberately tiny agent ceiling: one read tool, nothing else.
    const ceiling = new Set(['list_actions'])
    const tools = {
      ...createWebSearchTool(),
      search_tools: stub(),
      list_actions: stub(),
      create_action: stub(),
    }

    const permitted = pickPermittedTools(tools, ceiling)

    expect(Object.keys(permitted).sort()).toEqual(['list_actions', 'search_tools', 'web_search'])
    // The ceiling still does its real job on everything else.
    expect(permitted).not.toHaveProperty('create_action')
  })

  it('survives an EMPTY ceiling (the most restrictive case there is)', () => {
    const tools = { ...createWebSearchTool(), create_action: stub() }
    const permitted = pickPermittedTools(tools, new Set<string>())
    expect(Object.keys(permitted)).toEqual(['web_search'])
  })

  it('is not INVENTED by pickPermittedTools — only preserved when present', () => {
    // Gateway-off runs build their map without it; the ceiling pass must not
    // conjure a key that has no implementation behind it.
    const permitted = pickPermittedTools({ list_actions: stub() }, new Set(['list_actions']))
    expect(permitted).not.toHaveProperty('web_search')
  })

  it('a real narrow computeToolCeiling never contains it (it is not a registry tool)', () => {
    const ceiling = computeToolCeiling(['actions'], [])
    expect(ceiling).not.toBeNull()
    expect(ceiling!.has('web_search')).toBe(false)
  })
})

describe('(b) web_search is in the initial activeTools', () => {
  it('computeInitialActiveTools includes it with no skill categories', () => {
    expect(computeInitialActiveTools()).toContain('web_search')
  })

  it('computeInitialActiveTools includes it for a narrow skill selection too', () => {
    expect(computeInitialActiveTools(['actions'], [])).toContain('web_search')
  })

  it('still returns every CORE_TOOL_NAMES entry (the capability is additive)', () => {
    const active = computeInitialActiveTools()
    for (const core of CORE_TOOL_NAMES) expect(active).toContain(core)
  })
})

describe('(c) web_search is absent when the Gateway is disabled', () => {
  it('the tools map has no web_search, so the `in tools` filter drops it', () => {
    process.env.USE_GATEWAY = 'false'

    const tools = { ...createWebSearchTool(), search_tools: stub(), list_actions: stub() }
    expect(tools).not.toHaveProperty('web_search')

    // The call sites all gate activeTools on `name in tools`; replicate that.
    const active = computeInitialActiveTools().filter((name) => name in tools)
    expect(active).not.toContain('web_search')
  })
})
