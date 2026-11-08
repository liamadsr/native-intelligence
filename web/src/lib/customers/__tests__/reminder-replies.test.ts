/**
 * A customer's answer to their reminder (issue #11, ../reminder-replies.ts),
 * through their own agent's tools (../customer-tools.ts): yes confirms (the
 * booking shows it; the owner's thread gets one quiet line), another open
 * time moves the booking and its calendar event (the owner is told where
 * they are), a calendar that refuses puts it back, a meeting is the owner's
 * to move, and STOP tells the owner once. Fenced to the business and to the
 * number the reminder went to. Over the real store on an in-memory database;
 * the business is made up.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { memoryDb } from '@/test/memory-db'
import type { AgentGuest } from '@/lib/guests/store'
import { customerRecordSection } from '../customer-spec'
import { customerToolCall } from '../customer-tools'
import { CUSTOMER_REMINDER_ROUTES_KEY } from '../reminder-message'
import { confirmAppointment, moveAppointment, remindersStopped, type ReminderReplyDeps } from '../reminder-replies'
import { openRemindersForPhone, toReminder } from '../reminder-store'
import { getBooking } from '../store'

const WS = 'ws-brightside'
const OWNER = 'user-owner'
const CHICAGO = 'America/Chicago'
const NOW = Date.parse('2026-11-04T18:00:00Z') // Nov 4, noon in Chicago
const DANA = '+13125550142'
const LEE = '+13125550123'
const R_DANA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const R_LEE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const B_DANA = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const NEW_SLOT = { start: '2026-11-06T16:00:00.000Z', end: '2026-11-06T17:30:00.000Z' }

type Row = Record<string, unknown>
let tables: Record<string, Row[]>
let db: SupabaseClient

const reminder = (over: Row): Row => ({
  workspace_id: WS, owner_user_id: OWNER, contact_id: null, kind: 'visit', status: 'sent', answer: null, answered_at: null, moved_to: null,
  sent_at: '2026-11-04T16:00:00.000Z', created_at: '2026-11-04T16:00:00.000Z', ...over,
})

beforeEach(() => {
  tables = {
    customer_booking: [
      {
        id: B_DANA, workspace_id: WS, owner_user_id: OWNER, quote_id: null, contact_id: null, guest_id: null, source: 'sms', kind: 'visit',
        starts_at: '2026-11-05T15:00:00.000Z', ends_at: '2026-11-05T16:30:00.000Z', customer_name: 'Dana Ruiz', customer_phone: DANA,
        address: '400 Lake St', note: null, state: 'confirmed', approval_id: null, calendar_event_id: 'evt-dana', customer_confirmed_at: null, created_at: '2026-11-01T12:00:00Z',
      },
    ],
    customer_reminder: [
      reminder({ id: R_DANA, subject_type: 'booking', subject_id: B_DANA, phone_e164: DANA, customer_name: 'Dana Ruiz', starts_at: '2026-11-05T15:00:00.000Z', ends_at: '2026-11-05T16:30:00.000Z' }),
      reminder({ id: R_LEE, subject_type: 'meeting', subject_id: 'evt-lee', phone_e164: LEE, customer_name: 'Lee Chan', kind: 'meeting', starts_at: '2026-11-05T22:00:00.000Z', ends_at: '2026-11-05T23:00:00.000Z' }),
    ],
  }
  db = memoryDb(tables, {
    customer_booking: (a, b) => a.workspace_id === b.workspace_id && a.starts_at === b.starts_at && ['requested', 'confirmed'].includes(a.state as string) && ['requested', 'confirmed'].includes(b.state as string),
  })
})

function deps(over: Partial<ReminderReplyDeps> = {}) {
  const append = vi.fn(async (_db: unknown, args: { messageId: string; parts: Array<{ text?: string }>; metadata?: Record<string, unknown> }) => ({ written: true as const, conversationId: '11111111-1111-4111-8111-111111111111', args }))
  const route = vi.fn(async () => {})
  const moveEvent = vi.fn(async () => ({}))
  const d: ReminderReplyDeps = {
    now: () => NOW,
    timeZone: async () => CHICAGO,
    openSlotAt: vi.fn(async () => ({ slot: NEW_SLOT, timeZone: CHICAGO, rules: {} as never })),
    moveEvent,
    append: append as never,
    route,
    ...over,
  }
  return { d, append, route, moveEvent }
}

const business = { workspaceId: WS, ownerUserId: OWNER }

describe('yes: confirm_appointment', () => {
  it("confirms the booking (it shows as confirmed), answers the reminder, and leaves the owner one quiet line; a second yes changes nothing", async () => {
    const { d, append, route } = deps()
    expect(await confirmAppointment(db, { ...business, phone: DANA, reminderId: R_DANA }, d)).toMatchObject({ success: true, status: 'confirmed' })
    expect((await getBooking(db, WS, B_DANA))?.customerConfirmedAt).toBe('2026-11-04T18:00:00.000Z')
    expect(tables.customer_reminder[0]).toMatchObject({ answer: 'confirmed', answered_at: '2026-11-04T18:00:00.000Z' })
    expect(append).toHaveBeenCalledTimes(1)
    expect(append.mock.calls[0][1]).toMatchObject({ messageId: `customer-reminder:${R_DANA}:confirmed`, parts: [{ type: 'text', text: 'Dana Ruiz confirmed their visit on Thu, Nov 5 at 9:00 AM.' }] })
    expect(append.mock.calls[0][1].metadata?.[CUSTOMER_REMINDER_ROUTES_KEY]).toBe(false)
    expect(route).not.toHaveBeenCalled()
    expect(await confirmAppointment(db, { ...business, phone: DANA, reminderId: R_DANA }, d)).toMatchObject({ success: true, status: 'already_confirmed' })
    expect(append).toHaveBeenCalledTimes(1)
  })

  it('a meeting is confirmed on its reminder alone', async () => {
    const { d, append } = deps()
    expect(await confirmAppointment(db, { ...business, phone: LEE, reminderId: R_LEE }, d)).toMatchObject({ success: true })
    expect(tables.customer_reminder[1].answer).toBe('confirmed')
    expect(append.mock.calls[0][1].parts[0].text).toBe('Lee Chan confirmed their meeting on Thu, Nov 5 at 4:00 PM.')
  })

  it("only the customer it went to, at this business, while it's ahead; a booking no longer on the calendar is the owner's", async () => {
    const { d } = deps()
    expect(await confirmAppointment(db, { ...business, phone: LEE, reminderId: R_DANA }, d)).toMatchObject({ success: false, code: 'NOT_FOUND' })
    expect(await confirmAppointment(db, { workspaceId: 'ws-other', ownerUserId: OWNER, phone: DANA, reminderId: R_DANA }, d)).toMatchObject({ code: 'NOT_FOUND' })
    expect(await confirmAppointment(db, { ...business, phone: DANA, reminderId: R_DANA }, { ...d, now: () => Date.parse('2026-11-05T16:00:00Z') })).toMatchObject({ code: 'NOT_FOUND' })
    tables.customer_booking[0].state = 'cancelled'
    expect(await confirmAppointment(db, { ...business, phone: DANA, reminderId: R_DANA }, d)).toMatchObject({ code: 'BOOKING_GONE' })
    expect(tables.customer_reminder[0].answer).toBeNull()
  })
})

describe('another time: move_appointment', () => {
  it('moves the booking and its calendar event to the open slot they picked, counts it confirmed, and tells the owner where they are', async () => {
    const { d, append, route, moveEvent } = deps()
    const out = await moveAppointment(db, { ...business, phone: DANA, reminderId: R_DANA, start: NEW_SLOT.start }, d)
    expect(out).toMatchObject({ success: true, status: 'moved', when: 'Fri, Nov 6, 10:00 AM' })
    expect(d.openSlotAt).toHaveBeenCalledWith(db, business, NEW_SLOT.start, expect.anything())
    expect(moveEvent).toHaveBeenCalledWith(OWNER, 'evt-dana', NEW_SLOT)
    const moved = await getBooking(db, WS, B_DANA)
    expect(moved).toMatchObject({ startsAt: NEW_SLOT.start, endsAt: NEW_SLOT.end, state: 'confirmed', customerConfirmedAt: '2026-11-04T18:00:00.000Z' })
    expect(tables.customer_reminder[0]).toMatchObject({ answer: 'moved', moved_to: NEW_SLOT.start })
    expect(append.mock.calls[0][1].parts[0].text).toBe("Dana Ruiz moved their visit from Thu, Nov 5 at 9:00 AM to Fri, Nov 6 at 10:00 AM. It's moved on your calendar too. Tell me if you want it back.")
    expect(append.mock.calls[0][1].metadata?.[CUSTOMER_REMINDER_ROUTES_KEY]).toBe(true)
    expect(route).toHaveBeenCalledTimes(1)
    // Their agent now sees it at the new time.
    const open = await openRemindersForPhone(db, WS, DANA, NOW)
    expect(customerRecordSection('Dana Ruiz', [], [moved!], CHICAGO, open)).toBe(
      [
        "## Dana Ruiz's quotes and bookings",
        '- Visit booked: Fri, Nov 6, 10:00 AM, and they confirmed it.',
        `- We texted them a reminder for their visit on Fri, Nov 6, 10:00 AM: they moved it to this time. [reminder ${R_DANA}]`,
      ].join('\n'),
    )
  })

  it("a time that isn't open, or one someone just took, changes nothing", async () => {
    const closed = deps({ openSlotAt: vi.fn(async () => ({ slot: null, timeZone: CHICAGO, rules: {} as never })) })
    expect(await moveAppointment(db, { ...business, phone: DANA, reminderId: R_DANA, start: NEW_SLOT.start }, closed.d)).toMatchObject({ success: false, code: 'SLOT_TAKEN' })
    tables.customer_booking.push({ ...tables.customer_booking[0], id: 'other', customer_phone: '+13125550199', starts_at: NEW_SLOT.start, ends_at: NEW_SLOT.end })
    const raced = deps()
    expect(await moveAppointment(db, { ...business, phone: DANA, reminderId: R_DANA, start: NEW_SLOT.start }, raced.d)).toMatchObject({ success: false, code: 'SLOT_TAKEN' })
    expect(raced.moveEvent).not.toHaveBeenCalled()
    expect(tables.customer_booking[0].starts_at).toBe('2026-11-05T15:00:00.000Z')
    expect(tables.customer_reminder[0].answer).toBeNull()
    expect(closed.append).not.toHaveBeenCalled()
  })

  it('a calendar that refuses puts the booking back where it was, and nobody is told it moved', async () => {
    const { d, append } = deps({ moveEvent: vi.fn(async () => Promise.reject(new Error('403'))) })
    expect(await moveAppointment(db, { ...business, phone: DANA, reminderId: R_DANA, start: NEW_SLOT.start }, d)).toMatchObject({ success: false, code: 'CALENDAR_FAILED' })
    expect(await getBooking(db, WS, B_DANA)).toMatchObject({ startsAt: '2026-11-05T15:00:00.000Z', endsAt: '2026-11-05T16:30:00.000Z', customerConfirmedAt: null })
    expect(tables.customer_reminder[0].answer).toBeNull()
    expect(append).not.toHaveBeenCalled()
  })

  it('a calendar that refuses after the old time was taken meanwhile: the booking stays moved, and the owner is told to move the event', async () => {
    const { d, append, route } = deps({
      moveEvent: vi.fn(async () => {
        // Another customer's request takes the freed 9:00 before the rollback.
        tables.customer_booking.push({ ...tables.customer_booking[0], id: 'other', state: 'requested', customer_phone: '+13125550199', starts_at: '2026-11-05T15:00:00.000Z', created_at: '2026-11-04T18:00:00Z' })
        throw new Error('403')
      }),
    })
    expect(await moveAppointment(db, { ...business, phone: DANA, reminderId: R_DANA, start: NEW_SLOT.start }, d)).toMatchObject({ success: true, status: 'moved' })
    expect(await getBooking(db, WS, B_DANA)).toMatchObject({ startsAt: NEW_SLOT.start })
    expect(append.mock.calls[0][1].parts[0].text).toBe(
      "Dana Ruiz moved their visit from Thu, Nov 5 at 9:00 AM to Fri, Nov 6 at 10:00 AM. Your calendar wouldn't move, so it still shows Thu, Nov 5 at 9:00 AM: move that event yourself. Tell me if you want it back.",
    )
    expect(route).toHaveBeenCalledTimes(1)
  })

  describe('over the real slot finder', () => {
    beforeEach(() => {
      tables.business_profile = [{ workspace_id: WS, owner_user_id: OWNER, business_name: 'Brightside', customer_facts: null, time_zone: CHICAGO, booking_days: [1, 2, 3, 4, 5], booking_start: '08:00', booking_end: '17:00', slot_minutes: 60, lead_hours: 12, horizon_days: 21, booking_kind: 'visit', booking_slug: null, reminders: true }]
    })
    // The booking's own event on the owner's calendar: 9:00 to 10:30 on Thu, Nov 5.
    const ownEvent = { id: 'evt-dana', title: 'Visit: Dana Ruiz', start: '2026-11-05T15:00:00.000Z', end: '2026-11-05T16:30:00.000Z' }
    const real = (over: Partial<ReminderReplyDeps> = {}) => deps({ openSlotAt: undefined, listEvents: vi.fn(async () => [ownEvent]), ...over })

    it('the booking and its own event never block its new time: a 90-minute visit moves an hour later', async () => {
      const { d, moveEvent } = real()
      const out = await moveAppointment(db, { ...business, phone: DANA, reminderId: R_DANA, start: '2026-11-05T16:00:00.000Z' }, d)
      expect(out).toMatchObject({ success: true, status: 'moved', when: 'Thu, Nov 5, 10:00 AM' })
      expect(moveEvent).toHaveBeenCalledWith(OWNER, 'evt-dana', { start: '2026-11-05T16:00:00.000Z', end: '2026-11-05T17:00:00.000Z' })
    })

    it("a request the owner never answered doesn't hold its slot: it is expired first, and the move takes the time", async () => {
      tables.customer_booking.push({ ...tables.customer_booking[0], id: 'stale', state: 'requested', customer_phone: '+13125550199', starts_at: '2026-11-05T17:00:00.000Z', ends_at: '2026-11-05T18:00:00.000Z', calendar_event_id: null, created_at: '2026-11-01T12:00:00Z' })
      const { d } = real()
      expect(await moveAppointment(db, { ...business, phone: DANA, reminderId: R_DANA, start: '2026-11-05T17:00:00.000Z' }, d)).toMatchObject({ success: true, status: 'moved' })
      expect(tables.customer_booking.find((b) => b.id === 'stale')?.state).toBe('expired')
    })

    it('another confirmed booking, or a time outside the hours, is not open', async () => {
      tables.customer_booking.push({ ...tables.customer_booking[0], id: 'taken', customer_phone: '+13125550199', starts_at: '2026-11-05T17:00:00.000Z', ends_at: '2026-11-05T18:00:00.000Z', calendar_event_id: null })
      const { d } = real()
      expect(await moveAppointment(db, { ...business, phone: DANA, reminderId: R_DANA, start: '2026-11-05T17:00:00.000Z' }, d)).toMatchObject({ code: 'SLOT_TAKEN' })
      expect(await moveAppointment(db, { ...business, phone: DANA, reminderId: R_DANA, start: '2026-11-06T01:00:00.000Z' }, d)).toMatchObject({ code: 'SLOT_TAKEN' })
      expect(tables.customer_booking[0].starts_at).toBe('2026-11-05T15:00:00.000Z')
    })
  })

  it("a meeting is the owner's to move: nothing changes, and the agent is told to pass it on", async () => {
    const { d, moveEvent } = deps()
    expect(await moveAppointment(db, { ...business, phone: LEE, reminderId: R_LEE, start: NEW_SLOT.start }, d)).toMatchObject({ success: false, code: 'OWNER_MOVES_MEETINGS' })
    expect(moveEvent).not.toHaveBeenCalled()
    expect(d.openSlotAt).not.toHaveBeenCalled()
  })

  it("someone else's reminder is not found", async () => {
    const { d } = deps()
    expect(await moveAppointment(db, { ...business, phone: LEE, reminderId: R_DANA, start: NEW_SLOT.start }, d)).toMatchObject({ code: 'NOT_FOUND' })
    expect(d.openSlotAt).not.toHaveBeenCalled()
  })
})

describe('STOP', () => {
  it('answers their open reminders opted out and tells the owner once each; the booking stands', async () => {
    const { d, append, route } = deps()
    expect(await remindersStopped(db, { workspaceId: WS, phone: DANA, businessName: 'Brightside' }, d)).toBe(1)
    expect(tables.customer_reminder[0].answer).toBe('opted_out')
    expect(tables.customer_booking[0].state).toBe('confirmed')
    expect(append.mock.calls[0][1]).toMatchObject({
      messageId: `customer-reminder:${R_DANA}:stop`,
      parts: [{ type: 'text', text: "Dana Ruiz replied STOP to their reminder, so Brightside can't text them any more. Their visit on Thu, Nov 5 at 9:00 AM still stands; call them if you need to." }],
    })
    expect(route).toHaveBeenCalledTimes(1)
    expect(await remindersStopped(db, { workspaceId: WS, phone: DANA, businessName: 'Brightside' }, d)).toBe(0)
    expect(await remindersStopped(db, { workspaceId: WS, phone: '+13125550100', businessName: 'Brightside' }, d)).toBe(0)
  })
})

describe("the customer's own tools", () => {
  const guest = (phone: string | null) => ({ id: 'g-1', phone, displayName: 'Dana Ruiz', contactId: null }) as unknown as AgentGuest
  const claims = { userId: OWNER, workspaceId: WS }

  it('answer only for the number the customer texts from, and check their input', async () => {
    const lee = await customerToolCall(db, claims, guest(LEE), 'confirm_appointment', { input: { reminder_id: R_DANA } })
    expect((await lee.json()).output).toMatchObject({ success: false, code: 'NOT_FOUND' })
    const none = await customerToolCall(db, claims, guest(null), 'move_appointment', { input: { reminder_id: R_DANA, start: NEW_SLOT.start } })
    expect((await none.json()).output).toMatchObject({ success: false, code: 'NOT_FOUND' })
    const bad = await customerToolCall(db, claims, guest(DANA), 'confirm_appointment', { input: { reminder_id: 'nope' } })
    expect(bad.status).toBe(400)
    expect(tables.customer_reminder[0].answer).toBeNull()
  })
})

describe('the reminder row', () => {
  it('reads what the table holds, unknown values safely', () => {
    expect(toReminder({ ...(tables.customer_reminder[0] as never), status: 'odd', answer: 'odd' } as never)).toMatchObject({ status: 'failed', answer: null, subjectType: 'booking' })
  })
})
