/**
 * A meeting's time as the person reads it, in their own zone (Liam,
 * 2026-10-17: at 6:47 PM his chat still called that morning's 12:00 meeting
 * "still ahead"). Every line Dial8 writes about a meeting names its start in
 * local time, with the zone where the line outlives the moment (a prep's
 * task, a digest line, a report), so a message kept in the thread all day
 * still reads as time-bound. Pure and client-safe.
 *
 * Deterministic for the same start and zone: the prep's task line is
 * fingerprinted (start_chat_helper), so a retry must write the same words.
 */
import { isTimeZone } from '@/lib/chat-cards/calendar'

/**
 * A meeting with no end on record is taken to run this long: "happening now"
 * for an hour after its start, then "over". Long rather than short, so a
 * meeting still going is never called over.
 */
export const DEFAULT_MEETING_MS = 60 * 60_000
/** Closer than this, a meeting "starts in N min". */
const SOON_MS = 60 * 60_000
/** "starts in N min" moves in steps of this many minutes, so the line changes rarely. */
const SOON_STEP_MIN = 5

function zoneOf(timeZone: unknown): string {
  return typeof timeZone === 'string' && isTimeZone(timeZone) ? timeZone : 'UTC'
}

/** Intl's words, with its narrow and no-break spaces made plain (they differ across ICU versions). */
function format(ms: number, zone: string, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat('en-US', { ...options, timeZone: zone }).format(new Date(ms)).replace(/[  ]/g, ' ')
}

/** "12:00 PM EDT", or "12:00 PM" without the zone; '' for an unreadable start. Pure. */
export function meetingClock(iso: string, timeZone: unknown, withZone = true): string {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return ''
  return format(ms, zoneOf(timeZone), { hour: 'numeric', minute: '2-digit', ...(withZone ? { timeZoneName: 'short' } : {}) })
}

/** "Friday, October 17"; '' for an unreadable start. Pure. */
export function meetingDay(iso: string, timeZone: unknown): string {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return ''
  return format(ms, zoneOf(timeZone), { weekday: 'long', month: 'long', day: 'numeric' })
}

/** "12:00 PM EDT on Friday, October 17"; '' for an unreadable start. Pure. */
export function meetingWhen(iso: string, timeZone: unknown): string {
  const clock = meetingClock(iso, timeZone)
  return clock ? `${clock} on ${meetingDay(iso, timeZone)}` : ''
}

/** The local calendar day of `ms` in `zone`, as a day number (days since the epoch). Pure. */
export function localDay(ms: number, zone: string): number {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms))
  const n = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value)
  return Math.round(Date.UTC(n('year'), n('month') - 1, n('day')) / 86_400_000)
}

/**
 * What a prep document is for, at `nowMs`, in the person's zone: the
 * meeting's local start and a coarse state, for the cards note:
 *   "prep for the 12:00 PM meeting · over" / "· happening now" /
 *   "· starts in 25 min" / "· later today" / "· tomorrow" / "· on Mon, Oct 20",
 * and "prep for the 12:00 PM meeting yesterday · over" for an earlier day.
 * Coarse on purpose: the note is diffed by hash, so it changes only when the
 * state does (every 5 minutes in the last hour). The meeting runs to `endIso`,
 * else DEFAULT_MEETING_MS. Null for an unreadable start. Pure.
 */
export function prepTimeLabel(startIso: string, nowMs: number, timeZone: unknown, endIso?: string | null): string | null {
  const start = Date.parse(startIso)
  if (!Number.isFinite(start)) return null
  const zone = zoneOf(timeZone)
  const endParsed = endIso ? Date.parse(endIso) : NaN
  const end = Number.isFinite(endParsed) && endParsed > start ? endParsed : start + DEFAULT_MEETING_MS
  const clock = meetingClock(startIso, zone, false)
  const days = localDay(start, zone) - localDay(nowMs, zone)
  if (end <= nowMs) {
    const when = days === 0 ? '' : days === -1 ? ' yesterday' : ` on ${format(start, zone, { weekday: 'short', month: 'short', day: 'numeric' })}`
    return `prep for the ${clock} meeting${when} · over`
  }
  const head = `prep for the ${clock} meeting`
  if (start <= nowMs) return `${head} · happening now`
  if (start - nowMs <= SOON_MS) {
    const min = Math.max(SOON_STEP_MIN, Math.ceil((start - nowMs) / 60_000 / SOON_STEP_MIN) * SOON_STEP_MIN)
    return `${head} · starts in ${min} min`
  }
  if (days === 0) return `${head} · later today`
  if (days === 1) return `${head} · tomorrow`
  return `${head} · on ${format(start, zone, { weekday: 'short', month: 'short', day: 'numeric' })}`
}
