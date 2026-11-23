/**
 * The bookings booking links made (booking insights, phase 1): the Bookings
 * tab of Settings › Availability, its agent tool (list_link_bookings) and the
 * attendance a host marks on a past one (migration 705).
 *
 * Who sees a booking is today's rule, never wider: its organizer
 * (host_user_id) or a host who attends it (other_host_ids). A workspace owner
 * or admin sees no more of a teammate's bookings than anyone else
 * (docs/plans/booking-insights.md, Decision 1). Every read here is fenced by
 * the workspace AND that rule in the same query ({@link seenBy}).
 *
 *   upcoming   live (requested, booking, confirmed) and not yet ended, soonest first.
 *   past       confirmed and ended, newest first: what attendance is marked on.
 *   cancelled  cancelled, declined or expired, newest first.
 *
 * A search matches the guest's name, email or the booking's title; a link
 * filter narrows to one link. Paged by offset (PAGE_MAX at most).
 *
 * Server only; service role. Throws on a failed read; markAttendance answers
 * a result.
 */
import type {
  BookingAnswer,
  MeetingBookingState,
} from '@/lib/time-offers/types'
import type { SupabaseClient } from '@supabase/supabase-js'

export const BOOKING_VIEWS = ['upcoming', 'past', 'cancelled'] as const
export type BookingView = (typeof BOOKING_VIEWS)[number]

export const ATTENDANCE = ['attended', 'no_show'] as const
export type Attendance = (typeof ATTENDANCE)[number]

export const BOOKINGS_PAGE_MAX = 100
export const BOOKING_SEARCH_MAX = 100

const LIVE: MeetingBookingState[] = ['requested', 'booking', 'confirmed']
const CLOSED: MeetingBookingState[] = ['cancelled', 'declined', 'expired']
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const LINK_BOOKING_COLUMNS =
  'id, workspace_id, host_user_id, host_name, source, link_id, guest_name, guest_email, guest_phone, guest_time_zone, title, starts_at, ends_at, state, video, location, conference_url, answers, other_host_ids, cancelled_by, attendance, attendance_marked_at, created_at'

export interface LinkBookingRow {
  id: string
  workspace_id: string
  host_user_id: string
  host_name: string
  source: string
  link_id: string | null
  guest_name: string
  guest_email: string | null
  guest_phone: string | null
  guest_time_zone: string | null
  title: string
  starts_at: string
  ends_at: string
  state: MeetingBookingState
  video: boolean
  location: string | null
  conference_url: string | null
  answers: unknown
  other_host_ids: string[] | null
  cancelled_by: 'guest' | 'host' | null
  attendance?: Attendance | null
  attendance_marked_at?: string | null
  created_at: string
}

/** One booking as the tab, the API and the tool show it. Guests' words are theirs: the tool fences them. */
export interface LinkBookingView {
  id: string
  link_id: string | null
  link_title: string | null
  title: string
  guest_name: string
  guest_email: string | null
  guest_phone: string | null
  guest_time_zone: string | null
  starts_at: string
  ends_at: string
  state: MeetingBookingState
  /** Only a past confirmed booking carries one. */
  attendance: Attendance | null
  /** Whether attendance can be marked now: confirmed, and started. */
  can_mark: boolean
  host_name: string
  /** Whether the reader organizes it (else they attend as another host). */
  organizer: boolean
  video: boolean
  location: string | null
  conference_url: string | null
  cancelled_by: 'guest' | 'host' | null
  answers: BookingAnswer[]
  created_at: string
}

/** The visibility rule as a PostgREST or: the organizer, or an attending host. Throws on an id of the wrong shape (never interpolated). Pure. */
export function seenBy(userId: string): string {
  if (!UUID.test(userId)) throw new Error('seenBy: not a user id')
  return `host_user_id.eq.${userId},other_host_ids.cs.{${userId}}`
}

/** Whether `userId` may see this booking (the same rule, on a row in hand). Pure. */
export function sees(
  row: Pick<LinkBookingRow, 'host_user_id' | 'other_host_ids'>,
  userId: string,
): boolean {
  return (
    row.host_user_id === userId || (row.other_host_ids ?? []).includes(userId)
  )
}

/**
 * A search as a quoted ilike pattern for a PostgREST `or`: trimmed, at most
 * BOOKING_SEARCH_MAX, quoted (so an email's dots and an @ stay as typed), and
 * every character the quotes or LIKE would read (`% _ * , ( ) \ "`) made a
 * space, so a search is only ever text to match. Null when nothing is left. Pure.
 */
export function searchPattern(q: string | null | undefined): string | null {
  const cleaned = (q ?? '')
    .slice(0, BOOKING_SEARCH_MAX)
    .replace(/[%_*,()\\"]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned ? `"*${cleaned}*"` : null
}

export function readAnswers(value: unknown): BookingAnswer[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((a): a is Record<string, unknown> => !!a && typeof a === 'object')
    .filter((a) => typeof a.label === 'string' && typeof a.answer === 'string')
    .map((a) => ({
      id: typeof a.id === 'string' ? a.id : '',
      label: a.label as string,
      answer: a.answer as string,
    }))
}

/** Whether attendance can be marked on it at `now`: confirmed, and started. Pure. */
export function markable(
  row: Pick<LinkBookingRow, 'state' | 'starts_at'>,
  now: number,
): boolean {
  return row.state === 'confirmed' && Date.parse(row.starts_at) <= now
}

export function toBookingView(
  row: LinkBookingRow,
  userId: string,
  titles: ReadonlyMap<string, string>,
  now: number,
): LinkBookingView {
  return {
    id: row.id,
    link_id: row.link_id,
    link_title: row.link_id ? (titles.get(row.link_id) ?? null) : null,
    title: row.title,
    guest_name: row.guest_name,
    guest_email: row.guest_email,
    guest_phone: row.guest_phone,
    guest_time_zone: row.guest_time_zone,
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    state: row.state,
    attendance: row.state === 'confirmed' ? (row.attendance ?? null) : null,
    can_mark: markable(row, now),
    host_name: row.host_name,
    organizer: row.host_user_id === userId,
    video: row.video,
    location: row.location,
    conference_url: row.conference_url,
    cancelled_by: row.cancelled_by,
    answers: readAnswers(row.answers),
    created_at: row.created_at,
  }
}

export interface ListLinkBookingsArgs {
  workspaceId: string
  userId: string
  view: BookingView
  q?: string | null
  linkId?: string | null
  offset?: number
  limit?: number
  now?: number
}

/** One page of the reader's link bookings in a view (see the header), and whether more follow. */
export async function listLinkBookings(
  supabase: SupabaseClient,
  args: ListLinkBookingsArgs,
): Promise<{ rows: LinkBookingRow[]; more: boolean }> {
  const now = new Date(args.now ?? Date.now()).toISOString()
  const limit = Math.min(Math.max(1, args.limit ?? 50), BOOKINGS_PAGE_MAX)
  const offset = Math.max(0, Math.floor(args.offset ?? 0))
  let query = supabase
    .from('meeting_booking')
    .select(LINK_BOOKING_COLUMNS)
    .eq('workspace_id', args.workspaceId)
    .eq('source', 'link')
    .or(seenBy(args.userId))
  if (args.view === 'upcoming')
    query = query.in('state', LIVE).gt('ends_at', now)
  else if (args.view === 'past')
    query = query.eq('state', 'confirmed').lte('ends_at', now)
  else query = query.in('state', CLOSED)
  if (args.linkId) {
    if (!UUID.test(args.linkId)) return { rows: [], more: false }
    query = query.eq('link_id', args.linkId)
  }
  const pattern = searchPattern(args.q)
  if (pattern)
    query = query.or(
      `guest_name.ilike.${pattern},guest_email.ilike.${pattern},title.ilike.${pattern}`,
    )
  const { data, error } = await query
    .order('starts_at', { ascending: args.view === 'upcoming' })
    .range(offset, offset + limit)
  if (error) throw new Error(`meeting_booking read failed: ${error.message}`)
  const rows = (data as LinkBookingRow[] | null) ?? []
  return { rows: rows.slice(0, limit), more: rows.length > limit }
}

/** The reader's link bookings that start in [fromIso, toIso), at most `max` (and whether that cut some off): what insights count. */
export async function linkBookingsStarting(
  supabase: SupabaseClient,
  args: {
    workspaceId: string
    userId: string
    fromIso: string
    toIso: string
    linkId?: string | null
    max?: number
  },
): Promise<{ rows: LinkBookingRow[]; truncated: boolean }> {
  const max = args.max ?? 5000
  let query = supabase
    .from('meeting_booking')
    .select(LINK_BOOKING_COLUMNS)
    .eq('workspace_id', args.workspaceId)
    .eq('source', 'link')
    .or(seenBy(args.userId))
    .gte('starts_at', args.fromIso)
    .lt('starts_at', args.toIso)
  if (args.linkId) {
    if (!UUID.test(args.linkId)) return { rows: [], truncated: false }
    query = query.eq('link_id', args.linkId)
  }
  const { data, error } = await query
    .order('starts_at', { ascending: true })
    .limit(max + 1)
  if (error) throw new Error(`meeting_booking read failed: ${error.message}`)
  const rows = (data as LinkBookingRow[] | null) ?? []
  return { rows: rows.slice(0, max), truncated: rows.length > max }
}

/** One booking the reader sees, or null (not theirs, not a link's, another workspace's). */
export async function getSeenBooking(
  supabase: SupabaseClient,
  args: { workspaceId: string; userId: string; bookingId: string },
): Promise<LinkBookingRow | null> {
  if (!UUID.test(args.bookingId)) return null
  const { data, error } = await supabase
    .from('meeting_booking')
    .select(LINK_BOOKING_COLUMNS)
    .eq('id', args.bookingId)
    .eq('workspace_id', args.workspaceId)
    .eq('source', 'link')
    .or(seenBy(args.userId))
    .maybeSingle<LinkBookingRow>()
  if (error) throw new Error(`meeting_booking read failed: ${error.message}`)
  return data && sees(data, args.userId) ? data : null
}

export type AttendanceResult =
  | { ok: true; booking: LinkBookingRow }
  | {
      ok: false
      code: 'NOT_FOUND' | 'NOT_YET' | 'NOT_CONFIRMED' | 'FAILED'
      message: string
    }

/**
 * Mark a booking attended or a no-show (null clears it): one the reader
 * sees, confirmed, and started. The write is fenced on the same (state
 * confirmed, the reader still one of its hosts), so a booking cancelled
 * or handed on in between is never marked. Never throws.
 */
export async function markAttendance(
  supabase: SupabaseClient,
  args: {
    workspaceId: string
    userId: string
    bookingId: string
    attendance: Attendance | null
    now?: number
  },
): Promise<AttendanceResult> {
  const now = args.now ?? Date.now()
  try {
    const row = await getSeenBooking(supabase, args)
    if (!row)
      return {
        ok: false,
        code: 'NOT_FOUND',
        message: 'No booking of yours with that id in this workspace.',
      }
    if (row.state !== 'confirmed')
      return {
        ok: false,
        code: 'NOT_CONFIRMED',
        message: 'Only a confirmed booking is marked attended or a no-show.',
      }
    if (Date.parse(row.starts_at) > now)
      return {
        ok: false,
        code: 'NOT_YET',
        message: "It hasn't started yet: mark it once it has.",
      }
    const { data, error } = await supabase
      .from('meeting_booking')
      .update({
        attendance: args.attendance,
        attendance_marked_at: args.attendance
          ? new Date(now).toISOString()
          : null,
        attendance_marked_by: args.attendance ? args.userId : null,
        updated_at: new Date(now).toISOString(),
      })
      .eq('id', row.id)
      .eq('workspace_id', args.workspaceId)
      .eq('state', 'confirmed')
      .or(seenBy(args.userId))
      .select(LINK_BOOKING_COLUMNS)
    if (error) return { ok: false, code: 'FAILED', message: error.message }
    const updated = ((data as LinkBookingRow[] | null) ?? [])[0]
    return updated
      ? { ok: true, booking: updated }
      : {
          ok: false,
          code: 'NOT_FOUND',
          message: 'That booking changed just now: read it again.',
        }
  } catch (err) {
    return {
      ok: false,
      code: 'FAILED',
      message: err instanceof Error ? err.message : String(err),
    }
  }
}
