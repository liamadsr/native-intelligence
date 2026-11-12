/**
 * Arriving mail reaches the agent (understand-arrivals.ts;
 * docs/plans/email-through-the-agent.md E2): the input Jev sees, the event
 * it becomes (templated facts, never a subject or body), the gates and caps,
 * and what is skipped (a stale index, the person's own message, an
 * undecided answer).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'
import type { EmailMessageForAI, EmailThreadForAI } from '../email-read-service'
import type { EmailUnderstandValue } from '@/lib/ai/decisions/tasks/email-understand'
import { ARRIVED_EVENT_TTL_MS, MAX_UNDERSTOOD_PER_DAY, MAX_UNDERSTOOD_PER_PASS, arrivedEvent, understandArrivals, understandInput } from '../understand-arrivals'

const NOW = Date.parse('2026-10-20T14:00:00.000Z')
const ME = 'me@x.com'

const message = (over: Partial<EmailMessageForAI> = {}): EmailMessageForAI => ({
  messageId: 'm1', from: 'Google Calendar <calendar-notification@google.com>', to: ME, cc: '', isDraft: false,
  date: '10/20/2026', dateISO: '2026-10-20T13:30:00.000Z', subject: 'Canceled event: Board prep',
  bodyText: 'This event has been canceled.', hasAttachments: false, attachmentNames: [], ...over,
})

const value = (over: Partial<EmailUnderstandValue> = {}): EmailUnderstandValue => ({
  kind: 'meeting', shouldKnow: true, needsInput: false, knowProbability: 0.95, inputProbability: 0.05, ...over,
})

describe('understandInput', () => {
  it('sends the newest messages oldest first (drafts left out), with directions, and now; null for the person’s own newest message', () => {
    const input = understandInput({
      mailbox: ME, threadId: 't1', revision: 'm3', now: '10:00 AM EDT on Tuesday, October 20, 2026', known: true,
      messages: [
        message({ messageId: 'm1', from: 'Sam <sam@y.com>' }),
        message({ messageId: 'm2', from: `Me <${ME}>`, to: 'sam@y.com' }),
        message({ messageId: 'd1', isDraft: true, from: `Me <${ME}>` }),
        message({ messageId: 'm3', from: 'Sam <sam@y.com>', hasAttachments: true }),
      ],
    })!
    expect(input).toMatchObject({ mailbox: ME, threadId: 't1', revision: 'm3', knownSender: true, attachmentsUnseen: true })
    expect(input.messages.map((m) => m.direction)).toEqual(['inbound', 'outbound', 'inbound'])
    expect(input.messages[0].date).toBe('2026-10-20T13:30:00.000Z')
    expect(understandInput({ mailbox: ME, threadId: 't', revision: 'm', now: 'n', known: false, messages: [message({ from: `Me <${ME}>` })] })).toBeNull()
    expect(understandInput({ mailbox: ME, threadId: 't', revision: 'm', now: 'n', known: false, messages: [message({ isDraft: true })] })).toBeNull()
  })

  it('keeps the newest message and drops the oldest until the state fits', () => {
    const long = 'x'.repeat(10_000)
    const input = understandInput({
      mailbox: ME, threadId: 't', revision: 'm9', now: 'n', known: false,
      messages: Array.from({ length: 9 }, (_, i) => message({ messageId: `m${i + 1}`, bodyText: long })),
    })!
    expect(JSON.stringify(input).length).toBeLessThanOrEqual(26_000)
    expect(input.messages.length).toBeGreaterThan(0)
    expect(input.messages.at(-1)!.body.startsWith('x')).toBe(true)
  })
})

describe('arrivedEvent', () => {
  it('templated facts only (sender, contact, known, Jev’s answers), the thread as its pointer, three days of news, once per message', () => {
    const e = arrivedEvent({
      workspaceId: 'ws', userId: 'u', accountId: 'acct', threadId: 't1', messageId: 'm3', atIso: '2026-10-20T13:30:00.000Z',
      from: 'calendar-notification@google.com', contactId: 'c1', known: true, value: value(),
    }, NOW)
    expect(e).toMatchObject({
      kind: 'email.arrived', priority: 2, occursAt: '2026-10-20T13:30:00.000Z', refType: 'email_thread', refId: 't1',
      expiresAt: new Date(NOW + ARRIVED_EVENT_TTL_MS).toISOString(),
      facts: { from: 'calendar-notification@google.com', contactId: 'c1', known: true, emailKind: 'meeting', shouldKnow: true, needsInput: false },
      dedupeKey: 'email:arrived:acct:t1:m3',
    })
    expect(JSON.stringify(e.facts)).not.toMatch(/Board prep|canceled/i)
    // Unsure answers are left out, not stored as false.
    const unsure = arrivedEvent({ workspaceId: 'ws', userId: 'u', accountId: null, threadId: 't1', messageId: null, atIso: null, from: null, contactId: null, known: false,
      value: value({ kind: null, shouldKnow: null, needsInput: null }) }, NOW)
    expect(unsure.facts).toEqual({})
    expect(unsure.priority).toBe(1)
    expect(unsure.dedupeKey).toBe('email:arrived:mailbox:t1:latest')
  })
})

describe('understandArrivals', () => {
  let db: FakeSupabase
  let threads: Record<string, EmailThreadForAI | null>
  const decide = vi.fn()
  const send = vi.fn(async () => ({}))

  const thread = (id: string, messages: EmailMessageForAI[]): EmailThreadForAI =>
    ({ threadId: id, subject: 's', messages, participantEmails: [], source: 'provider' }) as EmailThreadForAI

  const run = (threadIds: string[], over: Record<string, unknown> = {}) =>
    understandArrivals(db as never, { userId: 'u', workspaceId: 'ws', accountId: 'acct', provider: 'google', threadIds, mailboxEmail: ME }, {
      readPaused: async () => 'active',
      blocked: async () => null,
      readThread: async (_u, id) => threads[id] ?? null,
      decide,
      timeZone: async () => 'America/New_York',
      record: { send },
      nowMs: NOW,
      ...over,
    })

  beforeEach(() => {
    db = makeFakeSupabase()
    db.seed('email_thread_index', [
      { id: 'i1', user_id: 'u', workspace_id: 'ws', provider_thread_id: 't1', provider_message_id: 'm1', from_email: 'calendar-notification@google.com', linked_contact_id: null },
      { id: 'i2', user_id: 'u', workspace_id: 'ws', provider_thread_id: 'stale', provider_message_id: 'm9', from_email: 'x@y.com', linked_contact_id: null },
      { id: 'i3', user_id: 'u', workspace_id: 'ws', provider_thread_id: 'own', provider_message_id: 'm1', from_email: ME, linked_contact_id: null },
    ])
    threads = {
      t1: thread('t1', [message()]),
      stale: thread('stale', [message({ messageId: 'm8' })]),
      own: thread('own', [message({ from: `Me <${ME}>` })]),
    }
    decide.mockReset().mockResolvedValue({ status: 'accepted', value: value(), inferenceId: 'inf', version: 'email-understand-v1' })
    send.mockClear()
  })

  it('reads each thread live, asks Jev with now in the person’s zone, and records one email.arrived each; a stale index or the person’s own message is skipped', async () => {
    const out = await run(['t1', 'stale', 'own', 'unknown'])
    expect(out).toEqual({ understood: 1, recorded: 1 })
    expect(decide).toHaveBeenCalledOnce()
    const [input, ctx] = decide.mock.calls[0]
    expect(ctx).toEqual({ userId: 'u', workspaceId: 'ws', runId: 'i1' })
    expect(input.now).toBe('10:00 AM EDT on Tuesday, October 20, 2026')
    const rows = db.rows('agent_event')
    expect(rows.map((r) => [r.kind, r.dedupe_key])).toEqual([['email.arrived', 'email:arrived:acct:t1:m1']])
    expect(send).toHaveBeenCalled()
  })

  it('an undecided answer is counted but records nothing', async () => {
    decide.mockResolvedValue({ status: 'escalate', reason: 'uncertain' })
    expect(await run(['t1'])).toEqual({ understood: 1, recorded: 0 })
    expect(db.rows('agent_event')).toEqual([])
  })

  it('the gates: paused (or unreadable) and the drafting gates stop it before any read', async () => {
    const readThread = vi.fn()
    expect(await run(['t1'], { readPaused: async () => 'paused', readThread })).toMatchObject({ skipped: 'paused' })
    expect(await run(['t1'], { readPaused: async () => { throw new Error('down') }, readThread })).toMatchObject({ skipped: 'paused' })
    expect(await run(['t1'], { blocked: async () => 'dormant', readThread })).toMatchObject({ skipped: 'dormant' })
    expect(await run(['t1'], { blocked: async () => 'usage', readThread })).toMatchObject({ skipped: 'usage' })
    expect(readThread).not.toHaveBeenCalled()
    expect(decide).not.toHaveBeenCalled()
  })

  it('caps: none past the day’s limit, at most MAX_UNDERSTOOD_PER_PASS a push', async () => {
    db.seed('agent_event', Array.from({ length: MAX_UNDERSTOOD_PER_DAY }, (_, i) => ({
      id: i + 1, workspace_id: 'ws', user_id: 'u', kind: 'email.arrived', created_at: new Date(NOW - 60_000).toISOString(),
    })))
    expect(await run(['t1'])).toMatchObject({ skipped: 'cap' })
    db = makeFakeSupabase()
    const ids = Array.from({ length: MAX_UNDERSTOOD_PER_PASS + 5 }, (_, i) => `x${i}`)
    db.seed('email_thread_index', ids.map((id, i) => ({ id: `r${i}`, user_id: 'u', workspace_id: 'ws', provider_thread_id: id, provider_message_id: 'm1', from_email: 'n@z.com' })))
    threads = Object.fromEntries(ids.map((id) => [id, thread(id, [message()])]))
    expect((await run(ids)).understood).toBe(MAX_UNDERSTOOD_PER_PASS)
  })

  it('puts each understood thread beside the to-dos (its kind, trust mark, folder and messages), and says how many it closed', async () => {
    Object.assign(db.rows('email_thread_index').find((r) => r.id === 'i1')!, { trust: 'suspicious', folder: 'inbox' })
    const consider = vi.fn(async () => 'closed' as const)
    const mailDone = vi.fn(() => ({ consider, closed: () => 1 }))
    expect(await run(['t1', 'own'], { mailDone })).toEqual({ understood: 1, recorded: 1, closed: 1 })
    expect(mailDone).toHaveBeenCalledWith(db, { workspaceId: 'ws', userId: 'u', accountId: 'acct', mailbox: ME, now: '10:00 AM EDT on Tuesday, October 20, 2026' })
    expect(consider).toHaveBeenCalledOnce()
    expect(consider).toHaveBeenCalledWith({ kind: 'meeting', trust: 'suspicious', folder: 'inbox', threadId: 't1', messageId: 'm1', messages: threads.t1!.messages, runId: 'i1' })
    // An undecided answer is never put beside them.
    consider.mockClear()
    decide.mockResolvedValue({ status: 'escalate', reason: 'uncertain' })
    await run(['t1'], { mailDone })
    expect(consider).not.toHaveBeenCalled()
  })

  it('every understood thread then goes to the record keeper, unless the to-do closer closed one from it (one change a source)', async () => {
    Object.assign(db.rows('email_thread_index').find((r) => r.id === 'i1')!, { folder: 'inbox' })
    const keep = vi.fn(async () => 'changed' as const)
    const kept = vi.fn(() => ({ consider: keep, changed: () => 1 }))
    const none = vi.fn(async () => 'none' as const)
    expect(await run(['t1'], { mailDone: () => ({ consider: none, closed: () => 0 }), kept })).toEqual({ understood: 1, recorded: 1, kept: 1 })
    expect(kept).toHaveBeenCalledWith(db, { workspaceId: 'ws', userId: 'u', mailbox: ME, now: '10:00 AM EDT on Tuesday, October 20, 2026' })
    expect(keep).toHaveBeenCalledWith({ kind: 'meeting', trust: null, folder: 'inbox', threadId: 't1', messageId: 'm1', messages: threads.t1!.messages, runId: 'i1' })
    keep.mockClear()
    await run(['t1'], { mailDone: () => ({ consider: vi.fn(async () => 'closed' as const), closed: () => 1 }), kept })
    expect(keep).not.toHaveBeenCalled()
    // Without the closer, still kept; null keeps nothing.
    await run(['t1'], { mailDone: null, kept })
    expect(keep).toHaveBeenCalledOnce()
    expect(await run(['t1'], { mailDone: null, kept: null })).toEqual({ understood: 1, recorded: 0 })
  })

  it('null closes nothing; the default closes nothing it cannot read', async () => {
    expect(await run(['t1'], { mailDone: null })).toEqual({ understood: 1, recorded: 1 })
    // The same message again: its event is a duplicate, and the default finds no to-dos in this fake.
    expect(await run(['t1'])).toEqual({ understood: 1, recorded: 0 })
  })

  it('no mailbox address, or no threads: nothing at all', async () => {
    expect(await understandArrivals(db as never, { userId: 'u', workspaceId: 'ws', accountId: 'acct', provider: 'google', threadIds: ['t1'], mailboxEmail: null }, { decide })).toEqual({ understood: 0, recorded: 0 })
    expect(await run([])).toEqual({ understood: 0, recorded: 0 })
    expect(decide).not.toHaveBeenCalled()
  })
})
