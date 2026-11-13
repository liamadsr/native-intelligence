/**
 * Send later's sender and sweep (../scheduled-send.ts) on an in-memory
 * database: a row is claimed 'scheduled' → 'sending' once, so two senders
 * reaching it send once; Gmail's draft is found by its DRAFT id and Graph's
 * by its message id, each sent through the provider-draft path pinned to the
 * row's mailbox; a draft gone (or a mailbox that refuses) fails the row with
 * a short reason and tells the person, never naming the subject; a sent row
 * keeps no words; the sweep sends overdue rows oldest first and fails rows
 * cut off mid-send. Made-up people and companies.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/admin', () => ({ getServiceClient: () => { throw new Error('tests pass a db') } }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }))
vi.mock('@/lib/notifications', () => ({ createNotification: vi.fn() }))
vi.mock('@/lib/crm/email-client', () => ({ saveDraftToProvider: vi.fn() }))
vi.mock('@/lib/integrations/email', () => ({ pinnedMailbox: vi.fn(), sendProviderDraft: vi.fn(), updateProviderDraft: vi.fn() }))
vi.mock('@/lib/email/provider-drafts', () => ({
  GMAIL_API: 'https://gmail.test/v1/users/me',
  GRAPH_API: 'https://graph.test/v1.0/me',
  gmailDraftIdFor: vi.fn(),
  isProviderId: (id: unknown) => typeof id === 'string' && /^[A-Za-z0-9_=+/-]{1,512}$/.test(id),
}))

import { memoryDb } from '@/test/memory-db'
import { saveDraftToProvider } from '@/lib/crm/email-client'
import { updateProviderDraft } from '@/lib/integrations/email'
import { gmailDraftIdFor } from '@/lib/email/provider-drafts'
import {
  FAILURE,
  STALE_SENDING_MS,
  cancelScheduledSend,
  dismissScheduledSend,
  parseSendAt,
  scheduleExistingDraft,
  scheduleNewMessage,
  sendScheduledEmail,
  sweepScheduledSends,
  type ScheduledSendDeps,
} from '../scheduled-send'

const NOW = new Date('2026-11-13T15:00:00.000Z')
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString()
const WS = 'ws-1'
const ME = 'user-me'
const MAILBOX = 'acct-1'

type Row = Record<string, unknown>
let tables: Record<string, Row[]>
let sent: Array<{ args: unknown[] }>
let notices: Array<Record<string, unknown>>
let fetches: string[]
let replies: Map<string, { status: number; body: unknown }>
let mailbox: { provider: 'google' | 'microsoft'; token: string; email: string | null } | null
let sendResult: { ok: true; threadId: string; messageId: string | null } | { ok: false; reason: 'not_found' | 'no_recipients' } | Error
let queued: string[]
let deps: ScheduledSendDeps

const row = (over: Row): Row => ({
  id: 'sched-1',
  workspace_id: WS,
  user_id: ME,
  account_id: MAILBOX,
  provider: 'google',
  provider_draft_id: 'r-5551234',
  thread_id: null,
  to_emails: ['dana@harborline.example'],
  subject: 'Q4 renewal',
  send_at: ago(60_000),
  status: 'scheduled',
  error: null,
  sent_at: null,
  created_at: ago(3_600_000),
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  tables = {
    email_scheduled_send: [],
    member: [{ id: 'member-me', user_id: ME, workspace_id: WS }],
    email_thread_index: [],
  }
  sent = []
  notices = []
  fetches = []
  queued = []
  replies = new Map([
    ['https://gmail.test/v1/users/me/drafts/r-5551234?format=minimal', { status: 200, body: { id: 'r-5551234', message: { id: 'msg-now', threadId: 'thr-9' } } }],
  ])
  mailbox = { provider: 'google', token: 'tok', email: 'me@fernhill.example' }
  sendResult = { ok: true, threadId: 'thr-9', messageId: 'sent-1' }
  const db = memoryDb(tables)
  deps = {
    db: () => db,
    now: () => NOW,
    mailbox: async () => mailbox,
    fetch: (async (url: string) => {
      fetches.push(url)
      const r = replies.get(url) ?? { status: 404, body: {} }
      return new Response(JSON.stringify(r.body), { status: r.status })
    }) as typeof fetch,
    sendDraft: (async (...args: unknown[]) => {
      if (sendResult instanceof Error) throw sendResult
      sent.push({ args })
      return sendResult
    }) as ScheduledSendDeps['sendDraft'],
    notify: async (p) => void notices.push(p as unknown as Record<string, unknown>),
    queue: async (r) => void queued.push(r.id),
  }
})

describe('parseSendAt', () => {
  it('takes a future time within a year, refuses the past, junk and too far', () => {
    expect(parseSendAt('2026-11-14T13:00:00.000Z', NOW)).toEqual(new Date('2026-11-14T13:00:00.000Z'))
    expect(parseSendAt(NOW.toISOString(), NOW)).toBe('past')
    expect(parseSendAt('2026-11-13T14:59:00Z', NOW)).toBe('past')
    expect(parseSendAt('tomorrow', NOW)).toBe('invalid')
    expect(parseSendAt(42, NOW)).toBe('invalid')
    expect(parseSendAt('2028-01-01T00:00:00Z', NOW)).toBe('too_far')
  })
})

describe('sendScheduledEmail', () => {
  it('Gmail: finds the draft by its DRAFT id, sends it pinned to the row’s mailbox, marks it sent and keeps no words', async () => {
    tables.email_scheduled_send.push(row({}))
    expect(await sendScheduledEmail('sched-1', {}, deps)).toBe('sent')
    expect(fetches).toEqual(['https://gmail.test/v1/users/me/drafts/r-5551234?format=minimal'])
    expect(sent[0].args).toEqual([ME, WS, 'thr-9', 'msg-now', null, { accountId: MAILBOX }])
    expect(tables.email_scheduled_send[0]).toMatchObject({ status: 'sent', sent_at: NOW.toISOString(), to_emails: null, subject: null, error: null })
    expect(notices).toEqual([])
  })

  it('Graph: the message id is the draft’s; it must still be a draft, and its conversation is the thread', async () => {
    mailbox = { provider: 'microsoft', token: 'tok', email: null }
    tables.email_scheduled_send.push(row({ provider: 'microsoft', provider_draft_id: 'AAMkAGI2=' }))
    replies.set('https://graph.test/v1.0/me/messages/AAMkAGI2%3D?$select=isDraft,conversationId', { status: 200, body: { isDraft: true, conversationId: 'conv-7' } })
    expect(await sendScheduledEmail('sched-1', {}, deps)).toBe('sent')
    expect(sent[0].args).toEqual([ME, WS, 'conv-7', 'AAMkAGI2=', null, { accountId: MAILBOX }])
  })

  it('claims a row once: two senders at the same row send it once (CAS on scheduled → sending)', async () => {
    tables.email_scheduled_send.push(row({}))
    const outcomes = await Promise.all([sendScheduledEmail('sched-1', {}, deps), sendScheduledEmail('sched-1', {}, deps)])
    expect(outcomes.sort()).toEqual(['sent', 'skipped'])
    expect(sent).toHaveLength(1)
    // And again later: it is sent, nothing goes out.
    expect(await sendScheduledEmail('sched-1', {}, deps)).toBe('skipped')
    expect(sent).toHaveLength(1)
  })

  it('sends nothing for a row not yet due, cancelled, or (with a user) someone else’s', async () => {
    tables.email_scheduled_send.push(
      row({ id: 'later', send_at: new Date(NOW.getTime() + 60_000).toISOString() }),
      row({ id: 'cancelled', status: 'cancelled' }),
      row({ id: 'theirs', user_id: 'user-them' }),
    )
    expect(await sendScheduledEmail('later', {}, deps)).toBe('skipped')
    expect(await sendScheduledEmail('cancelled', {}, deps)).toBe('skipped')
    expect(await sendScheduledEmail('theirs', { userId: ME, immediate: true }, deps)).toBe('skipped')
    expect(sent).toEqual([])
  })

  it('Send now sends a row before its time, moving its time to now', async () => {
    tables.email_scheduled_send.push(row({ send_at: new Date(NOW.getTime() + 86_400_000).toISOString() }))
    expect(await sendScheduledEmail('sched-1', { userId: ME, immediate: true }, deps)).toBe('sent')
    expect(tables.email_scheduled_send[0]).toMatchObject({ status: 'sent', send_at: NOW.toISOString() })
  })

  it('a draft gone from the mailbox: failed with a short reason, the person told (never the subject)', async () => {
    tables.email_scheduled_send.push(row({}))
    replies.clear()
    expect(await sendScheduledEmail('sched-1', {}, deps)).toBe('failed')
    expect(sent).toEqual([])
    expect(tables.email_scheduled_send[0]).toMatchObject({ status: 'failed', error: FAILURE.gone })
    expect(notices).toEqual([
      expect.objectContaining({ workspaceId: WS, recipientId: 'member-me', type: 'email_send_failed', body: FAILURE.gone, targetType: 'email_draft', targetId: 'sched-1' }),
    ])
    expect(JSON.stringify(notices)).not.toContain('Q4 renewal')
  })

  it('the send path says the draft is gone, or has no recipients: failed with why', async () => {
    tables.email_scheduled_send.push(row({}), row({ id: 'sched-2' }))
    sendResult = { ok: false, reason: 'not_found' }
    expect(await sendScheduledEmail('sched-1', {}, deps)).toBe('failed')
    sendResult = { ok: false, reason: 'no_recipients' }
    expect(await sendScheduledEmail('sched-2', {}, deps)).toBe('failed')
    expect(tables.email_scheduled_send.map((r) => r.error)).toEqual([FAILURE.gone, FAILURE.noRecipients])
  })

  it('a mailbox that refuses, or is no longer connected: failed, told, still a draft', async () => {
    tables.email_scheduled_send.push(row({}), row({ id: 'sched-2' }))
    sendResult = new Error('Gmail draft send error: 500')
    expect(await sendScheduledEmail('sched-1', {}, deps)).toBe('failed')
    mailbox = null
    expect(await sendScheduledEmail('sched-2', {}, deps)).toBe('failed')
    expect(tables.email_scheduled_send.map((r) => r.error)).toEqual([FAILURE.refused, FAILURE.mailbox])
    expect(notices).toHaveLength(2)
  })
})

describe('sweepScheduledSends', () => {
  it('sends the overdue rows the event missed, oldest first, and leaves the rest', async () => {
    tables.email_scheduled_send.push(
      row({ id: 'newer', provider_draft_id: 'r-5551234', send_at: ago(60_000) }),
      row({ id: 'older', provider_draft_id: 'r-5551234', send_at: ago(600_000) }),
      row({ id: 'future', send_at: new Date(NOW.getTime() + 600_000).toISOString() }),
      row({ id: 'done', status: 'sent' }),
    )
    const order: string[] = []
    const send = deps.sendDraft
    deps.sendDraft = (async (...args: Parameters<typeof send>) => {
      order.push(tables.email_scheduled_send.find((r) => r.status === 'sending')!.id as string)
      return send(...args)
    }) as typeof send
    expect(await sweepScheduledSends(deps)).toEqual({ sent: 2, failed: 0, skipped: 0, stale: 0 })
    expect(order).toEqual(['older', 'newer'])
    expect(tables.email_scheduled_send.find((r) => r.id === 'future')!.status).toBe('scheduled')
  })

  it('fails a row cut off mid-send long ago, and never sends it again', async () => {
    tables.email_scheduled_send.push(row({ id: 'stuck', status: 'sending', send_at: ago(STALE_SENDING_MS + 60_000) }), row({ id: 'busy', status: 'sending', send_at: ago(60_000) }))
    expect(await sweepScheduledSends(deps)).toMatchObject({ stale: 1, sent: 0 })
    expect(tables.email_scheduled_send.map((r) => [r.id, r.status, r.error])).toEqual([
      ['stuck', 'failed', FAILURE.unconfirmed],
      ['busy', 'sending', null],
    ])
    expect(sent).toEqual([])
    expect(notices).toHaveLength(1)
  })
})

describe('scheduling', () => {
  const AT = new Date('2026-11-14T13:00:00.000Z')

  it('a new message: saved as a draft in the picked mailbox (Gmail’s draft id kept), scheduled and queued', async () => {
    vi.mocked(saveDraftToProvider).mockResolvedValue({ draft_id: 'r-5559876' })
    const result = await scheduleNewMessage(
      { userId: ME, workspaceId: WS, accountId: MAILBOX, to: ['dana@harborline.example'], cc: ['lee@harborline.example'], subject: 'Q4 renewal', bodyHtml: '<p>Hi</p>', sendAt: AT },
      deps,
    )
    expect(result).toMatchObject({ ok: true })
    expect(saveDraftToProvider).toHaveBeenCalledWith(ME, expect.objectContaining({ account_id: MAILBOX, subject: 'Q4 renewal' }))
    expect(tables.email_scheduled_send[0]).toMatchObject({
      user_id: ME, workspace_id: WS, account_id: MAILBOX, provider: 'google', provider_draft_id: 'r-5559876', thread_id: null,
      to_emails: ['dana@harborline.example', 'lee@harborline.example'], subject: 'Q4 renewal', send_at: AT.toISOString(), status: 'scheduled',
    })
    expect(queued).toEqual([tables.email_scheduled_send[0].id])
  })

  it('a new message from a mailbox that is not the person’s: refused, nothing saved', async () => {
    mailbox = null
    const result = await scheduleNewMessage({ userId: ME, workspaceId: WS, accountId: 'acct-theirs', to: ['dana@harborline.example'], subject: 'Hi', bodyHtml: '', sendAt: AT }, deps)
    expect(result).toMatchObject({ ok: false, reason: 'account' })
    expect(saveDraftToProvider).not.toHaveBeenCalled()
    expect(tables.email_scheduled_send).toEqual([])
  })

  it('a draft on a thread, edited: the edits are written first, then its Gmail draft id is kept from the thread’s own mailbox', async () => {
    tables.email_thread_index.push({ user_id: ME, workspace_id: WS, provider_thread_id: 'thr-9', account_id: MAILBOX, provider: 'google' })
    vi.mocked(updateProviderDraft).mockResolvedValue({ ok: true, threadId: 'thr-9', messageId: 'msg-new', edits: { to: ['dana@harborline.example'], cc: [], subject: 'Re: Q4', body: 'Tuesday works.' } })
    vi.mocked(gmailDraftIdFor).mockResolvedValue('r-5550001')
    const edits = { to: ['dana@harborline.example'], cc: [], subject: 'Re: Q4', body: 'Tuesday works.' }
    const result = await scheduleExistingDraft({ userId: ME, workspaceId: WS, threadId: 'thr-9', draftMessageId: 'msg-old', edits, sendAt: AT }, deps)
    expect(result).toMatchObject({ ok: true })
    expect(gmailDraftIdFor).toHaveBeenCalledWith('tok', 'msg-new')
    expect(tables.email_scheduled_send[0]).toMatchObject({ provider_draft_id: 'r-5550001', thread_id: 'thr-9', account_id: MAILBOX, subject: 'Re: Q4' })
  })

  it('a draft on someone else’s thread (no index row of theirs): refused', async () => {
    tables.email_thread_index.push({ user_id: 'user-them', workspace_id: WS, provider_thread_id: 'thr-9', account_id: 'acct-them', provider: 'google' })
    const result = await scheduleExistingDraft({ userId: ME, workspaceId: WS, threadId: 'thr-9', draftMessageId: 'msg-old', edits: null, sendAt: AT }, deps)
    expect(result).toMatchObject({ ok: false, reason: 'account' })
    expect(tables.email_scheduled_send).toEqual([])
  })
})

describe('the owner’s changes', () => {
  it('cancel: only the owner’s row while still scheduled; the draft is left alone', async () => {
    tables.email_scheduled_send.push(row({}), row({ id: 'theirs', user_id: 'user-them' }), row({ id: 'going', status: 'sending' }))
    expect(await cancelScheduledSend(ME, WS, 'sched-1', deps)).toEqual({ ok: true })
    expect(tables.email_scheduled_send[0].status).toBe('cancelled')
    expect(await cancelScheduledSend(ME, WS, 'theirs', deps)).toEqual({ ok: false, reason: 'not_found' })
    expect(await cancelScheduledSend(ME, WS, 'going', deps)).toEqual({ ok: false, reason: 'conflict' })
    expect(sent).toEqual([])
  })

  it('dismiss: only a failed row of the owner’s', async () => {
    tables.email_scheduled_send.push(row({ status: 'failed', error: FAILURE.gone }), row({ id: 'waiting' }))
    expect(await dismissScheduledSend(ME, WS, 'waiting', deps)).toEqual({ ok: false, reason: 'conflict' })
    expect(await dismissScheduledSend('user-them', WS, 'sched-1', deps)).toEqual({ ok: false, reason: 'not_found' })
    expect(await dismissScheduledSend(ME, WS, 'sched-1', deps)).toEqual({ ok: true })
    expect(tables.email_scheduled_send.map((r) => r.id)).toEqual(['waiting'])
  })
})
