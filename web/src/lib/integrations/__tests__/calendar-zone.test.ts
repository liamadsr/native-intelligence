/**
 * Calendar times in the person's zone (calendar-zone.ts): a range edge a
 * model wrote is read there, and an instant is written back there with its
 * offset. Daylight-saving days on both sides of UTC.
 */
import { describe, expect, it } from 'vitest'
import { isoInZone, parseRangeEdge, readRangeEdge } from '@/lib/integrations/calendar-zone'

const iso = (at: number | null) => (at === null ? null : new Date(at).toISOString())

describe('parseRangeEdge', () => {
  it('reads a bare date as midnight in the zone, and anything else as written', () => {
    expect(iso(parseRangeEdge('2026-10-27', 'America/Los_Angeles'))).toBe('2026-10-27T07:00:00.000Z')
    expect(iso(parseRangeEdge('2026-10-27T09:00:00Z', 'America/Los_Angeles'))).toBe('2026-10-27T09:00:00.000Z')
    expect(parseRangeEdge('soon', 'UTC')).toBeNull()
    expect(parseRangeEdge('2026-13-40', 'UTC')).toBeNull()
  })

  it('lands on local midnight when the zone changes its clocks near UTC midnight (Auckland, April)', () => {
    // NZDT (+13) ends at 03:00 local on Sunday 5 April 2026, i.e. 14:00Z the day before.
    expect(iso(parseRangeEdge('2026-04-05', 'Pacific/Auckland'))).toBe('2026-04-04T11:00:00.000Z')
  })
})

describe('readRangeEdge', () => {
  it('a bare end date covers the whole day, to the next local midnight', () => {
    expect(iso(readRangeEdge('2026-11-07', 'America/New_York', 'end'))).toBe('2026-11-08T05:00:00.000Z')
    expect(iso(readRangeEdge('2026-11-01', 'America/New_York', 'start'))).toBe('2026-11-01T04:00:00.000Z')
    // The 25-hour day: its end is in EST.
    expect(iso(readRangeEdge('2026-11-01', 'America/New_York', 'end'))).toBe('2026-11-02T05:00:00.000Z')
  })

  it('a date-time with no offset is the zone’s clock; an offset or Z is taken as written', () => {
    expect(iso(readRangeEdge('2026-11-08T23:59:59', 'America/New_York', 'end'))).toBe('2026-11-09T04:59:59.000Z')
    expect(iso(readRangeEdge('2026-11-02 09:00', 'Asia/Kolkata', 'start'))).toBe('2026-11-02T03:30:00.000Z')
    expect(iso(readRangeEdge('2026-11-02T09:00:00+01:00', 'America/New_York', 'start'))).toBe('2026-11-02T08:00:00.000Z')
    expect(iso(readRangeEdge(' 2026-11-02T09:00:00Z ', 'America/New_York', 'start'))).toBe('2026-11-02T09:00:00.000Z')
  })

  it('is null for what it cannot read', () => {
    expect(readRangeEdge('next tuesday', 'UTC', 'start')).toBeNull()
    expect(readRangeEdge('2026-13-01', 'UTC', 'end')).toBeNull()
    expect(readRangeEdge('2026-11-02T25:00', 'UTC', 'start')).toBeNull()
  })
})

describe('isoInZone', () => {
  it('writes the zone’s wall clock with its offset', () => {
    expect(isoInZone(Date.parse('2026-11-05T12:00:00Z'), 'America/New_York')).toBe('2026-11-05T07:00:00-05:00')
    expect(isoInZone(Date.parse('2026-07-05T12:00:00Z'), 'America/New_York')).toBe('2026-07-05T08:00:00-04:00')
    expect(isoInZone(Date.parse('2026-11-05T12:00:00Z'), 'Asia/Kolkata')).toBe('2026-11-05T17:30:00+05:30')
    expect(isoInZone(Date.parse('2026-11-05T12:00:00.500Z'), 'UTC')).toBe('2026-11-05T12:00:00+00:00')
  })
})
