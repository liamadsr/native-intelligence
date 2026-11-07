/**
 * Approval cards (A5 slice 3) through settleAttentionCard: only the person's
 * own click (`actor: 'person'`, the PATCH route) settles one. The settle_card
 * tool (a service-role caller with an owner fence and no actor) is refused, so
 * the model can never approve its own blocked call. Accept runs the held call
 * (approveToolCall); dismiss denies it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'

let fake: FakeSupabase
vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => fake }))
const approvals = vi.hoisted(() => ({
  approve: vi.fn(async (): Promise<unknown> => ({ ok: true, status: 'executed', success: true, result: { ok: true } })),
  deny: vi.fn(async () => {}),
  expire: vi.fn(async () => 1),
}))
vi.mock('@/lib/safety/approvals', () => ({ approveToolCall: approvals.approve, denyToolCall: approvals.deny, expireLapsedApprovals: approvals.expire }))

import { settleAttentionCard } from '../settle-card'

const WS = 'a5000000-0000-4000-8000-000000000001'
const CARD = 'c5000000-0000-4000-8000-000000000009'
const statusOf = () => fake.rows('attention_item').find((r) => r.id === CARD)?.status

beforeEach(() => {
  fake = makeFakeSupabase()
  fake.seed('attention_item', [{
    id: CARD, workspace_id: WS, member_id: 'mem-liam', kind: 'approval', title: 'Approve delete_action?', why: null,
    status: 'pending', proposal_id: null, payload: { approval_id: 'a5000000-0000-4000-8000-0000000000aa' }, expires_at: null,
  }])
  approvals.approve.mockClear()
  approvals.deny.mockClear()
  approvals.expire.mockClear()
})

describe('settleAttentionCard: approval cards', () => {
  it.each(['accept', 'dismiss'] as const)('the settle_card tool (no person actor) is refused on %s, and nothing runs', async (action) => {
    const res = await settleAttentionCard(fake as never, 'user-liam', { id: CARD, action }, { ownerMemberId: 'mem-liam' })
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: 'APPROVAL_PERSON_ONLY' })
    expect(statusOf()).toBe('pending')
    expect(approvals.approve).not.toHaveBeenCalled()
    expect(approvals.deny).not.toHaveBeenCalled()
  })

  it('the person\'s accept runs the held call once and settles the card accepted', async () => {
    const res = await settleAttentionCard(fake as never, 'user-liam', { id: CARD, action: 'accept', corrections: { priority: 'high' } }, { actor: 'person' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, status: 'executed', success: true })
    expect(approvals.approve).toHaveBeenCalledWith(fake, { callerClass: 'person', userId: 'user-liam' }, expect.objectContaining({ id: CARD, kind: 'approval' }))
    expect(statusOf()).toBe('accepted')
  })

  it('a held call that could not run (expired, gone out of reach) clears the card', async () => {
    approvals.approve.mockResolvedValueOnce({ ok: false, status: 409, code: 'EXPIRED', error: 'This approval has expired. Ask again.' })
    const res = await settleAttentionCard(fake as never, 'user-liam', { id: CARD, action: 'accept' }, { actor: 'person' })
    expect(res.status).toBe(409)
    expect(statusOf()).toBe('dismissed')
  })

  it('the person\'s dismiss denies the held call', async () => {
    const res = await settleAttentionCard(fake as never, 'user-liam', { id: CARD, action: 'dismiss' }, { actor: 'person' })
    expect(res.status).toBe(200)
    expect(statusOf()).toBe('dismissed')
    expect(approvals.deny).toHaveBeenCalledWith(fake, { callerClass: 'person', userId: 'user-liam' }, expect.objectContaining({ id: CARD }))
  })

  it.each(['accept', 'dismiss'] as const)('a lapsed approval card answers EXPIRED on %s and expires its held call and card, never running it', async (action) => {
    fake.rows('attention_item')[0].expires_at = new Date(Date.now() - 60_000).toISOString()
    const res = await settleAttentionCard(fake as never, 'user-liam', { id: CARD, action }, { actor: 'person' })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'EXPIRED' })
    expect(approvals.expire).toHaveBeenCalledWith(fake, { cardId: CARD })
    expect(approvals.approve).not.toHaveBeenCalled()
    expect(approvals.deny).not.toHaveBeenCalled()
  })

  it.each(['start'] as const)('%s is not an approval action', async (action) => {
    const res = await settleAttentionCard(fake as never, 'user-liam', { id: CARD, action }, { actor: 'person' })
    expect(res.status).toBe(400)
  })
})

describe('settleAttentionCard: an approval answered from Slack (docs/plans/slack-connect.md piece 6)', () => {
  it('the person’s own click in Slack is the person: it runs, fenced on their member row', async () => {
    const res = await settleAttentionCard(fake as never, 'user-liam', { id: CARD, action: 'accept' }, { ownerMemberId: 'mem-liam', actor: 'person', channel: 'slack' })
    expect(res.status).toBe(200)
    expect(approvals.approve).toHaveBeenCalledWith(fake, { callerClass: 'person', userId: 'user-liam' }, expect.objectContaining({ id: CARD }))
    expect(statusOf()).toBe('accepted')
  })

  it('a click on someone else’s card finds nothing', async () => {
    const res = await settleAttentionCard(fake as never, 'user-ana', { id: CARD, action: 'accept' }, { ownerMemberId: 'mem-ana', actor: 'person', channel: 'slack' })
    expect(res.status).toBe(404)
    expect(approvals.approve).not.toHaveBeenCalled()
  })

  it('a channel with no person actor is no approver', async () => {
    const res = await settleAttentionCard(fake as never, 'user-liam', { id: CARD, action: 'accept' }, { ownerMemberId: 'mem-liam', channel: 'slack' })
    expect(res.status).toBe(403)
    expect(approvals.approve).not.toHaveBeenCalled()
  })

  it('a decline from Slack denies the held call as the person', async () => {
    const res = await settleAttentionCard(fake as never, 'user-liam', { id: CARD, action: 'dismiss' }, { ownerMemberId: 'mem-liam', actor: 'person', channel: 'slack' })
    expect(res.status).toBe(200)
    expect(approvals.deny).toHaveBeenCalledWith(fake, { callerClass: 'person', userId: 'user-liam' }, expect.objectContaining({ id: CARD }))
  })
})

describe('settleAttentionCard: an approval card’s Always allow', () => {
  const APPROVAL = 'a5000000-0000-4000-8000-0000000000aa'
  const held = (over: Record<string, unknown> = {}) => ({
    id: APPROVAL, user_id: 'user-liam', door: 'chat', tool: 'mcp__internal__create_issue',
    context: { alwaysAllow: { serverId: 'srv-1', tool: 'create_issue' } }, ...over,
  })
  const serverRow = (over: Record<string, unknown> = {}) => ({
    id: 'srv-1', user_id: 'user-liam', display_name: 'Internal', server_url: 'https://mcp.internal.example/mcp',
    tools_cache: [{ name: 'create_issue' }], disabled_tools: [], allowed_tools: ['create_issue'],
    require_approval_tools: ['create_issue'], approval_free_tools: [], ...over,
  })
  const server = () => fake.rows('connected_mcp_server').find((r) => r.id === 'srv-1')!
  const unchanged = () => expect(server()).toMatchObject({ require_approval_tools: ['create_issue'], approval_free_tools: [] })
  const accept = () => settleAttentionCard(fake as never, 'user-liam', { id: CARD, action: 'accept', always_allow: true }, { actor: 'person' })

  it('runs the held call once, then that tool runs without a card', async () => {
    fake.seed('tool_approval', [held()])
    fake.seed('connected_mcp_server', [serverRow()])
    const res = await accept()
    expect(await res.json()).toMatchObject({ ok: true, status: 'executed', always_allowed: true })
    expect(approvals.approve).toHaveBeenCalledTimes(1)
    expect(server()).toMatchObject({ approval_free_tools: ['create_issue'], require_approval_tools: [] })
    expect(statusOf()).toBe('accepted')
  })

  it('takes the server and tool from the held call, not the request: no stored offer, approved once only', async () => {
    fake.seed('tool_approval', [held({ context: {} })])
    fake.seed('connected_mcp_server', [serverRow()])
    expect(await (await accept()).json()).toMatchObject({ ok: true, always_allowed: false })
    unchanged()
  })

  it('the offer must name exactly the tool the person approved, on that server', async () => {
    fake.seed('tool_approval', [held({ tool: 'mcp__internal__delete_project' })])
    fake.seed('connected_mcp_server', [serverRow()])
    expect(await (await accept()).json()).toMatchObject({ always_allowed: false })
    unchanged()
  })

  it('only a chat call carries it (not a loop step or a skill run)', async () => {
    fake.seed('tool_approval', [held({ door: 'flow_step' })])
    fake.seed('connected_mcp_server', [serverRow()])
    expect(await (await accept()).json()).toMatchObject({ always_allowed: false })
    unchanged()
  })

  it('never sets another person’s server', async () => {
    fake.seed('tool_approval', [held()])
    fake.seed('connected_mcp_server', [serverRow({ user_id: 'someone-else' })])
    expect(await (await accept()).json()).toMatchObject({ always_allowed: false })
    unchanged()
  })

  it('a block set while the call ran stands', async () => {
    fake.seed('tool_approval', [held()])
    fake.seed('connected_mcp_server', [serverRow({ disabled_tools: ['create_issue'] })])
    expect(await (await accept()).json()).toMatchObject({ always_allowed: false })
    expect(server()).toMatchObject({ disabled_tools: ['create_issue'] })
  })

  it('never frees a catalog app’s always-ask tool', async () => {
    fake.seed('tool_approval', [held({ tool: 'mcp__typefully__create_draft', context: { alwaysAllow: { serverId: 'srv-1', tool: 'create_draft' } } })])
    fake.seed('connected_mcp_server', [serverRow({ display_name: 'Typefully', server_url: 'https://mcp.typefully.com/mcp', tools_cache: [{ name: 'create_draft' }], allowed_tools: ['create_draft'], require_approval_tools: [] })])
    expect(await (await accept()).json()).toMatchObject({ always_allowed: false })
    expect(server()).toMatchObject({ approval_free_tools: [] })
  })

  it('a held call that could not run sets nothing', async () => {
    fake.seed('tool_approval', [held()])
    fake.seed('connected_mcp_server', [serverRow()])
    approvals.approve.mockResolvedValueOnce({ ok: false, status: 409, code: 'EXPIRED', error: 'This approval has expired. Ask again.' })
    expect((await accept()).status).toBe(409)
    unchanged()
  })
})

describe('settleAttentionCard: Always allow is the app’s alone', () => {
  it('an approval answered from Slack runs once and never frees the tool, even when asked', async () => {
    const APPROVAL = 'a5000000-0000-4000-8000-0000000000aa'
    fake.seed('tool_approval', [{ id: APPROVAL, user_id: 'user-liam', door: 'chat', tool: 'mcp__internal__create_issue', context: { alwaysAllow: { serverId: 'srv-1', tool: 'create_issue' } } }])
    fake.seed('connected_mcp_server', [
      { id: 'srv-1', user_id: 'user-liam', display_name: 'Internal', server_url: 'https://mcp.internal.example/mcp', tools_cache: [{ name: 'create_issue' }], disabled_tools: [], allowed_tools: ['create_issue'], require_approval_tools: ['create_issue'], approval_free_tools: [] },
    ])
    const res = await settleAttentionCard(fake as never, 'user-liam', { id: CARD, action: 'accept', always_allow: true }, { ownerMemberId: 'mem-liam', actor: 'person', channel: 'slack' })
    expect(res.status).toBe(200)
    expect(approvals.approve).toHaveBeenCalledTimes(1)
    expect(fake.rows('connected_mcp_server')[0]).toMatchObject({ require_approval_tools: ['create_issue'], approval_free_tools: [] })
  })
})
