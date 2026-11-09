import { describe, expect, it, vi } from 'vitest'
import { makeFakeSupabase } from '@/lib/work/__tests__/fake-supabase'

vi.mock('@/lib/admin', () => ({ getServiceClient: () => { throw new Error('pass the client') } }))
const { supersedeOtherDrafts } = await import('../one-draft')

const draft = (id: string, status: string, more: Record<string, unknown> = {}) => ({
  id, user_id: 'u1', provider_thread_id: 'thr-1', status, account_id: 'acct-1', provider_draft_id: `pd-${id}`, ...more,
})

describe('one live draft per thread (GEN-1164)', () => {
  it("removes the thread's other untouched drafts and their mailbox drafts; keeps the new one, edited and approved ones, and other threads", async () => {
    const db = makeFakeSupabase()
    db.seed('email_draft', [
      draft('new', 'pending_review', { hold_id: 'h1' }), draft('accepts', 'pending_review', { hold_id: 'h1' }), draft('declines', 'pending_review', { hold_id: 'h1' }),
      draft('saved', 'approved'), draft('mine', 'edited'), draft('other', 'pending_review', { provider_thread_id: 'thr-2' }),
      draft('theirs', 'pending_review', { user_id: 'u2' }), draft('legacy', 'pending_review', { account_id: null }),
    ])
    db.seed('email_hold', [{ id: 'h1', user_id: 'u1' }])
    const deleteMailboxDraft = vi.fn(async (_userId: string, _accountId: string, _draftId: string) => true)
    expect(await supersedeOtherDrafts(db as never, { userId: 'u1', providerThreadId: 'thr-1', keepId: 'new' }, { deleteMailboxDraft })).toBe(3)
    expect(db.rows('email_draft').map((r) => r.id).sort()).toEqual(['mine', 'new', 'other', 'saved', 'theirs'])
    // By the id Native Intelligence saved; a legacy row with no account has no mailbox to clean.
    expect(deleteMailboxDraft.mock.calls.map((c) => c[2]).sort()).toEqual(['pd-accepts', 'pd-declines'])
    // The new draft rests on the hold: it stays.
    expect(db.rows('email_hold')).toHaveLength(1)
  })

  it('a hold no draft rests on any more goes (the new draft got none of its own)', async () => {
    const db = makeFakeSupabase()
    db.seed('email_draft', [draft('new', 'pending_review'), draft('older', 'pending_review', { hold_id: 'h-old' })])
    db.seed('email_hold', [{ id: 'h-old', user_id: 'u1' }])
    expect(await supersedeOtherDrafts(db as never, { userId: 'u1', providerThreadId: 'thr-1', keepId: 'new' }, { deleteMailboxDraft: async () => true })).toBe(1)
    expect(db.rows('email_hold')).toHaveLength(0)
  })

  it('no thread, nothing else open, or a failing read: nothing goes, never throws', async () => {
    const db = makeFakeSupabase()
    db.seed('email_draft', [draft('new', 'pending_review')])
    expect(await supersedeOtherDrafts(db as never, { userId: 'u1', providerThreadId: null, keepId: 'new' })).toBe(0)
    expect(await supersedeOtherDrafts(db as never, { userId: 'u1', providerThreadId: 'thr-1', keepId: 'new' })).toBe(0)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await supersedeOtherDrafts({ from: () => { throw new Error('down') } } as never, { userId: 'u1', providerThreadId: 'thr-1', keepId: 'new' })).toBe(0)
  })
})
