/**
 * The holding pattern (src/lib/email/hold.ts, migration 343). Pinned:
 *   - holdThread writes the thread's copy (subject, plain-text chain, capped)
 *     once per (owner, mailbox, thread), and a second call refreshes it in
 *     place, keeping the expiry;
 *   - send: the hold goes 'sending', then is deleted with its drafts; a failed
 *     send puts it back to 'held';
 *   - dismiss: the hold and its drafts are deleted; a draft of the person's own
 *     words (no hold) is deleted on its own;
 *   - expiry: 14 days untouched, or stuck 'sending' for an hour, deletes the
 *     hold; touching it pushes the expiry out 14 days;
 *   - a new message re-drafts an untouched draft and marks an edited one stale;
 *   - every read and write fences on the owner.
 */
import { describe, it, expect } from 'vitest'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'
import {
  HOLD_MAX_BODY_CHARS,
  HOLD_MAX_MESSAGES,
  HOLD_TTL_MS,
  draftRowsFor,
  expireHolds,
  findHold,
  heldMessagesFrom,
  heldThreadAction,
  holdThread,
  markHoldsSending,
  releaseDraftRows,
  restoreHolds,
  touchHold,
} from '../hold'
import type { SupabaseClient } from '@supabase/supabase-js'

const NOW = new Date('2026-10-15T12:00:00Z')

function db(): { fake: FakeSupabase; sb: SupabaseClient } {
  let n = 0
  const fake = makeFakeSupabase({
    defaults: {
      email_hold: { status: 'held', id: undefined },
      email_draft: { status: 'pending_review', stale: false },
    },
    unique: { email_hold: [] },
  })
  const from = fake.from.bind(fake)
  // ids for inserted holds; the cascade (email_draft.hold_id ON DELETE CASCADE) after each delete.
  const wrapped = {
    ...fake,
    from: (table: string) => {
      const q = from(table) as Record<string, (...a: unknown[]) => unknown>
      const insert = q.insert
      q.insert = (...a: unknown[]) => insert({ id: `hold-${++n}`, ...(a[0] as Record<string, unknown>) })
      return q
    },
  }
  return { fake, sb: wrapped as unknown as SupabaseClient }
}

/** The DB cascade: drafts whose hold is gone go with it. */
function cascade(fake: FakeSupabase) {
  const holds = new Set(fake.rows('email_hold').map((h) => h.id))
  const kept = fake.rows('email_draft').filter((d) => !d.hold_id || holds.has(d.hold_id))
  fake.rows('email_draft').splice(0, fake.rows('email_draft').length, ...kept)
}

const THREAD = (newest = 'm2', body = 'Can we lock the price?') => ({
  subject: 'Pricing',
  messages: [
    { messageId: 'm1', from: 'Sam <sam@x.com>', to: 'liam@dial8.ai', cc: '', isDraft: false, date: 'Mon', dateISO: '2026-10-12T10:00:00.000Z', subject: 'Pricing', bodyText: 'Hi', hasAttachments: false, attachmentNames: [] },
    { messageId: newest, from: 'Sam <sam@x.com>', to: 'Liam <liam@dial8.ai>', cc: 'Ops <ops@x.com>', isDraft: false, date: 'Tue', dateISO: '2026-10-13T10:00:00.000Z', subject: 'Re: Pricing', bodyText: body, hasAttachments: true, attachmentNames: ['quote.pdf'] },
    { messageId: 'd1', from: 'liam@dial8.ai', to: 'sam@x.com', cc: '', isDraft: true, date: 'Wed', subject: 'Re: Pricing', bodyText: 'draft', hasAttachments: false, attachmentNames: [] },
  ],
})

const TARGET = { userId: 'u1', workspaceId: 'w1', accountId: 'a1', provider: 'google' as const, providerThreadId: 't1' }

describe('heldMessagesFrom', () => {
  it('keeps sent messages only, plain text, addresses lowercased, oldest first', () => {
    const held = heldMessagesFrom(THREAD())
    expect(held.map((m) => m.message_id)).toEqual(['m1', 'm2'])
    expect(held[1]).toEqual({
      message_id: 'm2',
      from: 'Sam <sam@x.com>',
      to: ['liam@dial8.ai'],
      cc: ['ops@x.com'],
      date: '2026-10-13T10:00:00.000Z',
      body_text: 'Can we lock the price?',
      attachment_names: ['quote.pdf'],
    })
  })

  it('caps the chain at the reply gate limits', () => {
    const many = { messages: Array.from({ length: 40 }, (_, i) => ({ ...THREAD().messages[0], messageId: `m${i}`, bodyText: 'x'.repeat(30_000) })) }
    const held = heldMessagesFrom(many)
    expect(held).toHaveLength(HOLD_MAX_MESSAGES)
    expect(held[0].message_id).toBe('m10')
    expect(held[0].body_text).toHaveLength(HOLD_MAX_BODY_CHARS)
  })
})

describe('holdThread', () => {
  it('writes one hold per thread and refreshes it in place, keeping the expiry', async () => {
    const { fake, sb } = db()
    const id = await holdThread(sb, { ...TARGET, thread: THREAD() }, NOW)
    expect(id).toBeTruthy()
    const [row] = fake.rows('email_hold')
    expect(row).toMatchObject({ user_id: 'u1', account_id: 'a1', provider_thread_id: 't1', held_message_id: 'm2', subject: 'Pricing', status: 'held' })
    expect(row.expires_at).toBe(new Date(NOW.getTime() + HOLD_TTL_MS).toISOString())

    const later = new Date(NOW.getTime() + 60_000)
    const again = await holdThread(sb, { ...TARGET, thread: THREAD('m3', 'New reply') }, later)
    expect(again).toBe(id)
    expect(fake.rows('email_hold')).toHaveLength(1)
    expect(fake.rows('email_hold')[0]).toMatchObject({ held_message_id: 'm3' })
    expect((fake.rows('email_hold')[0].messages as Array<{ body_text: string }>).at(-1)?.body_text).toBe('New reply')
    expect(fake.rows('email_hold')[0].expires_at).toBe(row.expires_at)
  })

  it('a refresh (mustExist) never creates a hold, nor writes one mid-send', async () => {
    const { fake, sb } = db()
    expect(await holdThread(sb, { ...TARGET, thread: THREAD(), mustExist: true }, NOW)).toBeNull()
    expect(fake.rows('email_hold')).toHaveLength(0)
    await holdThread(sb, { ...TARGET, thread: THREAD() }, NOW)
    fake.rows('email_hold')[0].status = 'sending'
    expect(await holdThread(sb, { ...TARGET, thread: THREAD('m9'), mustExist: true }, NOW)).toBeNull()
    expect(fake.rows('email_hold')[0].held_message_id).toBe('m2')
  })

  it('holds nothing for a thread with no sent message', async () => {
    const { fake, sb } = db()
    expect(await holdThread(sb, { ...TARGET, thread: { subject: 'x', messages: [THREAD().messages[2]] } }, NOW)).toBeNull()
    expect(fake.rows('email_hold')).toHaveLength(0)
  })

  it('carries an injection mark, never another value', async () => {
    const { fake, sb } = db()
    await holdThread(sb, { ...TARGET, thread: THREAD(), trust: 'injection' }, NOW)
    await holdThread(sb, { ...TARGET, providerThreadId: 't2', thread: THREAD(), trust: 'suspicious' }, NOW)
    expect(fake.rows('email_hold').map((h) => h.trust)).toEqual(['injection', null])
  })

  it('never finds another owner\'s hold', async () => {
    const { sb } = db()
    await holdThread(sb, { ...TARGET, thread: THREAD() }, NOW)
    expect(await findHold(sb, { userId: 'u2', accountId: 'a1', providerThreadId: 't1' })).toBeNull()
    expect(await findHold(sb, { userId: 'u1', accountId: 'a1', providerThreadId: 't1' })).not.toBeNull()
  })
})

async function heldDraft(fake: FakeSupabase, sb: SupabaseClient) {
  const holdId = (await holdThread(sb, { ...TARGET, thread: THREAD() }, NOW))!
  fake.seed('email_draft', [{ id: 'dr1', user_id: 'u1', hold_id: holdId, status: 'pending_review', stale: false, provider_draft_id: 'pd1', body_text: 'Yes, locked.' }])
  return holdId
}

describe('the lifecycle', () => {
  it('a send or dismiss stamps a service-only activity row (never member); a plain release does not', async () => {
    const { fake, sb } = db()
    await heldDraft(fake, sb)
    fake.rows('email_draft')[0].workspace_id = 'w1'
    await releaseDraftRows(sb, 'u1', await draftRowsFor(sb, 'u1', { draftId: 'dr1' }), { reviewed: true })
    expect(fake.rows('mail_review_activity')).toEqual([expect.objectContaining({ user_id: 'u1', workspace_id: 'w1' })])
    expect(fake.rows('member')).toEqual([])
  })

  it('send: sending while in flight, then the hold and its draft are gone', async () => {
    const { fake, sb } = db()
    const holdId = await heldDraft(fake, sb)
    const rows = await draftRowsFor(sb, 'u1', { providerDraftId: 'pd1' })
    expect(await markHoldsSending(sb, 'u1', rows)).toEqual([holdId])
    expect(fake.rows('email_hold')[0].status).toBe('sending')
    expect(await releaseDraftRows(sb, 'u1', rows)).toEqual(['dr1'])
    cascade(fake)
    expect(fake.rows('email_hold')).toHaveLength(0)
    expect(fake.rows('email_draft')).toHaveLength(0)
  })

  it('a failed send puts the hold back to held', async () => {
    const { fake, sb } = db()
    await heldDraft(fake, sb)
    const rows = await draftRowsFor(sb, 'u1', { draftId: 'dr1' })
    const sending = await markHoldsSending(sb, 'u1', rows)
    await restoreHolds(sb, 'u1', sending)
    expect(fake.rows('email_hold')[0].status).toBe('held')
    expect(fake.rows('email_draft')).toHaveLength(1)
  })

  it('dismiss: the hold and its draft are deleted; an own-words draft goes on its own', async () => {
    const { fake, sb } = db()
    await heldDraft(fake, sb)
    fake.seed('email_draft', [{ id: 'own', user_id: 'u1', hold_id: null, status: 'pending_review', provider_draft_id: 'pd2' }])
    await releaseDraftRows(sb, 'u1', await draftRowsFor(sb, 'u1', { providerDraftId: 'pd1' }))
    cascade(fake)
    expect(fake.rows('email_hold')).toHaveLength(0)
    expect(fake.rows('email_draft').map((d) => d.id)).toEqual(['own'])
    await releaseDraftRows(sb, 'u1', await draftRowsFor(sb, 'u1', { draftId: 'own' }))
    expect(fake.rows('email_draft')).toHaveLength(0)
  })

  it('another person cannot release, send or touch the owner\'s hold', async () => {
    const { fake, sb } = db()
    const holdId = await heldDraft(fake, sb)
    expect(await draftRowsFor(sb, 'u2', { draftId: 'dr1' })).toEqual([])
    await releaseDraftRows(sb, 'u2', [{ id: 'dr1', hold_id: holdId, status: 'pending_review', provider_draft_id: 'pd1' }])
    expect(await markHoldsSending(sb, 'u2', [{ id: 'dr1', hold_id: holdId, status: 'pending_review', provider_draft_id: 'pd1' }])).toEqual([])
    expect(fake.rows('email_hold')).toHaveLength(1)
    expect(fake.rows('email_hold')[0].status).toBe('held')
  })

  it('expiry: past 14 days untouched the hold goes; touching pushes it out', async () => {
    const { fake, sb } = db()
    const holdId = await heldDraft(fake, sb)
    const day13 = new Date(NOW.getTime() + 13 * 86_400_000)
    await touchHold(sb, 'u1', holdId, day13)
    const day20 = new Date(NOW.getTime() + 20 * 86_400_000)
    expect((await expireHolds(sb, day20)).expired).toBe(0)
    const day28 = new Date(NOW.getTime() + 28 * 86_400_000)
    expect((await expireHolds(sb, day28)).expired).toBe(1)
    cascade(fake)
    expect(fake.rows('email_hold')).toHaveLength(0)
    expect(fake.rows('email_draft')).toHaveLength(0)
  })

  it('expiry clears a hold stuck sending for an hour and settled drafts past their grace; never the person’s own pending drafts', async () => {
    const { fake, sb } = db()
    await heldDraft(fake, sb)
    fake.rows('email_hold')[0].status = 'sending'
    fake.rows('email_hold')[0].updated_at = NOW.toISOString()
    fake.seed('email_draft', [
      { id: 'own-old', user_id: 'u1', hold_id: null, status: 'pending_review', created_at: '2026-09-01T00:00:00.000Z' },
      { id: 'sent-old', user_id: 'u1', hold_id: null, status: 'sent', updated_at: '2026-10-14T00:00:00.000Z' },
      // Dismissed five minutes before the sweep: still settling, kept.
      { id: 'dismissed-now', user_id: 'u1', hold_id: null, status: 'dismissed', updated_at: new Date(NOW.getTime() + 115 * 60_000).toISOString() },
    ])
    const out = await expireHolds(sb, new Date(NOW.getTime() + 2 * 60 * 60_000))
    expect(out.stuck).toBe(1)
    expect(out.drafts).toBe(1)
    cascade(fake)
    expect(fake.rows('email_draft').map((d) => d.id)).toEqual(['own-old', 'dismissed-now'])
  })
})

describe('the Gmail-edit fallback (the draft’s message id names no row)', () => {
  it('send takes every open draft on the thread; discard only a lone one', async () => {
    const { fake, sb } = db()
    fake.seed('email_draft', [
      { id: 'a', user_id: 'u1', provider_thread_id: 't1', provider_draft_id: 'old-a', status: 'pending_review' },
      { id: 'b', user_id: 'u1', provider_thread_id: 't1', provider_draft_id: 'old-b', status: 'edited' },
    ])
    expect((await draftRowsFor(sb, 'u1', { providerDraftId: 'new', providerThreadId: 't1' })).map((r) => r.id)).toEqual(['a', 'b'])
    expect(await draftRowsFor(sb, 'u1', { providerDraftId: 'new', providerThreadId: 't1', onlyIfSingle: true })).toEqual([])
    fake.rows('email_draft').pop()
    expect((await draftRowsFor(sb, 'u1', { providerDraftId: 'new', providerThreadId: 't1', onlyIfSingle: true })).map((r) => r.id)).toEqual(['a'])
  })
})

describe('before 343 (no hold_id or stale column)', () => {
  it('draftRowsFor falls back to the pre-343 columns, so send and dismiss still release the row', async () => {
    const asked: string[] = []
    const sb = {
      from: () => {
        let cols = ''
        const q: Record<string, unknown> = {}
        q.select = (c: string) => ((cols = c), asked.push(c), q)
        q.eq = () => q
        q.then = (resolve: (v: unknown) => unknown) =>
          Promise.resolve(
            cols.includes('hold_id')
              ? { data: null, error: { code: '42703', message: 'column email_draft.hold_id does not exist' } }
              : { data: [{ id: 'd1', status: 'pending_review', provider_draft_id: 'pd1' }], error: null },
          ).then(resolve)
        return q
      },
    }
    expect(await draftRowsFor(sb as never, 'u1', { providerDraftId: 'pd1' })).toEqual([
      { id: 'd1', workspace_id: null, hold_id: null, status: 'pending_review', stale: false, provider_draft_id: 'pd1' },
    ])
    expect(asked).toHaveLength(2)
  })
})

describe('heldThreadAction (a new message on a held thread)', () => {
  it('re-drafts an untouched draft and marks an edited one stale', () => {
    expect(heldThreadAction({ status: 'pending_review', stale: false })).toBe('redraft')
    expect(heldThreadAction({ status: 'edited', stale: false })).toBe('stale')
    expect(heldThreadAction({ status: 'pending_review', stale: true })).toBe('stale')
    expect(heldThreadAction(null)).toBe('none')
    expect(heldThreadAction({ status: 'pending_review', stale: false }, 'sending')).toBe('none')
  })
})
