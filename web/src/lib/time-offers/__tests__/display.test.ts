/**
 * The guest's pages' pure parts (../display.ts): the times by day in the
 * guest's own zone, the labels, and what each error of the public API means
 * to a guest.
 */
import { describe, expect, it } from 'vitest'
import { bookingPhase, groupByDay, isTimeZone, lengthLabel, manageFailureView, movesLeftLabel, pickFailure, whenLabel, zoneShort } from '../display'

// Tue Nov 17 2026, 15:00 and 23:30 UTC; Wed Nov 18, 14:00 UTC.
const SLOTS = [
  { start: '2026-11-18T14:00:00.000Z', end: '2026-11-18T14:30:00.000Z' },
  { start: '2026-11-17T15:00:00.000Z', end: '2026-11-17T15:30:00.000Z' },
  { start: '2026-11-17T23:30:00.000Z', end: '2026-11-18T00:00:00.000Z' },
]

describe('groupByDay', () => {
  it("groups by the guest's local day, soonest first, with the clock in their zone", () => {
    const ny = groupByDay(SLOTS, 'America/New_York')
    expect(ny.map((d) => [d.label, d.slots.map((s) => s.time)])).toEqual([
      ['Tuesday, November 17', ['10:00 AM', '6:30 PM']],
      ['Wednesday, November 18', ['9:00 AM']],
    ])
    // The same instants in Tokyo all fall on one day.
    const tokyo = groupByDay(SLOTS, 'Asia/Tokyo')
    expect(tokyo.map((d) => [d.label, d.slots.map((s) => s.time)])).toEqual([['Wednesday, November 18', ['12:00 AM', '8:30 AM', '11:00 PM']]])
    expect(tokyo[0].slots.map((s) => s.start)).toEqual([SLOTS[1].start, SLOTS[2].start, SLOTS[0].start])
  })

  it('nothing in, nothing out', () => {
    expect(groupByDay([], 'UTC')).toEqual([])
  })
})

describe('labels', () => {
  it('when, with the zone short name at that instant', () => {
    expect(whenLabel(SLOTS[1].start, SLOTS[1].end, 'America/New_York')).toBe('Tuesday, November 17 · 10:00 AM – 10:30 AM EST')
    expect(whenLabel('2026-07-07T14:00:00.000Z', '2026-07-07T15:00:00.000Z', 'America/New_York')).toBe('Tuesday, July 7 · 10:00 AM – 11:00 AM EDT')
    expect(zoneShort('Europe/London', Date.parse(SLOTS[1].start))).toBe('GMT')
  })

  it('a zone the browser does not know falls back to UTC for the clock', () => {
    expect(isTimeZone('Mars/Olympus')).toBe(false)
    expect(isTimeZone('America/Chicago')).toBe(true)
    expect(isTimeZone(null)).toBe(false)
    expect(whenLabel(SLOTS[1].start, SLOTS[1].end, 'Mars/Olympus')).toBe('Tuesday, November 17 · 3:00 PM – 3:30 PM Mars/Olympus')
  })

  it('lengths', () => {
    expect([15, 30, 60, 90, 120].map(lengthLabel)).toEqual(['15 min', '30 min', '1 hr', '1 hr 30 min', '2 hr'])
  })

  it('moves left: said once one is used, never at 0', () => {
    expect([3, 2, 1, 0].map((n) => movesLeftLabel(n, 3))).toEqual([null, 'You can move it 2 more times.', 'You can move it one more time.', null])
  })
})

describe('pickFailure', () => {
  it('every answer of POST /accept', () => {
    expect(pickFailure(409, { code: 'SLOT_TAKEN', details: { slots: [SLOTS[0], { start: 1 }] } }, 'Ava Lin')).toEqual({ kind: 'slot_taken', slots: [SLOTS[0]] })
    expect(pickFailure(409, { code: 'SLOT_TAKEN' }, 'Ava Lin')).toEqual({ kind: 'slot_taken', slots: [] })
    expect(pickFailure(410, { code: 'BOOKED' }, 'Ava Lin')).toEqual({ kind: 'closed', state: 'booked' })
    expect(pickFailure(410, { code: 'WITHDRAWN' }, 'Ava Lin')).toEqual({ kind: 'closed', state: 'withdrawn' })
    expect(pickFailure(410, { code: 'EXPIRED' }, 'Ava Lin')).toEqual({ kind: 'closed', state: 'expired' })
    expect(pickFailure(404, { code: 'NOT_FOUND' }, 'Ava Lin')).toEqual({ kind: 'missing' })
    expect(pickFailure(400, { code: 'NEEDS_EMAIL', error: 'Add your email so the invitation can reach you.' }, 'Ava Lin')).toEqual({ kind: 'needs_email', message: 'Add your email so the invitation can reach you.' })
    expect(pickFailure(400, { code: 'BAD_INPUT', error: "That email address doesn't look right." }, 'Ava Lin')).toEqual({ kind: 'message', message: "That email address doesn't look right." })
    expect(pickFailure(429, { code: 'RATE_LIMITED', error: 'Too many tries on this offer today. Ask for new times.' }, 'Ava Lin')).toEqual({ kind: 'message', message: 'Too many tries on this offer today. Ask for new times.' })
    expect(pickFailure(503, { code: 'UNAVAILABLE', error: 'raw' }, 'Ava Lin')).toEqual({ kind: 'message', message: "We couldn't check Ava Lin's calendar just now. Try again in a minute." })
    // A server error or a network failure never shows the raw text.
    expect(pickFailure(500, { error: 'relation does not exist' }, 'Ava Lin')).toEqual({ kind: 'message', message: "That didn't go through. Try again in a moment." })
    expect(pickFailure(0, null, 'Ava Lin')).toEqual({ kind: 'message', message: "That didn't go through. Try again in a moment." })
  })
})

describe('manageFailureView', () => {
  it('every answer of cancel, times and reschedule', () => {
    expect(manageFailureView(409, { code: 'SLOT_TAKEN' })).toEqual({ kind: 'slot_taken', message: 'That time was just taken. Pick another.' })
    expect(manageFailureView(410, { code: 'CLOSED', error: 'This meeting was cancelled.' })).toEqual({ kind: 'reload', message: 'This meeting was cancelled.' })
    expect(manageFailureView(404, null)).toEqual({ kind: 'missing' })
    expect(manageFailureView(429, { error: 'This meeting was already moved 3 times. Ask Ava Lin directly.' })).toEqual({ kind: 'message', message: 'This meeting was already moved 3 times. Ask Ava Lin directly.' })
    expect(manageFailureView(503, null).kind).toBe('message')
    expect(manageFailureView(500, { error: 'provider said 502' })).toEqual({ kind: 'message', message: "That didn't go through. Try again in a moment." })
  })
})

describe('bookingPhase', () => {
  const b = { state: 'confirmed' as const, start: SLOTS[1].start, end: SLOTS[1].end }
  const start = Date.parse(SLOTS[1].start)
  it('upcoming, being booked, under way, past, cancelled, failed', () => {
    expect(bookingPhase(b, start - 1)).toBe('upcoming')
    expect(bookingPhase({ ...b, state: 'booking' }, start - 1)).toBe('pending')
    expect(bookingPhase(b, start + 1)).toBe('live')
    expect(bookingPhase(b, Date.parse(SLOTS[1].end))).toBe('past')
    expect(bookingPhase({ ...b, state: 'cancelled' }, start - 1)).toBe('cancelled')
    expect(bookingPhase({ ...b, state: 'failed' }, start - 1)).toBe('failed')
  })
})
