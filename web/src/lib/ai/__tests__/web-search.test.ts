/**
 * `web_search` — the always-on, Gateway-only web capability.
 *
 * Three properties are pinned here:
 *   1. Availability tracks the USE_GATEWAY kill switch (Exa is Gateway-only).
 *   2. The tool is PROVIDER-EXECUTED — it must not carry a local `execute`,
 *      because the Gateway runs the search and the SDK would otherwise try to.
 *   3. Its Exa config matches eve's built-in defaults (numResults 10 /
 *      highlights 1000 chars) plus the enrichment pipeline's safety knobs, so
 *      the two runtimes behave the same.
 *
 * Plus the cost harvest that gives the classic paths spend visibility for a
 * provider-executed tool whose cost never reaches providerMetadata.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { createWebSearchTool, isWebSearchAvailable, harvestWebSearchCost } from '../tools/web-search'

const ORIGINAL_USE_GATEWAY = process.env.USE_GATEWAY

afterEach(() => {
  if (ORIGINAL_USE_GATEWAY === undefined) delete process.env.USE_GATEWAY
  else process.env.USE_GATEWAY = ORIGINAL_USE_GATEWAY
})

describe('isWebSearchAvailable — the USE_GATEWAY kill switch', () => {
  it('is available by default (env unset)', () => {
    delete process.env.USE_GATEWAY
    expect(isWebSearchAvailable()).toBe(true)
  })

  it('is available for any value other than the exact string "false"', () => {
    process.env.USE_GATEWAY = 'true'
    expect(isWebSearchAvailable()).toBe(true)
    process.env.USE_GATEWAY = ''
    expect(isWebSearchAvailable()).toBe(true)
  })

  it('is UNavailable when USE_GATEWAY=false — Exa has no direct-provider path', () => {
    process.env.USE_GATEWAY = 'false'
    expect(isWebSearchAvailable()).toBe(false)
  })
})

describe('createWebSearchTool', () => {
  it('returns a single `web_search` entry when Gateway is on', () => {
    delete process.env.USE_GATEWAY
    expect(Object.keys(createWebSearchTool())).toEqual(['web_search'])
  })

  it('returns {} when Gateway is off, so call sites can spread unconditionally', () => {
    process.env.USE_GATEWAY = 'false'
    expect(createWebSearchTool()).toEqual({})
  })

  it('is PROVIDER-EXECUTED: no local execute, flagged isProviderExecuted', () => {
    delete process.env.USE_GATEWAY
    const tool = createWebSearchTool().web_search as unknown as Record<string, unknown>
    expect(tool.execute).toBeUndefined()
    expect(tool.isProviderExecuted).toBe(true)
    // The provider id is what tells the Gateway to run Exa.
    expect(tool.id).toBe('gateway.exa_search')
  })

  it('carries eve-parity Exa defaults plus the enrichment safety knobs', () => {
    delete process.env.USE_GATEWAY
    const tool = createWebSearchTool().web_search as unknown as { args: Record<string, any> }
    // eve 0.47 built-in parity: 10 results, 1000-char highlights.
    expect(tool.args.numResults).toBe(10)
    expect(tool.args.contents.highlights.maxCharacters).toBe(1000)
    // Proven in src/lib/crm/enrichment.ts: bound the live crawl, prefer cache.
    expect(tool.args.contents.livecrawlTimeout).toBe(10_000)
    expect(tool.args.contents.maxAgeHours).toBe(168)
  })
})

describe('harvestWebSearchCost', () => {
  it('sums costDollars.total across every web_search result', () => {
    const steps = [
      { toolResults: [{ toolName: 'web_search', output: { costDollars: { total: 0.005 }, results: [] } }] },
      { toolResults: [{ toolName: 'web_search', output: { costDollars: { total: 0.0025 }, results: [] } }] },
    ]
    expect(harvestWebSearchCost(steps)).toBeCloseTo(0.0075, 6)
  })

  it('ignores workspace tool results, which carry no costDollars', () => {
    const steps = [
      { toolResults: [{ toolName: 'find', output: { results: [{ id: 'a' }] } }] },
      { toolResults: [{ toolName: 'list_actions', output: { actions: [] } }] },
      { toolResults: [{ toolName: 'web_search', output: { costDollars: { total: 0.01 } } }] },
    ]
    expect(harvestWebSearchCost(steps)).toBe(0.01)
  })

  // The harvest matches on SHAPE, not on the tool's map key — the same rule
  // harvestSearchResults uses in src/lib/crm/enrichment.ts, which registers the
  // identical Exa tool under `exa_search`. If the SDK or Gateway ever labelled a
  // provider-executed result with the provider tool id instead of the map key, a
  // name filter would silently harvest nothing; this pins that it does not.
  it('harvests Exa cost regardless of the label on the result', () => {
    const steps = [
      { toolResults: [{ toolName: 'gateway.exa_search', output: { costDollars: { total: 0.004 }, results: [] } }] },
      { toolResults: [{ output: { costDollars: { total: 0.001 }, results: [] } }] },
    ]
    expect(harvestWebSearchCost(steps)).toBeCloseTo(0.005, 6)
  })

  it('returns null (not 0) when no search ran, so callers can skip logging', () => {
    expect(harvestWebSearchCost([])).toBeNull()
    expect(harvestWebSearchCost(undefined)).toBeNull()
    expect(harvestWebSearchCost([{ toolResults: [] }])).toBeNull()
  })

  it('returns null when the search errored (Exa error branch — no costDollars)', () => {
    const steps = [
      { toolResults: [{ toolName: 'web_search', output: { error: 'rate_limit', message: 'slow down' } }] },
    ]
    expect(harvestWebSearchCost(steps)).toBeNull()
  })

  it('survives malformed / non-numeric outputs without throwing', () => {
    const steps = [
      { toolResults: [{ toolName: 'web_search', output: null }] },
      { toolResults: [{ toolName: 'web_search', output: { costDollars: { total: 'lots' } } }] },
      { toolResults: [{ toolName: 'web_search', output: { costDollars: { total: NaN } } }] },
      { toolResults: [{ toolName: 'web_search', output: { costDollars: { total: 0.002 } } }] },
    ]
    expect(harvestWebSearchCost(steps)).toBe(0.002)
  })
})
