/**
 * The FEATURE GATE on system library rows.
 *
 * `/create-eval` (migration 253) is an `is_system` recipe, which RLS makes
 * visible to every workspace. Every workspace has Evals on by default, but one
 * can switch it off (a stored `feature_overrides` 'off'), and then the skill
 * must be invisible everywhere the library is listed or resolved — otherwise
 * the slash command is there, runs, and can save nothing.
 *
 * What is pinned here is the SHAPE of the gate, on both library surfaces:
 *   - a list applies exactly one `.not('id','in','(<ids>)')` when gated…
 *   - …and NONE at all when the feature is on, so an ungated workspace issues
 *     byte-identical SQL to what it issued before the gate existed;
 *   - a get_* of a gated id reads as NOT FOUND without ever touching the table.
 */
import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createLibraryTools } from '../library'
import { registerLibraryTools } from '@/lib/mcp/tools/library'
import { offOverrides } from '@/test/editions'

const USER = 'user-1'
const WS = 'ws-1'
/** The `/create-eval` system skill (migration 253) — Evals' own recipe. */
const EVAL_SKILL_ID = '6b3f1d02-91ac-4e57-8c24-0a5f7d3e9b18'
/** The Evals and Browser playbooks (migration 319). */
const EVALS_PLAYBOOK_ID = '8e08678d-1944-4a10-95ec-b9e73a7feea4'
const BROWSER_PLAYBOOK_ID = 'eec790ec-399f-416d-8189-c883859ba8c3'
/** What a workspace with Evals and Browser off hides: both features' rows, in feature order. */
const GATED = `(${EVAL_SKILL_ID},${EVALS_PLAYBOOK_ID},${BROWSER_PLAYBOOK_ID})`

const EXEC = { toolCallId: 'c', messages: [], context: {} } as never

/**
 * A `recipe` + `workspace` client that RECORDS every `.not()` the query layer
 * applies. `workspace.settings` drives the edition resolution, so a test picks
 * the gate's state by handing over an overrides blob.
 */
function client(settings: Record<string, unknown>) {
  const nots: [string, string, string][] = []
  let tableCalls = 0

  const chain = (): Record<string, unknown> => {
    let proxy: Record<string, unknown>
    const self: Record<string, unknown> = {
      not: (col: string, op: string, val: string) => {
        nots.push([col, op, val])
        return proxy
      },
      then: (resolve: (r: unknown) => unknown) =>
        Promise.resolve({ data: [], error: null }).then(resolve),
      single: async () => ({ data: null, error: { message: 'no rows' } }),
    }
    // Every other builder method (select/eq/or/order/limit) just continues the
    // chain — and must hand back the PROXY, or the next hop finds nothing.
    proxy = new Proxy(self, {
      get: (t, p: string) => (p in t ? t[p] : () => proxy),
    })
    return proxy
  }

  const supabase = {
    from: (table: string) => {
      if (table === 'workspace') {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: { settings }, error: null }) }),
          }),
        }
      }
      tableCalls++
      return chain()
    },
  } as unknown as SupabaseClient

  return { supabase, nots, recipeCalls: () => tableCalls }
}

/** Evals and the browser both switched off. */
const OFF = { feature_overrides: offOverrides(['evals', 'browser']) }
/** Evals on; the browser still switched off. */
const ON = { feature_overrides: offOverrides(['browser']) }
/** No overrides: every feature is on, so nothing is gated. */
const ALL_ON = {}

describe('chat library tools — feature-gated system recipes', () => {
  it('list_skills excludes the gated id when evals is off', async () => {
    const { supabase, nots } = client(OFF)
    await createLibraryTools(USER, supabase, WS).list_skills.execute!({}, EXEC)
    expect(nots).toEqual([['id', 'in', GATED]])
  })

  it('list_skills stops hiding the eval rows when evals is on', async () => {
    const { supabase, nots } = client(ON)
    await createLibraryTools(USER, supabase, WS).list_skills.execute!({}, EXEC)
    expect(nots).toEqual([['id', 'in', `(${BROWSER_PLAYBOOK_ID})`]])
  })

  it('list_skills applies NO exclusion when every gated feature is on', async () => {
    const { supabase, nots } = client(ALL_ON)
    await createLibraryTools(USER, supabase, WS).list_skills.execute!({}, EXEC)
    expect(nots).toEqual([])
  })

  it('list_agents is gated the same way', async () => {
    const off = client(OFF)
    await createLibraryTools(USER, off.supabase, WS).list_agents.execute!({}, EXEC)
    expect(off.nots).toEqual([['id', 'in', GATED]])

    const on = client(ALL_ON)
    await createLibraryTools(USER, on.supabase, WS).list_agents.execute!({}, EXEC)
    expect(on.nots).toEqual([])
  })

  it('get_skill on a gated id is "not found" WITHOUT querying the table', async () => {
    const { supabase, recipeCalls } = client(OFF)
    const res = (await createLibraryTools(USER, supabase, WS).get_skill.execute!(
      { id: EVAL_SKILL_ID },
      EXEC,
    )) as { success: boolean; error?: string }
    expect(res).toEqual({ success: false, error: 'Skill not found' })
    // The `workspace` read does not count — only `recipe` does.
    expect(recipeCalls()).toBe(0)
  })

  it('get_skill on the SAME id succeeds through to the table when evals is on', async () => {
    const { supabase, recipeCalls } = client(ON)
    await createLibraryTools(USER, supabase, WS).get_skill.execute!({ id: EVAL_SKILL_ID }, EXEC)
    expect(recipeCalls()).toBe(1)
  })

  it('get_agent on a gated id is "not found" without querying', async () => {
    const { supabase, recipeCalls } = client(OFF)
    const res = (await createLibraryTools(USER, supabase, WS).get_agent.execute!(
      { id: EVAL_SKILL_ID },
      EXEC,
    )) as { success: boolean; error?: string }
    expect(res.success).toBe(false)
    expect(recipeCalls()).toBe(0)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// The MCP mirror of the same tools — same rows, same gate.
// ───────────────────────────────────────────────────────────────────────────

type Handler = (args: Record<string, unknown>) => Promise<unknown>

/** A minimal McpServer stand-in that just collects the handlers. */
function fakeServer() {
  const handlers: Record<string, Handler> = {}
  const server = {
    tool: (...args: unknown[]) => {
      const name = args[0] as string
      handlers[name] = args[args.length - 1] as Handler
    },
  }
  return { server, handlers }
}

describe('MCP library tools — feature-gated system recipes', () => {
  it('ni_list_skills excludes the gated ids when their features are off, and nothing by default', async () => {
    const off = client(OFF)
    const a = fakeServer()
    registerLibraryTools(a.server as never, USER, off.supabase, WS)
    await a.handlers['ni_list_skills']({})
    expect(off.nots).toEqual([['id', 'in', GATED]])

    const on = client(ALL_ON)
    const b = fakeServer()
    registerLibraryTools(b.server as never, USER, on.supabase, WS)
    await b.handlers['ni_list_skills']({})
    expect(on.nots).toEqual([])
  })

  it('ni_get_skill on a gated id never reaches the table', async () => {
    const { supabase, recipeCalls } = client(OFF)
    const { server, handlers } = fakeServer()
    registerLibraryTools(server as never, USER, supabase, WS)
    await handlers['ni_get_skill']({ id: EVAL_SKILL_ID })
    expect(recipeCalls()).toBe(0)
  })

  it('ni_get_agent on a gated id never reaches the table', async () => {
    const { supabase, recipeCalls } = client(OFF)
    const { server, handlers } = fakeServer()
    registerLibraryTools(server as never, USER, supabase, WS)
    await handlers['ni_get_agent']({ id: EVAL_SKILL_ID })
    expect(recipeCalls()).toBe(0)
  })
})
