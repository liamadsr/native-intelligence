import { describe, it, expect } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { createTools } from '@/lib/ai/tools'
import { EDITIONS, offFeatureDeniedToolNames } from '@/lib/editions'
import { offOverrides } from '@/test/editions'
import { registerTools } from '../index'

/**
 * Regression suite for the 2026-08-11 prod outage: PR #316 added `list_skills`
 * (and get/create/update_skill) to the AI chat toolset, whose auto-prefixed
 * MCP name `dial8_list_skills` collided with the hand-registered library tool.
 * McpServer.tool throws on duplicate names, so EVERY authenticated /api/mcp
 * request 500'd at server construction.
 *
 * These tests register the REAL chat toolset through the REAL registration
 * path, so any future chat tool whose `dial8_`-prefixed name collides with a
 * hand-registered MCP tool fails here instead of in production.
 */

// Registration only builds closures over the supabase client — it must never
// query. A chainable no-op proxy satisfies any accidental builder-style access
// without wiring a real client. (`then` is explicitly undefined so the stub is
// never mistaken for a thenable.)
function chainableStub(): unknown {
  const stub: unknown = new Proxy(function () {}, {
    get: (_target, prop) => (prop === 'then' ? undefined : stub),
    apply: () => stub,
  })
  return stub
}

const fakeSupabase = chainableStub() as SupabaseClient

async function buildRegisteredServer(): Promise<McpServer> {
  const server = new McpServer({ name: 'dial8-test', version: '0.0.0' })
  await registerTools(server, 'user-1', fakeSupabase, 'ws-1', 'Test Workspace')
  return server
}

// `resolveWorkspaceEdition` reads `workspace.settings`; a client that returns
// this blob is what a workspace with that settings row looks like.
async function buildServerWithSettings(settings: Record<string, unknown>): Promise<McpServer> {
  const supabase = {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: { settings }, error: null }),
        }),
      }),
    }),
  } as unknown as SupabaseClient
  const server = new McpServer({ name: 'dial8-test', version: '0.0.0' })
  await registerTools(server, 'user-1', supabase, 'ws-1', 'Test Workspace')
  return server
}

function registeredToolMap(server: McpServer): Record<string, { description?: string }> {
  return (server as unknown as { _registeredTools: Record<string, { description?: string }> })
    ._registeredTools
}


describe('discovery and dispatch', () => {
  /*
   * These two names are the contract with every already-connected client: a
   * catalog fetched months ago still contains them, which is the only reason a
   * stale session can reach a tool that shipped since. Renaming either one
   * silently breaks that, so the names are pinned here.
   */
  it('exposes dial8_search_tools and dial8_call_tool through the real registration path', async () => {
    const tools = registeredToolMap(await buildRegisteredServer())
    expect(tools['dial8_search_tools']).toBeDefined()
    expect(tools['dial8_call_tool']).toBeDefined()
  })

  it('does not let them collide with a bridged chat tool', async () => {
    const aiTools = createTools('user-1', fakeSupabase, 'ws-1')
    expect(Object.keys(aiTools)).not.toContain('search_tools')
    expect(Object.keys(aiTools)).not.toContain('call_tool')
  })
})

describe('registerTools name collisions', () => {
  it('registers the full toolset without throwing on duplicate names', async () => {
    await expect(buildRegisteredServer()).resolves.toBeInstanceOf(McpServer)
  })

  it('keeps the hand-registered MCP variant when a chat tool shares its name', async () => {
    const tools = registeredToolMap(await buildRegisteredServer())

    // The MCP-specific description references `dial8_get_skill`; the chat
    // variant references bare `get_skill`. If the chat variant ever wins the
    // name, the MCP safety defaults (visibility='personal', lightweight list
    // fields) are silently lost.
    expect(tools['dial8_list_skills']?.description).toContain('dial8_get_skill')
  })

  it('still exposes every executable chat tool that does not collide', async () => {
    const tools = registeredToolMap(await buildRegisteredServer())

    // Every feature is on for a workspace with no overrides (manifest
    // invariant 5), and the fail-open `full` resolution above is one, so no
    // feature gate withholds anything here.
    expect(offFeatureDeniedToolNames({ edition: EDITIONS.full, overrides: {} }).size).toBe(0)

    const aiTools = createTools('user-1', fakeSupabase, 'ws-1')
    for (const [name, def] of Object.entries(aiTools)) {
      if (!(def as { execute?: unknown }).execute) continue
      // A person's connector holds settle_card and revise_email_draft, never
      // undo_extraction_pass (bots v3 Phase 5, src/lib/mcp/attended-tools.ts).
      // read_card reads a card on the person's chat screen; a connector has none.
      // connect, disconnect and set_tool_access (F2): the Connect card is a chat
      // card, and widening or removing a connection is done in the app.
      // review_post (content C0): its reviewer must be another vendor than an
      // MCP client's model, which is unknown to us.
      // update_now: the person's Now file is written only from their chat in the app.
      // finish_getting_started: getting started is ended only from their chat in the app.
      // unsubscribe_thread (GEN-1166): only on the person's approval card in the app.
      // connect_link: a texted link goes only to the person's phone, from their own text turn.
      if (['undo_extraction_pass', 'update_now', 'finish_getting_started', 'read_card', 'connect', 'disconnect', 'set_tool_access', 'review_post', 'publish_post', 'schedule_post', 'unsubscribe_thread', 'connect_link'].includes(name)) {
        expect(tools[`dial8_${name}`], `dial8_${name} is withheld from MCP`).toBeUndefined()
        continue
      }
      expect(tools[`dial8_${name}`], `dial8_${name} missing from MCP registry`).toBeDefined()
    }
  })

  // The feature gate, end to end through the real registration path. Evals is
  // on by default now, so the workspace switches it off in its settings.
  it('registers NO eval tool when the workspace has evals off', async () => {
    const tools = registeredToolMap(
      await buildServerWithSettings({ feature_overrides: offOverrides(['evals']) }),
    )
    expect(Object.keys(tools).filter((n) => n.includes('eval'))).toEqual([])
  })

  it('keeps a feature-off tool out of dial8_search_tools / dial8_call_tool too', async () => {
    const tools = registeredToolMap(
      await buildServerWithSettings({ feature_overrides: offOverrides(['evals']) }),
    ) as unknown as Record<
      string,
      { handler: (args: Record<string, unknown>, extra: unknown) => Promise<{ content: { text: string }[] }> }
    >
    const found = await tools['dial8_search_tools'].handler({ name: 'start_eval_run' }, {})
    expect(JSON.parse(found.content[0].text).found).toBe(false)
  })

  it('registers the hand-written eval tools on a workspace with no overrides', async () => {
    const tools = registeredToolMap(await buildServerWithSettings({}))
    expect(tools['dial8_list_evals']).toBeDefined()
    expect(tools['dial8_create_eval_suite']).toBeDefined()
  })

  it('would have caught the PR #316 outage: duplicate registration throws in the SDK', () => {
    // Sanity-check the failure mode this suite guards against — if the SDK
    // ever stops throwing on duplicates, the skip logic (and this suite's
    // premise) should be revisited.
    const server = new McpServer({ name: 'dial8-test', version: '0.0.0' })
    const noop = async () => ({ content: [] })
    server.tool('dup', 'first', { a: z.string() }, noop)
    expect(() => server.tool('dup', 'second', { a: z.string() }, noop)).toThrow(
      /already registered/,
    )
  })
})

// bots-v4 Phase A1 / A2: the main agent's bot-work tools (the two reads, and
// the two writes on that work) reach a person's own connector
// (src/lib/mcp/attended-tools.ts).
describe('the bot-work tools (dial8_list_bot_work, dial8_get_bot_item, dial8_settle_work_item, dial8_send_work_answer)', () => {
  const NAMES = ['dial8_list_bot_work', 'dial8_get_bot_item', 'dial8_settle_work_item', 'dial8_send_work_answer']

  it('a person’s own connector has all four', async () => {
    const tools = registeredToolMap(await buildRegisteredServer())
    for (const name of NAMES) expect(tools[name], name).toBeDefined()
  })

  it('speaks of the person’s agent in the third person (one face): it’s a client acting for them, not the agent', async () => {
    const description = registeredToolMap(await buildRegisteredServer()).dial8_list_bot_work.description ?? ''
    expect(description).toContain("The agent marked self is the person's own Native Intelligence agent")
    expect(description).toContain("'Your agent…'")
    expect(description).not.toContain('The agent marked self is you')
  })
})

// A1b review H1: the loop builders are attended only. A person's own connector
// is the person acting, so it keeps them (src/lib/mcp/attended-tools.ts).
describe('the loop builders (dial8_create_flow, dial8_update_flow, dial8_delete_flow)', () => {
  const NAMES = ['dial8_create_flow', 'dial8_update_flow', 'dial8_delete_flow']

  it('a person’s own connector has all three, and the reads', async () => {
    const tools = registeredToolMap(await buildRegisteredServer())
    for (const name of [...NAMES, 'dial8_list_flows', 'dial8_list_flow_runs']) expect(tools[name], name).toBeDefined()
  })
})

// The library writers: a person's own connector holds all six (hand-registered
// over MCP: dial8_create/update/delete_skill and _agent), and the reads.
describe('the library writers (dial8_create/update/delete_skill and _agent)', () => {
  const NAMES = [
    'dial8_create_skill',
    'dial8_update_skill',
    'dial8_delete_skill',
    'dial8_create_agent',
    'dial8_update_agent',
    'dial8_delete_agent',
  ]
  const READS = ['dial8_list_skills', 'dial8_get_skill', 'dial8_list_agents', 'dial8_get_agent']

  it('a person’s own connector has all six, and the reads', async () => {
    const tools = registeredToolMap(await buildRegisteredServer())
    for (const name of [...NAMES, ...READS]) expect(tools[name], name).toBeDefined()
  })
})
