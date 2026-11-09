/**
 * The owner moves or cancels a customer's booking (issue #11's follow-up,
 * ../booking-changes.ts): the booking and its calendar event move (or the
 * event is deleted), the customer's reminder follows, the customer is texted
 * in fixed words, and the owner reads what happened. Nothing else may be on
 * the owner's calendar or booked at the new time; their booking hours don't
 * bind them. Owners and admins only; a requested booking is their card to
 * answer. Over the real store and slot check on an in-memory database; the
 * business is made up.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { memoryDb } from '@/test/memory-db'
import { bookingCancelledText, bookingMovedText, ownerCancelBooking, ownerMoveBooking, type BookingChangeDeps } from '../booking-changes'
import { customerRecordSection } from '../customer-spec'
import { confirmAppointment, remindersStopped } from '../reminder-replies'
import { openRemindersForPhone } from '../reminder-store'
import { getBooking } from '../store'

const WS = 'ws-brightside'
const OWNER = 'user-owner'
const ADMIN = 'user-admin'
const SAM = 'user-sam'
const CHICAGO = 'America/Chicago'
const NOW = Date.parse('2026-11-04T18:00:00Z') // Wed, Nov 4, noon in Chicago
const DANA = '+13125550142'
const B_DANA = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const R_DANA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
// Dana's visit: Thu, Nov 5, 9:00 to 10:30 AM in Chicago, on the owner's calendar as evt-dana.
const ownEvent = { id: 'evt-dana', title: 'Visit: Dana Ruiz', start: '2026-11-05T15:00:00.000Z', end: '2026-11-05T16:30:00.000Z' }

type Row = Record<string, unknown>
let tables: Record<string, Row[]>
let db: SupabaseClient

beforeEach(() => {
  tables = {
    member: [
      { id: 'm-owner', workspace_id: WS, user_id: OWNER, role: 'owner' },
      { id: 'm-admin', workspace_id: WS, user_id: ADMIN, role: 'admin' },
      { id: 'm-sam', workspace_id: WS, user_id: SAM, role: 'member' },
    ],
    business_profile: [
      { workspace_id: WS, owner_user_id: OWNER, business_name: 'Brightside', customer_facts: null, time_zone: CHICAGO, booking_days: [1, 2, 3, 4, 5], booking_start: '08:00', booking_end: '17:00', slot_minutes: 60, lead_hours: 12, horizon_days: 21, booking_kind: 'visit', booking_slug: null, reminders: true },
    ],
    customer_booking: [
      {
        id: B_DANA, workspace_id: WS, owner_user_id: OWNER, quote_id: null, contact_id: null, guest_id: null, source: 'sms', kind: 'visit',
        starts_at: '2026-11-05T15:00:00.000Z', ends_at: '2026-11-05T16:30:00.000Z', customer_name: 'Dana Ruiz', customer_phone: DANA,
        address: '400 Lake St', note: null, state: 'confirmed', approval_id: null, calendar_event_id: 'evt-dana', customer_confirmed_at: '2026-11-04T16:30:00.000Z', created_at: '2026-11-01T12:00:00Z',
      },
    ],
    customer_reminder: [
      {
        id: R_DANA, workspace_id: WS, owner_user_id: OWNER, subject_type: 'booking', subject_id: B_DANA, contact_id: null, phone_e164: DANA, customer_name: 'Dana Ruiz', kind: 'visit',
        starts_at: '2026-11-05T15:00:00.000Z', ends_at: '2026-11-05T16:30:00.000Z', status: 'sent', answer: 'confirmed', answered_at: '2026-11-04T16:30:00.000Z', moved_to: null,
        sent_at: '2026-11-04T16:00:00.000Z', created_at: '2026-11-04T16:00:00.000Z',
      },
    ],
  }
  db = memoryDb(tables, {
    customer_booking: (a, b) => a.workspace_id === b.workspace_id && a.starts_at === b.starts_at && ['requested', 'confirmed'].includes(a.state as string) && ['requested', 'confirmed'].includes(b.state as string),
  })
})

function deps(over: Partial<BookingChangeDeps> = {}) {
  const texts: Array<{ to: string | null; body: string }> = []
  const d: BookingChangeDeps = {
    now: () => NOW,
    timeZone: async () => CHICAGO,
    listEvents: vi.fn(async () => [ownEvent]) as never,
    moveEvent: vi.fn(async () => ({})),
    deleteEvent: vi.fn(async () => {}),
    textCustomer: vi.fn(async (booking, body) => (texts.push({ to: booking.customerPhone, body }), true)),
    ...over,
  }
  return { d, texts }
}

const move = (start: string, d: BookingChangeDeps, over: Partial<{ userId: string; bookingId: string; tellCustomer: boolean }> = {}) =>
  ownerMoveBooking(db, { userId: OWNER, workspaceId: WS, bookingId: B_DANA, start, tellCustomer: true, ...over }, d)
const cancel = (d: BookingChangeDeps, over: Partial<{ userId: string; bookingId: string; tellCustomer: boolean }> = {}) =>
  ownerCancelBooking(db, { userId: OWNER, workspaceId: WS, bookingId: B_DANA, tellCustomer: true, ...over }, d)

describe('move_booking', () => {
  it("moves the booking and its calendar event to the owner's local time, the same length; the customer is texted the new time and asked again", async () => {
    const { d, texts } = deps()
    const out = await move('2026-11-06T13:00', d)
    expect(out).toEqual({
      success: true,
      status: 'moved',
      booking_id: B_DANA,
      from: 'Thu, Nov 5, 9:00 AM',
      when: 'Fri, Nov 6, 1:00 PM',
      calendar: 'moved',
      customer_texted: true,
      message: "Moved Dana Ruiz's visit to Fri, Nov 6, 1:00 PM. It's moved on your calendar too. Dana Ruiz got a text with the new time.",
    })
    const slot = { start: '2026-11-06T19:00:00.000Z', end: '2026-11-06T20:30:00.000Z' }
    expect(d.moveEvent).toHaveBeenCalledWith(OWNER, 'evt-dana', slot)
    const moved = await getBooking(db, WS, B_DANA)
    // Their yes was to the old time: it is cleared.
    expect(moved).toMatchObject({ startsAt: slot.start, endsAt: slot.end, state: 'confirmed', customerConfirmedAt: null })
    expect(texts).toEqual([{ to: DANA, body: 'Brightside: your visit has moved to Fri, Nov 6, 1:00 PM at 400 Lake St. Reply here if that time doesn\'t work.' }])
    // The reminder follows it, its answer about the old time cleared, so their agent asks again.
    expect(tables.customer_reminder[0]).toMatchObject({ moved_to: slot.start, answer: null, answered_at: null })
    const open = await openRemindersForPhone(db, WS, DANA, NOW)
    expect(customerRecordSection('Dana Ruiz', [], [moved!], CHICAGO, open)).toBe(
      [
        "## Dana Ruiz's quotes and bookings",
        '- Visit booked: Fri, Nov 6, 1:00 PM.',
        `- We texted them a reminder for their visit on Fri, Nov 6, 1:00 PM: they haven't answered. [reminder ${R_DANA}]`,
      ].join('\n'),
    )
  })

  it("the booking's own time and event never block it (an hour later), and the booking hours don't bind the owner (a Saturday)", async () => {
    const later = deps()
    expect(await move('2026-11-05T10:00', later.d)).toMatchObject({ success: true, when: 'Thu, Nov 5, 10:00 AM' })
    expect(later.d.moveEvent).toHaveBeenCalledWith(OWNER, 'evt-dana', { start: '2026-11-05T16:00:00.000Z', end: '2026-11-05T17:30:00.000Z' })
    const saturday = deps({ listEvents: vi.fn(async () => [{ ...ownEvent, start: '2026-11-05T16:00:00.000Z', end: '2026-11-05T17:30:00.000Z' }]) as never })
    expect(await move('2026-11-07T07:00', saturday.d)).toMatchObject({ success: true, when: 'Sat, Nov 7, 7:00 AM' })
  })

  it("another booking or anything on the owner's calendar then is refused, and so is a calendar that can't be read: nothing changes", async () => {
    tables.customer_booking.push({ ...tables.customer_booking[0], id: 'other', customer_phone: '+13125550199', starts_at: '2026-11-06T19:30:00.000Z', ends_at: '2026-11-06T20:30:00.000Z', calendar_event_id: null })
    const booked = deps()
    expect(await move('2026-11-06T13:00', booked.d)).toMatchObject({ success: false, code: 'SLOT_TAKEN' })
    const busy = deps({ listEvents: vi.fn(async () => [ownEvent, { id: 'dentist', title: 'Dentist', start: '2026-11-06T15:00:00.000Z', end: '2026-11-06T16:00:00.000Z' }]) as never })
    expect(await move('2026-11-06T08:30', busy.d)).toMatchObject({ success: false, code: 'SLOT_TAKEN', error: expect.stringContaining('Fri, Nov 6, 8:30 AM') })
    const unreadable = deps({ listEvents: vi.fn(async () => Promise.reject(new Error('401'))) as never })
    expect(await move('2026-11-06T10:00', unreadable.d)).toMatchObject({ success: false, code: 'CALENDAR_UNAVAILABLE' })
    for (const { d, texts } of [booked, busy, unreadable]) {
      expect(d.moveEvent).not.toHaveBeenCalled()
      expect(texts).toEqual([])
    }
    expect(tables.customer_booking[0]).toMatchObject({ starts_at: '2026-11-05T15:00:00.000Z', customer_confirmed_at: '2026-11-04T16:30:00.000Z' })
    expect(tables.customer_reminder[0]).toMatchObject({ moved_to: null, answer: 'confirmed' })
  })

  it('a calendar that refuses puts the booking back, and nobody is texted', async () => {
    const { d, texts } = deps({ moveEvent: vi.fn(async () => Promise.reject(new Error('403'))) })
    expect(await move('2026-11-06T13:00', d)).toMatchObject({ success: false, code: 'CALENDAR_FAILED', error: expect.stringContaining('stays at Thu, Nov 5, 9:00 AM') })
    expect(await getBooking(db, WS, B_DANA)).toMatchObject({ startsAt: '2026-11-05T15:00:00.000Z', endsAt: '2026-11-05T16:30:00.000Z', customerConfirmedAt: '2026-11-04T16:30:00.000Z' })
    expect(texts).toEqual([])
    expect(tables.customer_reminder[0].moved_to).toBeNull()
  })

  it('a time that is past, or that never happens there (the clocks skip it), is refused; the same time changes nothing', async () => {
    const { d, texts } = deps()
    expect(await move('2026-11-04T11:00', d)).toMatchObject({ success: false, code: 'PAST' })
    expect(await move('2027-03-14T02:30', d)).toMatchObject({ success: false, code: 'BAD_START' })
    expect(await move('2026-11-05T09:00', d)).toMatchObject({ success: true, status: 'unchanged' })
    expect(d.moveEvent).not.toHaveBeenCalled()
    expect(texts).toEqual([])
  })

  it('tell_customer false texts nobody; a text that fails is said plainly', async () => {
    const quiet = deps()
    expect(await move('2026-11-06T13:00', quiet.d, { tellCustomer: false })).toMatchObject({ customer_texted: false, message: expect.stringContaining("Dana Ruiz wasn't texted.") })
    expect(quiet.texts).toEqual([])
    const failed = deps({ textCustomer: vi.fn(async () => false) })
    expect(await move('2026-11-06T14:30', failed.d)).toMatchObject({ success: true, customer_texted: false, message: expect.stringContaining("Dana Ruiz couldn't be texted: tell them yourself.") })
  })

  it("owners and admins only; another workspace's booking is not found; a request is the owner's card to answer", async () => {
    const { d } = deps()
    expect(await move('2026-11-06T13:00', d, { userId: SAM })).toMatchObject({ success: false, code: 'NOT_ALLOWED' })
    expect(await move('2026-11-06T13:00', d, { userId: 'user-stranger' })).toMatchObject({ success: false, code: 'NOT_A_MEMBER' })
    expect(await ownerMoveBooking(db, { userId: OWNER, workspaceId: 'ws-other', bookingId: B_DANA, start: '2026-11-06T13:00', tellCustomer: true }, d)).toMatchObject({ success: false })
    tables.member.push({ id: 'm-other', workspace_id: 'ws-other', user_id: OWNER, role: 'owner' })
    expect(await ownerMoveBooking(db, { userId: OWNER, workspaceId: 'ws-other', bookingId: B_DANA, start: '2026-11-06T13:00', tellCustomer: true }, d)).toMatchObject({ success: false, code: 'NOT_FOUND' })
    tables.customer_booking[0].state = 'requested'
    expect(await move('2026-11-06T13:00', d)).toMatchObject({ success: false, code: 'WAITING' })
    tables.customer_booking[0].state = 'cancelled'
    expect(await move('2026-11-06T13:00', d)).toMatchObject({ success: false, code: 'NOT_BOOKED' })
    expect(d.moveEvent).not.toHaveBeenCalled()
    tables.customer_booking[0].state = 'confirmed'
    expect(await move('2026-11-06T13:00', d, { userId: ADMIN })).toMatchObject({ success: true, status: 'moved' })
  })
})

describe('cancel_booking', () => {
  it('cancels it, deletes its calendar event and texts the customer; their reminder says so, a late yes is refused, and STOP no longer says it stands', async () => {
    const { d, texts } = deps()
    expect(await cancel(d)).toEqual({
      success: true,
      status: 'cancelled',
      booking_id: B_DANA,
      when: 'Thu, Nov 5, 9:00 AM',
      calendar: 'deleted',
      customer_texted: true,
      message: "Cancelled Dana Ruiz's visit on Thu, Nov 5, 9:00 AM. It's off your calendar too. Dana Ruiz got a text saying so.",
    })
    expect(d.deleteEvent).toHaveBeenCalledWith(OWNER, 'evt-dana')
    expect(tables.customer_booking[0].state).toBe('cancelled')
    expect(texts).toEqual([{ to: DANA, body: "Brightside: your visit on Thu, Nov 5, 9:00 AM is cancelled. Reply here if you'd like another time." }])
    expect(tables.customer_reminder[0]).toMatchObject({ answer: 'cancelled', answered_at: '2026-11-04T18:00:00.000Z' })
    const open = await openRemindersForPhone(db, WS, DANA, NOW)
    expect(customerRecordSection('Dana Ruiz', [], [], CHICAGO, open)).toContain(`the business cancelled it since. [reminder ${R_DANA}]`)
    const report = { now: () => NOW, timeZone: async () => CHICAGO, append: vi.fn(), route: vi.fn() }
    expect(await confirmAppointment(db, { workspaceId: WS, ownerUserId: OWNER, phone: DANA, reminderId: R_DANA }, report as never)).toMatchObject({ code: 'BOOKING_GONE' })
    expect(await remindersStopped(db, { workspaceId: WS, phone: DANA, businessName: 'Brightside' }, report as never)).toBe(0)
    expect(report.append).not.toHaveBeenCalled()
    expect(await cancel(d)).toMatchObject({ success: false, code: 'NOT_BOOKED' })
  })

  it("a calendar that won't delete leaves it cancelled and says so; tell_customer false texts nobody", async () => {
    const { d, texts } = deps({ deleteEvent: vi.fn(async () => Promise.reject(new Error('403'))) })
    expect(await cancel(d, { tellCustomer: false })).toMatchObject({
      success: true,
      calendar: 'stuck',
      customer_texted: false,
      message: "Cancelled Dana Ruiz's visit on Thu, Nov 5, 9:00 AM. Your calendar wouldn't delete its event: remove it yourself. Dana Ruiz wasn't texted.",
    })
    expect(tables.customer_booking[0].state).toBe('cancelled')
    expect(texts).toEqual([])
  })

  it("only a confirmed booking not yet started, by an owner or admin", async () => {
    const { d, texts } = deps()
    expect(await cancel(d, { userId: SAM })).toMatchObject({ success: false, code: 'NOT_ALLOWED' })
    tables.customer_booking[0].state = 'requested'
    expect(await cancel(d)).toMatchObject({ success: false, code: 'WAITING' })
    tables.customer_booking[0].state = 'confirmed'
    expect(await cancel({ ...d, now: () => Date.parse('2026-11-05T15:30:00Z') })).toMatchObject({ success: false, code: 'STARTED' })
    expect(tables.customer_booking[0].state).toBe('confirmed')
    expect(d.deleteEvent).not.toHaveBeenCalled()
    expect(texts).toEqual([])
    expect(await cancel(d, { userId: ADMIN })).toMatchObject({ success: true, status: 'cancelled' })
  })
})

describe("the customer's texts", () => {
  it('are fixed words: the business, the kind, the time, the address when there is one', () => {
    expect(bookingMovedText('Brightside', { kind: 'visit', address: null }, 'Fri, Nov 6, 1:00 PM')).toBe("Brightside: your visit has moved to Fri, Nov 6, 1:00 PM. Reply here if that time doesn't work.")
    expect(bookingCancelledText('Brightside', { kind: 'lesson' }, 'Fri, Nov 6, 1:00 PM')).toBe("Brightside: your lesson on Fri, Nov 6, 1:00 PM is cancelled. Reply here if you'd like another time.")
  })
})
