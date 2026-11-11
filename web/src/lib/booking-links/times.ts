/**
 * A booking link's open times (availability phase 4a): each host's hours
 * (their working hours, src/lib/availability/schedule.ts, or the link's own)
 * minus everything busy on every calendar of theirs that counts and every
 * claim on their time (src/lib/availability/busy.ts), through the engine
 * (src/lib/availability/engine.ts freeWindows), then cut onto the link's
 * grid.
 *
 *   one   the host's free time.
 *   all   the time every host has free (intersectAll): all of them attend.
 *   any   the times any one host has free, each remembering who can take
 *         it; the booking picks the least booked of those (chooseHost).
 *
 * The link's rules: a buffer before and after (busy time is widened by the
 * buffer after on its start side and the buffer before on its end side, so
 * a meeting never starts sooner than `before` after something ends or ends
 * later than `after` before the next), the minimum notice (nothing starts
 * sooner), the window (nothing starts later than that many days out), the
 * grid (starts on multiples of the step from local midnight in the link's
 * zone; the step defaults to the length) and the daily cap (a day that has
 * as many of the link's bookings as the cap offers nothing).
 *
 * Unknown is never free: a host whose calendar can't be read (or who has no
 * calendar connected, or no longer shares their availability) makes the
 * whole answer unknown, in every mode, with nothing offered.
 *
 * {@link linkSlots} and {@link chooseHost} are pure; {@link readLinkTimes}
 * reads the hosts' calendars and the link's bookings (a flat number of reads
 * per host, never more with history).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { getServiceClient } from '@/lib/admin'
import { hasCountedCalendar, listCountedEvents } from '@/lib/availability/busy'
import type { ClaimExceptions } from '@/lib/availability/claims'
import { freeWindows, intersectAll, type AvailabilitySchedule, type Span } from '@/lib/availability/engine'
import { readWorkingHours } from '@/lib/availability/schedule'
import { readSharing } from '@/lib/availability/sharing'
import { addDays, dayKey, localDate, zonedTime } from '@/lib/availability/zone'
import { busyBlocks, type BusyBlock } from '@/lib/guests/free-busy'
import { linkBookingStarts } from './store'
import { LINK_TIMES_DAYS_MAX, LINK_TIMES_MAX, type BookingLink } from './types'

const MINUTE_MS = 60_000
const DAY_MS = 24 * 60 * MINUTE_MS

export interface LinkSlot extends Span {
  /** Who can take it: every host for one and all, the free ones for any. In the hosts' order. */
  hostIds: string[]
}

export interface HostTime {
  userId: string
  schedule: AvailabilitySchedule
  busy: readonly BusyBlock[]
}

export type LinkRules = Pick<BookingLink, 'durationMinutes' | 'bufferBeforeMinutes' | 'bufferAfterMinutes' | 'noticeMinutes' | 'windowDays' | 'stepMinutes' | 'dailyCap' | 'hostMode'>

export interface LinkSlotsInput {
  link: LinkRules
  /** In the link's host order. */
  hosts: readonly HostTime[]
  /** The zone the grid and the daily cap count days in (the organizer's). */
  timeZone: string
  now: number
  /** The range asked for: starts in [from, to). */
  from: number
  to: number
  /** The starts of the link's live bookings (for the daily cap). */
  booked?: readonly number[]
  max?: number
}

/** Busy time widened by the link's buffers: a timed block [s, e) keeps [s - after, e + before) clear. Pure. */
export function widenBusy(busy: readonly BusyBlock[], beforeMinutes: number, afterMinutes: number): BusyBlock[] {
  const before = Math.max(0, beforeMinutes) * MINUTE_MS
  const after = Math.max(0, afterMinutes) * MINUTE_MS
  return busy.map((b) => (b.allDay ? b : { start: new Date(Date.parse(b.start) - after).toISOString(), end: new Date(Date.parse(b.end) + before).toISOString() }))
}

/** Starts on the grid (multiples of `step` minutes from local midnight in `timeZone`) with room for the length inside each window. Pure. */
export function gridStarts(windows: readonly Span[], stepMinutes: number, durationMinutes: number, timeZone: string): number[] {
  const step = Math.max(1, stepMinutes) * MINUTE_MS
  const duration = Math.max(1, durationMinutes) * MINUTE_MS
  const out: number[] = []
  for (const w of [...windows].sort((a, b) => a.start - b.start)) {
    const midnight = zonedTime(localDate(w.start, timeZone), '00:00', timeZone)
    for (let start = midnight + Math.ceil((w.start - midnight) / step) * step; start + duration <= w.end; start += step) out.push(start)
  }
  return out
}

/** The local days [from, to) touches in `timeZone`, the first one and how many. Pure. */
function daysCovering(from: number, to: number, timeZone: string) {
  const firstDay = localDate(from, timeZone)
  let days = 1
  while (days < LINK_TIMES_DAYS_MAX + 2 && zonedTime(addDays(firstDay, days), '00:00', timeZone) < to) days++
  return { firstDay, days }
}

/** One host's free windows for the link in [from, to) (see the header). Pure. */
function hostWindows(host: HostTime, link: LinkRules, notBefore: number, notAfter: number): Span[] {
  // The day before, so a range that starts late in one zone sees its own day's hours.
  const { firstDay, days } = daysCovering(notBefore - DAY_MS, notAfter, host.schedule.timeZone)
  return freeWindows({
    schedule: host.schedule,
    busy: widenBusy(host.busy, link.bufferBeforeMinutes, link.bufferAfterMinutes),
    firstDay,
    days,
    minMinutes: link.durationMinutes,
    notBefore,
    notAfter,
  })
}

/** The link's open times (see the header), soonest first. Pure. */
export function linkSlots(input: LinkSlotsInput): LinkSlot[] {
  const { link, timeZone } = input
  if (!input.hosts.length) return []
  const notBefore = Math.max(input.from, input.now + link.noticeMinutes * MINUTE_MS)
  const lastStart = Math.min(input.to - 1, input.now + link.windowDays * DAY_MS)
  if (lastStart < notBefore) return []
  const duration = link.durationMinutes
  // A window may run past the last start by the meeting's length.
  const notAfter = lastStart + duration * MINUTE_MS
  const step = link.stepMinutes ?? duration
  const keep = (start: number) => start >= notBefore && start <= lastStart

  let slots: LinkSlot[]
  if (link.hostMode === 'any') {
    const byStart = new Map<number, string[]>()
    for (const host of input.hosts) {
      for (const start of gridStarts(hostWindows(host, link, notBefore, notAfter), step, duration, timeZone)) {
        if (!keep(start)) continue
        byStart.set(start, [...(byStart.get(start) ?? []), host.userId])
      }
    }
    slots = [...byStart.entries()].sort((a, b) => a[0] - b[0]).map(([start, hostIds]) => ({ start, end: start + duration * MINUTE_MS, hostIds }))
  } else {
    const hosts = link.hostMode === 'one' ? input.hosts.slice(0, 1) : input.hosts
    const common = intersectAll(hosts.map((h) => hostWindows(h, link, notBefore, notAfter)))
    const hostIds = hosts.map((h) => h.userId)
    slots = gridStarts(common, step, duration, timeZone)
      .filter(keep)
      .map((start) => ({ start, end: start + duration * MINUTE_MS, hostIds }))
  }

  if (link.dailyCap) {
    const perDay = new Map<string, number>()
    for (const at of input.booked ?? []) {
      const key = dayKey(localDate(at, timeZone))
      perDay.set(key, (perDay.get(key) ?? 0) + 1)
    }
    const cap = link.dailyCap
    slots = slots.filter((s) => (perDay.get(dayKey(localDate(s.start, timeZone))) ?? 0) < cap)
  }
  return slots.slice(0, input.max ?? LINK_TIMES_MAX)
}

/**
 * The host an `any` booking goes to: of those who can take the time, the one
 * with the fewest bookings in the coming window, ties by the link's order.
 * Pure.
 */
export function chooseHost(candidates: readonly string[], load: ReadonlyMap<string, number>, order: readonly string[]): string | null {
  if (!candidates.length) return null
  const rank = (id: string) => {
    const at = order.indexOf(id)
    return at === -1 ? Number.MAX_SAFE_INTEGER : at
  }
  return [...candidates].sort((a, b) => (load.get(a) ?? 0) - (load.get(b) ?? 0) || rank(a) - rank(b))[0]
}

// ── Reading ─────────────────────────────────────────────────────────────────

export type LinkTimesResult = { known: true; timeZone: string; slots: LinkSlot[] } | { known: false; reason: string }

export interface ReadLinkTimesDeps {
  supabase?: SupabaseClient
  now?: () => number
  listEvents?: typeof listCountedEvents
  hasCalendar?: (userId: string, workspaceId: string) => Promise<boolean>
  readHours?: (userId: string, workspaceId: string) => Promise<AvailabilitySchedule>
  /** Whether a host other than the link's owner still shares their availability (default: their member row). */
  shares?: (userId: string, workspaceId: string) => Promise<boolean>
  bookedStarts?: (linkId: string, fromIso: string, toIso: string) => Promise<number[]>
  /** Claims the read leaves out: a booking's own while the host's yes re-checks it. */
  exceptClaims?: ClaimExceptions
}

/** A reason a guest may read: what kind of thing went wrong, never a provider's words or whose calendar. */
const UNKNOWN = "The calendar couldn't be checked just now."

/**
 * The link's open times in [from, to) (see the header): known, or unknown
 * when any host's calendar can't be read. The organizer (the first host)
 * sets the zone. `from`/`to` are clipped to LINK_TIMES_DAYS_MAX days.
 */
export async function readLinkTimes(link: BookingLink, range: { from: number; to: number }, deps: ReadLinkTimesDeps = {}): Promise<LinkTimesResult> {
  const supabase = deps.supabase ?? getServiceClient()
  const now = (deps.now ?? Date.now)()
  const hosts = link.hosts.length ? link.hosts.map((h) => h.userId) : [link.ownerUserId]
  const ws = link.workspaceId
  const from = Math.max(range.from, now)
  const to = Math.min(range.to, from + LINK_TIMES_DAYS_MAX * DAY_MS)
  const readHours = deps.readHours ?? ((userId: string, workspaceId: string) => readWorkingHours(supabase, { userId, workspaceId }))
  const hasCalendar = deps.hasCalendar ?? ((userId: string, workspaceId: string) => hasCountedCalendar(userId, workspaceId, { supabase }))
  const shares = deps.shares ?? (async (userId: string, workspaceId: string) => (await readSharing(supabase, { userId, workspaceId })) !== 'none')

  const reads = await Promise.all(
    hosts.map(async (userId): Promise<HostTime | null> => {
      try {
        if (userId !== link.ownerUserId && !(await shares(userId, ws))) return null
        const schedule: AvailabilitySchedule = link.weeklyHours
          ? { timeZone: link.timeZone ?? (await readHours(userId, ws)).timeZone, weekly: link.weeklyHours }
          : await readHours(userId, ws)
        if (!(await hasCalendar(userId, ws))) return null
        // The day before and after, so an all-day event's UTC midnights are seen.
        const timeMin = new Date(from - DAY_MS).toISOString()
        const timeMax = new Date(to + DAY_MS + link.durationMinutes * MINUTE_MS).toISOString()
        const events = await (deps.listEvents ?? listCountedEvents)(userId, { timeMin, timeMax, maxResults: 1000, workspaceId: ws, strict: true, exceptClaims: deps.exceptClaims })
        return { userId, schedule, busy: busyBlocks(events, timeMin, timeMax) }
      } catch (err) {
        console.warn(`[booking-links] link=${link.id} a host's time could not be read:`, err instanceof Error ? err.message : String(err))
        return null
      }
    }),
  )
  if (reads.some((r) => r === null)) return { known: false, reason: UNKNOWN }
  const hostTimes = reads as HostTime[]
  const timeZone = hostTimes[0].schedule.timeZone
  let booked: number[] = []
  if (link.dailyCap) {
    try {
      booked = await (deps.bookedStarts ?? ((id, a, b) => linkBookingStarts(supabase, id, a, b)))(link.id, new Date(from - DAY_MS).toISOString(), new Date(to + DAY_MS).toISOString())
    } catch {
      return { known: false, reason: UNKNOWN }
    }
  }
  return { known: true, timeZone, slots: linkSlots({ link, hosts: hostTimes, timeZone, now, from, to, booked }) }
}
