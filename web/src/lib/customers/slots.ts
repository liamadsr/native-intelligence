/**
 * Open slots for a job (roadmap B4): the business's booking days and hours
 * (business_profile), cut into slots of its length, minus what is too soon
 * (its lead time), what the owner's calendar has busy, and every live
 * booking (requested or confirmed). Times are worked in the business's zone,
 * so a slot is 10:00 there across a daylight-saving change.
 *
 * An all-day event counts as a busy day (a day off, travel): never offered.
 * It blocks each local day it covers for at least half the day: a provider's
 * all-day event comes as UTC midnights (Google's dates), which in New York
 * start the evening before, and that evening must not block the day before.
 * The calendar is read as busy blocks only (src/lib/guests/free-busy.ts):
 * nothing about an event ever reaches a customer. It is read strictly (a
 * calendar account that can't be read throws: a time is never "free" on a
 * failed read), over just the days asked for, never past the horizon.
 *
 * {@link openSlots} is pure; {@link findOpenSlots} reads the calendar and the
 * bookings.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { listCalendarEventsUnified } from '@/lib/integrations/calendar'
import { readMemberTimeZone } from '@/lib/agent-events/member-time-zone'
import { busyBlocks, type BusyBlock } from '@/lib/guests/free-busy'
import { getBusinessProfile, liveBookingsBetween } from './store'
import { BOOKING_REQUEST_TTL_MS, type BusinessProfile, type CustomerBooking, type OpenSlot } from './types'

const DAY_MS = 24 * 60 * 60_000
/** The most slots one call returns. */
export const OPEN_SLOTS_MAX = 40
/** The most days one call looks at. */
export const OPEN_SLOT_DAYS_MAX = 14

/** The booking rules a business without a profile gets: weekdays 9 to 5, hour-long, a day ahead, two weeks out. */
export const DEFAULT_BOOKING_RULES: Pick<BusinessProfile, 'bookingDays' | 'bookingStart' | 'bookingEnd' | 'slotMinutes' | 'leadHours' | 'horizonDays' | 'bookingKind'> = {
  bookingDays: [1, 2, 3, 4, 5],
  bookingStart: '09:00',
  bookingEnd: '17:00',
  slotMinutes: 60,
  leadHours: 24,
  horizonDays: 14,
  bookingKind: 'pickup',
}

export type BookingRules = typeof DEFAULT_BOOKING_RULES

/** The zone's offset from UTC at `at`, in ms (positive east of UTC). */
function offsetAt(at: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(at))
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value)
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - at
}

/** A wall-clock time in `timeZone` as an instant (DST-correct: the offset is read at the instant itself). Pure. */
export function zonedTime(date: { y: number; m: number; d: number }, clock: string, timeZone: string): number {
  const [h, min] = clock.split(':').map(Number)
  const wall = Date.UTC(date.y, date.m - 1, date.d, h, min)
  let at = wall - offsetAt(wall, timeZone)
  // A second pass settles a guess that landed across a daylight-saving change.
  at = wall - offsetAt(at, timeZone)
  return at
}

/** The local calendar date of `at` in `timeZone`, and its weekday (0 Sunday). Pure. */
export function localDate(at: number, timeZone: string): { y: number; m: number; d: number; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' }).formatToParts(new Date(at))
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'))
  return { y: Number(get('year')), m: Number(get('month')), d: Number(get('day')), weekday }
}

function addDays(date: { y: number; m: number; d: number }, n: number): { y: number; m: number; d: number; weekday: number } {
  const utc = new Date(Date.UTC(date.y, date.m - 1, date.d + n))
  return { y: utc.getUTCFullYear(), m: utc.getUTCMonth() + 1, d: utc.getUTCDate(), weekday: utc.getUTCDay() }
}

const HALF_DAY_MS = 12 * 60 * 60_000

/** Whether an all-day block takes the local day [dayStart, dayEnd): it covers half of it or more. Pure. */
export function allDayTakes(block: { start: number; end: number }, dayStart: number, dayEnd: number): boolean {
  return Math.min(block.end, dayEnd) - Math.max(block.start, dayStart) >= Math.min(HALF_DAY_MS, dayEnd - dayStart)
}

function clockMinutes(clock: string): number {
  const [h, m] = clock.split(':').map(Number)
  return h * 60 + m
}

function minutesClock(total: number): string {
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

export interface OpenSlotsInput {
  rules: BookingRules
  timeZone: string
  now: number
  busy: readonly BusyBlock[]
  bookings: readonly Pick<CustomerBooking, 'startsAt' | 'endsAt'>[]
  /** First local day to look at (YYYY-MM-DD); default today. */
  fromDate?: string | null
  /** Days from there; default 7, at most OPEN_SLOT_DAYS_MAX. */
  days?: number
  max?: number
}

/** The open slots (see the header), soonest first. Pure. */
export function openSlots(input: OpenSlotsInput): OpenSlot[] {
  const { rules, timeZone, now } = input
  const slotMs = rules.slotMinutes * 60_000
  const earliest = now + rules.leadHours * 60 * 60_000
  const latest = now + rules.horizonDays * DAY_MS
  const days = Math.max(1, Math.min(OPEN_SLOT_DAYS_MAX, Math.round(input.days ?? 7)))
  const max = Math.max(1, Math.min(OPEN_SLOTS_MAX, input.max ?? OPEN_SLOTS_MAX))
  const fromMatch = input.fromDate ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.fromDate) : null
  const today = localDate(now, timeZone)
  const start = fromMatch ? { y: Number(fromMatch[1]), m: Number(fromMatch[2]), d: Number(fromMatch[3]) } : today

  const timed = input.busy.filter((b) => !b.allDay).map((b) => [Date.parse(b.start), Date.parse(b.end)] as const)
  const allDay = input.busy.filter((b) => b.allDay).map((b) => [Date.parse(b.start), Date.parse(b.end)] as const)
  const held = input.bookings.map((b) => [Date.parse(b.startsAt), Date.parse(b.endsAt)] as const)
  const overlaps = (blocks: ReadonlyArray<readonly [number, number]>, from: number, to: number) => blocks.some(([s, e]) => s < to && e > from)

  const days0 = clockMinutes(rules.bookingStart)
  const days1 = clockMinutes(rules.bookingEnd)
  const out: OpenSlot[] = []
  for (let i = 0; i < days && out.length < max; i++) {
    const day = addDays(start, i)
    if (!rules.bookingDays.includes(day.weekday)) continue
    const dayStart = zonedTime(day, '00:00', timeZone)
    const dayEnd = zonedTime(addDays(day, 1), '00:00', timeZone)
    // An all-day event (a day off, travel) takes the whole day.
    if (allDay.some(([s, e]) => allDayTakes({ start: s, end: e }, dayStart, dayEnd))) continue
    for (let m = days0; m + rules.slotMinutes <= days1 && out.length < max; m += rules.slotMinutes) {
      const from = zonedTime(day, minutesClock(m), timeZone)
      const to = from + slotMs
      if (from < earliest || from > latest) continue
      if (overlaps(timed, from, to) || overlaps(held, from, to)) continue
      out.push({ start: new Date(from).toISOString(), end: new Date(to).toISOString() })
    }
  }
  return out
}

const LOCAL_START = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::00)?$/

/** A wall-clock start in `timeZone` as an instant, or null when that local time doesn't exist there (a bad date, a skipped hour). Pure. */
export function localStartInstant(start: string, timeZone: string): number | null {
  const m = LOCAL_START.exec(start)
  if (!m) return null
  const [y, mo, d, h, mi] = m.slice(1).map(Number)
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null
  const clock = `${m[4]}:${m[5]}`
  const at = zonedTime({ y, m: mo, d }, clock, timeZone)
  // Read back: a date that doesn't exist (Feb 30) or an hour the clocks skip lands elsewhere.
  const back = localDate(at, timeZone)
  const backClock = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).format(new Date(at))
  return back.y === y && back.m === mo && back.d === d && backClock === clock ? at : null
}

/** A slot as a customer reads it: "Tue, Nov 3, 10:00 AM". Pure. */
export function slotLabel(startIso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(startIso))
  } catch {
    return startIso
  }
}

export interface BusinessBookingSetup {
  rules: BookingRules
  timeZone: string
  profile: BusinessProfile | null
}

/** The business's booking rules and zone (its profile's, else the defaults and the owner's zone). Throws on a failed read. */
export async function bookingSetup(supabase: SupabaseClient, business: { workspaceId: string; ownerUserId: string }): Promise<BusinessBookingSetup> {
  const profile = await getBusinessProfile(supabase, business.workspaceId)
  const timeZone = profile?.timeZone ?? (await readMemberTimeZone(supabase, { workspaceId: business.workspaceId, userId: business.ownerUserId })).timeZone
  const rules: BookingRules = profile
    ? { bookingDays: profile.bookingDays, bookingStart: profile.bookingStart, bookingEnd: profile.bookingEnd, slotMinutes: profile.slotMinutes, leadHours: profile.leadHours, horizonDays: profile.horizonDays, bookingKind: profile.bookingKind }
    : DEFAULT_BOOKING_RULES
  return { rules, timeZone, profile }
}

/**
 * The instants the asked-for days span in the business's zone, from now at
 * the earliest, to the horizon at the latest (with the day before for an
 * all-day event's UTC midnight). Null when they are all past the horizon.
 * Pure.
 */
export function slotWindow(range: { fromDate?: string | null; days?: number }, setup: Pick<BusinessBookingSetup, 'rules' | 'timeZone'>, now: number): { from: number; to: number } | null {
  const days = Math.max(1, Math.min(OPEN_SLOT_DAYS_MAX, Math.round(range.days ?? 7)))
  const m = range.fromDate ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(range.fromDate) : null
  const first = m ? { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) } : localDate(now, setup.timeZone)
  const from = Math.max(now, zonedTime(first, '00:00', setup.timeZone)) - DAY_MS
  const to = Math.min(zonedTime(addDays(first, days), '00:00', setup.timeZone), now + setup.rules.horizonDays * DAY_MS + DAY_MS) + DAY_MS
  return to > from + DAY_MS ? { from, to } : null
}

export interface FindOpenSlotsDeps {
  listEvents?: typeof listCalendarEventsUnified
  now?: () => number
  /** What a move leaves behind: the booking being moved and its own calendar event never block its new time. */
  except?: { bookingId?: string | null; eventId?: string | null }
}

/**
 * The business's open slots from its owner's calendar and its bookings.
 * Throws when the calendar can't be read (a slot offered blind could be
 * double-booked).
 */
export async function findOpenSlots(
  supabase: SupabaseClient,
  business: { workspaceId: string; ownerUserId: string },
  range: { fromDate?: string | null; days?: number; max?: number } = {},
  deps: FindOpenSlotsDeps = {},
): Promise<{ slots: OpenSlot[]; timeZone: string; rules: BookingRules }> {
  const now = (deps.now ?? Date.now)()
  const setup = await bookingSetup(supabase, business)
  // The calendar is read over exactly the days asked for (never past the
  // horizon), strictly: a calendar that can't be read throws, so no time is
  // ever offered as free on a failed read.
  const window = slotWindow(range, setup, now)
  if (!window) return { slots: [], timeZone: setup.timeZone, rules: setup.rules }
  const timeMin = new Date(window.from).toISOString()
  const timeMax = new Date(window.to).toISOString()
  const [events, bookings] = await Promise.all([
    (deps.listEvents ?? listCalendarEventsUnified)(business.ownerUserId, { timeMin, timeMax, maxResults: 500, workspaceId: business.workspaceId, strict: true }),
    liveBookingsBetween(supabase, business.workspaceId, timeMin, timeMax),
  ])
  // A request the owner never answered lapses with its approval: its slot is open again.
  const staleBefore = now - BOOKING_REQUEST_TTL_MS
  const live = bookings.filter((b) => b.id !== deps.except?.bookingId && (b.state === 'confirmed' || Date.parse(b.createdAt) > staleBefore))
  const busy = busyBlocks(deps.except?.eventId ? events.filter((e) => e.id !== deps.except?.eventId) : events, timeMin, timeMax)
  const slots = openSlots({ rules: setup.rules, timeZone: setup.timeZone, now, busy, bookings: live, ...range })
  return { slots, timeZone: setup.timeZone, rules: setup.rules }
}

/** Whether `startIso` is one of the open slots right now; its slot when it is. */
export async function openSlotAt(
  supabase: SupabaseClient,
  business: { workspaceId: string; ownerUserId: string },
  startIso: string,
  deps: FindOpenSlotsDeps = {},
): Promise<{ slot: OpenSlot | null; timeZone: string; rules: BookingRules }> {
  const at = Date.parse(startIso)
  if (!Number.isFinite(at)) return { slot: null, ...(await bookingSetup(supabase, business)) }
  const now = (deps.now ?? Date.now)()
  const setup = await bookingSetup(supabase, business)
  const day = localDate(at, setup.timeZone)
  const found = await findOpenSlots(supabase, business, { fromDate: `${day.y}-${String(day.m).padStart(2, '0')}-${String(day.d).padStart(2, '0')}`, days: 1 }, { ...deps, now: () => now })
  const slot = found.slots.find((s) => Date.parse(s.start) === at) ?? null
  return { slot, timeZone: found.timeZone, rules: found.rules }
}

/**
 * Whether [start, end) is still free: nothing on the owner's calendar then
 * (an all-day event that day included) and no other live booking (a fresh
 * request or a confirmed one), `exceptBookingId`'s own hold aside (and, for
 * a move, `deps.except`'s booking and calendar event). The owner's yes checks
 * it again before booking. Throws when the calendar can't be read.
 */
export async function isSlotFree(
  supabase: SupabaseClient,
  business: { workspaceId: string; ownerUserId: string },
  slot: { start: string; end: string; exceptBookingId?: string | null },
  deps: FindOpenSlotsDeps = {},
): Promise<boolean> {
  const now = (deps.now ?? Date.now)()
  const from = Date.parse(slot.start)
  const to = Date.parse(slot.end)
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return false
  // The whole local day around it, so an all-day event that day is seen.
  const timeMin = new Date(from - DAY_MS).toISOString()
  const timeMax = new Date(to + DAY_MS).toISOString()
  const [events, bookings] = await Promise.all([
    (deps.listEvents ?? listCalendarEventsUnified)(business.ownerUserId, { timeMin, timeMax, maxResults: 500, workspaceId: business.workspaceId, strict: true }),
    liveBookingsBetween(supabase, business.workspaceId, slot.start, slot.end),
  ])
  const staleBefore = now - BOOKING_REQUEST_TTL_MS
  const exceptBookingId = slot.exceptBookingId ?? deps.except?.bookingId
  if (bookings.some((b) => b.id !== exceptBookingId && (b.state === 'confirmed' || Date.parse(b.createdAt) > staleBefore))) return false
  const setup = await bookingSetup(supabase, business)
  const day = localDate(from, setup.timeZone)
  const dayStart = zonedTime(day, '00:00', setup.timeZone)
  const dayEnd = zonedTime(addDays(day, 1), '00:00', setup.timeZone)
  // A moved booking's own calendar event never blocks its new time.
  const theirs = deps.except?.eventId
  for (const block of busyBlocks(theirs ? events.filter((e) => e.id !== theirs) : events, timeMin, timeMax)) {
    const s = Date.parse(block.start)
    const e = Date.parse(block.end)
    if (block.allDay ? allDayTakes({ start: s, end: e }, dayStart, dayEnd) : s < to && e > from) return false
  }
  return true
}
