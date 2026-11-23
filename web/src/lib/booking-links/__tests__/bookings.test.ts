import { memoryDb } from '@/test/memory-db'
import { describe, expect, it } from 'vitest'
import {
  getSeenBooking,
  linkBookingsStarting,
  listLinkBookings,
  markAttendance,
  searchPattern,
  seenBy,
  toBookingView,
  type LinkBookingRow,
} from '../bookings'

// Made-up people: Ava and Ben host, Cy is a teammate (an admin, say) who hosts nothing.
const WS = '11111111-1111-4111-8111-111111111111'
const OTHER_WS = '22222222-2222-4222-8222-222222222222'
const AVA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const BEN = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const CY = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const LINK = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const LINK_2 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const NOW = Date.parse('2026-11-20T15:00:00Z')
const H = 3_600_000

let n = 0
function booking(over: Partial<LinkBookingRow> = {}): LinkBookingRow {
  n++
  const start = over.starts_at ?? new Date(NOW + 24 * H).toISOString()
  return {
    id: uid(n),
    workspace_id: WS,
    host_user_id: AVA,
    host_name: 'Ava Lin',
    source: 'link',
    link_id: LINK,
    guest_name: 'Dana Wu',
    guest_email: 'dana@example.com',
    guest_phone: null,
    guest_time_zone: 'America/New_York',
    title: 'Intro call',
    starts_at: start,
    ends_at: new Date(Date.parse(start) + 0.5 * H).toISOString(),
    state: 'confirmed',
    video: true,
    location: null,
    conference_url: null,
    answers: [],
    other_host_ids: [],
    cancelled_by: null,
    attendance: null,
    attendance_marked_at: null,
    created_at: new Date(NOW - 48 * H).toISOString(),
    ...over,
  }
}

const uid = (i: number) =>
  `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`

function seed() {
  n = 0
  const rows: LinkBookingRow[] = [
    booking({ id: uid(1), starts_at: new Date(NOW + 2 * H).toISOString() }),
    booking({
      id: uid(2),
      starts_at: new Date(NOW + 30 * H).toISOString(),
      guest_name: 'Eli Park',
      guest_email: 'eli@example.com',
    }),
    booking({ id: uid(3), starts_at: new Date(NOW - 5 * H).toISOString() }),
    booking({
      id: uid(4),
      starts_at: new Date(NOW - 50 * H).toISOString(),
      state: 'cancelled',
      cancelled_by: 'guest',
    }),
    booking({
      id: uid(5),
      starts_at: new Date(NOW + 5 * H).toISOString(),
      state: 'requested',
    }),
    // Ben organizes, Ava attends: both see it.
    booking({
      id: uid(6),
      starts_at: new Date(NOW + 3 * H).toISOString(),
      host_user_id: BEN,
      host_name: 'Ben Ortiz',
      other_host_ids: [AVA],
      link_id: LINK_2,
      title: 'Team call',
    }),
    // Ben's alone: Ava never sees it.
    booking({
      id: uid(7),
      starts_at: new Date(NOW + 4 * H).toISOString(),
      host_user_id: BEN,
      host_name: 'Ben Ortiz',
      title: 'Ben only',
    }),
    // Another workspace's, and an offer's (not a link's).
    booking({ id: uid(8), workspace_id: OTHER_WS }),
    booking({ id: uid(9), source: 'offer', link_id: null }),
    // An upcoming one that is already over is past.
    booking({
      id: uid(10),
      starts_at: new Date(NOW - 0.25 * H).toISOString(),
      ends_at: new Date(NOW + 0.25 * H).toISOString(),
    }),
  ]
  const tables = {
    meeting_booking: rows as unknown as Record<string, unknown>[],
  }
  return { db: memoryDb(tables), tables }
}

describe('seenBy', () => {
  it('is the organizer or an attending host, and refuses anything but a user id', () => {
    expect(seenBy(AVA)).toBe(
      `host_user_id.eq.${AVA},other_host_ids.cs.{${AVA}}`,
    )
    expect(() => seenBy('x,host_user_id.neq.0')).toThrow()
  })
})

describe('searchPattern', () => {
  it('quotes a search, keeping an email whole; no PostgREST or LIKE syntax survives', () => {
    expect(searchPattern('  Dana  ')).toBe('"*Dana*"')
    expect(searchPattern('dana@example.com')).toBe('"*dana@example.com*"')
    expect(searchPattern('a,b(c)%_*"\\d')).toBe('"*a b c d*"')
    expect(searchPattern('   ')).toBeNull()
    expect(searchPattern(null)).toBeNull()
    expect(searchPattern('x'.repeat(300))!.length).toBe(104)
  })
})

describe('listLinkBookings', () => {
  const ids = (rows: LinkBookingRow[]) => rows.map((r) => r.id)

  it("upcoming: the reader's live link bookings not yet over, soonest first, never a teammate's alone", async () => {
    const { db } = seed()
    const { rows, more } = await listLinkBookings(db, {
      workspaceId: WS,
      userId: AVA,
      view: 'upcoming',
      now: NOW,
    })
    expect(ids(rows)).toEqual([uid(10), uid(1), uid(6), uid(5), uid(2)])
    expect(more).toBe(false)
  })

  it('past: confirmed and over, newest first', async () => {
    const { db } = seed()
    const { rows } = await listLinkBookings(db, {
      workspaceId: WS,
      userId: AVA,
      view: 'past',
      now: NOW,
    })
    expect(ids(rows)).toEqual([uid(3)])
  })

  it('cancelled: closed ones', async () => {
    const { db } = seed()
    const { rows } = await listLinkBookings(db, {
      workspaceId: WS,
      userId: AVA,
      view: 'cancelled',
      now: NOW,
    })
    expect(ids(rows)).toEqual([uid(4)])
  })

  it('a teammate who hosts nothing sees nothing, whatever their role', async () => {
    const { db } = seed()
    for (const view of ['upcoming', 'past', 'cancelled'] as const) {
      expect(
        (
          await listLinkBookings(db, {
            workspaceId: WS,
            userId: CY,
            view,
            now: NOW,
          })
        ).rows,
      ).toEqual([])
    }
  })

  it('Ben sees his own and the one Ava attends, not hers', async () => {
    const { db } = seed()
    const { rows } = await listLinkBookings(db, {
      workspaceId: WS,
      userId: BEN,
      view: 'upcoming',
      now: NOW,
    })
    expect(ids(rows)).toEqual([uid(6), uid(7)])
  })

  it("searches the guest's name, email or the title, and filters by link", async () => {
    const { db } = seed()
    expect(
      ids(
        (
          await listLinkBookings(db, {
            workspaceId: WS,
            userId: AVA,
            view: 'upcoming',
            q: 'eli',
            now: NOW,
          })
        ).rows,
      ),
    ).toEqual([uid(2)])
    expect(
      ids(
        (
          await listLinkBookings(db, {
            workspaceId: WS,
            userId: AVA,
            view: 'upcoming',
            q: 'DANA@EXAMPLE.COM',
            now: NOW,
          })
        ).rows,
      ),
    ).toEqual([uid(10), uid(1), uid(6), uid(5)])
    expect(
      ids(
        (
          await listLinkBookings(db, {
            workspaceId: WS,
            userId: AVA,
            view: 'upcoming',
            q: 'team',
            now: NOW,
          })
        ).rows,
      ),
    ).toEqual([uid(6)])
    expect(
      ids(
        (
          await listLinkBookings(db, {
            workspaceId: WS,
            userId: AVA,
            view: 'upcoming',
            linkId: LINK_2,
            now: NOW,
          })
        ).rows,
      ),
    ).toEqual([uid(6)])
    expect(
      (
        await listLinkBookings(db, {
          workspaceId: WS,
          userId: AVA,
          view: 'upcoming',
          linkId: 'not-a-link',
          now: NOW,
        })
      ).rows,
    ).toEqual([])
  })

  it('pages', async () => {
    const { db } = seed()
    const first = await listLinkBookings(db, {
      workspaceId: WS,
      userId: AVA,
      view: 'upcoming',
      limit: 2,
      now: NOW,
    })
    expect(ids(first.rows)).toEqual([uid(10), uid(1)])
    expect(first.more).toBe(true)
    const last = await listLinkBookings(db, {
      workspaceId: WS,
      userId: AVA,
      view: 'upcoming',
      limit: 2,
      offset: 4,
      now: NOW,
    })
    expect(ids(last.rows)).toEqual([uid(2)])
    expect(last.more).toBe(false)
  })
})

describe('linkBookingsStarting', () => {
  it("the reader's link bookings that start in the range, capped", async () => {
    const { db } = seed()
    const read = await linkBookingsStarting(db, {
      workspaceId: WS,
      userId: AVA,
      fromIso: new Date(NOW - 10 * H).toISOString(),
      toIso: new Date(NOW + 10 * H).toISOString(),
    })
    expect(read.rows.map((r) => r.id).sort()).toEqual(
      [uid(1), uid(10), uid(3), uid(5), uid(6)].sort(),
    )
    const capped = await linkBookingsStarting(db, {
      workspaceId: WS,
      userId: AVA,
      fromIso: new Date(NOW - 10 * H).toISOString(),
      toIso: new Date(NOW + 10 * H).toISOString(),
      max: 2,
    })
    expect(capped.rows).toHaveLength(2)
    expect(capped.truncated).toBe(true)
  })
})

describe('markAttendance', () => {
  it("marks a started confirmed booking of the reader's, and clears it", async () => {
    const { db, tables } = seed()
    const done = await markAttendance(db, {
      workspaceId: WS,
      userId: AVA,
      bookingId: uid(3),
      attendance: 'no_show',
      now: NOW,
    })
    expect(done.ok).toBe(true)
    const row = tables.meeting_booking.find((r) => r.id === uid(3))!
    expect(row.attendance).toBe('no_show')
    expect(row.attendance_marked_by).toBe(AVA)
    await markAttendance(db, {
      workspaceId: WS,
      userId: AVA,
      bookingId: uid(3),
      attendance: null,
      now: NOW,
    })
    expect(row.attendance).toBeNull()
    expect(row.attendance_marked_by).toBeNull()
  })

  it('an attending host may mark it too', async () => {
    const { db } = seed()
    const later = NOW + 4 * H
    expect(
      (
        await markAttendance(db, {
          workspaceId: WS,
          userId: AVA,
          bookingId: uid(6),
          attendance: 'attended',
          now: later,
        })
      ).ok,
    ).toBe(true)
  })

  it('refuses one not yet started, one not confirmed, and anyone who is not its host', async () => {
    const { db, tables } = seed()
    expect(
      await markAttendance(db, {
        workspaceId: WS,
        userId: AVA,
        bookingId: uid(1),
        attendance: 'attended',
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: 'NOT_YET' })
    expect(
      await markAttendance(db, {
        workspaceId: WS,
        userId: AVA,
        bookingId: uid(4),
        attendance: 'attended',
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: 'NOT_CONFIRMED' })
    expect(
      await markAttendance(db, {
        workspaceId: WS,
        userId: CY,
        bookingId: uid(3),
        attendance: 'attended',
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: 'NOT_FOUND' })
    expect(
      await markAttendance(db, {
        workspaceId: OTHER_WS,
        userId: AVA,
        bookingId: uid(3),
        attendance: 'attended',
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: 'NOT_FOUND' })
    expect(
      tables.meeting_booking.find((r) => r.id === uid(3))!.attendance,
    ).toBeNull()
  })
})

describe('getSeenBooking / toBookingView', () => {
  it('reads one the reader sees and shows its link, whose it is and whether it can be marked', async () => {
    const { db } = seed()
    const row = await getSeenBooking(db, {
      workspaceId: WS,
      userId: AVA,
      bookingId: uid(6),
    })
    const view = toBookingView(row!, AVA, new Map([[LINK_2, 'Team call']]), NOW)
    expect(view).toMatchObject({
      link_title: 'Team call',
      organizer: false,
      can_mark: false,
      attendance: null,
    })
    expect(
      await getSeenBooking(db, {
        workspaceId: WS,
        userId: AVA,
        bookingId: uid(7),
      }),
    ).toBeNull()
  })
})
