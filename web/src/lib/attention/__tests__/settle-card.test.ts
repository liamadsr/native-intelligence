/**
 * settleAttentionCard's owner fence for a SERVICE-ROLE caller (bots v3 Phase 5:
 * settle_card runs it on the internal tool routes' service client, where no RLS
 * restricts the card read). With `ownerMemberId` the card load is fenced on
 * it: someone else's card is a 404 and nothing is written; the caller's own is
 * settled as a click would settle it. The route's own behaviour (RLS client,
 * no scope) is pinned by src/app/api/account/attention-items/__tests__.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'

let fake: FakeSupabase
vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => fake }))
const engine = vi.hoisted(() => ({ apply: vi.fn(async (): Promise<unknown> => ({ success: true, entity_id: null })) }))
vi.mock('@/lib/proposed-changes/apply-engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/proposed-changes/apply-engine')>()),
  applyChange: engine.apply,
}))

import { settleAttentionCard } from '../settle-card'

const WS = 'a5000000-0000-4000-8000-000000000001'
const MINE = 'c5000000-0000-4000-8000-000000000001'
const ANAS = 'c5000000-0000-4000-8000-000000000002'

const card = (id: string, member: string) => ({
  id,
  workspace_id: WS,
  member_id: member,
  kind: 'proposal',
  title: 'Send the deck',
  why: null,
  status: 'pending',
  proposal_id: null,
  payload: null,
  expires_at: null,
})
const statusOf = (id: string) => fake.rows('attention_item').find((r) => r.id === id)?.status

beforeEach(() => {
  fake = makeFakeSupabase()
  fake.seed('attention_item', [card(MINE, 'mem-liam'), card(ANAS, 'mem-ana')])
})

describe('settleAttentionCard with an owner fence', () => {
  it('someone else’s card is a 404, and it stays pending', async () => {
    const res = await settleAttentionCard(fake as never, 'user-liam', { id: ANAS, action: 'dismiss' }, { ownerMemberId: 'mem-liam' })
    expect(res.status).toBe(404)
    expect(statusOf(ANAS)).toBe('pending')
  })

  it('the caller’s own card is settled as the click settles it', async () => {
    const res = await settleAttentionCard(fake as never, 'user-liam', { id: MINE, action: 'dismiss' }, { ownerMemberId: 'mem-liam' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, status: 'dismissed' })
    expect(statusOf(MINE)).toBe('dismissed')
    // Settled once: a second settle is the route's 409.
    const again = await settleAttentionCard(fake as never, 'user-liam', { id: MINE, action: 'dismiss' }, { ownerMemberId: 'mem-liam' })
    expect(again.status).toBe(409)
  })
})

describe('a card whose proposal runs a connected app\'s tool (mcp_call)', () => {
  const MCP_CARD = 'c5000000-0000-4000-8000-000000000003'
  const PROPOSAL = 'p5000000-0000-4000-8000-000000000003'
  beforeEach(() => {
    engine.apply.mockClear()
    fake.seed('member', [{ id: 'mem-liam', user_id: 'user-liam', workspace_id: WS }])
    fake.seed('proposed_change', [{
      id: PROPOSAL, workspace_id: WS, change_type: 'mcp_call', entity_type: 'external', status: 'pending',
      mcp_server_id: 'srv-1', mcp_tool_name: 'createJiraIssue', mcp_tool_args: { summary: 'x' }, display_text: 'Open a Jira ticket',
    }])
    fake.seed('attention_item', [{ ...card(MCP_CARD, 'mem-liam'), kind: 'action_card', proposal_id: PROPOSAL }])
  })

  it('the model (settle_card: no person actor) cannot accept it, and nothing runs', async () => {
    const res = await settleAttentionCard(fake as never, 'user-liam', { id: MCP_CARD, action: 'accept' }, { ownerMemberId: 'mem-liam' })
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: 'PROPOSAL_PERSON_ONLY' })
    expect(engine.apply).not.toHaveBeenCalled()
    expect(statusOf(MCP_CARD)).toBe('pending')
  })

  it('the model may still dismiss it', async () => {
    const res = await settleAttentionCard(fake as never, 'user-liam', { id: MCP_CARD, action: 'dismiss' }, { ownerMemberId: 'mem-liam' })
    expect(res.status).toBe(200)
  })

  it('the person\'s own click still applies it', async () => {
    const res = await settleAttentionCard(fake as never, 'user-liam', { id: MCP_CARD, action: 'accept' }, { actor: 'person', ownerMemberId: 'mem-liam' })
    const body = await res.json()
    expect(body.code).not.toBe('PROPOSAL_PERSON_ONLY')
    expect(engine.apply).toHaveBeenCalledTimes(1)
  })
})
