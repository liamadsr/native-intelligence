/**
 * A page watch that changes hands, or goes on from its approval card:
 *   - transfer_flow_owner and request_flow_takeover hold the NEW owner to the
 *     page-watch limit (page-changed-save.ts pageWatchLimitProblem), before a
 *     card is raised and again on its Accept, so a hand-over can't take a
 *     person past PAGE_WATCH_MAX_PER_PERSON watches switched on. The page is
 *     not read again: it does not change.
 *   - a page watch with a webhook step switched on from its card forgets its
 *     baseline (resetPageWatch) once it is on.
 * The reset is a stand-in; made-up people and pages.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import type { ApprovedCall } from '@/lib/safety/approved-call'
import { memoryDb } from '@/test/memory-db'

type Row = Record<string, unknown>
const h = vi.hoisted(() => ({
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  approvals: [] as Array<Record<string, unknown>>,
  reset: vi.fn(async (_s: unknown, _flowId: string) => {}),
  probe: vi.fn(async (_url: string) => ({ ok: true as const, lineCount: 40 })),
}))
vi.mock('@/lib/supabase/service', async () => {
  const { memoryDb: db } = await import('@/test/memory-db')
  return { getServiceClient: () => db(h.tables) }
})
vi.mock('@/lib/flows/page-watch/changes', async (orig) => ({ ...(await orig<Record<string, unknown>>()), resetPageWatch: h.reset }))
vi.mock('@/lib/flows/page-watch/probe', () => ({ probeWatchPage: h.probe }))
vi.mock('@/lib/flows/flow-bot', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/flows/flow-bot')>()),
  defaultFlowBot: async () => ({ teammateId: 'bot-default', created: false }),
}))
vi.mock('@/lib/crypto/credentials', () => ({ encryptCredentialOrNull: () => null }))
vi.mock('@/lib/safety/approvals', () => ({
  createToolApproval: async (_client: unknown, approval: Record<string, unknown>) => {
    h.approvals.push(approval)
    return { ok: true, approvalId: `appr-${h.approvals.length}`, cardId: `card-${h.approvals.length}` }
  },
}))

const { createFlowTools } = await import('../flows')
const { PAGE_WATCH_MAX_PER_PERSON } = await import('@/lib/flows/page-watch/url')

const ANA = 'user-ana'
const CY = 'user-cy'
const WS = 'ws-1'
const EXEC = { toolCallId: 'c', messages: [], context: {} } satisfies ToolExecutionOptions<Record<string, unknown>>
const call = async (fn: { execute?: (a: never, o: typeof EXEC) => unknown }, args: Row) => (await fn.execute!(args as never, EXEC)) as Row
const tools = (user: string, approvedCall?: ApprovedCall) =>
  createFlowTools(user, memoryDb(h.tables) as never, WS, false, 'session', undefined, { conversationId: 'conv-1', ...(approvedCall ? { approvedCall } : {}) })
const cardFlow = (i = 0) => (h.approvals[i].context as { flow: ApprovedCall['flow'] }).flow

const KETTLE = { kind: 'page_changed', url: 'https://shop.example.com/kettle', look_for: 'when the price drops' }
const pageLoop = (over: Row = {}): Row => ({
  id: 'flow-p',
  workspace_id: WS,
  team_id: null,
  name: 'Kettle price',
  enabled: true,
  trigger_type: 'page_changed',
  trigger_config: KETTLE,
  actions: [{ id: 'a-1', type: 'archive_capture', config: {}, condition: null, parent_id: null, enabled: true }],
  created_by: ANA,
  next_run_at: null,
  ...over,
})
/** `n` page watches switched on that Cy already keeps. */
const cysWatches = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `cy-${i}`, workspace_id: WS, created_by: CY, enabled: true, trigger_type: 'page_changed', trigger_config: KETTLE, actions: [] }))

function world(flows: Row[]) {
  h.tables = {
    member: [
      { id: 'm-ana', user_id: ANA, workspace_id: WS, role: 'member', display_name: 'Ana' },
      { id: 'm-cy', user_id: CY, workspace_id: WS, role: 'member', display_name: 'Cy' },
    ],
    flow: flows,
    flow_run: [],
  }
}
const loopRow = () => h.tables.flow.find((f) => f.id === 'flow-p')!

beforeEach(() => {
  h.approvals.length = 0
  h.reset.mockClear()
  h.probe.mockClear()
})

describe('transfer_flow_owner holds the new owner to the page-watch limit', () => {
  it('raises no card when the new owner already keeps the most watches on', async () => {
    world([pageLoop(), ...cysWatches(PAGE_WATCH_MAX_PER_PERSON)])
    const res = await call(tools(ANA).transfer_flow_owner, { flow_id: 'flow-p', new_owner: 'm-cy' })
    expect(res).toMatchObject({ success: false, code: 'PAGE_WATCH_LIMIT', field: 'new_owner' })
    expect(res.error).toMatch(new RegExp(`^Cy already watches ${PAGE_WATCH_MAX_PER_PERSON} pages`))
    expect(h.approvals).toEqual([])
    expect(loopRow().created_by).toBe(ANA)
  })

  it('on Accept, refuses and changes nothing when the new owner reached the limit since the card', async () => {
    world([pageLoop(), ...cysWatches(PAGE_WATCH_MAX_PER_PERSON - 1)])
    await call(tools(ANA).transfer_flow_owner, { flow_id: 'flow-p', new_owner: CY })
    expect(h.approvals).toHaveLength(1)
    h.tables.flow.push(...cysWatches(PAGE_WATCH_MAX_PER_PERSON).slice(-1).map((f) => ({ ...f, id: 'cy-late' })))
    const res = await call(tools(CY, { approvalId: 'appr-1', tool: 'transfer_flow_owner', flow: cardFlow() }).transfer_flow_owner, { flow_id: 'flow-p', new_owner: CY })
    expect(res).toMatchObject({ success: false, code: 'PAGE_WATCH_LIMIT' })
    expect(res.error).toMatch(/^You already watch .* did not change hands/)
    expect(loopRow().created_by).toBe(ANA)
    expect(h.probe).not.toHaveBeenCalled()
  })

  it('hands over a watch under the limit, or one that is off, as before', async () => {
    world([pageLoop(), ...cysWatches(PAGE_WATCH_MAX_PER_PERSON - 1)])
    await call(tools(ANA).transfer_flow_owner, { flow_id: 'flow-p', new_owner: CY })
    expect(await call(tools(CY, { approvalId: 'appr-1', tool: 'transfer_flow_owner', flow: cardFlow() }).transfer_flow_owner, { flow_id: 'flow-p', new_owner: CY })).toMatchObject({ success: true })
    expect(loopRow().created_by).toBe(CY)

    world([pageLoop({ enabled: false }), ...cysWatches(PAGE_WATCH_MAX_PER_PERSON)])
    await call(tools(ANA).transfer_flow_owner, { flow_id: 'flow-p', new_owner: CY })
    expect(await call(tools(CY, { approvalId: 'appr-2', tool: 'transfer_flow_owner', flow: cardFlow(1) }).transfer_flow_owner, { flow_id: 'flow-p', new_owner: CY })).toMatchObject({ success: true })
    expect(loopRow().created_by).toBe(CY)
  })
})

describe('request_flow_takeover holds the asker to the page-watch limit', () => {
  it('asks nothing of the owner when the asker already keeps the most watches on', async () => {
    world([pageLoop(), ...cysWatches(PAGE_WATCH_MAX_PER_PERSON)])
    const res = await call(tools(CY).request_flow_takeover, { flow_id: 'flow-p' })
    expect(res).toMatchObject({ success: false, code: 'PAGE_WATCH_LIMIT' })
    expect(res.error).toMatch(/^You already watch /)
    expect(h.approvals).toEqual([])
  })

  it("on the owner's Accept, refuses when the asker reached the limit since", async () => {
    world([pageLoop(), ...cysWatches(PAGE_WATCH_MAX_PER_PERSON - 1)])
    await call(tools(CY).request_flow_takeover, { flow_id: 'flow-p' })
    expect(h.approvals).toHaveLength(1)
    h.tables.flow.push({ ...cysWatches(1)[0], id: 'cy-late' })
    const res = await call(tools(ANA, { approvalId: 'a', tool: 'request_flow_takeover', flow: cardFlow() }).request_flow_takeover, { flow_id: 'flow-p' })
    expect(res).toMatchObject({ success: false, code: 'PAGE_WATCH_LIMIT' })
    expect(res.error).toMatch(new RegExp(`^Cy already watches ${PAGE_WATCH_MAX_PER_PERSON} pages`))
    expect(loopRow().created_by).toBe(ANA)
  })
})

describe('a page watch switched on from its card', () => {
  it('forgets its baseline once it is on', async () => {
    const hook = { id: 'a-1', type: 'http_post', config: { method: 'POST', url: 'https://example.com/hook', headers: {}, body_template: '' }, condition: null, parent_id: null, enabled: true }
    world([pageLoop({ enabled: false, actions: [hook] })])
    const raised = await call(tools(ANA).update_flow, { flow_id: 'flow-p', enabled: true, confirmed_with_user: true })
    expect(raised).toMatchObject({ awaiting_approval: true })
    expect(loopRow().enabled).toBe(false)
    expect(h.reset).not.toHaveBeenCalled()
    const on = await call(tools(ANA, { approvalId: 'appr-1', tool: 'update_flow', flow: cardFlow() }).update_flow, { flow_id: 'flow-p', enabled: true })
    expect(on).toMatchObject({ success: true })
    expect(loopRow()).toMatchObject({ enabled: true, next_run_at: expect.any(String) })
    expect(h.reset).toHaveBeenCalledOnce()
    expect(h.reset.mock.calls[0][1]).toBe('flow-p')
  })
})
