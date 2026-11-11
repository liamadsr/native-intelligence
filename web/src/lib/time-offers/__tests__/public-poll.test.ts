/**
 * A poll's public API (src/lib/time-offers/public.ts, phase 5): a guest's
 * page reads their own answer and counts of the others, never a name or an
 * answer of theirs; the answer's POST in the shared error shape, with the
 * honeypot and the daily cap; once booked, their own manage link; that link
 * opens the group meeting, where they can only say they can't make it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PublicPollData } from '../display'
import { createPoll, planPoll } from '../polls'
import { handleAnswerPoll, handleBookingTimes, handleCancelBooking, handleGetBooking, handleGetOffer, handleRescheduleBooking, loadBookingPage, loadOfferPage, type PublicDeps } from '../public'
import { pollManageTokenFor, pollTokenFor } from '../tokens'
import { bookingSeams, freeCalendar, hoursFromNow, HOST, offerDb, WS } from './fake-db'

const NOW = Date.now()
const SLOTS = [hoursFromNow(26, NOW), hoursFromNow(50, NOW)]

async function setup() {
  const db = offerDb()
  const cal = freeCalendar()
  const planned = await planPoll(
    db.db,
    {
      workspaceId: WS,
      hostUserId: HOST,
      recipient: { name: 'Dana Reyes' },
      recipients: [{ name: 'Dana Reyes', email: 'dana@initech.example' }, { name: 'Sam Ortiz', email: 'sam@globex.example' }, { name: 'Ira Chen', email: 'ira@hooli.example' }],
      title: 'Planning',
      slots: SLOTS,
      durationMinutes: 30,
      sendBy: 'link',
    },
    { ...cal, linkedGrant: vi.fn(async () => null) },
  )
  if (!planned.ok) throw new Error(planned.message)
  const made = await createPoll(db.db, planned.plan, { state: 'open', createdBy: HOST }, { ...cal, linkedGrant: vi.fn(async () => null), secret: 'test-secret' })
  if (!made.ok) throw new Error(made.message)
  const seams = bookingSeams()
  const poll = { ...seams, checkFree: cal.checkFree, calendarAccount: cal.calendarAccount, hostEmails: vi.fn(async () => []) }
  const updateEvent = vi.fn(async () => ({}) as never)
  const deps: PublicDeps = { supabase: db.db, poll, manage: { secret: 'test-secret', origin: 'https://app.example', updateEvent, tellHost: seams.tellHost } }
  const tokens = made.poll.recipients.map((r) => pollTokenFor(r.id, 'test-secret'))
  return { ...db, deps, tokens, poll: made.poll, seams, updateEvent }
}

const post = (body: unknown) => new Request('https://app.example/api/public/x', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('a poll guest\'s page', () => {
  it('reads as a poll: the times, their own name, counts only; the server render is the same read', async () => {
    const { deps, tokens } = await setup()
    const res = await handleGetOffer(tokens[0], deps)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { poll: PublicPollData; offer?: unknown }
    expect(body.offer).toBeUndefined()
    expect(body.poll).toMatchObject({ state: 'open', host_name: 'Ava Lin', title: 'Planning', recipient_name: 'Dana Reyes', answer: null, guests: 3, waiting: 3, booked: null })
    expect(body.poll.slots.map((s) => s.start)).toEqual(SLOTS)
    const raw = JSON.stringify(body)
    for (const other of ['Sam Ortiz', 'sam@globex.example', 'Ira Chen', 'dana@initech.example']) expect(raw).not.toContain(other)
    expect(await loadOfferPage(deps.supabase, tokens[0], Date.now(), deps)).toEqual({ kind: 'poll', data: body.poll })
  })

  it('saves an answer and answers with the page as it is now; a bot filling the honeypot learns nothing', async () => {
    const { deps, tokens, tables } = await setup()
    const res = await handleAnswerPoll(post({ works: [SLOTS[1]], note: 'Afternoons please' }), tokens[0], deps)
    expect(res.status).toBe(200)
    const { poll } = (await res.json()) as { poll: PublicPollData }
    expect(poll.answer).toMatchObject({ works: [SLOTS[1]], none: false, note: 'Afternoons please', from_calendar: false })
    expect(poll.waiting).toBe(2)
    const bot = await handleAnswerPoll(post({ works: [SLOTS[0]], website: 'spam.example' }), tokens[1], deps)
    expect(await bot.json()).toEqual({ ok: true })
    expect(tables.time_offer_recipient[1].answered_at ?? null).toBeNull()
  })

  it('answers in the shared shape: nothing marked, not one of the times, a token of nobody, too many saves', async () => {
    const { deps, tokens, tables } = await setup()
    expect((await handleAnswerPoll(post({ works: [] }), tokens[0], deps)).status).toBe(400)
    const wrong = await handleAnswerPoll(post({ works: [hoursFromNow(30, NOW)] }), tokens[0], deps)
    expect(wrong.status).toBe(400)
    expect(await wrong.json()).toMatchObject({ code: 'BAD_INPUT', details: { slots: expect.any(Array) } })
    expect((await handleAnswerPoll(post({ works: [SLOTS[0]] }), 'Z'.repeat(24), deps)).status).toBe(404)
    tables.time_offer_recipient[0].saves = 20
    tables.time_offer_recipient[0].saves_since = new Date().toISOString()
    expect((await handleAnswerPoll(post({ works: [SLOTS[0]] }), tokens[0], deps)).status).toBe(429)
  })

  it('the last answer books it: the page shows the meeting and their own manage link; another save is 410', async () => {
    const { deps, tokens } = await setup()
    for (const token of tokens.slice(0, 2)) await handleAnswerPoll(post({ works: SLOTS }), token, deps)
    const res = await handleAnswerPoll(post({ works: [SLOTS[1]] }), tokens[2], deps)
    const { poll } = (await res.json()) as { poll: PublicPollData }
    expect(poll.state).toBe('booked')
    expect(poll.booked).toMatchObject({ start: SLOTS[1], attending: true, conference_url: 'https://meet.example/abc-defg-hij' })
    expect(poll.booked?.manage_url).toMatch(/^https:\/\/app\.example\/b\/[A-Za-z0-9_-]{24}$/)
    const again = await handleAnswerPoll(post({ works: [SLOTS[0]] }), tokens[0], deps)
    expect(again.status).toBe(410)
    expect(await again.json()).toMatchObject({ code: 'BOOKED' })
  })
})

describe('a poll guest\'s manage link', () => {
  async function booked() {
    const ctx = await setup()
    for (const token of ctx.tokens) await handleAnswerPoll(post({ works: [SLOTS[0]] }), token, ctx.deps)
    const bookingId = String(ctx.tables.meeting_booking[0].id)
    const manage = ctx.poll.recipients.map((r) => pollManageTokenFor(bookingId, r.id, 'test-secret'))
    return { ...ctx, manage, bookingId }
  }

  it('opens their group meeting: "I can\'t make it" takes them off it and tells the host; the meeting stays', async () => {
    const { deps, manage, tables, updateEvent, seams } = await booked()
    const res = await handleGetBooking(manage[0], deps)
    expect((await res.json()).booking).toMatchObject({ state: 'confirmed', guest_name: 'Dana Reyes', can_cancel: true, can_reschedule: false, group: { attending: true } })
    const out = await handleCancelBooking(manage[0], deps)
    expect(out.status).toBe(200)
    expect((await out.json()).booking).toMatchObject({ state: 'confirmed', can_cancel: false, group: { attending: false }, conference_url: null })
    expect(updateEvent).toHaveBeenCalledWith(HOST, 'evt-1', { attendees: ['sam@globex.example', 'ira@hooli.example'] }, expect.objectContaining({ notifyAttendees: true }))
    expect(tables.meeting_booking[0].state).toBe('confirmed')
    expect(seams.tellHost).toHaveBeenLastCalledWith(expect.objectContaining({ text: expect.stringContaining("Dana Reyes can't make Planning") }))
    expect(await loadBookingPage(deps.supabase, manage[1])).toMatchObject({ kind: 'found', data: { guest_name: 'Sam Ortiz', group: { attending: true } } })
  })

  it('a guest can\'t move a group meeting: they reply to the host', async () => {
    const { deps, manage } = await booked()
    const times = await handleBookingTimes(manage[0], deps)
    expect(times.status).toBe(400)
    expect((await times.json()).error).toContain('Reply to Ava Lin')
    expect((await handleRescheduleBooking(post({ start: SLOTS[1] }), manage[0], deps)).status).toBe(400)
  })
})
