/**
 * The account API of link bookings (booking insights, phases 1 and 2): what
 * Settings › Availability's Bookings and Insights tabs read, signed in, for
 * the caller's current workspace. Each route under /api/account/link-bookings
 * is a thin call into a handler here, pure over {@link BookingsDeps}.
 *
 *   GET   /api/account/link-bookings?view=upcoming|past|cancelled&q=&link=&offset=  → { bookings, more, links }
 *   PATCH /api/account/link-bookings/<id>/attendance { attendance: 'attended'|'no_show'|null } → { booking }
 *   GET   /api/account/link-bookings/insights?days=7|30|90 | from=&to= &tz=&link=     → { insights }
 *   GET   /api/account/link-bookings/export?…the same range…                        → text/csv
 *
 * Who sees what is ./bookings.ts's rule: the caller's own bookings (they
 * organize or attend), never a teammate's. `links` is the filter's choices:
 * the workspace's links the caller hosts or owns, and those their bookings
 * name.
 *
 * Server only.
 */
import { badRequest, notFound, serverError } from '@/lib/api-errors'
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import {
  ATTENDANCE,
  BOOKING_VIEWS,
  linkBookingsStarting,
  listLinkBookings,
  markAttendance,
  toBookingView,
  type BookingView,
} from './bookings'
import {
  bookingInsights,
  bookingsCsv,
  INSIGHT_ROWS_MAX,
  insightRange,
} from './insights'
import { listLinks } from './store'

export interface BookingsDeps {
  supabase: SupabaseClient
  now?: () => number
}

export interface Reader {
  workspaceId: string
  userId: string
}

const PRIVATE = { 'Cache-Control': 'private, no-store' }

/** The workspace's link titles, and the links the reader hosts or owns (the filter's choices). */
async function linkIndex(deps: BookingsDeps, reader: Reader) {
  const links = await listLinks(deps.supabase, {
    workspaceId: reader.workspaceId,
    limit: 200,
  })
  const titles = new Map(links.map((l) => [l.id, l.title]))
  const mine = links
    .filter(
      (l) =>
        l.ownerUserId === reader.userId ||
        l.hosts.some((h) => h.userId === reader.userId),
    )
    .map((l) => ({ id: l.id, title: l.title, active: l.active }))
  return { titles, mine }
}

/** GET /api/account/link-bookings. */
export async function handleListBookings(
  request: Request,
  reader: Reader,
  deps: BookingsDeps,
): Promise<Response> {
  const url = new URL(request.url)
  const view = (url.searchParams.get('view') ?? 'upcoming') as BookingView
  if (!(BOOKING_VIEWS as readonly string[]).includes(view))
    return badRequest('view is upcoming, past or cancelled.')
  const offset = Number(url.searchParams.get('offset') ?? 0)
  if (!Number.isInteger(offset) || offset < 0 || offset > 10_000)
    return badRequest('offset is a whole number.')
  try {
    const now = (deps.now ?? Date.now)()
    const [{ rows, more }, { titles, mine }] = await Promise.all([
      listLinkBookings(deps.supabase, {
        ...reader,
        view,
        q: url.searchParams.get('q'),
        linkId: url.searchParams.get('link') || null,
        offset,
        limit: 50,
        now,
      }),
      linkIndex(deps, reader),
    ])
    return Response.json(
      {
        bookings: rows.map((r) => toBookingView(r, reader.userId, titles, now)),
        more,
        links: mine,
      },
      { headers: PRIVATE },
    )
  } catch (err) {
    return serverError(
      err instanceof Error ? err.message : 'Could not read the bookings',
    )
  }
}

const attendanceInput = z.object({ attendance: z.enum(ATTENDANCE).nullable() })

/** PATCH /api/account/link-bookings/<id>/attendance. */
export async function handleMarkAttendance(
  request: Request,
  bookingId: string,
  reader: Reader,
  deps: BookingsDeps,
): Promise<Response> {
  const body = (await request.json().catch(() => null)) as unknown
  const parsed = attendanceInput.safeParse(body)
  if (!parsed.success)
    return badRequest("attendance is 'attended', 'no_show' or null.")
  const now = (deps.now ?? Date.now)()
  const result = await markAttendance(deps.supabase, {
    ...reader,
    bookingId,
    attendance: parsed.data.attendance,
    now,
  })
  if (!result.ok) {
    if (result.code === 'NOT_FOUND') return notFound(result.message)
    if (result.code === 'FAILED') return serverError(result.message)
    return badRequest(result.message)
  }
  try {
    const { titles } = await linkIndex(deps, reader)
    return Response.json(
      { booking: toBookingView(result.booking, reader.userId, titles, now) },
      { headers: PRIVATE },
    )
  } catch {
    return Response.json(
      { booking: toBookingView(result.booking, reader.userId, new Map(), now) },
      { headers: PRIVATE },
    )
  }
}

function rangeOf(url: URL, now: number) {
  const p = url.searchParams
  return insightRange(
    {
      days: p.get('days'),
      from: p.get('from'),
      to: p.get('to'),
      tz: p.get('tz'),
    },
    now,
  )
}

/** GET /api/account/link-bookings/insights. */
export async function handleInsights(
  request: Request,
  reader: Reader,
  deps: BookingsDeps,
): Promise<Response> {
  const url = new URL(request.url)
  const range = rangeOf(url, (deps.now ?? Date.now)())
  if (!range.ok) return badRequest(range.error)
  try {
    const [read, { titles, mine }] = await Promise.all([
      linkBookingsStarting(deps.supabase, {
        ...reader,
        fromIso: new Date(range.from).toISOString(),
        toIso: new Date(range.to).toISOString(),
        linkId: url.searchParams.get('link') || null,
        max: INSIGHT_ROWS_MAX,
      }),
      linkIndex(deps, reader),
    ])
    return Response.json(
      {
        insights: bookingInsights(read.rows, {
          from: range.from,
          to: range.to,
          timeZone: range.timeZone,
          titles,
          truncated: read.truncated,
        }),
        links: mine,
      },
      { headers: PRIVATE },
    )
  } catch (err) {
    return serverError(
      err instanceof Error ? err.message : 'Could not read the insights',
    )
  }
}

/** GET /api/account/link-bookings/export: the range's bookings as CSV. */
export async function handleExport(
  request: Request,
  reader: Reader,
  deps: BookingsDeps,
): Promise<Response> {
  const url = new URL(request.url)
  const range = rangeOf(url, (deps.now ?? Date.now)())
  if (!range.ok) return badRequest(range.error)
  try {
    const [read, { titles }] = await Promise.all([
      linkBookingsStarting(deps.supabase, {
        ...reader,
        fromIso: new Date(range.from).toISOString(),
        toIso: new Date(range.to).toISOString(),
        linkId: url.searchParams.get('link') || null,
        max: INSIGHT_ROWS_MAX,
      }),
      linkIndex(deps, reader),
    ])
    const name = `bookings-${new Date(range.from).toISOString().slice(0, 10)}.csv`
    return new Response(bookingsCsv(read.rows, titles), {
      headers: {
        ...PRIVATE,
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${name}"`,
      },
    })
  } catch (err) {
    return serverError(
      err instanceof Error ? err.message : 'Could not export the bookings',
    )
  }
}
