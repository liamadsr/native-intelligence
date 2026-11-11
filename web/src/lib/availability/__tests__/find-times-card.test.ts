/**
 * The find_times card's data (../find-times-card.ts): the times to offer, and
 * a group's people with whether their time is known; the generic chip for a
 * call that failed before reading anyone, or one person's unknown.
 */
import { describe, expect, it } from 'vitest'
import { findTimesCardOf } from '../find-times-card'
import { zoneAbbreviation } from '../zone'

// Nov 10 2026: standard time in New York and Chicago, GMT in London.
const NOW = Date.parse('2026-11-10T15:00:00.000Z')
const NY = 'America/New_York'

const label = (l: string) => ({ start: 'x', end: 'y', label: l })

describe('findTimesCardOf', () => {
  it("one person: the suggested times, in the person's zone, no people", () => {
    const out = findTimesCardOf({ success: true, time_zone: NY, duration_minutes: 30, suggested: [label('Tue, Nov 3, 10:00 AM to 10:30 AM')], free: [] }, NOW)
    expect(out).toEqual({ durationMinutes: 30, zone: 'EST', suggested: ['Tue, Nov 3, 10:00 AM – 10:30 AM'], people: null, unknown: false })
  })

  it("a group: each person, the person first, a teammate's zone only when it differs", () => {
    const out = findTimesCardOf(
      {
        success: true,
        time_zone: NY,
        duration_minutes: 45,
        suggested: [label('Wed, Nov 4, 11:00 AM to 11:45 AM')],
        people: [
          { name: 'Ada Finch', you: true, coverage: 'complete', time_zone: NY },
          { name: 'Dana Whitfield', coverage: 'complete', time_zone: 'America/Chicago' },
          { name: 'Lee Okafor', coverage: 'complete', time_zone: 'America/Detroit' },
        ],
      },
      NOW,
    )
    expect(out?.people).toEqual([
      { name: 'Ada Finch', you: true, known: true, reason: null, zone: null },
      { name: 'Dana Whitfield', you: false, known: true, reason: null, zone: 'CST' },
      { name: 'Lee Okafor', you: false, known: true, reason: null, zone: null },
    ])
  })

  it('a group with someone unknown: who and why, and no times', () => {
    const out = findTimesCardOf(
      {
        success: false,
        unknown: true,
        time_zone: NY,
        duration_minutes: 30,
        error: 'Free time together is unknown (...)',
        people: [
          { name: 'Ada Finch', you: true, coverage: 'complete', time_zone: NY },
          { name: 'Sam Ortiz', coverage: 'unknown', reason: "they don't share their availability", time_zone: null },
        ],
      },
      NOW,
    )
    expect(out).toEqual({
      durationMinutes: 30,
      zone: 'EST',
      suggested: [],
      unknown: true,
      people: [
        { name: 'Ada Finch', you: true, known: true, reason: null, zone: null },
        { name: 'Sam Ortiz', you: false, known: false, reason: "they don't share their availability", zone: null },
      ],
    })
  })

  it('nothing free: a card with no times', () => {
    expect(findTimesCardOf({ success: true, time_zone: NY, duration_minutes: 30, suggested: [], free: [], note: 'Nothing is free' }, NOW)).toMatchObject({ suggested: [], unknown: false })
  })

  it("the chip instead: a failed call, one person's unknown, anything unreadable", () => {
    expect(findTimesCardOf({ success: false, error: 'No calendar connected.' }, NOW)).toBeNull()
    expect(findTimesCardOf({ success: false, unknown: true, error: 'Free time is unknown: A calendar account needs signing in again.' }, NOW)).toBeNull()
    expect(findTimesCardOf({ success: true, time_zone: NY }, NOW)).toBeNull()
    expect(findTimesCardOf({ success: false, unknown: true, people: [{ coverage: 'complete' }] }, NOW)).toBeNull()
    expect(findTimesCardOf(null, NOW)).toBeNull()
    expect(findTimesCardOf('oops', NOW)).toBeNull()
  })
})

describe('zoneAbbreviation', () => {
  it("a zone's short name, or null", () => {
    expect(zoneAbbreviation(NY, NOW)).toBe('EST')
    expect(zoneAbbreviation(NY, Date.parse('2026-07-01T12:00:00.000Z'))).toBe('EDT')
    expect(zoneAbbreviation('Not/AZone', NOW)).toBeNull()
    expect(zoneAbbreviation(null, NOW)).toBeNull()
  })
})
