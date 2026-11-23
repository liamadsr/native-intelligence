import { describe, expect, it } from 'vitest'
import type { LinkBookingRow } from '../bookings'
import {
  bookingInsights,
  bookingsCsv,
  csvCell,
  insightRange,
  knownZone,
} from '../insights'

const NY = 'America/New_York'
const LINK = 'link-intro'
const LINK_2 = 'link-team'
const titles = new Map([
  [LINK, 'Intro call'],
  [LINK_2, 'Team call'],
])

function row(
  start: string,
  over: Partial<LinkBookingRow> = {},
): LinkBookingRow {
  return {
    id: start,
    workspace_id: 'ws',
    host_user_id: 'ava',
    host_name: 'Ava Lin',
    source: 'link',
    link_id: LINK,
    guest_name: 'Dana Wu',
    guest_email: 'dana@example.com',
    guest_phone: null,
    guest_time_zone: null,
    title: 'Intro call',
    starts_at: start,
    ends_at: new Date(Date.parse(start) + 30 * 60_000).toISOString(),
    state: 'confirmed',
    video: true,
    location: null,
    conference_url: null,
    answers: [],
    other_host_ids: [],
    cancelled_by: null,
    attendance: null,
    created_at: start,
    ...over,
  }
}

describe('insightRange', () => {
  const now = Date.parse('2026-11-20T15:00:00Z')

  it("7, 30 or 90 days ending today, from local midnight in the reader's zone", () => {
    const r = insightRange({ days: 7, tz: NY }, now)
    expect(r).toMatchObject({ ok: true, days: 7, timeZone: NY })
    if (!r.ok) return
    expect(new Date(r.from).toISOString()).toBe('2026-11-14T05:00:00.000Z')
    expect(new Date(r.to).toISOString()).toBe('2026-11-21T05:00:00.000Z')
    expect(insightRange({ days: 14 }, now).ok).toBe(false)
  })

  it('a custom range, both days included, at most a year', () => {
    const r = insightRange(
      { from: '2026-11-01', to: '2026-11-03', tz: NY },
      now,
    )
    expect(r).toMatchObject({ ok: true, days: 3 })
    expect(insightRange({ from: '2026-11-03', to: '2026-11-01' }, now).ok).toBe(
      false,
    )
    expect(insightRange({ from: '2026-02-30', to: '2026-03-02' }, now).ok).toBe(
      false,
    )
    expect(insightRange({ from: '2025-01-01', to: '2026-11-01' }, now).ok).toBe(
      false,
    )
    expect(insightRange({ from: '2026-11-01' }, now).ok).toBe(false)
  })

  it('an unknown zone is UTC', () => {
    expect(knownZone('Not/AZone')).toBe(false)
    expect(insightRange({ days: 7, tz: 'Not/AZone' }, now)).toMatchObject({
      ok: true,
      timeZone: 'UTC',
    })
  })
})

describe('bookingInsights', () => {
  const range = insightRange(
    { from: '2026-11-01', to: '2026-11-07', tz: NY },
    0,
  )
  if (!range.ok) throw new Error('range')
  const rows = [
    row('2026-11-01T14:00:00Z', { attendance: 'attended' }),
    row('2026-11-01T15:00:00Z', { attendance: 'no_show' }),
    row('2026-11-02T14:00:00Z', {
      link_id: LINK_2,
      ends_at: '2026-11-02T15:00:00Z',
    }),
    row('2026-11-02T16:00:00Z', { state: 'cancelled' }),
    row('2026-11-03T14:00:00Z', { state: 'requested' }),
    row('2026-11-03T15:00:00Z', { state: 'declined' }),
    row('2026-11-03T16:00:00Z', { state: 'expired' }),
    // 11 pm on the 7th in New York is still the range; 1 am on the 8th is not.
    row('2026-11-08T04:00:00Z', { link_id: null }),
    row('2026-11-08T06:00:00Z'),
    // Before the range.
    row('2026-10-31T14:00:00Z'),
  ]
  const out = bookingInsights(rows, {
    from: range.from,
    to: range.to,
    timeZone: NY,
    titles,
  })

  it('totals: booked, requested, cancelled, declined; hours leave no-shows out', () => {
    expect(out.totals).toEqual({
      booked: 4,
      requested: 1,
      cancelled: 1,
      declined: 2,
      hours: 2,
      attended: 1,
      no_shows: 1,
      no_show_rate: 0.5,
    })
  })

  it('a bucket per local day', () => {
    expect(out.bucket).toBe('day')
    expect(out.series.map((b) => b.date)).toEqual([
      '2026-11-01',
      '2026-11-02',
      '2026-11-03',
      '2026-11-04',
      '2026-11-05',
      '2026-11-06',
      '2026-11-07',
    ])
    expect(out.series.map((b) => [b.booked, b.cancelled])).toEqual([
      [2, 0],
      [1, 1],
      [0, 0],
      [0, 0],
      [0, 0],
      [0, 0],
      [1, 0],
    ])
  })

  it('top links by bookings then hours, a deleted link named so', () => {
    expect(out.top_links).toEqual([
      { link_id: LINK, title: 'Intro call', bookings: 2, hours: 0.5 },
      { link_id: LINK_2, title: 'Team call', bookings: 1, hours: 1 },
      { link_id: null, title: 'A deleted link', bookings: 1, hours: 0.5 },
    ])
  })

  it('no marks: no rate', () => {
    expect(
      bookingInsights([row('2026-11-01T14:00:00Z')], {
        from: range.from,
        to: range.to,
        timeZone: NY,
        titles,
      }).totals.no_show_rate,
    ).toBeNull()
  })

  it('weeks past 92 days', () => {
    const long = insightRange(
      { from: '2026-01-01', to: '2026-06-30', tz: 'UTC' },
      0,
    )
    if (!long.ok) throw new Error('range')
    const weekly = bookingInsights([row('2026-01-09T10:00:00Z')], {
      from: long.from,
      to: long.to,
      timeZone: 'UTC',
      titles,
    })
    expect(weekly.bucket).toBe('week')
    expect(weekly.series[0].date).toBe('2026-01-01')
    expect(weekly.series[1]).toEqual({
      date: '2026-01-08',
      booked: 1,
      cancelled: 0,
    })
    expect(weekly.series).toHaveLength(26)
  })
})

describe('CSV', () => {
  it('quotes what must be, and never lets a cell run as a formula', () => {
    expect(csvCell('plain')).toBe('plain')
    expect(csvCell('a, b')).toBe('"a, b"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell('=HYPERLINK("x")')).toBe('"\'=HYPERLINK(""x"")"')
    expect(csvCell('+1 555 0100')).toBe("'+1 555 0100")
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)")
    expect(csvCell(null)).toBe('')
  })

  it('one row a booking, soonest first, attendance only on confirmed ones', () => {
    const csv = bookingsCsv(
      [
        row('2026-11-02T14:00:00Z', {
          state: 'cancelled',
          attendance: 'attended',
        }),
        row('2026-11-01T14:00:00Z', {
          guest_name: '-Dana',
          attendance: 'no_show',
        }),
      ],
      titles,
    )
    const lines = csv.trim().split('\r\n')
    expect(lines[0]).toBe(
      'start,end,title,link,guest,guest_email,guest_phone,state,attendance,host,cancelled_by',
    )
    expect(lines[1]).toBe(
      "2026-11-01T14:00:00Z,2026-11-01T14:30:00.000Z,Intro call,Intro call,'-Dana,dana@example.com,,confirmed,no_show,Ava Lin,",
    )
    expect(lines[2].split(',')[8]).toBe('')
  })
})
