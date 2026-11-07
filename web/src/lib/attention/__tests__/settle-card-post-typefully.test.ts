/**
 * A post card's Typefully button (C2a, P9): only the person's own click
 * sends it; the click is held as a tool_approval and approved at once, as
 * them; the post card settles only when it went out.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'

let fake: FakeSupabase
vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => fake }))
const approvals = vi.hoisted(() => ({
  create: vi.fn(async (): Promise<unknown> => ({ ok: true, approvalId: 'appr-1', cardId: 'card-appr' })),
  approve: vi.fn(async (): Promise<unknown> => ({ ok: true, status: 'executed', success: true, result: { success: true, message: 'Sent to Typefully to post on X now.' } })),
}))
vi.mock('@/lib/safety/approvals', () => ({
  approveToolCall: approvals.approve,
  createToolApproval: approvals.create,
  denyToolCall: vi.fn(),
  expireLapsedApprovals: vi.fn(),
}))

import { settleAttentionCard } from '../settle-card'

const WS = 'a5000000-0000-4000-8000-000000000001'
const CARD = 'c5000000-0000-4000-8000-000000000010'
const statusOf = (id: string) => fake.rows('attention_item').find((r) => r.id === id)?.status

beforeEach(() => {
  fake = makeFakeSupabase()
  fake.seed('attention_item', [
    {
      id: CARD, workspace_id: WS, member_id: 'mem-liam', kind: 'question', title: 'Post on X: “We shipped calendar sync.”', why: null,
      status: 'pending', proposal_id: null, expires_at: null,
      payload: { post_draft: { text: 'We shipped calendar sync.', surface: 'x', chars: 25, limit: 280, typefully: true } },
    },
    { id: 'card-appr', workspace_id: WS, member_id: 'mem-liam', kind: 'approval', title: 'Post to X via Typefully now', why: null, status: 'pending', proposal_id: null, expires_at: null, payload: { approval_id: 'appr-1' } },
  ])
  approvals.create.mockClear()
  approvals.approve.mockClear()
})

describe('a post card’s Typefully button', () => {
  it('the person’s click holds exactly the post as an approval, runs it once as them, and settles both cards', async () => {
    const res = await settleAttentionCard(fake as never, 'user-liam', { id: CARD, action: 'accept', publish: 'now' }, { actor: 'person' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, status: 'posted', message: 'Sent to Typefully to post on X now.' })
    expect(approvals.create).toHaveBeenCalledWith(fake, expect.objectContaining({
      door: 'chat',
      userId: 'user-liam',
      workspaceId: WS,
      toolName: 'publish_post',
      sideEffect: 'external-write',
      input: { surface: 'x', text: 'We shipped calendar sync.' },
      context: { postCard: true },
      card: expect.objectContaining({ title: "Post to X via Typefully now: 'We shipped calendar sync.'" }),
    }))
    expect(approvals.approve).toHaveBeenCalledWith(fake, { callerClass: 'person', userId: 'user-liam' }, { workspace_id: WS, payload: { approval_id: 'appr-1' } })
    expect(statusOf(CARD)).toBe('accepted')
    expect(statusOf('card-appr')).toBe('accepted')
  })

  it('Add to queue holds schedule_post', async () => {
    await settleAttentionCard(fake as never, 'user-liam', { id: CARD, action: 'accept', publish: 'next_free_slot' }, { actor: 'person' })
    expect(approvals.create).toHaveBeenCalledWith(fake, expect.objectContaining({ toolName: 'schedule_post' }))
  })

  it('never the model: settle_card (no person actor) is refused and nothing is held', async () => {
    const res = await settleAttentionCard(fake as never, 'user-liam', { id: CARD, action: 'accept', publish: 'now' }, { ownerMemberId: 'mem-liam' })
    expect(res.status).toBe(403)
    expect(approvals.create).not.toHaveBeenCalled()
    expect(statusOf(CARD)).toBe('pending')
  })

  it('a Typefully failure leaves the post card waiting, with the reason', async () => {
    approvals.approve.mockResolvedValueOnce({ ok: true, status: 'executed', success: false, result: { success: false, code: 'NOT_CONNECTED', error: 'Typefully is not connected' } })
    const res = await settleAttentionCard(fake as never, 'user-liam', { id: CARD, action: 'accept', publish: 'now' }, { actor: 'person' })
    expect(res.status).toBe(502)
    expect(await res.json()).toMatchObject({ code: 'NOT_CONNECTED' })
    expect(statusOf(CARD)).toBe('pending')
    expect(statusOf('card-appr')).toBe('dismissed')
  })

  it('a double click (two tabs, the rail and the column) posts once: the second finds the card taken (B1)', async () => {
    const [a, b] = await Promise.all([
      settleAttentionCard(fake as never, 'user-liam', { id: CARD, action: 'accept', publish: 'now' }, { actor: 'person' }),
      settleAttentionCard(fake as never, 'user-liam', { id: CARD, action: 'accept', publish: 'now' }, { actor: 'person' }),
    ])
    expect([a.status, b.status].sort()).toEqual([200, 409])
    expect(approvals.create).toHaveBeenCalledTimes(1)
    expect(approvals.approve).toHaveBeenCalledTimes(1)
    // And a click after it went out finds it settled.
    const again = await settleAttentionCard(fake as never, 'user-liam', { id: CARD, action: 'accept', publish: 'now' }, { actor: 'person' })
    expect(again.status).toBe(409)
    expect(approvals.create).toHaveBeenCalledTimes(1)
  })

  it('Typefully refused it, or the send threw: the card stays settled (it may have gone out), never retried into a double post', async () => {
    approvals.approve.mockResolvedValueOnce({ ok: true, status: 'executed', success: false, result: { success: false, code: 'TYPEFULLY_ERROR', error: 'Typefully refused it' } })
    const res = await settleAttentionCard(fake as never, 'user-liam', { id: CARD, action: 'accept', publish: 'now' }, { actor: 'person' })
    expect(res.status).toBe(502)
    expect(statusOf(CARD)).toBe('accepted')
    fake.rows('attention_item')[0].status = 'pending'
    approvals.approve.mockRejectedValueOnce(new Error('socket hang up'))
    const thrown = await settleAttentionCard(fake as never, 'user-liam', { id: CARD, action: 'accept', publish: 'now' }, { actor: 'person' })
    expect(thrown.status).toBe(502)
    expect(await thrown.json()).toMatchObject({ code: 'TYPEFULLY_UNKNOWN' })
    expect(statusOf(CARD)).toBe('accepted')
  })

  it('nothing held (too many approvals waiting): the card waits again, with a clear message', async () => {
    approvals.create.mockResolvedValueOnce({ ok: false, code: 'TOO_MANY_PENDING', error: 'x' })
    const res = await settleAttentionCard(fake as never, 'user-liam', { id: CARD, action: 'accept', publish: 'now' }, { actor: 'person' })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/too many approvals waiting/)
    expect(statusOf(CARD)).toBe('pending')
  })

  it('publish only on a post card', async () => {
    fake.rows('attention_item')[0].payload = { question: 'x' }
    const res = await settleAttentionCard(fake as never, 'user-liam', { id: CARD, action: 'accept', publish: 'now' }, { actor: 'person' })
    expect(res.status).toBe(400)
  })
})
