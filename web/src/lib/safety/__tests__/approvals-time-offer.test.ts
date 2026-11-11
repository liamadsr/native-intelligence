/**
 * A time offer's card through the approvals (availability phase 3a): the
 * yes replays offer_times with the card's own check (its offer and its
 * words' hash) as the approved call, never anything a model sent; the same
 * input with other words is a new card; a no or a lapse lets the offer's
 * held times go. The offer module is mocked:
 * src/lib/time-offers/__tests__/send.test.ts covers it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'

vi.mock('server-only', () => ({}))
const mocks = vi.hoisted(() => ({
  home: vi.fn(async () => ({ written: true, conversationId: 'home-conv' })),
  execute: vi.fn(async () => ({ success: true, sent_via: 'email' })),
  createTools: vi.fn(),
  settle: vi.fn(async () => {}),
}))
vi.mock('@/lib/ai/tools', () => ({ createTools: mocks.createTools }))
vi.mock('@/lib/mcp-client/adapter', () => ({ createExternalMcpTools: async () => ({ tools: {}, meta: new Map(), servers: [] }), executeExternalMcpCall: vi.fn() }))
vi.mock('@/lib/chat/chat-ceiling', () => ({
  isToolExcludedForSurface: () => false,
  resolveAgentToolCeiling: async () => null,
  resolveChatCeiling: async () => null,
  resolveTeammateChatBounds: async () => null,
  resolveTeammateChatCeiling: async () => new Set(),
}))
vi.mock('@/lib/flows/run-skill', () => ({ computeSkillCeiling: () => null }))
vi.mock('@/lib/chat/home-message-writer', () => ({ appendHomeMessage: mocks.home }))
vi.mock('@/lib/work/agent-paused', () => ({ isAgentPaused: async () => false }))
vi.mock('@/lib/agent-events/record', () => ({ recordAgentEvents: vi.fn(async () => 1) }))
vi.mock('@/lib/reach/route', () => ({ requestRoute: vi.fn(async () => {}) }))
vi.mock('../approval-turn', () => ({ requestApprovalTurn: vi.fn(async () => {}) }))
vi.mock('@/lib/log/agent-log', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/log/agent-log')>()),
  deferLogWrite: () => {},
}))
vi.mock('@/lib/time-offers/send', () => ({ settleTimeOfferApproval: mocks.settle }))

import { approveToolCall, createToolApproval, denyToolCall, expireLapsedApprovals, type NewApproval } from '../approvals'

const HOST = 'user-ava'
const WS = 'ws-fernhill'
const person = { callerClass: 'person' as const, userId: HOST }
const INPUT = { recipient: { name: 'Dana Reyes', email: 'dana@initech.example' }, title: 'Intro call', slots: ['2026-11-17T10:00:00-05:00', '2026-11-18T14:00:00-05:00'], duration_minutes: 30, send_by: 'email' }
let db: FakeSupabase

const offerCard = (cardHash = 'h-1', offerId = 'offer-1'): NewApproval => ({
  door: 'chat',
  userId: HOST,
  workspaceId: WS,
  toolName: 'offer_times',
  sideEffect: 'external-write',
  input: INPUT,
  conversationId: 'conv-1',
  context: { timeOffer: { offer_id: offerId, card_hash: cardHash } },
  reason: 'time_offer',
  card: { title: 'Email Dana Reyes (dana@initech.example) times to meet?', why: 'From your mailbox …' },
})

async function raise(approval: NewApproval = offerCard()) {
  const created = await createToolApproval(db as never, approval)
  if (!created.ok) throw new Error(created.error)
  const card = db.rows('attention_item').find((row) => row.id === created.cardId)! as { workspace_id: string; payload: unknown }
  return { created, card }
}

beforeEach(() => {
  db = makeFakeSupabase({ project: true })
  db.seed('member', [{ id: 'member-1', user_id: HOST, workspace_id: WS }])
  for (const m of Object.values(mocks)) m.mockClear()
  mocks.createTools.mockImplementation(() => ({ offer_times: { execute: mocks.execute } }))
})

describe("a time offer's card", () => {
  it("the same input with the same words is the same card; other words are a new one", async () => {
    const first = await raise()
    expect(await createToolApproval(db as never, offerCard())).toMatchObject({ ok: true, reused: true, approvalId: first.created.approvalId })
    expect(await createToolApproval(db as never, offerCard('h-2', 'offer-2'))).toMatchObject({ ok: true })
    expect((await createToolApproval(db as never, offerCard('h-2', 'offer-2'))) as { reused?: true }).toMatchObject({ reused: true })
    expect(db.rows('tool_approval')).toHaveLength(2)
  })

  it("the yes replays offer_times with the card's own check as the approved call", async () => {
    const { created, card } = await raise()
    expect(await approveToolCall(db as never, person, card)).toMatchObject({ ok: true, success: true })
    expect(mocks.createTools).toHaveBeenCalledWith(HOST, db, WS, undefined, expect.objectContaining({ approvedCall: { approvalId: created.approvalId, tool: 'offer_times', timeOffer: { offer_id: 'offer-1', card_hash: 'h-1' } } }))
    expect(mocks.execute).toHaveBeenCalledWith(expect.objectContaining({ send_by: 'email', title: 'Intro call' }), expect.anything())
  })

  it('a no lets its times go as declined, a lapse as expired; another card settles no offer', async () => {
    const { card } = await raise()
    await denyToolCall(db as never, person, card)
    expect(mocks.settle).toHaveBeenCalledWith(db, { context: expect.objectContaining({ timeOffer: { offer_id: 'offer-1', card_hash: 'h-1' } }) }, 'denied')

    mocks.settle.mockClear()
    const lapsing = await raise(offerCard('h-3', 'offer-3'))
    db.rows('tool_approval').find((r) => r.id === lapsing.created.approvalId)!.expires_at = new Date(Date.now() - 60_000).toISOString()
    expect(await expireLapsedApprovals(db as never)).toBe(1)
    expect(mocks.settle).toHaveBeenCalledWith(db, { context: expect.objectContaining({ timeOffer: { offer_id: 'offer-3', card_hash: 'h-3' } }) }, 'expired')

    mocks.settle.mockClear()
    const other = await raise({ ...offerCard(), toolName: 'delete_action', sideEffect: 'delete', input: { action_id: 'GEN-1' }, context: {} })
    await denyToolCall(db as never, person, other.card)
    expect(mocks.settle).not.toHaveBeenCalled()
  })
})
