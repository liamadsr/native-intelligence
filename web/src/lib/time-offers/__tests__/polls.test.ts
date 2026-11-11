/**
 * Polls (src/lib/time-offers/polls.ts, migration 583): several guests, each
 * marking every time that works. The poll holds every host's time; answers
 * replace each other whole; the last answer books the earliest time that
 * works for everyone (a time a host's calendar filled is let go and the next
 * tried), once, however many last answers race; no common time books
 * nothing and tells the host the best option once; the host books anyway
 * without whom they name; a guest of the group meeting drops out (the
 * meeting stays); a poll that lapses tells the host who never answered; a
 * linked guest is answered from their calendar only with their grant, and
 * an unreadable calendar leaves them to answer like anyone.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspacePerson } from '@/lib/availability/people'
import { autoAnswerLinked, bookPollAnyway, bookWhenAnswered, createPoll, declineGroupMeeting, normalizeRecipients, nudgeTargets, planPoll, recordAnswer, recipientLink, type AnswerDeps, type PollDeps } from '../polls'
import { getPoll } from '../poll-store'
import type { OfferRequest } from '../offers'
import { sweepTimeOffers } from '../sweep'
import { manageTokenHash, offerTokenHash, pollManageTokenFor, pollTokenFor } from '../tokens'
import { bookingSeams, freeCalendar, hoursFromNow, HOST, offerDb, WS } from './fake-db'

const NOW = Date.now()
const SLOTS = [hoursFromNow(26, NOW), hoursFromNow(50, NOW), hoursFromNow(74, NOW)]
const LEE = 'user-lee'
const GUESTS = [
  { name: 'Dana Reyes', email: 'dana@initech.example' },
  { name: 'Sam Ortiz', email: 'sam@globex.example' },
  { name: 'Ira Chen', phone: '+13125550143' },
]

const person = (userId: string, name: string, sharing: WorkspacePerson['sharing'] = 'busy_only'): WorkspacePerson => ({ memberId: `m-${userId}`, userId, name, role: 'member', sharing })

function request(over: Partial<OfferRequest> = {}): OfferRequest {
  return { workspaceId: WS, hostUserId: HOST, recipient: { name: GUESTS[0].name }, recipients: GUESTS, coHosts: ['Lee Park'], title: 'Planning', slots: SLOTS, durationMinutes: 30, sendBy: 'link', ...over }
}

async function setup(over: Partial<OfferRequest> = {}, extra: Partial<PollDeps> = {}) {
  const db = offerDb({ member: [{ workspace_id: WS, user_id: HOST, display_name: 'Ava Lin', role: 'owner' }, { workspace_id: WS, user_id: LEE, display_name: 'Lee Park', role: 'member' }] })
  const cal = freeCalendar()
  const findPeople = vi.fn(async () => ({ ok: true as const, requester: person(HOST, 'Ava Lin'), others: [person(LEE, 'Lee Park')] }))
  const linkedGrant = vi.fn(async () => null)
  const deps: PollDeps = { ...cal, findPeople, linkedGrant, secret: 'test-secret', ...extra }
  const planned = await planPoll(db.db, request(over), deps)
  if (!planned.ok) throw new Error(planned.message)
  const made = await createPoll(db.db, planned.plan, { state: 'open', createdBy: HOST }, deps)
  if (!made.ok) throw new Error(made.message)
  const seams = bookingSeams()
  const answerDeps: AnswerDeps = {
    ...seams,
    checkFree: cal.checkFree,
    calendarAccount: cal.calendarAccount,
    findContact: cal.findContact,
    linkedGrant,
    hostEmails: vi.fn(async () => ['lee@fernhill.example']),
    textGuest: vi.fn(async () => true),
  }
  const tokens = made.poll.recipients.map((r) => pollTokenFor(r.id, 'test-secret'))
  return { ...db, poll: made.poll, cal, seams, deps: answerDeps, tokens, findPeople, linkedGrant }
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('planPoll and createPoll', () => {
  it('writes one poll: its times, its guests in order, and a hold on every time for the host and each co-host; the links are live', async () => {
    const { tables, poll, cal } = await setup()
    expect(tables.time_offer).toHaveLength(1)
    expect(tables.time_offer[0]).toMatchObject({ mode: 'poll', state: 'open', token_hash: null, co_host_ids: [LEE], recipient_name: 'Dana Reyes, Sam Ortiz and Ira Chen', sent_via: 'link' })
    expect(tables.time_offer_recipient.map((r) => [r.position, r.name, r.email ?? null, r.phone ?? null])).toEqual([
      [0, 'Dana Reyes', 'dana@initech.example', null],
      [1, 'Sam Ortiz', 'sam@globex.example', null],
      [2, 'Ira Chen', null, '+13125550143'],
    ])
    expect(tables.time_offer_recipient.map((r) => r.token_hash)).toEqual(poll.recipients.map((r) => offerTokenHash(pollTokenFor(r.id, 'test-secret'))))
    expect(tables.host_time_claim.filter((c) => c.host_user_id === HOST)).toHaveLength(3)
    expect(tables.host_time_claim.filter((c) => c.host_user_id === LEE)).toHaveLength(3)
    // Every host's calendar was read strictly before anything was written.
    expect(cal.checkFree.mock.calls.map((c) => (c[0] as unknown as { userId: string }).userId)).toEqual([HOST, LEE])
    expect(recipientLink('https://app.example', poll.recipients[0].id, 'test-secret')).toBe(`https://app.example/t/${pollTokenFor(poll.recipients[0].id, 'test-secret')}`)
  })

  it('stays open until its last time, not its first, and takes up to six times', async () => {
    const six = [26, 30, 50, 54, 74, 78].map((h) => hoursFromNow(h, NOW))
    const { poll } = await setup({ slots: six, expiresAt: hoursFromNow(200, NOW) })
    expect(poll.slots).toHaveLength(6)
    expect(poll.expiresAt).toBe(six[5])
  })

  it('refuses what it cannot hold or send, naming why', async () => {
    const db = offerDb()
    const cal = freeCalendar()
    const deps: PollDeps = { ...cal, findPeople: vi.fn(async () => ({ ok: true as const, requester: person(HOST, 'Ava Lin'), others: [person(LEE, 'Lee Park', 'none')] })), linkedGrant: vi.fn(async () => null) }
    expect(await planPoll(db.db, request(), deps)).toMatchObject({ ok: false, code: 'NOT_SHARING', message: expect.stringContaining("Lee Park doesn't share") })
    expect(await planPoll(db.db, request({ coHosts: [], sendBy: 'email' }), deps)).toMatchObject({ ok: false, code: 'NEEDS_EMAIL', message: expect.stringContaining('Ira Chen has none') })
    expect(await planPoll(db.db, request({ coHosts: [], slots: [...SLOTS, ...[30, 54, 78, 98].map((h) => hoursFromNow(h, NOW))] }), deps)).toMatchObject({ ok: false, message: 'Offer 2 to 6 times.' })
    expect(normalizeRecipients([{ name: 'Dana Reyes', email: 'dana@initech.example' }, { name: 'D. Reyes', email: 'DANA@initech.example' }], 'link')).toMatchObject({ ok: false, message: 'D. Reyes is in the list twice.' })
    expect(normalizeRecipients(Array.from({ length: 9 }, (_, i) => ({ name: `Guest ${i}` })), 'link')).toMatchObject({ ok: false })
    // A co-host's calendar that can't be read refuses the poll, without its reason.
    const planned = await planPoll(db.db, request(), { ...deps, findPeople: vi.fn(async () => ({ ok: true as const, requester: person(HOST, 'Ava Lin'), others: [person(LEE, 'Lee Park')] })) })
    if (!planned.ok) throw new Error(planned.message)
    cal.checkFree.mockResolvedValueOnce({ known: true, busy: [false, false, false] }).mockResolvedValueOnce({ known: false, reason: 'token for lee@fernhill.example expired' } as never)
    const made = await createPoll(db.db, planned.plan, { state: 'open', createdBy: HOST }, deps)
    expect(made).toMatchObject({ ok: false, code: 'CALENDAR_UNKNOWN', message: "Lee Park's calendar couldn't be read, so no times were offered. Try again in a moment, or leave them out." })
    expect(db.tables.time_offer).toHaveLength(0)
  })

  it('a pending poll (its card) gives its guests no live link yet', async () => {
    const db = offerDb()
    const cal = freeCalendar()
    const deps: PollDeps = { ...cal, linkedGrant: vi.fn(async () => null) }
    const planned = await planPoll(db.db, request({ coHosts: [] }), deps)
    if (!planned.ok) throw new Error(planned.message)
    const made = await createPoll(db.db, planned.plan, { state: 'pending_send', createdBy: HOST, cardHash: 'card-1' }, deps)
    expect(made.ok).toBe(true)
    expect(db.tables.time_offer_recipient.every((r) => r.token_hash == null)).toBe(true)
    // The same card asked again gets its poll back.
    const again = await createPoll(db.db, planned.plan, { state: 'pending_send', createdBy: HOST, cardHash: 'card-1' }, deps)
    expect(again).toMatchObject({ ok: true, reused: true })
    expect(db.tables.time_offer).toHaveLength(1)
  })
})

describe('recordAnswer', () => {
  it('records a guest\'s whole answer and replaces it when they change it; counts who is still to answer', async () => {
    const { db, tables, tokens, deps } = await setup()
    const first = await recordAnswer(db, { ref: { token: tokens[0] }, works: [SLOTS[0], SLOTS[1]], via: 'link' }, deps)
    expect(first).toMatchObject({ ok: true, waiting: 2, booking: null })
    const changed = await recordAnswer(db, { ref: { token: tokens[0] }, works: [SLOTS[1]], note: 'Mornings are easier', via: 'link' }, deps)
    expect(changed.ok && changed.recipient.works).toHaveLength(1)
    expect(tables.time_offer_response.filter((x) => x.recipient_id === tables.time_offer_recipient[0].id && x.works)).toHaveLength(1)
    expect(tables.time_offer_recipient[0]).toMatchObject({ answered_via: 'link', note: 'Mornings are easier' })
    expect(tables.meeting_booking).toHaveLength(0)
  })

  it('takes none of these work, and refuses an answer that is neither, both, or not one of the times', async () => {
    const { db, tokens, deps } = await setup()
    expect(await recordAnswer(db, { ref: { token: tokens[0] }, works: [], none: true, note: 'Away that week', via: 'link' }, deps)).toMatchObject({ ok: true, recipient: { works: [], note: 'Away that week' } })
    expect(await recordAnswer(db, { ref: { token: tokens[0] }, works: [], via: 'link' }, deps)).toMatchObject({ ok: false, code: 'BAD_INPUT' })
    expect(await recordAnswer(db, { ref: { token: tokens[0] }, works: [SLOTS[0]], none: true, via: 'link' }, deps)).toMatchObject({ ok: false, code: 'BAD_INPUT' })
    expect(await recordAnswer(db, { ref: { token: tokens[0] }, works: [hoursFromNow(30, NOW)], via: 'link' }, deps)).toMatchObject({ ok: false, code: 'BAD_INPUT', openSlots: expect.any(Array) })
    expect(await recordAnswer(db, { ref: { token: 'A'.repeat(24) }, works: [SLOTS[0]], via: 'link' }, deps)).toMatchObject({ ok: false, code: 'NOT_FOUND' })
  })

  it('caps a page\'s saves a day, never the agents\'', async () => {
    const { db, tables, tokens, poll, deps } = await setup()
    tables.time_offer_recipient[0].saves = 20
    tables.time_offer_recipient[0].saves_since = new Date().toISOString()
    expect(await recordAnswer(db, { ref: { token: tokens[0] }, works: [SLOTS[0]], via: 'link' }, deps)).toMatchObject({ ok: false, code: 'LIMIT' })
    expect(await recordAnswer(db, { ref: { offerId: poll.id, workspaceId: WS, recipientId: poll.recipients[0].id }, works: [SLOTS[0]], via: 'host', actingUserId: HOST }, deps)).toMatchObject({ ok: true })
  })

  it('the host\'s agent answers only for its own poll\'s guests; the business\'s assistant only for the guest at that number', async () => {
    const { db, poll, deps } = await setup()
    expect(await recordAnswer(db, { ref: { offerId: poll.id, workspaceId: WS, recipientId: poll.recipients[0].id }, works: [SLOTS[0]], via: 'host', actingUserId: 'user-other' }, deps)).toMatchObject({ ok: false, code: 'NOT_FOUND' })
    expect(await recordAnswer(db, { ref: { offerId: poll.id, workspaceId: WS, recipientId: 'not-a-guest' }, works: [SLOTS[0]], via: 'host', actingUserId: HOST }, deps)).toMatchObject({ ok: false, code: 'NOT_FOUND' })
    expect(await recordAnswer(db, { ref: { offerId: poll.id, workspaceId: WS }, works: [SLOTS[0]], via: 'text', guestPhone: '+13125550199' }, deps)).toMatchObject({ ok: false, code: 'NOT_FOUND' })
    expect(await recordAnswer(db, { ref: { offerId: poll.id, workspaceId: WS }, works: [SLOTS[0]], via: 'text', guestPhone: '+1 312 555 0143' }, deps)).toMatchObject({ ok: true, recipient: { name: 'Ira Chen', answeredVia: 'text' } })
  })
})

describe('the last answer books', () => {
  it('the earliest time that works for everyone: one event with every guest who has an email and the co-host, claims for both hosts, a text to the mobile-only guest, the host told', async () => {
    const { db, tables, tokens, deps, seams, poll } = await setup()
    await recordAnswer(db, { ref: { token: tokens[0] }, works: [SLOTS[1], SLOTS[2]], via: 'link' }, deps)
    await recordAnswer(db, { ref: { token: tokens[1] }, works: [SLOTS[0], SLOTS[1], SLOTS[2]], via: 'link' }, deps)
    const last = await recordAnswer(db, { ref: { token: tokens[2] }, works: [SLOTS[1], SLOTS[2]], via: 'link' }, deps)
    expect(last.ok).toBe(true)
    if (!last.ok) return
    expect(last.booking).toMatchObject({ state: 'confirmed', source: 'poll', startsAt: SLOTS[1], otherHostIds: [LEE], guestName: 'Dana Reyes, Sam Ortiz and Ira Chen' })
    const [userId, event, , options] = seams.createEvent.mock.calls[0] as unknown as [string, { attendees: string[]; description: string; title: string }, string, Record<string, unknown>]
    expect(userId).toBe(HOST)
    expect(event.attendees).toEqual(['dana@initech.example', 'sam@globex.example', 'lee@fernhill.example'])
    expect(options).toMatchObject({ sendInvites: true, idempotencyKey: last.booking!.id })
    // Everyone gets the same invitation: no one guest's link is in it.
    expect(event.description).not.toMatch(/\/[bt]\//)
    expect(event.description).toContain('Booked through Native Intelligence')
    expect(tables.host_time_claim.map((c) => [c.kind, c.host_user_id]).sort()).toEqual([['booking', HOST], ['booking', LEE]])
    expect(tables.time_offer[0]).toMatchObject({ state: 'booked', booking_id: last.booking!.id })
    // Each guest has their own manage link; the mobile-only one got it by text.
    const ira = poll.recipients[2]
    expect(tables.time_offer_recipient[2]).toMatchObject({ attending: true, manage_token_hash: manageTokenHash(pollManageTokenFor(last.booking!.id, ira.id, 'test-secret')) })
    expect(deps.textGuest).toHaveBeenCalledWith(expect.objectContaining({ id: last.booking!.id }), expect.stringContaining(`https://app.example/b/${pollManageTokenFor(last.booking!.id, ira.id, 'test-secret')}`))
    expect(seams.tellHost).toHaveBeenCalledWith(expect.objectContaining({ messageId: `meeting-booking:${last.booking!.id}:booked`, routes: false, text: expect.stringMatching(/^Everyone answered: Planning is booked for .* with Dana Reyes, Sam Ortiz and Ira Chen\. .*Dana Reyes and Sam Ortiz got the invitation\. Ira Chen got a confirmation text\.$/) }))
  })

  it('a time a host\'s calendar filled since is let go, and the next common time is booked', async () => {
    const { db, tables, tokens, deps, cal } = await setup({ coHosts: [] })
    for (const token of tokens.slice(0, 2)) await recordAnswer(db, { ref: { token }, works: SLOTS, via: 'link' }, deps)
    cal.checkFree.mockResolvedValueOnce({ known: true, busy: [true] })
    const last = await recordAnswer(db, { ref: { token: tokens[2] }, works: SLOTS, via: 'link' }, deps)
    expect(last.ok && last.booking?.startsAt).toBe(SLOTS[1])
    expect(tables.time_offer_slot.find((s) => s.starts_at === SLOTS[0])?.state).toBe('released')
  })

  it('a host calendar that can\'t be read books nothing now; the sweep books it later', async () => {
    const { db, tables, tokens, deps, cal } = await setup({ coHosts: [] })
    for (const token of tokens.slice(0, 2)) await recordAnswer(db, { ref: { token }, works: [SLOTS[0]], via: 'link' }, deps)
    cal.checkFree.mockResolvedValueOnce({ known: false, reason: 'timeout' } as never)
    const last = await recordAnswer(db, { ref: { token: tokens[2] }, works: [SLOTS[0]], via: 'link' }, deps)
    expect(last).toMatchObject({ ok: true, booking: null, waiting: 0 })
    expect(tables.meeting_booking).toHaveLength(0)
    const swept = await sweepTimeOffers(db, deps)
    expect(swept.pollsBooked).toBe(1)
    expect(tables.meeting_booking).toHaveLength(1)
  })

  it('two last answers at once make one booking and one event', async () => {
    const { db, tables, tokens, deps, seams } = await setup({ coHosts: [] })
    await recordAnswer(db, { ref: { token: tokens[0] }, works: [SLOTS[0]], via: 'link' }, deps)
    const [a, b] = await Promise.all([
      recordAnswer(db, { ref: { token: tokens[1] }, works: [SLOTS[0]], via: 'link' }, deps),
      recordAnswer(db, { ref: { token: tokens[2] }, works: [SLOTS[0]], via: 'link' }, deps),
    ])
    expect(a.ok && b.ok).toBe(true)
    expect(tables.meeting_booking).toHaveLength(1)
    expect(seams.createEvent).toHaveBeenCalledTimes(1)
    // A third try reads the booking, never makes another.
    expect(await bookWhenAnswered(db, tables.time_offer[0].id as string, deps)).toMatchObject({ status: 'booked', already: true })
    expect(tables.meeting_booking).toHaveLength(1)
  })

  it('an answer after the booking is told it is booked', async () => {
    const { db, tokens, deps } = await setup({ coHosts: [] })
    for (const token of tokens) await recordAnswer(db, { ref: { token }, works: [SLOTS[0]], via: 'link' }, deps)
    expect(await recordAnswer(db, { ref: { token: tokens[0] }, works: [SLOTS[1]], via: 'link' }, deps)).toMatchObject({ ok: false, code: 'BOOKED' })
  })

  it('no time for everyone: nothing booked, the holds stay, the host is told the best option once', async () => {
    const { db, tables, tokens, deps, seams } = await setup({ coHosts: [] })
    await recordAnswer(db, { ref: { token: tokens[0] }, works: [SLOTS[0], SLOTS[1]], via: 'link' }, deps)
    await recordAnswer(db, { ref: { token: tokens[1] }, works: [SLOTS[1]], via: 'link' }, deps)
    await recordAnswer(db, { ref: { token: tokens[2] }, works: [], none: true, via: 'link' }, deps)
    expect(tables.meeting_booking).toHaveLength(0)
    expect(tables.host_time_claim).toHaveLength(3)
    expect(seams.tellHost).toHaveBeenCalledTimes(1)
    expect(seams.tellHost).toHaveBeenCalledWith(expect.objectContaining({ messageId: `time-offer:${tables.time_offer[0].id}:no-common`, routes: true, text: expect.stringContaining("(Dana Reyes and Sam Ortiz can; Ira Chen can't)") }))
  })
})

describe('bookPollAnyway', () => {
  it('books with whoever can make it: not who said no, not who is left out; who hasn\'t answered is invited', async () => {
    const { db, tables, tokens, poll, deps, seams } = await setup({ coHosts: [] })
    await recordAnswer(db, { ref: { token: tokens[0] }, works: [SLOTS[0]], via: 'link' }, deps)
    await recordAnswer(db, { ref: { token: tokens[1] }, works: [SLOTS[1]], via: 'link' }, deps)
    const out = await bookPollAnyway(db, { workspaceId: WS, userId: HOST, offerId: poll.id, start: SLOTS[0] }, deps)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.left.map((r) => r.name)).toEqual(['Sam Ortiz'])
    expect(tables.time_offer_recipient.map((r) => r.attending)).toEqual([true, false, true])
    expect((seams.createEvent.mock.calls[0] as unknown as [string, { attendees: string[] }])[1].attendees).toEqual(['dana@initech.example'])
    expect(seams.tellHost).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringMatching(/^Booked Planning for .*Sam Ortiz isn't on it\.$/) }))
  })

  it('"without Dana" leaves Dana out, by name; only the poll\'s own times and guests, and only the host\'s', async () => {
    const { db, tables, poll, deps } = await setup({ coHosts: [] })
    expect(await bookPollAnyway(db, { workspaceId: WS, userId: HOST, offerId: poll.id, start: SLOTS[0], without: ['Nobody Here'] }, deps)).toMatchObject({ ok: false, code: 'BAD_INPUT' })
    expect(await bookPollAnyway(db, { workspaceId: WS, userId: HOST, offerId: poll.id, start: hoursFromNow(30, NOW) }, deps)).toMatchObject({ ok: false, code: 'BAD_INPUT' })
    expect(await bookPollAnyway(db, { workspaceId: WS, userId: 'user-other', offerId: poll.id, start: SLOTS[0] }, deps)).toMatchObject({ ok: false, code: 'NOT_FOUND' })
    const out = await bookPollAnyway(db, { workspaceId: WS, userId: HOST, offerId: poll.id, start: SLOTS[2], without: ['dana'] }, deps)
    expect(out.ok).toBe(true)
    expect(tables.time_offer_recipient.map((r) => r.attending)).toEqual([false, true, true])
    expect(await bookPollAnyway(db, { workspaceId: WS, userId: HOST, offerId: poll.id, start: SLOTS[1] }, deps)).toMatchObject({ ok: false, code: 'BOOKED' })
  })
})

describe('declineGroupMeeting', () => {
  it('takes the guest off the invitation, keeps the meeting, tells the host; a second time is refused', async () => {
    const { db, tables, tokens, deps, seams } = await setup({ coHosts: [] })
    for (const token of tokens) await recordAnswer(db, { ref: { token }, works: [SLOTS[0]], via: 'link' }, deps)
    const poll = (await getPoll(db, tables.time_offer[0].id as string))!
    const booking = { ...(await import('../store').then((m) => m.getBooking(db, poll.bookingId!)))! }
    const updateEvent = vi.fn(async () => ({}) as never)
    seams.tellHost.mockClear()
    const out = await declineGroupMeeting(db, { booking, recipient: poll.recipients[0] }, { ...deps, updateEvent })
    expect(out.ok).toBe(true)
    expect(updateEvent).toHaveBeenCalledWith(HOST, 'evt-1', { attendees: ['sam@globex.example'] }, expect.objectContaining({ notifyAttendees: true }))
    expect(tables.meeting_booking[0].state).toBe('confirmed')
    expect(tables.time_offer_recipient[0]).toMatchObject({ attending: false })
    expect(seams.tellHost).toHaveBeenCalledWith(expect.objectContaining({ routes: true, text: expect.stringMatching(/^Dana Reyes can't make Planning at .* after all, so they're off the invitation\. It stays on with Sam Ortiz and Ira Chen\.$/) }))
    const again = await declineGroupMeeting(db, { booking, recipient: { ...poll.recipients[0], attending: false } }, { ...deps, updateEvent })
    expect(again).toMatchObject({ ok: false, code: 'CLOSED' })
  })

  it('a calendar that refuses leaves them on it', async () => {
    const { db, tables, tokens, deps } = await setup({ coHosts: [] })
    for (const token of tokens) await recordAnswer(db, { ref: { token }, works: [SLOTS[0]], via: 'link' }, deps)
    const poll = (await getPoll(db, tables.time_offer[0].id as string))!
    const booking = (await import('../store').then((m) => m.getBooking(db, poll.bookingId!)))!
    const out = await declineGroupMeeting(db, { booking, recipient: poll.recipients[0] }, { ...deps, updateEvent: vi.fn(async () => { throw new Error('403') }) })
    expect(out).toMatchObject({ ok: false, code: 'FAILED' })
    expect(tables.time_offer_recipient[0].attending).toBe(true)
  })
})

describe('expiry and reminders', () => {
  it('a poll that lapses unbooked lets its times go and tells the host who never answered and the best option', async () => {
    const { db, tables, tokens, deps, seams } = await setup({ coHosts: [] })
    await recordAnswer(db, { ref: { token: tokens[0] }, works: [SLOTS[0]], via: 'link' }, deps)
    tables.time_offer[0].expires_at = new Date(Date.now() - 60_000).toISOString()
    const swept = await sweepTimeOffers(db, deps)
    expect(swept.expired).toBe(1)
    expect(tables.host_time_claim).toHaveLength(0)
    expect(seams.tellHost).toHaveBeenCalledWith(expect.objectContaining({ messageId: `time-offer:${tables.time_offer[0].id}:expired`, routes: true, text: expect.stringContaining('Sam Ortiz and Ira Chen never answered') }))
    expect((seams.tellHost.mock.calls as unknown as Array<[{ text: string }]>)[0][0].text).toContain("(Dana Reyes can; Sam Ortiz and Ira Chen haven't answered)")
  })

  it('reminds only those sent and not answered, 12 hours apart, three times at most', async () => {
    const { db, tokens, poll, deps } = await setup({ coHosts: [] })
    await recordAnswer(db, { ref: { token: tokens[0] }, works: [SLOTS[0]], via: 'link' }, deps)
    const fresh = (await getPoll(db, poll.id))!
    expect(nudgeTargets(fresh, Date.now()).map((r) => r.name)).toEqual(['Sam Ortiz', 'Ira Chen'])
    const reminded = { ...fresh, recipients: fresh.recipients.map((r) => ({ ...r, nudgedAt: new Date().toISOString(), nudges: r.name === 'Ira Chen' ? 3 : 1 })) }
    expect(nudgeTargets(reminded, Date.now())).toEqual([])
    expect(nudgeTargets(reminded, Date.now() + 13 * 3_600_000).map((r) => r.name)).toEqual(['Sam Ortiz'])
  })
})

describe('linked guests answered from their calendar', () => {
  const grant = { peerUserId: 'user-dana', workspaceId: 'ws-initech' }

  it('a guest whose link shares free/busy is answered at once (free works, busy does not), marked as from their calendar', async () => {
    const linkedGrant = vi.fn(async (_s: unknown, a: { email: string | null }) => (a.email === 'dana@initech.example' ? grant : null))
    const { db, tables, poll, deps } = await setup({ coHosts: [] }, { linkedGrant: linkedGrant as never })
    expect(tables.time_offer_recipient[0].peer_user_id).toBe('user-dana')
    const linkedCheckFree = vi.fn(async () => ({ known: true as const, busy: [false, true, false] }))
    const answered = await autoAnswerLinked(db, poll.id, { ...deps, linkedGrant: linkedGrant as never, linkedCheckFree, linkedTimeZone: async () => 'America/Chicago' })
    expect(answered).toBe(1)
    expect(tables.time_offer_recipient[0]).toMatchObject({ answered_via: 'calendar' })
    const fresh = (await getPoll(db, poll.id))!
    expect(fresh.recipients[0].works).toEqual([fresh.slots[0].id, fresh.slots[2].id])
    // Only busy or free was read: the linked guest's own calendar, their own zone.
    expect(linkedCheckFree).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-dana', workspaceId: 'ws-initech', timeZone: 'America/Chicago' }))
    expect(fresh.recipients.slice(1).every((r) => !r.answeredAt)).toBe(true)
  })

  it('an unreadable calendar, a grant gone since, or a guest\'s or linked agent\'s turn: they are asked like anyone', async () => {
    const linkedGrant = vi.fn(async (_s: unknown, a: { email: string | null; omitGrants?: boolean }) => (a.email === 'dana@initech.example' && !a.omitGrants ? grant : null))
    const { db, tables, poll, deps } = await setup({ coHosts: [] }, { linkedGrant: linkedGrant as never })
    expect(await autoAnswerLinked(db, poll.id, { ...deps, linkedGrant: linkedGrant as never, linkedCheckFree: vi.fn(async () => ({ known: false as const, reason: 'x' })) as never, linkedTimeZone: async () => 'UTC' })).toBe(0)
    expect(await autoAnswerLinked(db, poll.id, { ...deps, omitGrants: true, linkedGrant: linkedGrant as never, linkedCheckFree: vi.fn(async () => ({ known: true as const, busy: [false, false, false] })), linkedTimeZone: async () => 'UTC' })).toBe(0)
    expect(await autoAnswerLinked(db, poll.id, { ...deps, linkedGrant: vi.fn(async () => null), linkedCheckFree: vi.fn(async () => ({ known: true as const, busy: [false, false, false] })), linkedTimeZone: async () => 'UTC' })).toBe(0)
    expect(tables.time_offer_recipient[0].answered_at ?? null).toBeNull()
  })

  it('a poll made on a guest\'s or a linked agent\'s turn reads no grant', async () => {
    const db = offerDb()
    const cal = freeCalendar()
    const linkedGrant = vi.fn(async () => null)
    const planned = await planPoll(db.db, request({ coHosts: [] }), { ...cal, linkedGrant })
    if (!planned.ok) throw new Error(planned.message)
    await createPoll(db.db, planned.plan, { state: 'open', createdBy: HOST, omitGrants: true }, { ...cal, linkedGrant })
    expect((linkedGrant.mock.calls as unknown as Array<[unknown, { omitGrants?: boolean }]>).every((c) => c[1].omitGrants === true)).toBe(true)
  })
})
