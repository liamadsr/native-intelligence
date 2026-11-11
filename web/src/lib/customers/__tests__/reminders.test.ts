/**
 * Reminders (issue #11, ../reminders.ts): 10 o'clock in the business's own
 * zone, one request per local date; tomorrow's confirmed bookings and
 * meetings with customers, each customer texted once from the business's
 * number in Native Intelligence's words; never a STOP, an unsubscribed tag, a lead nobody
 * vouched for, a number abroad, a booking's own calendar event, or the same
 * booking twice; nothing at night, a day late, paused, off, or without a
 * number; and one line to the owner, which finds them only on the first day.
 * Over the real store on an in-memory database; the business is made up.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { CalendarEvent } from '@/lib/integrations/calendar'
import { routeOf } from '@/lib/reach/route-policy'
import { bookingDb, seedBookings, type CustomerBookingSeed } from '@/test/booking-db'
import { textBookingCustomer } from '../booking'
import { ensureCustomerGuest } from '../customer-guests'
import { CUSTOMER_REMINDER_MESSAGE_KIND, CUSTOMER_REMINDER_ROUTES_KEY } from '../reminder-message'
import {
  MEETING_ATTENDEES_MAX,
  REMINDERS_EVENT,
  findReminderBusinesses,
  meetingGuests,
  planReminders,
  reminderText,
  remindersSentReport,
  reportToOwner,
  sendDayReminders,
  type RemindersDeps,
} from '../reminders'

const WS = 'ws-brightside'
const OWNER = 'user-owner'
const CHICAGO = 'America/Chicago'
// Nov 4, 10:00 AM in Chicago (CST, UTC-6): tomorrow, Nov 5, runs 06:00Z to 06:00Z.
const NOW = Date.parse('2026-11-04T16:00:00Z')
const DANA = '+13125550142'
const SAM = '+13125550199'
const KIM = '+13125550188'
const LEE = '+13125550123'
const GONE = '+13125550144'

type Row = Record<string, unknown>
let tables: Record<string, Row[]>
let db: SupabaseClient

const booking = (over: Row): Row => ({
  id: crypto.randomUUID(), workspace_id: WS, owner_user_id: OWNER, quote_id: null, contact_id: null, guest_id: null, source: 'owner', kind: 'visit',
  customer_name: 'Someone', customer_phone: null, address: null, note: null, state: 'confirmed', approval_id: null, calendar_event_id: null,
  customer_confirmed_at: null, created_at: '2026-11-01T12:00:00Z', ...over,
})

const contact = (over: Row): Row => ({ id: crypto.randomUUID(), workspace_id: WS, merged_into_contact_id: null, secondary_emails: [], tags: [], relationship_type: 'contact', ...over })

const event = (over: Partial<CalendarEvent>): CalendarEvent => ({
  id: `evt-${Math.random().toString(36).slice(2)}`,
  title: 'Estimate',
  start: '2026-11-05T19:30:00.000Z',
  end: '2026-11-05T20:00:00.000Z',
  accountEmail: 'owner@brightside.test',
  attendeeDetails: [{ email: 'owner@brightside.test', isOrganizer: true, responseStatus: 'accepted' }],
  ...over,
})

const who = (email: string) => ({ email, responseStatus: 'needsAction' })

// The customer bookings, as migration 458 named them: meeting_booking rows (with their claims) since 581.
const BOOKINGS = [
  booking({ id: 'b-dana', starts_at: '2026-11-05T15:00:00.000Z', ends_at: '2026-11-05T16:30:00.000Z', customer_name: 'Dana Ruiz', customer_phone: DANA, address: '400 Lake St, Oak Park', calendar_event_id: 'evt-dana' }),
  booking({ id: 'b-sam', starts_at: '2026-11-05T20:30:00.000Z', ends_at: '2026-11-05T22:00:00.000Z', customer_name: 'Sam Ortiz', customer_phone: SAM, contact_id: 'c-sam' }),
  booking({ starts_at: '2026-11-05T17:00:00.000Z', ends_at: '2026-11-05T18:30:00.000Z', customer_name: 'Still Waiting', customer_phone: '+13125550111', state: 'requested' }),
  booking({ starts_at: '2026-11-05T18:00:00.000Z', ends_at: '2026-11-05T19:00:00.000Z', customer_name: 'No Phone' }),
  booking({ starts_at: '2026-11-04T20:00:00.000Z', ends_at: '2026-11-04T21:00:00.000Z', customer_name: 'Today', customer_phone: '+13125550122' }),
  booking({ starts_at: '2026-11-06T15:00:00.000Z', ends_at: '2026-11-06T16:00:00.000Z', customer_name: 'Day After', customer_phone: '+13125550133' }),
  booking({ starts_at: '2026-11-05T19:00:00.000Z', ends_at: '2026-11-05T19:30:00.000Z', customer_name: 'Abroad', customer_phone: '+447700900123' }),
  booking({ starts_at: '2026-11-05T21:30:00.000Z', ends_at: '2026-11-05T22:30:00.000Z', customer_name: 'Said Stop', customer_phone: GONE }),
  booking({ workspace_id: 'ws-other', starts_at: '2026-11-05T16:00:00.000Z', ends_at: '2026-11-05T17:00:00.000Z', customer_name: 'Other Business', customer_phone: '+13125550155' }),
] as CustomerBookingSeed[]

beforeEach(async () => {
  tables = {
    business_profile: [{ workspace_id: WS, owner_user_id: OWNER, business_name: 'Brightside Window Washing', customer_facts: null, time_zone: CHICAGO, booking_days: [1, 2, 3, 4, 5], booking_start: '08:00', booking_end: '17:00', slot_minutes: 90, lead_hours: 12, horizon_days: 21, booking_kind: 'visit', booking_slug: null, reminders: true }],
    business_phone_number: [{ id: 'bn-1', workspace_id: WS, owner_user_id: OWNER, phone_e164: '+13125550100', twilio_sid: 'PN1', state: 'active' }],
    workspace: [{ id: WS, name: 'Brightside HQ', settings: {} }],
    member: [{ workspace_id: WS, user_id: OWNER, role: 'owner' }],
    user_profiles: [],
    contact: [
      contact({ id: 'c-sam', full_name: 'Sam Ortiz', phone: SAM, tags: ['Unsubscribed SMS'], relationship_type: 'customer' }),
      contact({ id: 'c-lee', full_name: 'Lee Chan', email: 'lee@example.com', phone: '(312) 555-0123', relationship_type: 'customer' }),
      contact({ id: 'c-kim', full_name: 'Kim Park', email: 'kim@example.com', phone: KIM, relationship_type: 'lead' }),
      contact({ id: 'c-pat', full_name: 'Pat Doe', email: 'pat@example.com', phone: '+13125550177', relationship_type: 'lead' }),
      contact({ id: 'c-dana', full_name: 'Dana Ruiz', email: 'dana@example.com', phone: DANA, relationship_type: 'customer' }),
      contact({ id: 'c-ana', full_name: 'Ana Silva', email: 'ana@example.com', phone: '+13125550166', relationship_type: 'customer', tags: ['unsubscribed sms'] }),
    ],
    customer_reminder: [],
    agent_guest: [],
  }
  seedBookings(tables, BOOKINGS)
  db = bookingDb(tables, {
    customer_reminder: (a, b) => a.workspace_id === b.workspace_id && a.subject_type === b.subject_type && a.subject_id === b.subject_id && a.phone_e164 === b.phone_e164,
  })
  // Kim texted the business's number once: a customer, though the CRM still calls her a lead.
  await ensureCustomerGuest(db, { number: { id: 'bn-1', workspaceId: WS, ownerUserId: OWNER, phone: '+13125550100', twilioSid: 'PN1' }, phone: KIM, contact: { id: 'c-kim', fullName: 'Kim Park' } })
})

const EVENTS: CalendarEvent[] = [
  // The booking's own event: reminded as the booking.
  event({ id: 'evt-dana', start: '2026-11-05T15:00:00.000Z', end: '2026-11-05T16:30:00.000Z', attendeeDetails: [] }),
  event({ id: 'evt-kim', attendeeDetails: [{ email: 'owner@brightside.test', isOrganizer: true }, who('Kim@Example.com')] }),
  event({ id: 'evt-lee', start: '2026-11-05T22:00:00.000Z', end: '2026-11-05T23:00:00.000Z', location: 'Lee’s office, https://maps.example.com/x', attendeeDetails: [who('lee@example.com')] }),
  // A lead nobody vouched for (never texted the business, not marked a customer).
  event({ id: 'evt-pat', attendeeDetails: [who('pat@example.com')] }),
  // Too many people: not a meeting with a customer.
  event({ id: 'evt-big', attendeeDetails: Array.from({ length: MEETING_ATTENDEES_MAX + 1 }, (_, i) => who(i === 0 ? 'lee@example.com' : `p${i}@example.com`)) }),
  event({ id: 'evt-declined', myResponse: 'declined', attendeeDetails: [who('lee@example.com')] }),
  event({ id: 'evt-allday', isAllDay: true, start: '2026-11-05T06:00:00.000Z', end: '2026-11-06T06:00:00.000Z', attendeeDetails: [who('lee@example.com')] }),
  event({ id: 'evt-they-declined', attendeeDetails: [{ email: 'lee@example.com', responseStatus: 'declined' }] }),
  // Dana at her booking's time again: the booking's reminder covers it.
  event({ id: 'evt-dana-twice', start: '2026-11-05T15:00:00.000Z', end: '2026-11-05T16:00:00.000Z', attendeeDetails: [who('dana@example.com')] }),
  event({ id: 'evt-ana', attendeeDetails: [who('ana@example.com')] }),
  event({ id: 'evt-tomorrow-night', start: '2026-11-06T07:00:00.000Z', end: '2026-11-06T08:00:00.000Z', attendeeDetails: [who('lee@example.com')] }),
]

function deps(over: Partial<RemindersDeps> = {}) {
  const texts: Array<{ to: string; body: string; guestId: string | null }> = []
  const append = vi.fn(async (_db: unknown, args: { messageId: string; parts: unknown[]; metadata?: Record<string, unknown> }) => ({ written: true as const, conversationId: '11111111-1111-4111-8111-111111111111', args }))
  const route = vi.fn(async () => {})
  const d: RemindersDeps = {
    now: () => NOW,
    paused: async () => false,
    listEvents: vi.fn(async () => EVENTS),
    optedOut: async (phone) => phone === GONE,
    text: vi.fn(async (to, body) => {
      texts.push({ to: to.customerPhone, body, guestId: to.guestId })
      return true
    }),
    append: append as never,
    route,
    ...over,
  }
  return { d, texts, append, route }
}

describe("10 o'clock in the business's own zone", () => {
  it('one request per business from 10 in its own zone, dated by its own day; each later hour until 8 pm asks again under the same id', () => {
    const plan = (iso: string, timeZone: string) => planReminders([{ workspaceId: 'ws-1', ownerUserId: 'u', timeZone }], Date.parse(iso)).map((r) => r.id)
    const request = (date: string) => [`customer-reminders:ws-1:${date}`]
    expect(planReminders([{ workspaceId: 'ws-1', ownerUserId: 'u', timeZone: CHICAGO }], NOW)).toEqual([{ id: 'customer-reminders:ws-1:2026-11-04', name: REMINDERS_EVENT, data: { workspaceId: 'ws-1', localDate: '2026-11-04' } }])
    // 21:00Z on Nov 3 is 10:00 on Nov 4 in Auckland (NZDT, UTC+13): its own date, not UTC's.
    expect(plan('2026-11-03T21:00:00Z', 'Pacific/Auckland')).toEqual(request('2026-11-04'))
    // A catch-up at 7 PM in Chicago (a missed pass): the same request, so Inngest keeps one.
    expect(plan('2026-11-05T01:00:00Z', CHICAGO)).toEqual(request('2026-11-04'))
    // Before 10, and from 8 PM on: nothing.
    expect(plan('2026-11-04T15:00:00Z', CHICAGO)).toEqual([])
    expect(plan('2026-11-05T02:00:00Z', CHICAGO)).toEqual([])
    expect(plan('2026-11-04T16:00:00Z', 'Not/AZone')).toEqual([])
  })

  it('only businesses with reminders on and a live number', async () => {
    tables.business_profile.push(
      { ...tables.business_profile[0], workspace_id: 'ws-off', reminders: false },
      { ...tables.business_profile[0], workspace_id: 'ws-no-number' },
    )
    tables.business_phone_number.push({ id: 'bn-2', workspace_id: 'ws-off', owner_user_id: OWNER, phone_e164: '+13125550101', state: 'active' })
    tables.business_phone_number.push({ id: 'bn-3', workspace_id: 'ws-no-number', owner_user_id: OWNER, phone_e164: '+13125550102', state: 'released' })
    expect(await findReminderBusinesses(db)).toEqual([{ workspaceId: WS, ownerUserId: OWNER, timeZone: CHICAGO }])
  })
})

describe("the customer's text", () => {
  it("names the business, what, when and where, how to confirm or move, and the opt-out; a place's links never ride along", () => {
    expect(reminderText({ business: 'Brightside Window Washing', kind: 'visit', startsAt: '2026-11-05T15:00:00.000Z', timeZone: CHICAGO, place: '400 Lake St, Oak Park' })).toBe(
      'Brightside Window Washing: a reminder that your visit is tomorrow (Thu, Nov 5) at 9:00 AM, 400 Lake St, Oak Park. Reply YES to confirm, or tell us a better time. Reply STOP to opt out.',
    )
    expect(reminderText({ business: 'Brightside', kind: 'meeting', startsAt: '2026-11-05T22:00:00.000Z', timeZone: CHICAGO, place: 'https://meet.example.com/abc' })).toBe(
      'Brightside: a reminder that your meeting is tomorrow (Thu, Nov 5) at 4:00 PM. Reply YES to confirm, or tell us a better time. Reply STOP to opt out.',
    )
  })

  it('a meeting counts only its outside guests: never the calendar’s own account, nor one who declined', () => {
    expect(meetingGuests(event({ attendeeDetails: [{ email: 'Owner@Brightside.test' }, who('a@example.com'), { email: 'b@example.com', responseStatus: 'declined' }, who('a@example.com'), who('odd,one@example.com')] }))).toEqual(['a@example.com'])
    // Only bare addresses (attendees, no details) still count.
    expect(meetingGuests(event({ attendeeDetails: undefined, attendees: ['owner@brightside.test', 'c@example.com'] }))).toEqual(['c@example.com'])
  })
})

describe("one business's day", () => {
  it("texts tomorrow's confirmed bookings and meetings with customers, once each, from the business's number, and tells the owner where they are the first time", async () => {
    const { d, texts, append, route } = deps()
    const out = await sendDayReminders(db, { workspaceId: WS, localDate: '2026-11-04' }, d)
    expect(out).toEqual({ outcome: 'done', sent: 3, skipped: 2, failed: 0, reported: true })
    expect(texts.map((t) => t.to)).toEqual([DANA, KIM, LEE])
    expect(texts[0].body).toBe('Brightside Window Washing: a reminder that your visit is tomorrow (Thu, Nov 5) at 9:00 AM, 400 Lake St, Oak Park. Reply YES to confirm, or tell us a better time. Reply STOP to opt out.')
    expect(texts[2].body).toBe('Brightside Window Washing: a reminder that your meeting is tomorrow (Thu, Nov 5) at 4:00 PM, Lee’s office. Reply YES to confirm, or tell us a better time. Reply STOP to opt out.')
    // Kim's texts land in her customer thread's log.
    expect(texts[1].guestId).toBe((tables.agent_guest[0] as { id: string }).id)
    expect(tables.customer_reminder.map((r) => [r.subject_type, r.subject_id, r.phone_e164, r.status, r.kind])).toEqual([
      ['booking', 'b-dana', DANA, 'sent', 'visit'],
      ['meeting', 'evt-kim', KIM, 'sent', 'meeting'],
      ['meeting', 'evt-lee', LEE, 'sent', 'meeting'],
    ])
    expect(append).toHaveBeenCalledTimes(1)
    const report = append.mock.calls[0][1]
    expect(report.messageId).toBe('customer-reminders:ws-brightside:2026-11-04')
    expect(report.metadata).toEqual({ kind: CUSTOMER_REMINDER_MESSAGE_KIND, [CUSTOMER_REMINDER_ROUTES_KEY]: true })
    expect((report.parts[0] as { text: string }).text).toBe(
      "I texted 3 reminders for tomorrow: Dana Ruiz (visit, 9:00 AM), Kim Park (meeting, 1:30 PM) and Lee Chan (meeting, 4:00 PM). I'll tell you if anyone moves or says STOP. This is new: the day before each booked job or meeting with a customer, your business number texts them a reminder they can confirm or move to another open time. Tell me to turn reminders off if you’d rather not.",
    )
    expect(route).toHaveBeenCalledWith({ userId: OWNER, workspaceId: WS, conversationId: '11111111-1111-4111-8111-111111111111' }, 'customer-reminders:ws-brightside:2026-11-04')
  })

  it('never twice for one booking: a second run (a retry, a second request) texts no one, and its report is the same message', async () => {
    const first = deps()
    await sendDayReminders(db, { workspaceId: WS, localDate: '2026-11-04' }, first.d)
    const again = deps()
    expect(await sendDayReminders(db, { workspaceId: WS, localDate: '2026-11-04' }, again.d)).toMatchObject({ outcome: 'done', sent: 0, skipped: 5, failed: 0 })
    expect(again.texts).toEqual([])
    expect(tables.customer_reminder).toHaveLength(3)
    // The same message id: the home thread's unique index keeps it to one.
    expect(again.append.mock.calls[0][1].messageId).toBe(first.append.mock.calls[0][1].messageId)
  })

  it('a run cut short after its texts still tells the owner on its retry, as the first day', async () => {
    const cut = deps({ append: vi.fn(async () => Promise.reject(new Error('timed out'))) as never })
    expect(await sendDayReminders(db, { workspaceId: WS, localDate: '2026-11-04' }, cut.d)).toMatchObject({ sent: 3, reported: false })
    const retry = deps()
    expect(await sendDayReminders(db, { workspaceId: WS, localDate: '2026-11-04' }, retry.d)).toMatchObject({ sent: 0, reported: true })
    expect(retry.texts).toEqual([])
    const text = (retry.append.mock.calls[0][1].parts[0] as { text: string }).text
    expect(text).toMatch(/^I texted 3 reminders for tomorrow: Dana Ruiz \(visit, 9:00 AM\), Kim Park \(meeting, 1:30 PM\) and Lee Chan \(meeting, 4:00 PM\)\./)
    expect(text).toContain('This is new')
    expect(retry.route).toHaveBeenCalledTimes(1)
  })

  it('a number that said STOP (the SMS ledger itself) is never texted', async () => {
    tables.sms_message = [{ phone_e164: DANA, direction: 'in', kind: 'stop', created_at: '2026-10-01T12:00:00Z' }]
    const { d, texts } = deps({ optedOut: undefined })
    await sendDayReminders(db, { workspaceId: WS, localDate: '2026-11-04' }, d)
    expect(texts.map((t) => t.to)).not.toContain(DANA)
    expect(texts.map((t) => t.to)).toContain(KIM)
    expect(tables.customer_reminder.some((r) => r.phone_e164 === DANA)).toBe(false)
  })

  it('tomorrow is the business’s own day, across the fall-back change (a 25-hour day)', async () => {
    // Sat Oct 31, 10:00 AM in Chicago (CDT); Sun Nov 1 runs 05:00Z to Nov 2 06:00Z.
    seedBookings(tables, [
      { ...BOOKINGS[0], id: 'b-late', starts_at: '2026-11-02T05:30:00.000Z', ends_at: '2026-11-02T06:00:00.000Z', customer_name: 'Late Sunday', customer_phone: '+13125550135', calendar_event_id: null },
      { ...BOOKINGS[0], id: 'b-monday', starts_at: '2026-11-02T06:30:00.000Z', ends_at: '2026-11-02T07:00:00.000Z', customer_name: 'Early Monday', customer_phone: '+13125550136', calendar_event_id: null },
      { ...BOOKINGS[0], id: 'b-sat', starts_at: '2026-11-01T04:30:00.000Z', ends_at: '2026-11-01T05:00:00.000Z', customer_name: 'Saturday Night', customer_phone: '+13125550137', calendar_event_id: null },
    ])
    const { d, texts } = deps({ now: () => Date.parse('2026-10-31T15:00:00Z'), listEvents: vi.fn(async () => []) })
    await sendDayReminders(db, { workspaceId: WS, localDate: '2026-10-31' }, d)
    expect(texts.map((t) => t.to)).toEqual(['+13125550135'])
    expect(texts[0].body).toContain('tomorrow (Sun, Nov 1) at 11:30 PM')
  })

  it('after the first day the owner’s line stays in their thread', async () => {
    tables.customer_reminder.push({ id: 'old', workspace_id: WS, subject_type: 'booking', subject_id: 'b-old', phone_e164: DANA, status: 'sent', starts_at: '2026-11-02T15:00:00.000Z' })
    const { d, append, route } = deps()
    await sendDayReminders(db, { workspaceId: WS, localDate: '2026-11-04' }, d)
    expect(append.mock.calls[0][1].metadata).toEqual({ kind: CUSTOMER_REMINDER_MESSAGE_KIND, [CUSTOMER_REMINDER_ROUTES_KEY]: false })
    expect((append.mock.calls[0][1].parts[0] as { text: string }).text).not.toContain('This is new')
    expect(route).not.toHaveBeenCalled()
  })

  it('a text that fails is marked failed and never retried; the others still go', async () => {
    const { d } = deps({ text: vi.fn(async (to) => to.customerPhone !== KIM) })
    expect(await sendDayReminders(db, { workspaceId: WS, localDate: '2026-11-04' }, d)).toMatchObject({ sent: 2, failed: 1 })
    expect(tables.customer_reminder.find((r) => r.phone_e164 === KIM)?.status).toBe('failed')
    const again = deps()
    await sendDayReminders(db, { workspaceId: WS, localDate: '2026-11-04' }, again.d)
    expect(again.texts).toEqual([])
  })

  it('a calendar that cannot be read still sends the bookings’ reminders', async () => {
    const { d, texts } = deps({ listEvents: vi.fn(async () => Promise.reject(new Error('token expired'))) })
    expect(await sendDayReminders(db, { workspaceId: WS, localDate: '2026-11-04' }, d)).toMatchObject({ outcome: 'done', sent: 1 })
    expect(texts.map((t) => t.to)).toEqual([DANA])
  })

  it('nothing at all: reminders off, no live number, the owner gone, the agent paused', async () => {
    const run = async (mutate: () => void, over: Partial<RemindersDeps> = {}) => {
      const { d, texts } = deps(over)
      mutate()
      const out = await sendDayReminders(db, { workspaceId: WS, localDate: '2026-11-04' }, d)
      expect(texts).toEqual([])
      return out.outcome
    }
    expect(await run(() => (tables.business_profile[0].reminders = false))).toBe('off')
    tables.business_profile[0].reminders = true
    expect(await run(() => (tables.business_phone_number[0].state = 'released'))).toBe('no_number')
    tables.business_phone_number[0].state = 'active'
    expect(await run(() => (tables.member[0].role = 'member'))).toBe('owner_gone')
    tables.member[0].role = 'owner'
    expect(await run(() => {}, { paused: async () => true })).toBe('paused')
    expect(tables.customer_reminder).toEqual([])
  })

  it('never at night, and never a day late: a retry that lands outside 9 am to 8 pm, or on the next local day, reminds no one', async () => {
    const at = async (iso: string, localDate = '2026-11-04') => {
      const { d, texts } = deps({ now: () => Date.parse(iso) })
      const out = await sendDayReminders(db, { workspaceId: WS, localDate }, d)
      expect(texts).toEqual([])
      return out.outcome
    }
    expect(await at('2026-11-05T02:30:00Z')).toBe('quiet') // 8:30 PM in Chicago
    expect(await at('2026-11-04T14:30:00Z')).toBe('quiet') // 8:30 AM
    expect(await at('2026-11-05T16:00:00Z')).toBe('quiet') // the next day, 10 AM
    expect(await at('2026-11-04T16:00:00Z', 'not-a-date')).toBe('bad_date')
  })
})

describe("the owner's report", () => {
  it('one or two names read as a sentence', () => {
    expect(remindersSentReport({ sent: [{ name: 'Dana Ruiz', kind: 'visit', startsAt: '2026-11-05T15:00:00.000Z' }], timeZone: CHICAGO, first: false })).toBe(
      "I texted a reminder for tomorrow: Dana Ruiz (visit, 9:00 AM). I'll tell you if anyone moves or says STOP.",
    )
  })

  it('a report that routes reaches the owner through the router; one that does not only sits in the thread; the router reads the flag', async () => {
    const append = vi.fn(async () => ({ written: true as const, conversationId: '22222222-2222-4222-8222-222222222222' }))
    const route = vi.fn(async () => {})
    expect(await reportToOwner(db, { workspaceId: WS, userId: OWNER, messageId: 'm-1', text: 'Dana moved.', routes: true }, { append: append as never, route })).toBe(true)
    expect(await reportToOwner(db, { workspaceId: WS, userId: OWNER, messageId: 'm-2', text: 'Dana confirmed.', routes: false }, { append: append as never, route })).toBe(true)
    expect(route).toHaveBeenCalledTimes(1)
    const row = (text: string, routes: boolean) => ({ id: 'row-1', created_at: '2026-11-04T16:00:00Z', ui_message: { id: 'm', parts: [{ type: 'text', text }], metadata: { kind: CUSTOMER_REMINDER_MESSAGE_KIND, [CUSTOMER_REMINDER_ROUTES_KEY]: routes } } })
    expect(routeOf(row('Dana moved her visit.', true), OWNER)).toEqual({
      routes: true,
      kind: 'customer_reminder',
      ref: { type: 'home_message', id: 'row-1' },
      text: 'Dana moved her visit.',
      textable: true,
      notifies: false,
      approvalIds: [],
      urgentBy: null,
    })
    expect(routeOf(row('Dana confirmed.', false), OWNER)).toEqual({ routes: false })
    expect(routeOf(row('   ', true), OWNER)).toEqual({ routes: false })
  })

  it('a write that fails is reported, never thrown', async () => {
    const append = vi.fn(async () => Promise.reject(new Error('down')))
    expect(await reportToOwner(db, { workspaceId: WS, userId: OWNER, messageId: 'm-3', text: 'x', routes: true }, { append: append as never })).toBe(false)
  })
})

describe('the ledger', () => {
  it("a reminder is logged as a notice even to a customer with a row: never the global auto-reply cap's kinds", async () => {
    tables.sms_message = []
    const send = vi.fn(async () => ({ ok: true as const, sid: 'SM-r1' }))
    const guestId = (tables.agent_guest[0] as { id: string }).id
    expect(await textBookingCustomer(db, { workspaceId: WS, customerPhone: KIM, guestId }, 'Reminder.', { send: send as never, kind: 'notice' })).toBe(true)
    expect(send).toHaveBeenCalledWith(KIM, 'Reminder.', { from: '+13125550100' })
    expect(tables.sms_message.map((r) => [r.kind, r.guest_id])).toEqual([['notice', guestId]])
  })
})
