/**
 * A new message on a held thread (src/lib/email/held-refresh.ts; Liam,
 * 2026-10-15): an untouched draft is re-drafted (the old row and its mailbox
 * draft go once the new one lands), an edited one is kept and marked stale,
 * and a hold whose thread is gone, answered elsewhere, or whose draft was
 * discarded in the mailbox is released. Gated drafting marks stale instead.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'

vi.mock('@/lib/crm/email-drafts', () => ({ generateEmailDrafts: vi.fn() }))
vi.mock('../thread-mailbox', () => ({ ownedMailbox: vi.fn() }))

const { refreshHeldThreads, mailboxDraftState } = await import('../held-refresh')

let db: FakeSupabase
const readThread = vi.fn()
const generate = vi.fn()
const deleteMailboxDraft = vi.fn(async () => true)

const msg = (id: string, from: string, extra: Record<string, unknown> = {}) => ({
  messageId: id, from, to: 'liam@dial8.ai', cc: '', isDraft: false, date: 'd', dateISO: '2026-10-15T10:00:00.000Z',
  subject: 'Pricing', bodyText: `body ${id}`, hasAttachments: false, attachmentNames: [], ...extra,
})
const thread = (...messages: unknown[]) => ({ threadId: 't1', subject: 'Pricing', messages, participantEmails: [], source: 'provider' as const })

const INPUT = {
  userId: 'u1', workspaceId: 'w1', accountId: 'a1', provider: 'google' as const,
  providerThreadIds: ['t1'], mailboxEmail: 'liam@dial8.ai', mayDraft: true,
}

beforeEach(() => {
  db = makeFakeSupabase()
  db.seed('email_hold', [{ id: 'h1', user_id: 'u1', workspace_id: 'w1', account_id: 'a1', provider: 'google', provider_thread_id: 't1', held_message_id: 'm1', status: 'held', messages: [], trust: null }])
  db.seed('email_draft', [{ id: 'd1', user_id: 'u1', hold_id: 'h1', status: 'pending_review', stale: false, provider_draft_id: 'pd1', created_at: '2026-10-14T00:00:00.000Z' }])
  db.seed('email_thread_index', [{ id: 'i1', user_id: 'u1', provider_thread_id: 't1' }])
  readThread.mockReset()
  generate.mockReset()
  deleteMailboxDraft.mockClear()
})

const run = (over: Partial<typeof INPUT> = {}) =>
  refreshHeldThreads(db as never, { ...INPUT, ...over }, { readThread, generate, deleteMailboxDraft })

describe('refreshHeldThreads', () => {
  it('re-drafts an untouched draft: the new one lands, the old row and its mailbox draft go', async () => {
    readThread.mockResolvedValue(thread(msg('m1', 'sam@x.com'), msg('pd1', 'liam@dial8.ai', { isDraft: true }), msg('m2', 'sam@x.com')))
    generate.mockResolvedValue({ drafts: [{ id: 'd2', email_thread_id: 'i1', created_at: 'now' }], count: 1 })
    const out = await run()
    expect(generate).toHaveBeenCalledWith('u1', 'w1', expect.objectContaining({ thread_ids: ['t1'], max_drafts: 1, replyIntent: 'automatic', review: false }))
    expect(out).toEqual({ redrafted: [{ id: 'd2', email_thread_id: 'i1', created_at: 'now' }], staled: 0, released: 0 })
    expect(db.rows('email_draft').map((d) => d.id)).toEqual([])
    expect(deleteMailboxDraft).toHaveBeenCalledWith(expect.objectContaining({ id: 'h1' }), 'pd1')
    // The read is live, from the hold's own mailbox.
    expect(readThread).toHaveBeenCalledWith('u1', 't1', 'w1', { accountId: 'a1', provider: 'google' })
  })

  it('an edited draft is kept and marked stale; the copy is refreshed', async () => {
    db.rows('email_draft')[0].status = 'edited'
    readThread.mockResolvedValue(thread(msg('m1', 'sam@x.com'), msg('pd1', 'liam@dial8.ai', { isDraft: true }), msg('m2', 'sam@x.com')))
    expect(await run()).toEqual({ redrafted: [], staled: 1, released: 0 })
    expect(generate).not.toHaveBeenCalled()
    expect(db.rows('email_draft')[0]).toMatchObject({ status: 'edited', stale: true })
    expect(db.rows('email_hold')[0]).toMatchObject({ held_message_id: 'm2' })
  })

  it('a draft edited in Gmail (new message id) counts as edited: stale, never re-drafted over', async () => {
    readThread.mockResolvedValue(thread(msg('m1', 'sam@x.com'), msg('pd1-edited', 'liam@dial8.ai', { isDraft: true }), msg('m2', 'sam@x.com')))
    expect((await run()).staled).toBe(1)
    expect(generate).not.toHaveBeenCalled()
  })

  it('gated drafting marks an untouched draft stale instead of re-drafting', async () => {
    readThread.mockResolvedValue(thread(msg('m1', 'sam@x.com'), msg('pd1', 'liam@dial8.ai', { isDraft: true }), msg('m2', 'sam@x.com')))
    expect((await run({ mayDraft: false })).staled).toBe(1)
    expect(generate).not.toHaveBeenCalled()
    expect(db.rows('email_draft')[0]).toMatchObject({ status: 'pending_review', stale: true })
  })

  it.each([
    ['an out-of-office (Auto-Submitted)', msg('m2', 'Pat <pat@x.com>', { automatedBy: 'auto_submitted' })],
    ['a no-reply notice', msg('m2', 'gustonoreply@gusto.com')],
  ])('%s on a held thread writes no draft and leaves the person\'s draft as it was', async (_label, newest) => {
    readThread.mockResolvedValue(thread(msg('m1', 'sam@x.com'), msg('pd1', 'liam@dial8.ai', { isDraft: true }), newest))
    expect(await run()).toEqual({ redrafted: [], staled: 0, released: 0 })
    expect(generate).not.toHaveBeenCalled()
    expect(db.rows('email_draft')[0]).toMatchObject({ id: 'd1', status: 'pending_review', stale: false })
    expect(db.rows('email_hold')[0]).toMatchObject({ held_message_id: 'm2' })
    expect(deleteMailboxDraft).not.toHaveBeenCalled()
  })

  it('the cap stopping the re-draft brings the old draft back, stale', async () => {
    readThread.mockResolvedValue(thread(msg('m1', 'sam@x.com'), msg('pd1', 'liam@dial8.ai', { isDraft: true }), msg('m2', 'sam@x.com')))
    generate.mockResolvedValue({ drafts: [], count: 0, stoppedBy: 'allowance' })
    expect((await run()).staled).toBe(1)
    expect(db.rows('email_draft')[0]).toMatchObject({ id: 'd1', status: 'pending_review', stale: true })
  })

  it('the reply gate saying no reply is needed now releases the hold and our untouched mailbox draft', async () => {
    readThread.mockResolvedValue(thread(msg('m1', 'sam@x.com'), msg('pd1', 'liam@dial8.ai', { isDraft: true }), msg('m2', 'sam@x.com')))
    generate.mockResolvedValue({ drafts: [], count: 0, skipped: { t1: 'no_reply' } })
    expect((await run()).released).toBe(1)
    expect(db.rows('email_hold')).toHaveLength(0)
    expect(deleteMailboxDraft).toHaveBeenCalledWith(expect.objectContaining({ id: 'h1' }), 'pd1')
  })

  it('a temporary skip (unreadable body, unverified Reply-To, index ahead, another open draft) keeps the person\'s draft, stale', async () => {
    for (const result of [{ drafts: [], count: 0, skipped: { t1: 'deferred' } }, { drafts: [], count: 0 }]) {
      db.rows('email_draft')[0].status = 'pending_review'
      db.rows('email_draft')[0].stale = false
      db.rows('email_hold')[0].held_message_id = 'm1'
      readThread.mockResolvedValue(thread(msg('m1', 'sam@x.com'), msg('pd1', 'liam@dial8.ai', { isDraft: true }), msg('m2', 'sam@x.com')))
      generate.mockResolvedValue(result)
      expect(await run()).toEqual({ redrafted: [], staled: 1, released: 0 })
      expect(db.rows('email_hold')).toHaveLength(1)
      expect(db.rows('email_draft')[0]).toMatchObject({ id: 'd1', status: 'pending_review', stale: true })
      expect(deleteMailboxDraft).not.toHaveBeenCalled()
    }
  })

  it('a send begun mid-refresh (the hold went sending) is left alone: no re-draft, no stale write', async () => {
    readThread.mockImplementation(async () => {
      db.rows('email_hold')[0].status = 'sending'
      return thread(msg('m1', 'sam@x.com'), msg('pd1', 'liam@dial8.ai', { isDraft: true }), msg('m2', 'sam@x.com'))
    })
    expect(await run()).toEqual({ redrafted: [], staled: 0, released: 0 })
    expect(generate).not.toHaveBeenCalled()
    expect(db.rows('email_draft')[0]).toMatchObject({ status: 'pending_review', stale: false })
  })

  it('the re-draft is told the hold must still exist (never recreated)', async () => {
    readThread.mockResolvedValue(thread(msg('m1', 'sam@x.com'), msg('pd1', 'liam@dial8.ai', { isDraft: true }), msg('m2', 'sam@x.com')))
    generate.mockResolvedValue({ drafts: [], count: 0, skipped: { t1: 'deferred' } })
    await run()
    expect(generate.mock.calls[0][2]).toMatchObject({ holdMustExist: true })
  })

  it('answered elsewhere (the newest message is the person\'s own): the hold goes, their mailbox untouched', async () => {
    readThread.mockResolvedValue(thread(msg('m1', 'sam@x.com'), msg('m2', 'Liam <liam@dial8.ai>')))
    expect((await run()).released).toBe(1)
    expect(db.rows('email_hold')).toHaveLength(0)
    expect(deleteMailboxDraft).not.toHaveBeenCalled()
  })

  it('our draft discarded in the mailbox: the hold goes', async () => {
    readThread.mockResolvedValue(thread(msg('m1', 'sam@x.com'), msg('m2', 'sam@x.com')))
    expect((await run()).released).toBe(1)
  })

  it('a thread gone from the mailbox and the index: the hold goes; merely unreadable: it stays', async () => {
    readThread.mockResolvedValue(null)
    expect((await run()).released).toBe(0)
    expect(db.rows('email_hold')).toHaveLength(1)
    db.rows('email_thread_index').length = 0
    expect((await run()).released).toBe(1)
    expect(db.rows('email_hold')).toHaveLength(0)
  })

  it('no new message (our own draft landing): nothing changes', async () => {
    readThread.mockResolvedValue(thread(msg('m1', 'sam@x.com'), msg('pd1', 'liam@dial8.ai', { isDraft: true })))
    expect(await run()).toEqual({ redrafted: [], staled: 0, released: 0 })
    expect(db.calls.filter((c) => c.op !== 'select')).toEqual([])
  })

  it('a hold mid-send is left alone', async () => {
    db.rows('email_hold')[0].status = 'sending'
    expect(await run()).toEqual({ redrafted: [], staled: 0, released: 0 })
    expect(readThread).not.toHaveBeenCalled()
  })
})

describe('mailboxDraftState', () => {
  it('there, changed (Gmail gives an edit a new id) or gone', () => {
    const t = (ids: string[]) => ({ messages: ids.map((id) => ({ messageId: id, isDraft: true })) }) as never
    expect(mailboxDraftState(t(['pd1']), 'pd1')).toBe('there')
    expect(mailboxDraftState(t(['pd9']), 'pd1')).toBe('changed')
    expect(mailboxDraftState(t([]), 'pd1')).toBe('gone')
    expect(mailboxDraftState(t([]), null)).toBe('unknown')
  })
})
