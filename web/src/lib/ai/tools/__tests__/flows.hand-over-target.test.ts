/**
 * Handing a loop to a new owner re-checks what its event trigger watches, for
 * the NEW owner (flow-approvals.ts handOverTargetProblem, the save-time
 * eventTriggerTargetProblem run for them): a chat loop's channel, a record
 * loop's table. A loop runs as its owner and fires only on what they can
 * read, so handed to someone who can't, it would start nothing, silently.
 * Every path that hands one over asks, and on a no it changes nothing and
 * says what they can't read, never naming the table or channel (it may be the
 * old owner's private one):
 *   - transfer_flow_owner: before the new owner's card is raised, and on
 *     their Accept;
 *   - request_flow_takeover: before the owner's card is raised (the asker),
 *     and on the owner's Accept (the editor's "Take over" button runs the
 *     same tool).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import type { ApprovedCall } from '@/lib/safety/approved-call'

const TABLE = '33333333-3333-4333-8333-333333333333'
const CHANNEL = '44444444-4444-4444-8444-444444444444'
/** Who can read the table and the channel, as the service-role checks see it. */
const access = vi.hoisted(() => ({ table: new Set<string>(), channel: new Set<string>(), tableCalls: [] as string[] }))

vi.mock('@/lib/supabase/service', () => ({
  getServiceClient: () => ({
    from: (table: string) => {
      const q: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'is']) q[m] = () => q
      q.maybeSingle = async () => ({ data: table === 'data_table' ? { id: TABLE } : null, error: null })
      return q
    },
    rpc: async (fn: string, args: { p_user_id: string; p_ids: string[] }) => {
      if (fn !== 'visible_data_table_ids') return { data: null, error: { message: 'no stub' } }
      access.tableCalls.push(args.p_user_id)
      return { data: access.table.has(args.p_user_id) ? args.p_ids : [], error: null }
    },
  }),
}))
vi.mock('@/lib/knowledge/entity-fences', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/knowledge/entity-fences')>()),
  visiblePrivateKindIds: async (_db: unknown, _kind: string, userId: string, ids: string[]) => new Set(access.channel.has(userId) ? ids : []),
}))
vi.mock('@/lib/flows/flow-bot', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/flows/flow-bot')>()),
  defaultFlowBot: async () => ({ teammateId: 'bot-default', created: false }),
}))
const approvals = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }))
vi.mock('@/lib/safety/approvals', () => ({
  createToolApproval: async (_client: unknown, approval: Record<string, unknown>) => {
    approvals.calls.push(approval)
    return { ok: true, approvalId: `appr-${approvals.calls.length}`, cardId: `card-${approvals.calls.length}` }
  },
}))

import { createFlowTools } from '../flows'

const USER = 'user-1'
const OTHER = 'user-2'
const WS = 'ws-1'
const EXEC = { toolCallId: 'c', messages: [], context: {} } satisfies ToolExecutionOptions<Record<string, unknown>>
type Row = Record<string, unknown>

/** The tool's own client: an in-memory table store (eq / in filters, update, single). */
function makeClient(seed: Record<string, Row[]>) {
  const tables: Record<string, Row[]> = Object.fromEntries(Object.entries(seed).map(([k, v]) => [k, v.map((r) => ({ ...r }))]))
  const from = (table: string) => {
    tables[table] ??= []
    const preds: Array<(r: Row) => boolean> = []
    let payload: Row | null = null
    let proxy: Record<string, unknown>
    const run = () => {
      const rows = tables[table].filter((r) => preds.every((p) => p(r)))
      if (payload) for (const r of rows) Object.assign(r, payload)
      return rows
    }
    const self: Record<string, unknown> = {
      eq: (col: string, val: unknown) => ((preds.push((r) => r[col] === val)), proxy),
      in: (col: string, vals: unknown[]) => ((preds.push((r) => vals.includes(r[col]))), proxy),
      update: (p: Row) => ((payload = p), proxy),
      single: async () => {
        const row = run()[0]
        return { data: row ?? null, error: row ? null : { message: 'no rows' } }
      },
      maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: run(), error: null }).then(resolve),
    }
    proxy = new Proxy(self, { get: (t, p: string) => (p in t ? t[p] : () => proxy) })
    return proxy
  }
  return { client: { from } as never, tables }
}

const recordTrigger = { trigger_type: 'record_created', trigger_config: { kind: 'record_created', table_id: TABLE } }
const chatTrigger = { trigger_type: 'chat_message', trigger_config: { kind: 'chat_message', channel_id: CHANNEL, mentions_only: false } }

function world(trigger: Row) {
  return makeClient({
    member: [
      { id: 'm-1', user_id: USER, workspace_id: WS, role: 'member', display_name: 'Liam' },
      { id: 'm-2', user_id: OTHER, workspace_id: WS, role: 'member', display_name: 'Sam' },
    ],
    flow: [
      {
        id: 'flow-1', workspace_id: WS, team_id: null, name: 'New leads', enabled: true,
        actions: [{ id: 'a-1', type: 'archive_capture', config: {}, condition: null, parent_id: null, enabled: true }],
        created_by: USER, next_run_at: null, ...trigger,
      },
    ],
    flow_run: [],
  })
}

const call = async (fn: { execute?: (a: never, o: typeof EXEC) => unknown }, args: Row) => (await fn.execute!(args as never, EXEC)) as Row
const tools = (client: never, user = USER, approvedCall?: ApprovedCall) =>
  createFlowTools(user, client, WS, false, 'session', undefined, { conversationId: 'conv-1', ...(approvedCall ? { approvedCall } : {}) })
const cardFlow = () => (approvals.calls[0].context as { flow: ApprovedCall['flow'] }).flow

beforeEach(() => {
  approvals.calls.length = 0
  access.table = new Set([USER, OTHER])
  access.channel = new Set([USER, OTHER])
  access.tableCalls = []
})
afterEach(() => vi.clearAllMocks())

describe('transfer_flow_owner re-checks the target for the new owner', () => {
  it('raises no card for a new owner who cannot read the table, and says so without naming it', async () => {
    access.table = new Set([USER])
    const { client, tables } = world(recordTrigger)
    const res = await call(tools(client).transfer_flow_owner, { flow_id: 'flow-1', new_owner: 'm-2' })
    expect(res).toMatchObject({ success: false, code: 'TARGET_UNREADABLE', field: 'new_owner' })
    expect(res.error).toMatch(/^Sam can't read the table this loop watches/)
    expect(String(res.error)).not.toContain(TABLE)
    expect(approvals.calls).toEqual([])
    expect(tables.flow[0].created_by).toBe(USER)
    expect(access.tableCalls).toEqual([OTHER])
  })

  it('on Accept, refuses and changes nothing when the new owner lost the table since the card', async () => {
    const { client, tables } = world(recordTrigger)
    await call(tools(client).transfer_flow_owner, { flow_id: 'flow-1', new_owner: OTHER })
    expect(approvals.calls).toHaveLength(1)
    access.table = new Set([USER])
    const res = await call(tools(client, OTHER, { approvalId: 'appr-1', tool: 'transfer_flow_owner', flow: cardFlow() }).transfer_flow_owner, { flow_id: 'flow-1', new_owner: OTHER })
    expect(res).toMatchObject({ success: false, code: 'TARGET_UNREADABLE' })
    expect(res.error).toMatch(/^You can't read the table this loop watches, so it did not change hands/)
    expect(tables.flow[0].created_by).toBe(USER)
  })

  it('a chat loop: the channel, in plain words', async () => {
    access.channel = new Set([USER])
    const { client } = world(chatTrigger)
    const res = await call(tools(client).transfer_flow_owner, { flow_id: 'flow-1', new_owner: OTHER })
    expect(res).toMatchObject({ code: 'TARGET_UNREADABLE' })
    expect(res.error).toMatch(/^Sam can't read the team chat channel this loop watches/)
    expect(String(res.error)).not.toContain(CHANNEL)
  })

  it('hands over as before when the new owner can read it', async () => {
    const { client, tables } = world(recordTrigger)
    await call(tools(client).transfer_flow_owner, { flow_id: 'flow-1', new_owner: OTHER })
    const res = await call(tools(client, OTHER, { approvalId: 'appr-1', tool: 'transfer_flow_owner', flow: cardFlow() }).transfer_flow_owner, { flow_id: 'flow-1', new_owner: OTHER })
    expect(res).toMatchObject({ success: true })
    expect(tables.flow[0].created_by).toBe(OTHER)
  })
})

describe('request_flow_takeover re-checks the target for the asker', () => {
  it('asks nothing of the owner when the asker cannot read the table', async () => {
    access.table = new Set([USER])
    const { client, tables } = world(recordTrigger)
    const res = await call(tools(client, OTHER).request_flow_takeover, { flow_id: 'flow-1' })
    expect(res).toMatchObject({ success: false, code: 'TARGET_UNREADABLE' })
    expect(res.error).toMatch(/^You can't read the table this loop watches, so nothing was asked/)
    expect(approvals.calls).toEqual([])
    expect(tables.flow[0].created_by).toBe(USER)
  })

  it("on the owner's Accept, refuses and changes nothing when the asker lost the channel since", async () => {
    const { client, tables } = world(chatTrigger)
    await call(tools(client, OTHER).request_flow_takeover, { flow_id: 'flow-1' })
    expect(approvals.calls).toHaveLength(1)
    access.channel = new Set([USER])
    const res = await call(tools(client, USER, { approvalId: 'a', tool: 'request_flow_takeover', flow: cardFlow() }).request_flow_takeover, { flow_id: 'flow-1' })
    expect(res).toMatchObject({ success: false, code: 'TARGET_UNREADABLE' })
    expect(res.error).toMatch(/^Sam can't read the team chat channel this loop watches, so it did not change hands/)
    expect(String(res.error)).not.toContain(CHANNEL)
    expect(tables.flow[0].created_by).toBe(USER)
  })

  it('hands over as before when the asker can read it', async () => {
    const { client, tables } = world(recordTrigger)
    await call(tools(client, OTHER).request_flow_takeover, { flow_id: 'flow-1' })
    const res = await call(tools(client, USER, { approvalId: 'a', tool: 'request_flow_takeover', flow: cardFlow() }).request_flow_takeover, { flow_id: 'flow-1' })
    expect(res).toMatchObject({ success: true })
    expect(tables.flow[0].created_by).toBe(OTHER)
  })

  it('a loop whose trigger watches nothing in particular is never checked', async () => {
    const { client, tables } = world({ trigger_type: 'contact_created', trigger_config: { kind: 'contact_created', source: 'form' } })
    await call(tools(client, OTHER).request_flow_takeover, { flow_id: 'flow-1' })
    const res = await call(tools(client, USER, { approvalId: 'a', tool: 'request_flow_takeover', flow: cardFlow() }).request_flow_takeover, { flow_id: 'flow-1' })
    expect(res).toMatchObject({ success: true })
    expect(tables.flow[0].created_by).toBe(OTHER)
    expect(access.tableCalls).toEqual([])
  })
})
