/**
 * Open slots (roadmap B4, ../slots.ts): the business's days and hours, cut
 * into its slot length, minus the lead time, the owner's busy times, every
 * live booking and any all-day event; worked in the business's zone across
 * a daylight-saving change.
 */
import { describe, expect, it, vi } from 'vitest'
import { memoryDb } from '@/test/memory-db'
import { customerBooking, type CustomerBookingSeed } from '@/test/booking-db'
import { DEFAULT_BOOKING_RULES, findOpenSlots, isSlotFree, localDate, openSlots, slotLabel, slotWindow, zonedTime, type BookingRules } from '../slots'

const NY = 'America/New_York'
// Friday Oct 30 2026, 09:00 in New York (EDT, UTC-4).
const FRI_9AM = Date.parse('2026-10-30T13:00:00Z')
const RULES: BookingRules = { ...DEFAULT_BOOKING_RULES, bookingDays: [1, 2, 3, 4, 5], bookingStart: '09:00', bookingEnd: '12:00', slotMinutes: 60, leadHours: 24, horizonDays: 14 }

describe('the zone', () => {
  it('a wall-clock time is the right instant on both sides of the Nov 1 2026 change', () => {
    expect(new Date(zonedTime({ y: 2026, m: 10, d: 30 }, '10:00', NY)).toISOString()).toBe('2026-10-30T14:00:00.000Z')
    expect(new Date(zonedTime({ y: 2026, m: 11, d: 2 }, '10:00', NY)).toISOString()).toBe('2026-11-02T15:00:00.000Z')
    expect(localDate(Date.parse('2026-11-02T03:30:00Z'), NY)).toMatchObject({ y: 2026, m: 11, d: 1, weekday: 0 })
  })
})

describe('openSlots', () => {
  it('weekdays only, inside the hours, past the lead time, in order', () => {
    const slots = openSlots({ rules: RULES, timeZone: NY, now: FRI_9AM, busy: [], bookings: [], days: 5 })
    // Friday is inside the 24 h lead; the weekend is closed; Monday (after the change) is the first day.
    expect(slots.map((s) => s.start)).toEqual(['2026-11-02T14:00:00.000Z', '2026-11-02T15:00:00.000Z', '2026-11-02T16:00:00.000Z', '2026-11-03T14:00:00.000Z', '2026-11-03T15:00:00.000Z', '2026-11-03T16:00:00.000Z'])
    expect(slotLabel(slots[0].start, NY)).toBe('Mon, Nov 2, 9:00 AM')
  })

  it("leaves out the owner's busy times and every live booking", () => {
    const slots = openSlots({
      rules: RULES,
      timeZone: NY,
      now: FRI_9AM,
      busy: [{ start: '2026-11-02T14:30:00Z', end: '2026-11-02T15:10:00Z' }],
      bookings: [{ startsAt: '2026-11-02T16:00:00.000Z', endsAt: '2026-11-02T17:00:00.000Z' }],
      days: 4,
    })
    expect(slots.filter((s) => s.start.startsWith('2026-11-02'))).toEqual([])
  })

  it("an all-day event takes its own day, not the evening before (a provider's dates are UTC midnights)", () => {
    // Google's all-day Nov 3: 2026-11-03 to 2026-11-04, read as UTC midnights (Nov 2, 7 PM in New York).
    const google = openSlots({ rules: RULES, timeZone: NY, now: FRI_9AM, busy: [{ start: '2026-11-03T00:00:00Z', end: '2026-11-04T00:00:00Z', allDay: true }], days: 7, bookings: [] })
    expect(google.some((s) => s.start.startsWith('2026-11-03'))).toBe(false)
    expect(google.some((s) => s.start.startsWith('2026-11-02'))).toBe(true)
    expect(google.some((s) => s.start.startsWith('2026-11-04'))).toBe(true)
    // The same day at local midnights (an Outlook all-day event).
    const local = openSlots({ rules: RULES, timeZone: NY, now: FRI_9AM, busy: [{ start: '2026-11-03T05:00:00Z', end: '2026-11-04T05:00:00Z', allDay: true }], days: 7, bookings: [] })
    expect(local.some((s) => s.start.startsWith('2026-11-03'))).toBe(false)
    expect(local.some((s) => s.start.startsWith('2026-11-04'))).toBe(true)
  })

  it('a later first day, the horizon and the cap', () => {
    const later = openSlots({ rules: RULES, timeZone: NY, now: FRI_9AM, busy: [], bookings: [], fromDate: '2026-11-05', days: 1 })
    expect(later.map((s) => s.start)).toEqual(['2026-11-05T14:00:00.000Z', '2026-11-05T15:00:00.000Z', '2026-11-05T16:00:00.000Z'])
    expect(openSlots({ rules: { ...RULES, horizonDays: 1 }, timeZone: NY, now: FRI_9AM, busy: [], bookings: [], days: 7 })).toEqual([])
    expect(openSlots({ rules: RULES, timeZone: NY, now: FRI_9AM, busy: [], bookings: [], days: 14, max: 2 })).toHaveLength(2)
  })

  it('a slot that would run past the end of the day is not offered', () => {
    const slots = openSlots({ rules: { ...RULES, slotMinutes: 90 }, timeZone: NY, now: FRI_9AM, busy: [], bookings: [], fromDate: '2026-11-02', days: 1 })
    expect(slots.map((s) => [s.start, s.end])).toEqual([
      ['2026-11-02T14:00:00.000Z', '2026-11-02T15:30:00.000Z'],
      ['2026-11-02T15:30:00.000Z', '2026-11-02T17:00:00.000Z'],
    ])
  })
})

describe('isSlotFree (the check at the owner’s yes)', () => {
  const business = { workspaceId: 'ws-rug', ownerUserId: 'user-owner' }
  const slot = { start: '2026-11-02T15:00:00.000Z', end: '2026-11-02T16:00:00.000Z' }
  const db = (bookings: Record<string, unknown>[] = []) =>
    memoryDb({ business_profile: [{ workspace_id: 'ws-rug', owner_user_id: 'user-owner', business_name: 'Bright Loom', time_zone: NY, booking_days: [1, 2, 3, 4, 5], booking_start: '09:00', booking_end: '17:00', slot_minutes: 60, lead_hours: 24, horizon_days: 14, booking_kind: 'pickup', booking_slug: null }], meeting_booking: bookings.map((b) => customerBooking(b as unknown as CustomerBookingSeed)) })

  it("a booking's own hold doesn't count against it; another live one does", async () => {
    const own = { id: 'b-own', workspace_id: 'ws-rug', state: 'requested', starts_at: slot.start, ends_at: slot.end, created_at: new Date(FRI_9AM).toISOString() }
    const listEvents = async () => []
    expect(await isSlotFree(db([own]), business, { ...slot, exceptBookingId: 'b-own' }, { listEvents, now: () => FRI_9AM })).toBe(true)
    expect(await isSlotFree(db([own, { ...own, id: 'b-other', state: 'confirmed' }]), business, { ...slot, exceptBookingId: 'b-own' }, { listEvents, now: () => FRI_9AM })).toBe(false)
  })

  it('anything on the calendar then, or an all-day event that day, is busy', async () => {
    const timed = async () => [{ start: '2026-11-02T15:30:00Z', end: '2026-11-02T15:45:00Z' }] as never
    expect(await isSlotFree(db(), business, slot, { listEvents: timed, now: () => FRI_9AM })).toBe(false)
    const allDay = async () => [{ start: '2026-11-02T00:00:00Z', end: '2026-11-03T00:00:00Z', isAllDay: true }] as never
    expect(await isSlotFree(db(), business, slot, { listEvents: allDay, now: () => FRI_9AM })).toBe(false)
    const cancelled = async () => [{ start: '2026-11-02T15:30:00Z', end: '2026-11-02T15:45:00Z', status: 'cancelled' }] as never
    expect(await isSlotFree(db(), business, slot, { listEvents: cancelled, now: () => FRI_9AM })).toBe(true)
  })
})

describe('the read window and a failed read', () => {
  const setup = { rules: RULES, timeZone: NY }

  it('reads just the days asked for, never past the horizon', () => {
    const w = slotWindow({ fromDate: '2026-11-02', days: 2 }, setup, FRI_9AM)!
    // The day before (an all-day event's UTC midnight) through the day after.
    expect(new Date(w.from).toISOString()).toBe('2026-11-01T05:00:00.000Z')
    expect(new Date(w.to).toISOString()).toBe('2026-11-05T05:00:00.000Z')
    expect(slotWindow({ fromDate: '2026-12-30', days: 3 }, setup, FRI_9AM)).toBeNull()
  })

  it('a calendar that can’t be read offers nothing: the error goes up', async () => {
    const db = memoryDb({ business_profile: [], meeting_booking: [], member: [] })
    const listEvents = vi.fn(async () => {
      throw new Error('A calendar account needs signing in again')
    })
    await expect(findOpenSlots(db, { workspaceId: 'ws-rug', ownerUserId: 'user-owner' }, { days: 3 }, { listEvents, now: () => FRI_9AM })).rejects.toThrow('signing in again')
    expect(listEvents).toHaveBeenCalledWith('user-owner', expect.objectContaining({ strict: true }))
  })
})
