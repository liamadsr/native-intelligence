/**
 * The follow-through tools' contract (bots v3 Phase 5, ./follow-through.ts):
 *
 *   settle_card           reuses the attention-items PATCH (settleAttentionCard,
 *                         the route's own logic) and is OWNER-ONLY: the card is
 *                         looked up on the caller's member row in this
 *                         workspace, and the settle is fenced on it too;
 *   revise_email_draft    hands the whole revision to reviseEmailDraft;
 *   discard_email_draft   hands the drafts and the reason to discardEmailDrafts;
 *                         more than five, unconfirmed, discard nothing and
 *                         answer CONFIRM_FIRST with the list to show;
 *   undo_extraction_pass  hands the pass to undoExtractionPass.
 *
 * And the route really is a thin door to the same function (structural), so a
 * card settled from a chat goes through exactly the click's path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NextResponse } from 'next/server'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'

const settleAttentionCard = vi.fn()
vi.mock('@/lib/attention/settle-card', () => ({ settleAttentionCard: (...a: unknown[]) => settleAttentionCard(...a) }))
const reviseEmailDraft = vi.fn(async () => ({ success: true }))
vi.mock('@/lib/email/revise-draft', () => ({ reviseEmailDraft: (...a: unknown[]) => reviseEmailDraft(...(a as [])) }))
const discardEmailDrafts = vi.fn(async () => ({ success: true, discarded: 1, results: [], message: 'Discarded 1 draft.' }))
const readOwnDraftRows = vi.fn(async (_s: unknown, _u: unknown, ids: string[]) =>
  ids.map((id, i) => ({
    id,
    row: i === 0 ? null : { id, status: i === 1 ? 'sent' : 'pending_review', subject: `Re: Receipt ${i}`, to_emails: [`r${i}@squareup.com`], created_at: '2026-10-26T10:00:00Z' },
  })),
)
vi.mock('@/lib/email/discard-drafts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/email/discard-drafts')>()),
  discardEmailDrafts: (...a: unknown[]) => discardEmailDrafts(...(a as [])),
  readOwnDraftRows: (...a: unknown[]) => readOwnDraftRows(...(a as [unknown, unknown, string[]])),
}))
const undoExtractionPass = vi.fn(async () => ({ success: true }))
vi.mock('@/lib/proposed-changes/undo-extraction-pass', () => ({ undoExtractionPass: (...a: unknown[]) => undoExtractionPass(...(a as [])) }))

import { createFollowThroughTools } from '../follow-through'

const WS = 'a4000000-0000-4000-8000-000000000001'
const OTHER_WS = 'a4000000-0000-4000-8000-000000000002'
const CARD = 'c4000000-0000-4000-8000-000000000001'
const ANAS_CARD = 'c4000000-0000-4000-8000-000000000002'
const FOREIGN_CARD = 'c4000000-0000-4000-8000-000000000003'
const PROPOSAL = 'b4000000-0000-4000-8000-000000000001'
const PASS = 'e4000000-0000-4000-8000-000000000001'

let fake: FakeSupabase
type Exec = (input: Record<string, unknown>) => Promise<Record<string, unknown>>
const tools = (userId = 'user-liam') =>
  createFollowThroughTools(userId, fake as never, WS) as unknown as Record<string, { execute: Exec; inputSchema: { safeParse: (v: unknown) => { success: boolean } } }>

beforeEach(() => {
  fake = makeFakeSupabase()
  settleAttentionCard.mockReset()
  settleAttentionCard.mockImplementation(async () => NextResponse.json({ ok: true, status: 'dismissed' }))
  reviseEmailDraft.mockClear()
  discardEmailDrafts.mockClear()
  readOwnDraftRows.mockClear()
  undoExtractionPass.mockClear()
  fake.seed('member', [
    { id: 'mem-liam', workspace_id: WS, user_id: 'user-liam' },
    { id: 'mem-ana', workspace_id: WS, user_id: 'user-ana' },
    { id: 'mem-liam-2', workspace_id: OTHER_WS, user_id: 'user-liam' },
  ])
  fake.seed('attention_item', [
    { id: CARD, workspace_id: WS, member_id: 'mem-liam', status: 'pending', proposal_id: PROPOSAL, created_at: '2026-10-02T10:00:00Z' },
    { id: ANAS_CARD, workspace_id: WS, member_id: 'mem-ana', status: 'pending', proposal_id: PROPOSAL, created_at: '2026-10-02T10:00:00Z' },
    { id: FOREIGN_CARD, workspace_id: OTHER_WS, member_id: 'mem-liam-2', status: 'pending', proposal_id: null, created_at: '2026-10-02T10:00:00Z' },
  ])
})

describe('settle_card on an approval card (A5)', () => {
  const APPROVAL = 'c4000000-0000-4000-8000-0000000000a1'
  it('is refused before anything is settled: only the person approves, on the card', async () => {
    fake.seed('attention_item', [{ id: APPROVAL, workspace_id: WS, member_id: 'mem-liam', kind: 'approval', status: 'pending', proposal_id: null, created_at: '2026-10-02T11:00:00Z' }])
    for (const action of ['accept', 'dismiss']) {
      const out = await tools().settle_card.execute({ card_id: APPROVAL, action })
      expect(out).toMatchObject({ success: false, card_id: APPROVAL, code: 'APPROVAL_PERSON_ONLY' })
    }
    expect(settleAttentionCard).not.toHaveBeenCalled()
  })

  it('the click route is the one door that settles as the person', () => {
    const route = readFileSync(join(process.cwd(), 'src/app/api/account/attention-items/route.ts'), 'utf8')
    expect(route).toContain("{ actor: 'person' }")
    const tool = readFileSync(join(process.cwd(), 'src/lib/ai/tools/follow-through.ts'), 'utf8')
    expect(tool).not.toContain("actor: 'person'")
  })
})

describe('settle_card', () => {
  it('settles the caller’s own card through the PATCH logic, fenced on their member row', async () => {
    const out = await tools().settle_card.execute({ card_id: CARD, action: 'dismiss' })
    expect(out).toMatchObject({ success: true, card_id: CARD, status: 'dismissed' })
    expect(settleAttentionCard).toHaveBeenCalledWith(fake, 'user-liam', { id: CARD, action: 'dismiss' }, { ownerMemberId: 'mem-liam' })
  })

  it('finds the caller’s pending card by the proposal it carries', async () => {
    await tools().settle_card.execute({ proposal_id: PROPOSAL, action: 'accept', corrections: { priority: 'high' } })
    expect(settleAttentionCard).toHaveBeenCalledWith(
      fake,
      'user-liam',
      { id: CARD, action: 'accept', corrections: { priority: 'high' } },
      { ownerMemberId: 'mem-liam' },
    )
  })

  it('passes the action the person names to an update card whose target was unresolved; accept only', async () => {
    const ACTION = 'a7000000-0000-4000-8000-000000000001'
    await tools().settle_card.execute({ card_id: CARD, action: 'accept', target_entity_id: ACTION })
    expect(settleAttentionCard).toHaveBeenCalledWith(
      fake,
      'user-liam',
      { id: CARD, action: 'accept', target_entity_id: ACTION },
      { ownerMemberId: 'mem-liam' },
    )
    settleAttentionCard.mockClear()
    expect(await tools().settle_card.execute({ card_id: CARD, action: 'dismiss', target_entity_id: ACTION })).toMatchObject({ code: 'INPUT_INVALID' })
    expect(settleAttentionCard).not.toHaveBeenCalled()
  })

  it('is owner-only: someone else’s card, or one in another workspace, is not found and never settled', async () => {
    expect(await tools().settle_card.execute({ card_id: ANAS_CARD, action: 'dismiss' })).toMatchObject({ success: false, code: 'NOT_FOUND' })
    expect(await tools().settle_card.execute({ card_id: FOREIGN_CARD, action: 'dismiss' })).toMatchObject({ success: false, code: 'NOT_FOUND' })
    expect(await tools('user-stranger').settle_card.execute({ card_id: CARD, action: 'dismiss' })).toMatchObject({ success: false })
    expect(settleAttentionCard).not.toHaveBeenCalled()
  })

  it('reads the route’s refusal back (already settled elsewhere: 409)', async () => {
    settleAttentionCard.mockImplementation(async () => NextResponse.json({ error: 'Card already accepted', code: 'ALREADY_RESOLVED' }, { status: 409 }))
    expect(await tools().settle_card.execute({ card_id: CARD, action: 'dismiss' })).toMatchObject({ success: false, code: 'ALREADY_RESOLVED' })
  })

  it('takes exactly one of card_id / proposal_id, and only accept, dismiss or start', async () => {
    expect(await tools().settle_card.execute({ action: 'dismiss' })).toMatchObject({ success: false, code: 'INPUT_INVALID' })
    expect(await tools().settle_card.execute({ card_id: CARD, proposal_id: PROPOSAL, action: 'dismiss' })).toMatchObject({ code: 'INPUT_INVALID' })
    expect(tools().settle_card.inputSchema.safeParse({ card_id: CARD, action: 'draft' }).success).toBe(false)
    expect(settleAttentionCard).not.toHaveBeenCalled()
  })
})

describe('settle_card recovers the card id put in target_entity_id (PROD, 2026-10-08)', () => {
  // A PROD chat on deepseek-v4-flash sent exactly this 31 times in one turn,
  // the card's id in target_entity_id and no card_id, and every call failed.
  it('the exact PROD input settles the card: the id is taken as card_id and dropped as a target', async () => {
    const out = await tools().settle_card.execute({ action: 'accept', target_entity_id: CARD })
    expect(settleAttentionCard).toHaveBeenCalledTimes(1)
    expect(settleAttentionCard).toHaveBeenCalledWith(fake, 'user-liam', { id: CARD, action: 'accept' }, { ownerMemberId: 'mem-liam' })
    expect(out).toMatchObject({ success: true, card_id: CARD })
    expect(String(out.note)).toMatch(/pass a card's id as card_id/)
  })

  it('the proposal id a pending card of theirs carries, given as target_entity_id, finds that card too (and says so)', async () => {
    const out = await tools().settle_card.execute({ action: 'dismiss', target_entity_id: PROPOSAL })
    expect(settleAttentionCard).toHaveBeenCalledWith(fake, 'user-liam', { id: CARD, action: 'dismiss' }, { ownerMemberId: 'mem-liam' })
    expect(String(out.note)).toMatch(/is the proposal this card carries, so it was taken as proposal_id/)
    expect(String(out.note)).not.toMatch(/this card's id/)
  })

  it('a refusal on the recovered card still says which card and how to name it next time', async () => {
    settleAttentionCard.mockImplementation(async () => NextResponse.json({ error: 'Card already accepted', code: 'ALREADY_RESOLVED' }, { status: 409 }))
    const out = await tools().settle_card.execute({ action: 'accept', target_entity_id: CARD })
    expect(out).toMatchObject({ success: false, card_id: CARD, code: 'ALREADY_RESOLVED' })
    expect(String(out.note)).toMatch(/card_id/)
  })

  it('a target_entity_id that is not one of their cards gets the precise error, never a settle', async () => {
    const ACTION = 'a7000000-0000-4000-8000-000000000001'
    // An action's id, someone else's card, a card in another workspace.
    for (const id of [ACTION, ANAS_CARD, FOREIGN_CARD]) {
      const out = await tools().settle_card.execute({ action: 'accept', target_entity_id: id })
      expect(out).toMatchObject({ success: false, code: 'INPUT_INVALID' })
      expect(String(out.error)).toMatch(/^card_id is missing: pass the card's id as card_id \(target_entity_id is only the action an update card should change\)/)
      expect(String(out.error)).toContain(id)
    }
    // A stranger to the workspace never gets as far as a lookup.
    expect(await tools('user-stranger').settle_card.execute({ action: 'accept', target_entity_id: CARD })).toMatchObject({ success: false })
    expect(settleAttentionCard).not.toHaveBeenCalled()
  })

  it('no id at all names the fix too', async () => {
    const out = await tools().settle_card.execute({ action: 'accept' })
    expect(out).toMatchObject({ success: false, code: 'INPUT_INVALID' })
    expect(String(out.error)).toMatch(/^card_id is missing: pass the card's id as card_id/)
  })

  it("the card's own id repeated as target_entity_id beside card_id is dropped, not sent as the action to update", async () => {
    await tools().settle_card.execute({ card_id: CARD, action: 'dismiss', target_entity_id: CARD })
    expect(settleAttentionCard).toHaveBeenCalledWith(fake, 'user-liam', { id: CARD, action: 'dismiss' }, { ownerMemberId: 'mem-liam' })
  })

  it("so is the card's own proposal id beside card_id", async () => {
    const out = await tools().settle_card.execute({ card_id: CARD, action: 'accept', target_entity_id: PROPOSAL })
    expect(settleAttentionCard).toHaveBeenCalledWith(fake, 'user-liam', { id: CARD, action: 'accept' }, { ownerMemberId: 'mem-liam' })
    expect(out.note).toBeUndefined()
  })

  it('the description leads with card_id, and target_entity_id says it is NOT the card', () => {
    const t = tools().settle_card as unknown as { description: string; inputSchema: { shape: Record<string, { description?: string }> } }
    expect(t.description.split('. ')[0]).toMatch(/put the card's id in card_id/)
    expect(t.description).toMatch(/Never put the card's id in target_entity_id/)
    expect(t.inputSchema.shape.target_entity_id.description).toMatch(/^NOT the card's id \(that goes in card_id\)/)
  })
})

describe('revise_email_draft and undo_extraction_pass', () => {
  it('revise hands the whole revision over, for the caller in this workspace', async () => {
    await tools().revise_email_draft.execute({ draft_id: 'm-1', body: 'Dear Simon,', subject: 'Re: x' })
    expect(reviseEmailDraft).toHaveBeenCalledWith(fake, 'user-liam', WS, { draftId: 'm-1', body: 'Dear Simon,', subject: 'Re: x' })
  })

  it('undo hands the pass over, for the caller in this workspace', async () => {
    await tools().undo_extraction_pass.execute({ pass_id: PASS })
    expect(undoExtractionPass).toHaveBeenCalledWith(fake, 'user-liam', WS, PASS)
  })
})

describe('discard_email_draft', () => {
  it('a few drafts: hands them and the reason over, for the caller', async () => {
    await tools().discard_email_draft.execute({ draft_ids: ['d-1', 'draft:d-2'], reason: 'no_reply_needed', note: 'receipts' })
    expect(discardEmailDrafts).toHaveBeenCalledWith(fake, 'user-liam', { draftIds: ['d-1', 'draft:d-2'], reason: 'no_reply_needed', note: 'receipts', by: 'agent' })
    expect(readOwnDraftRows).not.toHaveBeenCalled()
  })

  it('more than five, unconfirmed: nothing is discarded; the drafts it would discard come back to show the person', async () => {
    const ids = ['x-0', 'x-1', 'x-2', 'x-3', 'x-4', 'x-5', 'x-6']
    const out = await tools().discard_email_draft.execute({ draft_ids: ids, reason: 'no_reply_needed' })
    expect(discardEmailDrafts).not.toHaveBeenCalled()
    expect(out).toMatchObject({ success: false, code: 'CONFIRM_FIRST' })
    const drafts = out.drafts as Array<{ draft_id: string; subject: string; to: string | null }>
    // The open ones only: x-0 is no draft of theirs, x-1 was sent.
    expect(drafts.map((d) => d.draft_id)).toEqual(['x-2', 'x-3', 'x-4', 'x-5', 'x-6'])
    expect(out.not_discardable).toEqual(['x-0', 'x-1'])
    // A subject derives from the sender's: fenced as outside text.
    expect(drafts[0].subject).toContain('Re: Receipt 2')
    expect(drafts[0].subject).not.toBe('Re: Receipt 2')
    expect(drafts[0].to).toBe('r2@squareup.com')
  })

  it('more than five, confirmed: discarded', async () => {
    const ids = ['x-0', 'x-1', 'x-2', 'x-3', 'x-4', 'x-5', 'x-6']
    await tools().discard_email_draft.execute({ draft_ids: ids, reason: 'outdated', confirmed: true })
    expect(discardEmailDrafts).toHaveBeenCalledWith(fake, 'user-liam', { draftIds: ids, reason: 'outdated', note: null, by: 'agent' })
  })

  it('takes one reason from the set, and at most 50 drafts', () => {
    const schema = tools().discard_email_draft.inputSchema
    expect(schema.safeParse({ draft_ids: ['d-1'], reason: 'no_reply_needed' }).success).toBe(true)
    expect(schema.safeParse({ draft_ids: ['d-1'], reason: 'spam' }).success).toBe(false)
    expect(schema.safeParse({ draft_ids: [], reason: 'other' }).success).toBe(false)
    expect(schema.safeParse({ draft_ids: Array.from({ length: 51 }, (_, i) => `d-${i}`), reason: 'other' }).success).toBe(false)
  })
})

describe('the route and the tool share one settle path (structural)', () => {
  const root = join(__dirname, '..', '..', '..', '..', '..')
  it('PATCH /api/account/attention-items calls settleAttentionCard and keeps no copy of its logic', () => {
    const route = readFileSync(join(root, 'src/app/api/account/attention-items/route.ts'), 'utf8')
    expect(route).toMatch(/settleAttentionCard\(/)
    expect(route).not.toMatch(/applyChange\(|function acceptCard|function dismissCard/)
  })
})
