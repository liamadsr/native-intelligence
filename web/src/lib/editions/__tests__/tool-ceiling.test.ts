/**
 * The EDITION tool ceiling and its composition with the agent ceiling.
 *
 * Follows the Workstream A pattern in
 * `src/lib/ai/__tests__/tool-ceiling-enforcement.test.ts`: the ceiling is only
 * real security when it gates the tools MAP (`pickPermittedTools`), not merely
 * discovery — the SDK executes any tool present in `tools`. These tests pin
 * both halves: what an edition's ceiling contains, and that intersecting it
 * with an agent ceiling can only ever NARROW.
 *
 * The chat consumes it through src/lib/chat/chat-ceiling.ts (resolveChatCeiling,
 * shared by chat-run-rebuild.ts and /api/internal/chat/tool — which also serve
 * /api/device/ask), which computes
 *   intersectCeilings(editionCeiling, agentCeiling) ∪ externalMcpToolNames.
 */
import { describe, it, expect } from 'vitest'
import { tool } from 'ai'
import { z } from 'zod'
import {
  computeEditionToolCeiling,
  intersectCeilings,
  withEffectiveSurface,
  EDITIONS,
} from '@/lib/editions'
import { pickPermittedTools, CORE_TOOL_NAMES } from '@/lib/ai/tool-discovery'
import { getToolNamesForCategories } from '@/lib/ai/tool-registry'
import { SCOPED } from '@/test/editions'

const fakeTool = () =>
  tool({ description: 'x', inputSchema: z.object({}), execute: async () => ({ ok: true }) })

describe('computeEditionToolCeiling', () => {
  it('every edition inherits everything: no ceiling, eval and browser tools included', () => {
    // `toolCategories: 'all'` means every category a DEFAULT-ON feature
    // contributes, and every feature is default-on (manifest invariant 5), so
    // the ceiling is null: the tools map passes through untouched.
    for (const edition of Object.values(EDITIONS)) {
      expect(computeEditionToolCeiling(edition), edition.id).toBeNull()
    }
    const evalNames = [...getToolNamesForCategories(['evals', 'browser'])]
    expect(evalNames.length).toBeGreaterThan(0)
    const map = Object.fromEntries(evalNames.map((n) => [n, fakeTool()]))
    const granted = pickPermittedTools(map, computeEditionToolCeiling(EDITIONS.sales))
    for (const name of evalNames) expect(granted[name], name).toBeDefined()
  })

  it('full + `evals: off` withholds exactly the eval tools', () => {
    const off = computeEditionToolCeiling(withEffectiveSurface(EDITIONS.full, { evals: 'off' }))!
    expect(off).not.toBeNull()
    for (const name of getToolNamesForCategories(['evals'])) {
      expect(off.has(name), `${name} must be withheld`).toBe(false)
    }
    expect(off.has('create_project')).toBe(true)
    expect(off.has('list_skills')).toBe(true)
  })

  it('a scoped sales preset drops the delivery-org tools (projects, flows) and keeps sequences', () => {
    const ceiling = computeEditionToolCeiling(SCOPED.sales)
    expect(ceiling).not.toBeNull()

    // Not in the sales tool-category set ⇒ absent from the ceiling.
    for (const name of getToolNamesForCategories(['projects', 'flows'])) {
      // CORE tools are unioned into every ceiling by computeToolCeiling; none of
      // the projects/flows tools are core, so this is an unambiguous assertion.
      expect(CORE_TOOL_NAMES).not.toContain(name)
      expect(ceiling!.has(name), `${name} must not be in the sales ceiling`).toBe(false)
    }

    // Sequences IS a sales category — outreach is the whole point of the edition.
    for (const name of getToolNamesForCategories(['sequences'])) {
      expect(ceiling!.has(name), `${name} must be in the sales ceiling`).toBe(true)
    }
  })

  it('a scoped notes preset drops sequences and knowledge; scoped brain keeps knowledge and flows', () => {
    const notes = computeEditionToolCeiling(SCOPED.notes)!
    const brain = computeEditionToolCeiling(SCOPED.brain)!

    for (const name of getToolNamesForCategories(['sequences'])) {
      expect(notes.has(name), `notes must not expose ${name}`).toBe(false)
      expect(brain.has(name), `brain must not expose ${name}`).toBe(false)
    }
    for (const name of getToolNamesForCategories(['knowledge', 'flows'])) {
      expect(notes.has(name), `notes must not expose ${name}`).toBe(false)
      expect(brain.has(name), `brain must expose ${name}`).toBe(true)
    }
  })

  it('every scoped ceiling still contains the core tool set', () => {
    // A scoped edition must never strand the assistant without its core surface
    // (search_tools especially — discovery is how it reaches the rest).
    for (const edition of [SCOPED.sales, SCOPED.notes, SCOPED.brain]) {
      const ceiling = computeEditionToolCeiling(edition)!
      for (const name of CORE_TOOL_NAMES) {
        expect(ceiling.has(name), `${edition.id} must keep core tool ${name}`).toBe(true)
      }
    }
  })
})

describe('intersectCeilings', () => {
  it('null is the identity on both sides (no limit from that side)', () => {
    const agent = new Set(['a', 'b'])
    expect(intersectCeilings(null, agent)).toBe(agent)
    expect(intersectCeilings(agent, null)).toBe(agent)
    expect(intersectCeilings(null, null)).toBeNull()
    expect(intersectCeilings(undefined, undefined)).toBeNull()
    expect(intersectCeilings(undefined, agent)).toBe(agent)
  })

  it('is a real intersection when both sides are sets', () => {
    const out = intersectCeilings(new Set(['a', 'b', 'c']), new Set(['b', 'c', 'd']))
    expect([...out!].sort()).toEqual(['b', 'c'])
  })

  it('NEVER widens: the result is a subset of both inputs', () => {
    // The safety property the three tool paths rely on. An agent allowlist
    // cannot re-grant a tool the edition hides, and a full workspace cannot
    // widen a narrowed agent.
    const edition = computeEditionToolCeiling(SCOPED.notes)!
    const agent = new Set([...getToolNamesForCategories(['projects', 'captures'])])
    const out = intersectCeilings(edition, agent)!
    for (const name of out) {
      expect(edition.has(name)).toBe(true)
      expect(agent.has(name)).toBe(true)
    }
    // Concretely: a project tool the AGENT allows is still gone, because the
    // notes edition does not carry the projects category.
    for (const name of getToolNamesForCategories(['projects'])) {
      expect(out.has(name), `${name} must not survive the notes edition`).toBe(false)
    }
  })

  it('empty intersection is a set, not null (a ceiling of nothing is still a ceiling)', () => {
    const out = intersectCeilings(new Set(['a']), new Set(['b']))
    expect(out).toBeInstanceOf(Set)
    expect(out!.size).toBe(0)
  })
})

describe('the edition ceiling gates the tools MAP (pickPermittedTools)', () => {
  it('a workspace without flows or projects cannot execute their tools even if they are in the map', () => {
    // Reproduces the routes' wiring: createTools returns the whole map; the
    // ceiling is what removes tools from it. Discovery-only filtering would
    // leave create_flow executable.
    const allTools: Record<string, ReturnType<typeof fakeTool>> = {
      search_tools: fakeTool(),
      list_actions: fakeTool(),
      create_flow: fakeTool(),
      list_projects: fakeTool(),
      create_sequence: fakeTool(),
    }
    const ceiling = computeEditionToolCeiling(SCOPED.sales)
    const permitted = pickPermittedTools(allTools, ceiling)

    expect(permitted.create_flow).toBeUndefined()
    expect(permitted.list_projects).toBeUndefined()
    expect(permitted.create_sequence).toBeDefined()
    expect(permitted.list_actions).toBeDefined()
    expect(permitted.search_tools).toBeDefined()
  })

  it('a full workspace passes the map through untouched (regression guard)', () => {
    const allTools: Record<string, ReturnType<typeof fakeTool>> = {
      search_tools: fakeTool(),
      create_flow: fakeTool(),
      list_projects: fakeTool(),
    }
    const permitted = pickPermittedTools(allTools, computeEditionToolCeiling(EDITIONS.full))
    expect(Object.keys(permitted).sort()).toEqual(Object.keys(allTools).sort())
  })

  it('the routes’ exact composition: edition ∩ agent, then ∪ external MCP', () => {
    // Mirrors chat/route.ts and chat-run-rebuild.ts verbatim: the MCP union is
    // applied AFTER the intersection, so a user-connected server's tools survive
    // both a narrow edition and a narrow agent (the user opted in explicitly).
    const editionCeiling = computeEditionToolCeiling(SCOPED.notes)
    const agentCeiling = new Set(['list_actions', 'create_flow'])
    const externalMcpToolNames = ['acme__do_thing']

    const combined = intersectCeilings(editionCeiling, agentCeiling)!
    const effective = new Set([...combined, ...externalMcpToolNames])

    expect(effective.has('list_actions')).toBe(true) // in both ceilings
    expect(effective.has('create_flow')).toBe(false) // agent yes, notes edition no
    expect(effective.has('acme__do_thing')).toBe(true) // user-connected MCP
  })
})
