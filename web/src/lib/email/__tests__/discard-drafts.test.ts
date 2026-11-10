/**
 * discard_email_draft's logic (GEN-1165, ../discard-drafts.ts): "clean up my
 * junk drafts" ends with them gone from the mailbox and from Native Intelligence's pending
 * list, and the reason kept for the drafting passes.
 *
 *  - a Native Intelligence draft named by its row id, its list item id (draft:…) or its
 *    mailbox id: the mailbox copy goes first (at the mailbox the row names),
 *    then the row, then the work that delivered it stops waiting;
 *  - only the caller's own rows, in their workspaces: a draft with no row (one
 *    the person wrote), someone else's, or one in a workspace they left is
 *    not found, and nothing is deleted anywhere;
 *  - the mailbox refuses: nothing changes in Native Intelligence either;
 *  - a sent or dismissed draft is left as it is;
 *  - two drafts on one thread share a hold: discarding one keeps the hold
 *    (the other's review row stays), discarding both releases it;
 *  - the label: a draft_dismissed candidate with the reason and pointers
 *    (never mail text); no_reply_needed and outdated remember the thread as
 *    needing no reply, bad_draft doesn't.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'

const deleteDraftOfRow = vi.fn(async (..._a: unknown[]): Promise<'deleted' | 'not_found' | 'failed'> => 'deleted')
vi.mock('@/lib/email/provider-drafts', () => ({
  deleteDraftOfRow: (...a: unknown[]) => deleteDraftOfRow(...a),
  isProviderId: (id: unknown) => typeof id === 'string' && /^[A-Za-z0-9_=+/-]{1,512}$/.test(id),
}))
const resolveWorkForDeliverable = vi.fn(async (..._a: unknown[]) => ({ touched: [], completed: [] }))
vi.mock('@/lib/work/resolve', () => ({ resolveWorkForDeliverable: (...a: unknown[]) => resolveWorkForDeliverable(...a) }))

import { discardEmailDrafts, readOwnDraftRows, recipientDomain } from '../discard-drafts'

const WS = 'a6000000-0000-4000-8000-000000000001'
const LEFT_WS = 'a6000000-0000-4000-8000-000000000002'
const ROW = 'd6000000-0000-4000-8000-000000000001'
const SENT_ROW = 'd6000000-0000-4000-8000-000000000002'
const ANAS_ROW = 'd6000000-0000-4000-8000-000000000003'
const LOCAL_ROW = 'd6000000-0000-4000-8000-000000000004'
const TWIN_A = 'd6000000-0000-4000-8000-000000000005'
const TWIN_B = 'd6000000-0000-4000-8000-000000000006'
const LEFT_ROW = 'd6000000-0000-4000-8000-000000000007'

let fake: FakeSupabase
const draftIds = () => fake.rows('email_draft').map((r) => r.id)

/** Postgres cascades a hold's delete to its drafts (migration 343); the fake doesn't, so every email_draft call does it first. */
function cascadeHolds(db: FakeSupabase) {
  const from = db.from.bind(db)
  ;(db as unknown as { from: (t: string) => unknown }).from = (table: string) => {
    if (table === 'email_draft') {
      const holds = new Set(db.rows('email_hold').map((h) => h.id))
      const drafts = db.rows('email_draft')
      for (let i = drafts.length - 1; i >= 0; i--) if (drafts[i].hold_id && !holds.has(drafts[i].hold_id)) drafts.splice(i, 1)
    }
    return from(table)
  }
}

const draft = (over: Record<string, unknown>) => ({
  workspace_id: WS,
  user_id: 'user-1',
  status: 'pending_review',
  subject: 'Re: Your receipt from Square',
  to_emails: ['messenger@reply2.squareup.com'],
  provider: 'google',
  account_id: 'acct-1',
  provider_thread_id: 'thr-1',
  provider_draft_id: 'm-1',
  hold_id: null,
  stale: false,
  metadata: { origin: 'automatic' },
  created_at: '2026-10-26T10:00:00Z',
  ...over,
})

beforeEach(() => {
  fake = makeFakeSupabase()
  cascadeHolds(fake)
  deleteDraftOfRow.mockReset()
  deleteDraftOfRow.mockImplementation(async () => 'deleted')
  resolveWorkForDeliverable.mockClear()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  fake.seed('member', [{ id: 'mem-1', workspace_id: WS, user_id: 'user-1', created_at: '2026-01-01T00:00:00Z' }])
  fake.seed('email_draft', [
    draft({ id: ROW }),
    draft({ id: SENT_ROW, status: 'sent', provider_draft_id: 'm-sent', provider_thread_id: 'thr-2' }),
    draft({ id: ANAS_ROW, user_id: 'user-ana', provider_draft_id: 'm-ana', provider_thread_id: 'thr-3' }),
    draft({ id: LOCAL_ROW, provider_draft_id: null, provider_thread_id: 'thr-4', metadata: { origin: 'chat' } }),
    draft({ id: TWIN_A, provider_draft_id: 'm-a', provider_thread_id: 'thr-5', hold_id: 'hold-5' }),
    draft({ id: TWIN_B, provider_draft_id: 'm-b', provider_thread_id: 'thr-5', hold_id: 'hold-5' }),
    draft({ id: LEFT_ROW, workspace_id: LEFT_WS, provider_draft_id: 'm-left', provider_thread_id: 'thr-6' }),
  ])
  fake.seed('email_hold', [{ id: 'hold-5', user_id: 'user-1', workspace_id: WS }])
  fake.seed('email_thread_index', [
    { id: 'idx-1', user_id: 'user-1', workspace_id: WS, account_id: 'acct-1', provider_thread_id: 'thr-1', needs_reply: true, last_message_at: '2026-10-26T09:30:00Z' },
    { id: 'idx-5', user_id: 'user-1', workspace_id: WS, account_id: 'acct-1', provider_thread_id: 'thr-5', needs_reply: true, last_message_at: '2026-10-26T09:30:00Z' },
  ])
})

describe('discardEmailDrafts', () => {
  it('deletes the mailbox copy first, then the row; the work that delivered it stops waiting; never sends', async () => {
    const out = await discardEmailDrafts(fake as never, 'user-1', { draftIds: [ROW], reason: 'no_reply_needed' })
    expect(out).toMatchObject({ success: true, discarded: 1, results: [{ id: ROW, discarded: true, draft_row_id: ROW, workspace_id: WS, mailbox: 'deleted' }] })
    expect(deleteDraftOfRow).toHaveBeenCalledWith('user-1', expect.objectContaining({ provider: 'google', account_id: 'acct-1', provider_draft_id: 'm-1', provider_thread_id: 'thr-1' }))
    expect(draftIds()).not.toContain(ROW)
    expect(resolveWorkForDeliverable).toHaveBeenCalledWith(fake, { type: 'email_draft', id: ROW }, expect.anything())
    expect(resolveWorkForDeliverable).toHaveBeenCalledWith(fake, { type: 'email_draft', id: 'm-1' }, expect.anything())
    expect(out.message).toMatch(/in Native Intelligence and in the mailbox/)
    expect(out.message).toMatch(/Nothing was sent/)
    // The person's verdict: dormancy reads it.
    expect(fake.rows('mail_review_activity')).toEqual([expect.objectContaining({ user_id: 'user-1', workspace_id: WS })])
  })

  it('takes the list item id (draft:…) and the mailbox id too, and a row named twice is discarded once', async () => {
    const out = await discardEmailDrafts(fake as never, 'user-1', { draftIds: [`draft:${ROW}`, 'm-1'], reason: 'duplicate' })
    expect(out.discarded).toBe(1)
    expect(deleteDraftOfRow).toHaveBeenCalledTimes(1)
    expect(out.results.map((r) => r.discarded)).toEqual([true, false])
  })

  it('keeps the reason for the drafting passes: pointers only, never mail text', async () => {
    await discardEmailDrafts(fake as never, 'user-1', { draftIds: [ROW], reason: 'no_reply_needed', note: 'it is a receipt' })
    const [candidate] = fake.rows('eval_candidate')
    expect(candidate).toMatchObject({
      workspace_id: WS,
      user_id: 'user-1',
      source: 'draft_dismissed',
      polarity: 'bad',
      ref_type: 'email_draft',
      ref_id: ROW,
      reason: 'it is a receipt',
      dedupe_key: `draft_dismissed:${ROW}`,
    })
    expect(candidate.evidence).toMatchObject({
      kind: 'draft_dismissed',
      reason: 'no_reply_needed',
      origin: 'automatic',
      by: 'agent',
      recipientDomain: 'reply2.squareup.com',
      providerThreadId: 'thr-1',
      accountId: 'acct-1',
    })
    const text = JSON.stringify(candidate.evidence)
    expect(text).not.toMatch(/Square|receipt|messenger@/)
  })

  it('no_reply_needed remembers the thread as needing no reply; bad_draft does not', async () => {
    await discardEmailDrafts(fake as never, 'user-1', { draftIds: [ROW], reason: 'no_reply_needed' })
    expect(fake.rows('email_thread_index').find((r) => r.id === 'idx-1')?.needs_reply).toBe(false)

    await discardEmailDrafts(fake as never, 'user-1', { draftIds: [TWIN_A], reason: 'bad_draft' })
    expect(fake.rows('email_thread_index').find((r) => r.id === 'idx-5')?.needs_reply).toBe(true)
  })

  it('a message that came after the draft is still to be read: the thread keeps needing a reply', async () => {
    fake.rows('email_thread_index').find((r) => r.id === 'idx-1')!.last_message_at = '2026-10-26T11:00:00Z'
    await discardEmailDrafts(fake as never, 'user-1', { draftIds: [ROW], reason: 'outdated' })
    expect(fake.rows('email_thread_index').find((r) => r.id === 'idx-1')?.needs_reply).toBe(true)
  })

  it('nothing in the mailbox holds that id any more (edited in Gmail, say): gone from Native Intelligence, and it says it may still be in Drafts', async () => {
    deleteDraftOfRow.mockImplementation(async () => 'not_found')
    const out = await discardEmailDrafts(fake as never, 'user-1', { draftIds: [ROW], reason: 'no_reply_needed' })
    expect(out.results[0]).toMatchObject({ discarded: true, mailbox: 'not_found', note: expect.stringMatching(/may still be in their Drafts/) })
    expect(out.message).toMatch(/^Discarded 1 draft in Native Intelligence\. 1 was no longer in the mailbox/)
    expect(out.message).not.toMatch(/in Native Intelligence and in the mailbox/)
    expect(draftIds()).not.toContain(ROW)
  })

  it('a row the release did not take is never said to be discarded', async () => {
    const from = fake.from.bind(fake)
    ;(fake as unknown as { from: (t: string) => unknown }).from = (table: string) => {
      const q = from(table) as Record<string, unknown>
      if (table !== 'email_draft') return q
      // The delete answers an error (supabase-js resolves it; it never throws).
      const failed: Record<string, unknown> = { eq: () => failed, in: () => failed, then: (ok: (v: unknown) => unknown) => ok({ data: null, error: { message: 'boom' } }) }
      return { ...q, delete: () => failed }
    }
    const out = await discardEmailDrafts(fake as never, 'user-1', { draftIds: [ROW], reason: 'no_reply_needed' })
    expect(out).toMatchObject({ success: false, discarded: 0, results: [{ discarded: false, code: 'FAILED', error: expect.stringMatching(/gone from the mailbox, but it is still listed in Native Intelligence/) }] })
    expect(fake.rows('eval_candidate')).toHaveLength(0)
  })

  it('never reaches a draft Native Intelligence did not write, someone else’s, or one in a workspace the caller left', async () => {
    const out = await discardEmailDrafts(fake as never, 'user-1', {
      draftIds: ['m-written-in-gmail', ANAS_ROW, 'm-ana', LEFT_ROW, 'not an id'],
      reason: 'no_reply_needed',
    })
    expect(out).toMatchObject({ success: false, discarded: 0 })
    expect(out.results.every((r) => !r.discarded && r.code === 'NOT_FOUND')).toBe(true)
    expect(deleteDraftOfRow).not.toHaveBeenCalled()
    expect(draftIds()).toEqual(expect.arrayContaining([ANAS_ROW, LEFT_ROW]))
    expect(fake.rows('eval_candidate')).toHaveLength(0)
  })

  it('a mailbox that refuses changes nothing in Native Intelligence either, and says so', async () => {
    deleteDraftOfRow.mockImplementation(async () => 'failed')
    const out = await discardEmailDrafts(fake as never, 'user-1', { draftIds: [ROW], reason: 'no_reply_needed' })
    expect(out).toMatchObject({ success: false, discarded: 0, results: [{ discarded: false, code: 'MAILBOX_FAILED' }] })
    expect(draftIds()).toContain(ROW)
    expect(fake.rows('eval_candidate')).toHaveLength(0)
    expect(fake.rows('email_thread_index').find((r) => r.id === 'idx-1')?.needs_reply).toBe(true)
  })

  it('leaves a sent draft as it is', async () => {
    const out = await discardEmailDrafts(fake as never, 'user-1', { draftIds: [SENT_ROW], reason: 'outdated' })
    expect(out).toMatchObject({ success: true, discarded: 0, results: [{ discarded: false, code: 'ALREADY_SETTLED' }] })
    expect(deleteDraftOfRow).not.toHaveBeenCalled()
  })

  it('a draft with no mailbox copy is discarded in Native Intelligence only', async () => {
    const out = await discardEmailDrafts(fake as never, 'user-1', { draftIds: [LOCAL_ROW], reason: 'other' })
    expect(out.results[0]).toMatchObject({ discarded: true, mailbox: 'none' })
    expect(deleteDraftOfRow).not.toHaveBeenCalled()
    expect(draftIds()).not.toContain(LOCAL_ROW)
    expect(fake.rows('eval_candidate')[0].evidence).toMatchObject({ origin: 'chat', reason: 'other' })
  })

  it('one of two drafts on a thread: the hold stays for the other; both: the hold goes', async () => {
    await discardEmailDrafts(fake as never, 'user-1', { draftIds: [TWIN_A], reason: 'duplicate' })
    expect(fake.rows('email_hold').map((h) => h.id)).toEqual(['hold-5'])
    expect(draftIds()).not.toContain(TWIN_A)
    expect(draftIds()).toContain(TWIN_B)

    const out = await discardEmailDrafts(fake as never, 'user-1', { draftIds: [TWIN_B], reason: 'no_reply_needed' })
    expect(out.discarded).toBe(1)
    expect(fake.rows('email_hold')).toHaveLength(0)
  })

  it('both drafts on a thread in one call: the hold goes', async () => {
    const out = await discardEmailDrafts(fake as never, 'user-1', { draftIds: [TWIN_A, TWIN_B], reason: 'no_reply_needed' })
    expect(out.discarded).toBe(2)
    expect(fake.rows('email_hold')).toHaveLength(0)
  })

  it('two discards at once, one draft each on a shared hold: the hold still goes (neither leaves it for the other)', async () => {
    const [a, b] = await Promise.all([
      discardEmailDrafts(fake as never, 'user-1', { draftIds: [TWIN_A], reason: 'duplicate' }),
      discardEmailDrafts(fake as never, 'user-1', { draftIds: [TWIN_B], reason: 'duplicate' }),
    ])
    expect(a.discarded + b.discarded).toBe(2)
    expect(fake.rows('email_hold')).toHaveLength(0)
  })
})

describe('readOwnDraftRows', () => {
  it('maps each id to the caller’s own row, or none', async () => {
    const found = await readOwnDraftRows(fake as never, 'user-1', [ROW, 'm-b', ANAS_ROW])
    expect(found.map((f) => f.row?.id ?? null)).toEqual([ROW, TWIN_B, null])
  })
})

describe('recipientDomain', () => {
  it('is the domain the reply would go to, never the address', () => {
    expect(recipientDomain(['Square <messenger@Reply2.SquareUp.com>'])).toBe('reply2.squareup.com')
    expect(recipientDomain([])).toBeUndefined()
    expect(recipientDomain(null)).toBeUndefined()
  })
})
