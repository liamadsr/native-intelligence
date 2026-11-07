/**
 * The agent's create_email_draft joins the review pile (src/lib/email/tool-drafts.ts):
 * a reply gets an email_draft row AND a hold of the thread, read live from the
 * thread's own mailbox; a new message gets the row only; a revision releases
 * the old row; an automatic draft lands an email.drafted event (the cap).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'

const hoisted = vi.hoisted(() => ({
  readEmailThread: vi.fn(),
  recordEmailEvent: vi.fn(async () => 1),
}))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => { throw new Error('pass the client') } }))
vi.mock('../email-read-service', () => ({ readEmailThread: hoisted.readEmailThread }))
vi.mock('@/lib/agent-events/email', () => ({ recordEmailEvent: hoisted.recordEmailEvent }))

const { recordToolDraft } = await import('../tool-drafts')

let db: FakeSupabase
const THREAD = {
  threadId: 'thr-1', subject: 'Pricing', participantEmails: [], source: 'provider' as const,
  messages: [{ messageId: 'm1', from: 'Sam <sam@x.com>', to: 'liam@dial8.ai', cc: '', isDraft: false, date: 'd', dateISO: '2026-10-15T09:00:00.000Z', subject: 'Pricing', bodyText: 'Can we lock it?', hasAttachments: false, attachmentNames: [] }],
}
const BASE = { userId: 'u1', workspaceId: 'w1', providerDraftId: 'pd-1', subject: 'Re: Pricing', to: ['sam@x.com'], body: 'Yes, locked.' }

beforeEach(() => {
  db = makeFakeSupabase({ defaults: { email_hold: { id: 'hold-1' }, email_draft: { id: 'row-1', created_at: '2026-10-15T10:00:00.000Z' } } })
  db.seed('email_thread_index', [{ id: 'idx-1', user_id: 'u1', workspace_id: 'w1', provider_thread_id: 'thr-1', account_id: 'acct-1', provider: 'microsoft', trust: null }])
  hoisted.readEmailThread.mockReset().mockResolvedValue(THREAD)
  hoisted.recordEmailEvent.mockClear()
})

describe('recordToolDraft', () => {
  it("a reply replaces the thread's older untouched draft; the person's edited one stays (GEN-1164)", async () => {
    db.seed('email_draft', [
      { id: 'older', user_id: 'u1', provider_thread_id: 'thr-1', status: 'pending_review', account_id: null, provider_draft_id: 'pd-0' },
      { id: 'mine', user_id: 'u1', provider_thread_id: 'thr-1', status: 'edited', account_id: null, provider_draft_id: 'pd-9' },
    ])
    await recordToolDraft({ ...BASE, threadId: 'thr-1' }, db as never)
    expect(db.rows('email_draft').map((r) => r.id).sort()).toEqual(['mine', 'row-1'])
  })

  it('an automatic reply replaces nothing (it is refused while another draft waits)', async () => {
    db.seed('email_draft', [{ id: 'chat', user_id: 'u1', provider_thread_id: 'thr-1', status: 'pending_review', account_id: null, provider_draft_id: 'pd-0' }])
    await recordToolDraft({ ...BASE, threadId: 'thr-1', automatic: true }, db as never)
    expect(db.rows('email_draft').map((r) => r.id).sort()).toEqual(['chat', 'row-1'])
  })

  it('a reply: a review row and a hold of the thread, read live from its own mailbox', async () => {
    const out = await recordToolDraft({ ...BASE, threadId: 'thr-1' }, db as never)
    expect(out.held).toBe(true)
    expect(hoisted.readEmailThread).toHaveBeenCalledWith('u1', 'thr-1', 'w1', { accountId: 'acct-1', provider: 'microsoft' })
    const [hold] = db.rows('email_hold')
    expect(hold).toMatchObject({ user_id: 'u1', account_id: 'acct-1', provider_thread_id: 'thr-1', held_message_id: 'm1', subject: 'Pricing' })
    const [row] = db.rows('email_draft')
    expect(row).toMatchObject({ hold_id: hold.id, provider_draft_id: 'pd-1', email_thread_id: 'idx-1', status: 'pending_review', subject: 'Re: Pricing', account_id: 'acct-1' })
    // Asked for in a chat: never the automatic cap's.
    expect(row.metadata).toEqual({ origin: 'chat' })
    // An attended draft (chat) is not an automatic one: no event.
    expect(hoisted.recordEmailEvent).not.toHaveBeenCalled()
  })

  it('a brand-new message quotes no received mail: the row only, no hold, no read', async () => {
    await recordToolDraft({ ...BASE, threadId: null }, db as never)
    expect(db.rows('email_hold')).toHaveLength(0)
    expect(hoisted.readEmailThread).not.toHaveBeenCalled()
    expect(db.rows('email_draft')[0]).toMatchObject({ provider_draft_id: 'pd-1', is_reply: false })
    expect(db.rows('email_draft')[0]).not.toHaveProperty('hold_id')
  })

  it('a revision releases the old draft\'s row first', async () => {
    db.seed('email_draft', [{ id: 'old', user_id: 'u1', hold_id: null, status: 'pending_review', provider_draft_id: 'pd-0' }])
    await recordToolDraft({ ...BASE, threadId: null, previousDraftId: 'pd-0' }, db as never)
    expect(db.rows('email_draft').map((r) => r.provider_draft_id)).toEqual(['pd-1'])
  })

  it('an automatic draft (a helper, a work run) lands an email.drafted event, so the cap counts it after it is sent', async () => {
    await recordToolDraft({ ...BASE, threadId: 'thr-1', automatic: true }, db as never)
    expect(hoisted.recordEmailEvent).toHaveBeenCalledWith(
      { workspaceId: 'w1', userId: 'u1', drafted: [{ draftId: 'row-1', at: '2026-10-15T10:00:00.000Z' }] },
      db,
    )
  })

  it('a thread that cannot be read still gets its review row, without a hold', async () => {
    hoisted.readEmailThread.mockResolvedValueOnce(null)
    const out = await recordToolDraft({ ...BASE, threadId: 'thr-1' }, db as never)
    expect(out).toMatchObject({ held: false, draftRowId: 'row-1' })
    expect(db.rows('email_hold')).toHaveLength(0)
  })
})
