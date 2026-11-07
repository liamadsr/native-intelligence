/**
 * A meeting's time as the person reads it (src/lib/agent-events/meeting-time.ts).
 *
 * Pinned: the local start with its zone ("12:00 PM EDT on Saturday, October
 * 17"), the same words every time (the prep's task line is fingerprinted),
 * UTC without a known zone; and the cards note's prep label at fixed clocks:
 * over / happening now / starts in N min (5-minute steps) / later today /
 * tomorrow / a later day, in the person's zone, the meeting running to its end
 * or DEFAULT_MEETING_MS.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_MEETING_MS, meetingClock, meetingDay, meetingWhen, prepTimeLabel } from '../meeting-time'

const NY = 'America/New_York'
/** Saturday 2026-10-17, 12:00 PM EDT. */
const START = '2026-10-17T16:00:00.000Z'
const at = (localHourMin: string) => Date.parse(`2026-10-17T${localHourMin}:00-04:00`)

describe('meeting times in the person\'s zone', () => {
  it('names the start with its zone, deterministically; UTC without a known zone', () => {
    expect(meetingClock(START, NY)).toBe('12:00 PM EDT')
    expect(meetingClock(START, NY, false)).toBe('12:00 PM')
    expect(meetingDay(START, NY)).toBe('Saturday, October 17')
    expect(meetingWhen(START, NY)).toBe('12:00 PM EDT on Saturday, October 17')
    expect(meetingWhen(START, NY)).toBe(meetingWhen(START, NY))
    expect(meetingWhen(START, 'Not/AZone')).toBe('4:00 PM UTC on Saturday, October 17')
    expect(meetingWhen('nonsense', NY)).toBe('')
    // A zone with no short name reads as its offset.
    expect(meetingClock(START, 'Asia/Kolkata')).toBe('9:30 PM GMT+5:30')
  })
})

describe('prepTimeLabel (the cards note, at fixed clocks)', () => {
  it('over, happening now, starts in N min (in 5-minute steps)', () => {
    // 6:47 PM the same day: the noon meeting is over.
    expect(prepTimeLabel(START, at('18:47'), NY)).toBe('prep for the 12:00 PM meeting · over')
    expect(prepTimeLabel(START, at('12:20'), NY)).toBe('prep for the 12:00 PM meeting · happening now')
    // No end on record: an hour (DEFAULT_MEETING_MS), then over.
    expect(DEFAULT_MEETING_MS).toBe(60 * 60_000)
    expect(prepTimeLabel(START, at('12:59'), NY)).toBe('prep for the 12:00 PM meeting · happening now')
    expect(prepTimeLabel(START, at('13:00'), NY)).toBe('prep for the 12:00 PM meeting · over')
    // A known end wins.
    expect(prepTimeLabel(START, at('12:31'), NY, '2026-10-17T16:30:00.000Z')).toBe('prep for the 12:00 PM meeting · over')
    expect(prepTimeLabel(START, at('11:35'), NY)).toBe('prep for the 12:00 PM meeting · starts in 25 min')
    expect(prepTimeLabel(START, at('11:37'), NY)).toBe('prep for the 12:00 PM meeting · starts in 25 min')
    expect(prepTimeLabel(START, at('11:58'), NY)).toBe('prep for the 12:00 PM meeting · starts in 5 min')
    expect(prepTimeLabel(START, at('11:00'), NY)).toBe('prep for the 12:00 PM meeting · starts in 60 min')
  })

  it('later today, tomorrow, a later day; an earlier day is over with its day', () => {
    const afternoon = '2026-10-17T19:30:00.000Z' // 3:30 PM EDT
    expect(prepTimeLabel(afternoon, at('09:00'), NY)).toBe('prep for the 3:30 PM meeting · later today')
    expect(prepTimeLabel('2026-10-18T13:00:00.000Z', at('18:47'), NY)).toBe('prep for the 9:00 AM meeting · tomorrow')
    expect(prepTimeLabel('2026-10-20T13:00:00.000Z', at('18:47'), NY)).toBe('prep for the 9:00 AM meeting · on Tue, Oct 20')
    expect(prepTimeLabel(START, Date.parse('2026-10-18T14:00:00.000Z'), NY)).toBe('prep for the 12:00 PM meeting yesterday · over')
    expect(prepTimeLabel(START, Date.parse('2026-10-20T14:00:00.000Z'), NY)).toBe('prep for the 12:00 PM meeting on Sat, Oct 17 · over')
  })

  it('the local day is the person\'s: 9 PM in New York is still the same day there', () => {
    // 01:00 UTC on the 18th is 9 PM on the 17th in New York.
    expect(prepTimeLabel('2026-10-18T13:00:00.000Z', Date.parse('2026-10-18T01:00:00.000Z'), NY)).toBe('prep for the 9:00 AM meeting · tomorrow')
    expect(prepTimeLabel('nope', at('09:00'), NY)).toBeNull()
  })
})
