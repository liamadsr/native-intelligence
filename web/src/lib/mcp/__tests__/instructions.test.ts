/**
 * The server `instructions` blob — the one thing every connected client treats
 * as system prompt for the whole session.
 *
 * It used to say "scope is sticky" and "START by calling ni_set_workspace".
 * That was true when the active workspace was a FENCE. It no longer is: writes
 * route by the entity's own workspace and creates route by an explicit
 * `workspace_id`. Left in place, that text now causes the bug it was written to
 * prevent — an agent that believes scope is sticky reads ENG-42 out of
 * Engineering, never passes its `workspace_id` back, and files the follow-up
 * wherever the connector happened to point.
 *
 * So the old phrasing is asserted ABSENT, not just the new phrasing present:
 * this is a regression that can only be reintroduced by someone re-adding a
 * sentence, and a "contains the new text" test would not catch that.
 */
import { describe, it, expect } from 'vitest'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { createMcpServer } from '../server'

const USER = 'user-1'
const WS = 'ws-1'
const WS_NAME = 'Native Intelligence Marketing'

/** Chainable no-op, except `workspace` which answers the name + settings read. */
function supabaseStub() {
  const chain = (single: unknown): Record<string, unknown> => {
    const self: Record<string, unknown> = {
      single: async () => ({ data: single, error: null }),
      maybeSingle: async () => ({ data: single, error: null }),
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ data: [], error: null }).then(resolve),
    }
    const proxy: Record<string, unknown> = new Proxy(self, {
      get: (t, p: string) => (p in t ? t[p] : () => proxy),
    })
    return proxy
  }
  return {
    from: (table: string) =>
      table === 'workspace' ? chain({ name: WS_NAME, settings: {} }) : chain(null),
  } as never
}

const instructionsOf = (server: McpServer): string =>
  (server.server as unknown as { _instructions?: string })._instructions ?? ''

async function build(scopes?: string[]): Promise<string> {
  return instructionsOf(
    await createMcpServer(USER, supabaseStub(), WS, undefined, { scopes, tokenId: null }),
  )
}

describe('workspace-scope section', () => {
  it('names the active workspace and calls it a DEFAULT, not a fence', async () => {
    const text = await build()
    expect(text).toContain(`Native Intelligence MCP — active workspace: "${WS_NAME}" (id ${WS}).`)
    expect(text).toContain('The active workspace is a DEFAULT, not a fence.')
  })

  it('teaches the routing protocol: read workspace_id off the row, pass it back', async () => {
    const text = await build()
    expect(text).toContain('Every row you read carries `workspace_id`')
    expect(text).toContain('`active_workspace`')
    expect(text).toMatch(/To act on an existing entity, pass its id/)
    expect(text).toMatch(/To CREATE, pass `workspace_id`/)
  })

  it('names the needs_workspace refusal so the agent recognises it', async () => {
    const text = await build()
    expect(text).toContain('needs_workspace')
  })

  it('demotes ni_set_workspace to optional pinning', async () => {
    const text = await build()
    expect(text).toContain('`ni_set_workspace` is optional')
  })

  it('drops the sticky-scope and set-workspace-first instructions entirely', async () => {
    const text = await build()
    expect(text).not.toMatch(/sticky/i)
    expect(text).not.toMatch(/START by calling/i)
    expect(text).not.toMatch(/The switch persists/i)
    expect(text).not.toMatch(/Every tool call is scoped to the active workspace/i)
  })
})

describe('the blocks the rewrite must NOT have eaten', () => {
  it('keeps the stale-tool-list escape hatch', async () => {
    const text = await build()
    expect(text).toContain('YOUR TOOL LIST MAY BE OUT OF DATE')
    expect(text).toContain('`ni_search_tools`')
    expect(text).toContain('`ni_call_tool`')
  })

  it('keeps the knowledge loop', async () => {
    const text = await build()
    expect(text).toContain('Knowledge loop')
    expect(text).toContain('dial8://brief/workspace')
    expect(text).toContain('ni_search_claims')
    expect(text).toContain('ni_create_claim')
  })

  it('keeps the read-only line, and only for a read-only token', async () => {
    expect(await build(['read'])).toContain("token is READ-ONLY")
    expect(await build(['read', 'write'])).not.toContain('READ-ONLY')
    expect(await build()).not.toContain('READ-ONLY')
  })
})
