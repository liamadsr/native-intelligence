/**
 * set_tool_access (F2): tightening applies at once; loosening (turning a tool
 * on, adding a new one, dropping an approval) only ever from the person's
 * card, and only on the app as the card saw it. A planted instruction can
 * never widen access.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  row: null as null | Record<string, unknown>,
  updates: [] as Array<Record<string, unknown>>,
  approvals: [] as Array<Record<string, unknown>>,
}))
vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => ({}) }))
vi.mock('@/lib/safety/approvals', () => ({
  createToolApproval: vi.fn(async (_s: unknown, approval: Record<string, unknown>) => {
    state.approvals.push(approval)
    return { ok: true, approvalId: 'appr-1', cardId: 'card-1' }
  }),
}))

import { createConnectionTools } from '../connections'
import { mcpToolState, withToolAccess } from '@/lib/mcp-client/tool-access'

const OPTS = { toolCallId: 't', messages: [] } as never
const ID = '22222222-2222-4222-8222-222222222222'
type Result = Record<string, unknown> & { success: boolean }

const db = {
  from: () => {
    const chain: Record<string, unknown> = {}
    let pendingUpdate: Record<string, unknown> | null = null
    chain.select = () => chain
    chain.eq = () => chain
    chain.update = (u: Record<string, unknown>) => {
      pendingUpdate = u
      return chain
    }
    chain.maybeSingle = async () => ({ data: state.row, error: null })
    chain.then = (resolve: (v: unknown) => void) => {
      if (pendingUpdate) {
        state.updates.push(pendingUpdate)
        state.row = { ...state.row, ...pendingUpdate }
      }
      resolve({ data: null, error: null })
    }
    return chain
  },
} as never

const run = (input: Record<string, unknown>, approvedCall?: unknown) =>
  createConnectionTools('u1', db, 'ws-1', { conversationId: 'c1', approvedCall: approvedCall as never }).set_tool_access.execute!(input as never, OPTS) as unknown as Promise<Result>

beforeEach(() => {
  state.row = {
    id: ID,
    user_id: 'u1',
    display_name: 'Acme',
    server_url: 'https://mcp.acme.dev/mcp',
    access_token_encrypted: 'SECRET',
    tools_cache: [
      { name: 'list_items', annotations: { readOnlyHint: true } },
      { name: 'create_item', annotations: {} },
      { name: 'purge_items', annotations: { destructiveHint: true } },
    ],
    disabled_tools: [],
    allowed_tools: ['list_items', 'create_item'],
    require_approval_tools: ['create_item'],
    approval_free_tools: [],
  }
  state.updates = []
  state.approvals = []
})

describe('set_tool_access', () => {
  it('tightening applies at once, with no card', async () => {
    const r = await run({ connection_id: ID, tool: 'create_item', access: 'off' })
    expect(r).toMatchObject({ success: true, changed: ['create_item: asks first → off'] })
    expect(state.updates[0].disabled_tools).toEqual(['create_item'])
    expect(state.approvals).toEqual([])
  })

  it('letting a write run without asking is only the person\'s card; nothing changes until they accept', async () => {
    const r = await run({ connection_id: ID, tool: 'create_item', access: 'read_only' })
    expect(r).toMatchObject({ success: false, code: 'APPROVAL_REQUIRED', waiting_on_card: ['create_item: asks first → runs without asking'] })
    expect(state.updates).toEqual([])
    const held = state.approvals[0]
    expect(held).toMatchObject({ door: 'chat', toolName: 'set_tool_access', sideEffect: 'automation-write' })
    // Only the real arguments; the words are in title and why.
    expect(held.input).toEqual({ connection_id: ID, tool: 'create_item', access: 'read_only' })
    expect((held.card as { title: string }).title).toBe('Let create_item in Acme run without asking?')
    expect((held.card as { why: string }).why).toContain('It can change things in Acme')
  })

  it('adding a new tool (not on the allow-list) is loosening too', async () => {
    const r = await run({ connection_id: ID, tool: 'purge_items', access: 'ask' })
    expect(r.code).toBe('APPROVAL_REQUIRED')
    expect((state.approvals[0].card as { title: string }).title).toBe('Turn on purge_items in Acme?')
  })

  it('the accepted card applies, on the app as it saw it; a changed app refuses', async () => {
    await run({ connection_id: ID, tool: 'create_item', access: 'read_only' })
    const connection = (state.approvals[0].context as { connection: unknown }).connection
    const ok = await run({ connection_id: ID, tool: 'create_item', access: 'read_only' }, { approvalId: 'appr-1', tool: 'set_tool_access', connection })
    expect(ok.success).toBe(true)
    expect(state.updates[0]).toMatchObject({ require_approval_tools: [], approval_free_tools: ['create_item'] })

    // A fresh card, then the server re-lists its tools before the Accept: refused.
    state.updates = []
    state.approvals = []
    await run({ connection_id: ID, tool: 'purge_items', access: 'ask' })
    const pending = (state.approvals[0].context as { connection: unknown }).connection
    state.row = { ...state.row, tools_cache: [...(state.row!.tools_cache as unknown[]), { name: 'new_tool' }] }
    const refused = await run({ connection_id: ID, tool: 'purge_items', access: 'ask' }, { approvalId: 'appr-2', tool: 'set_tool_access', connection: pending })
    expect(refused).toMatchObject({ success: false, code: 'CONNECTION_CHANGED' })
    expect(state.updates).toEqual([])
  })

  it('every tool, read_only: reads keep running, everything else goes off, at once', async () => {
    const r = await run({ connection_id: ID, access: 'read_only' })
    expect(r.success).toBe(true)
    expect(state.updates[0].disabled_tools).toEqual(['create_item', 'purge_items'])
    expect(state.approvals).toEqual([])
  })

  it('a mixed change applies the tightening now and cards the rest', async () => {
    const r = await run({ connection_id: ID, access: 'ask' })
    expect(r).toMatchObject({ code: 'APPROVAL_REQUIRED', changed_now: ['list_items: runs without asking → asks first'], waiting_on_card: ['purge_items: not added → asks first'] })
    expect(state.updates).toHaveLength(1)
  })

  it("a catalog app's publish tool can never be set to run without asking (Typefully, decision 2)", async () => {
    state.row = { ...state.row, display_name: 'Typefully', server_url: 'https://mcp.typefully.com/mcp', tools_cache: [{ name: 'typefully_create_draft' }, { name: 'list_drafts', annotations: { readOnlyHint: true } }], allowed_tools: null, require_approval_tools: [] }
    const one = await run({ connection_id: ID, tool: 'typefully_create_draft', access: 'read_only' })
    expect(one).toMatchObject({ success: false, error: expect.stringMatching(/always asks/) })
    // Every tool, read_only: the publish tool goes off (reads only), never free.
    const all = await run({ connection_id: ID, access: 'read_only' })
    expect(all.success).toBe(true)
    expect(state.updates.at(-1)!.disabled_tools).toEqual(['typefully_create_draft'])
    expect(state.approvals).toEqual([])
  })

  it('an unknown tool or app says so; no secret ever leaves', async () => {
    expect((await run({ connection_id: ID, tool: 'nope', access: 'off' })).success).toBe(false)
    state.row = null
    expect((await run({ connection_id: ID, access: 'off' })).success).toBe(false)
  })
})

describe('withToolAccess / mcpToolState', () => {
  const server = { server_url: 'https://mcp.acme.dev/mcp', disabled_tools: [], allowed_tools: ['list_a', 'w'], require_approval_tools: [], approval_free_tools: [] }
  it('reads the state each tool is in (a server we don\'t know: only a plain read runs)', () => {
    expect(mcpToolState({ name: 'list_a', annotations: { readOnlyHint: true } }, server)).toBe('read_only')
    expect(mcpToolState({ name: 'w', annotations: { readOnlyHint: true } }, server)).toBe('ask')
    expect(mcpToolState({ name: 'x' }, server)).toBe('new')
  })
  it('off keeps the approval pin, so switching it back on anywhere never frees it (F2 review S1)', () => {
    const off = withToolAccess({ ...server, require_approval_tools: ['w'] }, 'w', 'off', true)
    expect(off).toMatchObject({ disabled_tools: ['w'], require_approval_tools: ['w'] })
    const pinned = withToolAccess(server, 'w', 'off', true)
    expect(pinned.require_approval_tools).toEqual(['w'])
  })
  it('records each tool in at most one list, and adds it to the allow-list', () => {
    const lists = withToolAccess(server, 'x', 'read_only', true)
    expect(lists).toMatchObject({ allowed_tools: ['list_a', 'w', 'x'], approval_free_tools: ['x'], require_approval_tools: [], disabled_tools: [] })
    const back = withToolAccess(lists, 'x', 'ask', true)
    expect(back).toMatchObject({ approval_free_tools: [], require_approval_tools: ['x'] })
  })
})
