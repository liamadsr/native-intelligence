/**
 * The three sources (sources.ts), each one item for the same engine. Pinned:
 *   • mail: conversations count; never a newsletter, a trust-marked thread,
 *     one outside the inbox or the archive, or the person's own message; its
 *     people are the latest message's sender and recipients (not the
 *     person), the sender's work domain; to-dos only from a known contact's
 *     mail that is not a confirmation; the quoted reply never judged;
 *   • meetings: the owner's, never a demo or an eval one; its people are the
 *     participants but the owner; the transcript's change lines; the
 *     meeting's pending proposals' to-dos left alone; a private one is not
 *     quoted in a table's history;
 *   • texts: a guest's own texts in their thread, their CRM contact; nobody
 *     known, nothing.
 */
import { describe, expect, it, vi } from 'vitest'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'
import type { EmailMessageForAI } from '@/lib/email/email-read-service'
import type { AgentGuest } from '@/lib/guests/store'
import type { KeptPeople, KeptSourceItem } from '../engine'
import { keptFromCapture, keptFromTexts, mailKeptItem, mailKeptPass, meetingLines } from '../sources'

vi.mock('@/lib/admin', () => ({ getServiceClient: () => { throw new Error('no service client in tests') } }))

const WS = 'ws'
const ME = 'sam@fernhill.example'
const SCOPE = { workspaceId: WS, userId: 'u', mailbox: ME }
const DANA: KeptPeople = { contactIds: ['c-dana'], companyIds: ['co-acme'], names: new Map([['c-dana', 'Dana Reyes']]) }
const NOBODY: KeptPeople = { contactIds: [], companyIds: [], names: new Map() }

const message = (over: Partial<EmailMessageForAI> = {}): EmailMessageForAI => ({
  messageId: 'm2', from: 'Dana Reyes <dana@acme.example>', to: `Sam Lee <${ME}>`, cc: 'lee@acme.example', isDraft: false,
  date: 'Tue, 10 Nov 2026', dateISO: '2026-11-10T15:00:00.000Z', subject: 'Re: renewal',
  bodyText: 'We signed the renewal this morning.\n\nOn Mon, Nov 9, 2026 at 9:00 AM Sam Lee <sam@fernhill.example> wrote:\n> Any news?', hasAttachments: false, attachmentNames: [], ...over,
})
const args = (over: Partial<Parameters<typeof mailKeptItem>[2]> = {}) => ({
  kind: 'conversation' as const, trust: null, folder: 'inbox', threadId: 't1', messageId: 'm2',
  messages: [message({ messageId: 'm1', from: `Sam Lee <${ME}>`, to: 'dana@acme.example', bodyText: 'Any news?' }), message()], ...over,
})

describe('mail', () => {
  it('a conversation from a known contact: its people, its own words, to-dos too', async () => {
    const people = vi.fn(async () => DANA)
    const item = await mailKeptItem(makeFakeSupabase() as never, SCOPE, args(), { people })
    expect(people).toHaveBeenCalledWith(expect.anything(), WS, { emails: ['dana@acme.example', 'lee@acme.example'], domains: ['acme.example'] })
    expect(item).toMatchObject({
      source: 'email', ref: 't1:m2', label: 'acme.example', atIso: '2026-11-10T15:00:00.000Z',
      header: { kind: 'email', from: 'Dana Reyes <dana@acme.example>', subject: 'Re: renewal' },
      text: 'We signed the renewal this morning.\n', people: DANA, tasks: true,
    })
    expect(item!.context).toContain('Any news?')
  })

  it('a confirmation keeps rows only (to-dos stay with the closer); a stranger’s conversation closes no to-do; a free-mail domain is no company', async () => {
    expect((await mailKeptItem(makeFakeSupabase() as never, SCOPE, args({ kind: 'receipt_or_bill' }), { people: async () => DANA }))!.tasks).toBe(false)
    expect((await mailKeptItem(makeFakeSupabase() as never, SCOPE, args(), { people: async () => NOBODY }))!.tasks).toBe(false)
    const people = vi.fn(async (..._args: unknown[]) => NOBODY)
    await mailKeptItem(makeFakeSupabase() as never, SCOPE, args({ messages: [message({ from: 'Robin <robin@gmail.com>', cc: '' })] }), { people })
    expect(people.mock.calls[0][2]).toEqual({ emails: ['robin@gmail.com'], domains: [] })
  })

  it('never a newsletter, an unsure kind, a trust-marked thread, spam, or the person’s own message', async () => {
    const people = vi.fn(async () => DANA)
    const db = makeFakeSupabase() as never
    expect(await mailKeptItem(db, SCOPE, args({ kind: 'newsletter_or_promo' }), { people })).toBeNull()
    expect(await mailKeptItem(db, SCOPE, args({ kind: null }), { people })).toBeNull()
    expect(await mailKeptItem(db, SCOPE, args({ trust: 'suspicious' }), { people })).toBeNull()
    expect(await mailKeptItem(db, SCOPE, args({ folder: 'spam' }), { people })).toBeNull()
    expect(await mailKeptItem(db, SCOPE, args({ messages: [message({ from: `Sam Lee <${ME}>` })] }), { people })).toBeNull()
    expect(people).not.toHaveBeenCalled()
  })

  it('the pass hands each item to the engine with its run id', async () => {
    const decide = vi.fn()
    const pass = mailKeptPass(makeFakeSupabase() as never, { ...SCOPE, now: 'x' }, { people: async () => DANA, homeThread: async () => null, decide })
    expect(await pass.consider({ ...args(), runId: 'i1' })).toBe('skipped')
    expect(await pass.consider({ ...args({ kind: 'newsletter_or_promo' }), runId: 'i2' })).toBe('skipped')
    expect(decide).not.toHaveBeenCalled()
    expect(pass.changed()).toBe(0)
  })
})

describe('meetings', () => {
  it('a short transcript is read whole; a long one, the lines a change could be in', () => {
    expect(meetingLines('Dana: Hello\nSam: Hi', null)).toEqual(['Dana: Hello', 'Sam: Hi'])
    const filler = Array.from({ length: 60 }, (_, i) => `Sam: Point ${i} about the onboarding flow.`)
    const lines = meetingLines([...filler, 'Dana: We signed it yesterday.', 'Dana: Let’s push the start to March.', 'Dana: It is $48,000.'].join('\n'), '2026-11-10T15:00:00.000Z')
    expect(lines).toEqual(['Dana: We signed it yesterday.', 'Dana: Let’s push the start to March.', 'Dana: It is $48,000.'])
  })

  function seedCapture(db: FakeSupabase, over: Record<string, unknown> = {}) {
    db.seed('captures', [{
      id: 'cap-1', workspace_id: WS, user_id: 'u', title: 'Acme renewal call', visibility: 'workspace', started_at: '2026-11-10T15:00:00.000Z', created_at: '2026-11-10T15:00:00.000Z',
      transcript: 'Dana Reyes: We signed the renewal.\nSam: Great news.', ai_summary: 'Acme signed.', is_eval: false, metadata: {}, ...over,
    }])
    db.seed('capture_participant', [
      { id: 'p1', capture_id: 'cap-1', contact_id: 'c-dana', external_email: null, is_self: false, member_id: null },
      { id: 'p2', capture_id: 'cap-1', contact_id: null, external_email: 'lee@acme.example', is_self: false, member_id: null },
      { id: 'p3', capture_id: 'cap-1', contact_id: 'c-self', external_email: ME, is_self: true, member_id: 'mem-me' },
    ])
    db.seed('proposed_change', [
      { id: 'pc1', capture_id: 'cap-1', status: 'pending', entity_type: 'action', entity_id: 'a-carded' },
      { id: 'pc2', capture_id: 'cap-1', status: 'applied', entity_type: 'action', entity_id: 'a-applied' },
    ])
  }

  it('the owner’s records, from the participants but the owner, its pending proposals’ to-dos left alone', async () => {
    const db = makeFakeSupabase()
    seedCapture(db)
    const people = vi.fn(async () => DANA)
    let seen: KeptSourceItem | undefined
    const decide = vi.fn()
    await keptFromCapture(db as never, { workspaceId: WS, captureId: 'cap-1' }, {
      people, now: async () => 'Tuesday', decide,
      homeThread: async (_db, scope) => (scope.userId === 'u' ? 'home' : null),
      readRows: async (_db, _scope, _people, _at) => [],
      readTodos: async () => [],
      sourceDone: async (_db, _scope, item) => {
        seen = item as KeptSourceItem
        return false
      },
    })
    expect(people).toHaveBeenCalledWith(expect.anything(), WS, { contactIds: ['c-dana'], emails: ['lee@acme.example'] })
    expect(seen).toMatchObject({
      source: 'capture', ref: 'cap-1', label: null, atIso: '2026-11-10T15:00:00.000Z', tasks: true, private: false,
      text: 'Dana Reyes: We signed the renewal.\nSam: Great news.', skipActionIds: ['a-carded'],
      header: { kind: 'meeting', subject: 'Acme renewal call' },
    })
    expect(seen!.context).toContain('Acme signed.')
  })

  it('never a demo, an eval or an ownerless capture; a private one is marked private', async () => {
    for (const over of [{ is_eval: true }, { metadata: { demo: true } }, { user_id: null }, { transcript: '' }]) {
      const db = makeFakeSupabase()
      seedCapture(db, over)
      const sourceDone = vi.fn(async () => false)
      expect(await keptFromCapture(db as never, { workspaceId: WS, captureId: 'cap-1' }, { people: async () => DANA, now: async () => 'x', sourceDone })).toBe('skipped')
      expect(sourceDone).not.toHaveBeenCalled()
    }
    const db = makeFakeSupabase()
    seedCapture(db, { visibility: 'private' })
    let seen: KeptSourceItem | undefined
    await keptFromCapture(db as never, { workspaceId: WS, captureId: 'cap-1' }, {
      people: async () => DANA, now: async () => 'x', homeThread: async () => 'home', readRows: async () => [], readTodos: async () => [],
      sourceDone: async (_db, _s, item) => ((seen = item as KeptSourceItem), false),
    })
    expect(seen?.private).toBe(true)
    // Another workspace's capture is not found.
    expect(await keptFromCapture(db as never, { workspaceId: 'other', captureId: 'cap-1' }, { people: async () => DANA, now: async () => 'x' })).toBe('skipped')
  })
})

describe('texts', () => {
  const guest = (over: Partial<AgentGuest> = {}): AgentGuest => ({
    id: 'g1', ownerUserId: 'u', workspaceId: WS, displayName: 'Robin Okafor', phone: '+15555550123', channels: ['sms'], phoneBoundAt: null,
    slackTeamId: null, slackUserId: null, peerUserId: null, peerBoundAt: null, calendarEmails: [], businessNumberId: 'bn1', contactId: 'c-robin', ...over,
  } as AgentGuest)

  function seedThread(db: FakeSupabase) {
    db.seed('chat_messages', [
      { id: 1, conversation_id: 'gthread', user_id: 'u', created_at: '2026-11-10T15:00:00.000Z', ui_message: { id: 'sms:SM1', role: 'user', parts: [{ type: 'text', text: 'We just signed the onboarding agreement!' }] } },
      { id: 2, conversation_id: 'gthread', user_id: 'u', created_at: '2026-11-10T15:00:05.000Z', ui_message: { id: 'sms:SM2', role: 'user', parts: [{ type: 'text', text: 'See you Monday.' }] } },
      { id: 3, conversation_id: 'gthread', user_id: 'u', created_at: '2026-11-10T15:00:09.000Z', ui_message: { id: 'reply', role: 'assistant', parts: [{ type: 'text', text: 'Congrats!' }] } },
    ])
  }

  it('the texts the turn carried, oldest first, with the guest’s CRM contact', async () => {
    const db = makeFakeSupabase()
    seedThread(db)
    const people = vi.fn(async () => DANA)
    let seen: KeptSourceItem | undefined
    await keptFromTexts(db as never, { workspaceId: WS, userId: 'u', conversationId: 'gthread', guestId: 'g1', messageIds: ['sms:SM2', 'sms:SM1', 'reply'] }, {
      guest: async () => guest(), people, now: async () => 'x', homeThread: async () => 'home', readRows: async () => [], readTodos: async () => [],
      sourceDone: async (_db, _s, item) => ((seen = item as KeptSourceItem), false),
    })
    expect(people).toHaveBeenCalledWith(expect.anything(), WS, { contactIds: ['c-robin'] })
    expect(seen).toMatchObject({ source: 'sms', ref: 'sms:SM2', atIso: '2026-11-10T15:00:05.000Z', text: 'We just signed the onboarding agreement!\nSee you Monday.', header: { kind: 'text', from: 'Robin Okafor' }, tasks: true })
  })

  it('no contact on the guest: found by their number; nobody known, or another workspace’s guest, nothing', async () => {
    const db = makeFakeSupabase()
    seedThread(db)
    const contactByPhone = vi.fn(async () => 'c-found')
    const people = vi.fn(async (_db: unknown, _ws: string, who: { contactIds?: readonly string[] }) => (who.contactIds?.length ? DANA : NOBODY))
    const sourceDone = vi.fn(async () => false)
    const base = { workspaceId: WS, userId: 'u', conversationId: 'gthread', guestId: 'g1', messageIds: ['sms:SM1'] }
    await keptFromTexts(db as never, base, { guest: async () => guest({ contactId: null }), contactByPhone, people, now: async () => 'x', homeThread: async () => 'home', readRows: async () => [], sourceDone })
    expect(contactByPhone).toHaveBeenCalledWith(expect.anything(), WS, '+15555550123')
    expect(people).toHaveBeenCalledWith(expect.anything(), WS, { contactIds: ['c-found'] })
    sourceDone.mockClear()
    expect(await keptFromTexts(db as never, base, { guest: async () => guest({ contactId: null }), contactByPhone: async () => null, people, now: async () => 'x', sourceDone })).toBe('skipped')
    expect(await keptFromTexts(db as never, base, { guest: async () => guest({ workspaceId: 'other' }), people, now: async () => 'x', sourceDone })).toBe('skipped')
    expect(await keptFromTexts(db as never, { ...base, messageIds: [] }, { guest: async () => guest(), people, now: async () => 'x', sourceDone })).toBe('skipped')
    expect(sourceDone).not.toHaveBeenCalled()
  })
})
