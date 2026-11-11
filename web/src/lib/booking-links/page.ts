/**
 * What a booking link's public page draws (availability phase 4b):
 * /book/<handle>/<slug> (src/app/book/[slug]/[link]/). The week strip of
 * days in the guest's own zone, a week's times by day, the hosts as one
 * line, and what each error of the book call means to a guest.
 *
 * Pure and client-safe.
 */
import { addDays, dayKey, localDate, parseDayKey } from '@/lib/availability/zone'
import { clockLabel, type PublicSlot } from '@/lib/time-offers/display'
import type { HostMode } from './types'

/** Days the strip shows at once, and so one times read. */
export const STRIP_DAYS = 7

export interface StripDay {
  /** YYYY-MM-DD in the guest's zone. */
  key: string
  /** "Tue". */
  weekday: string
  /** 17. */
  date: number
  /** "Nov". */
  month: string
  /** Past the link's window (or before today): nothing to book. */
  outside: boolean
}

const utc = (key: string) => {
  const d = parseDayKey(key)!
  return new Date(Date.UTC(d.y, d.m - 1, d.d))
}
const part = (key: string, options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...options }).format(utc(key))

/** Today's date in `timeZone`, as YYYY-MM-DD. */
export function todayKey(now: number, timeZone: string): string {
  try {
    return dayKey(localDate(now, timeZone))
  } catch {
    return dayKey(localDate(now, 'UTC'))
  }
}

/** The day `n` days after `key`. */
export function shiftDay(key: string, n: number): string {
  return dayKey(addDays(parseDayKey(key)!, n))
}

/** How many strips the link's window takes: today and `windowDays` after it. */
export function stripCount(windowDays: number): number {
  return Math.max(1, Math.ceil((windowDays + 1) / STRIP_DAYS))
}

/** Strip `page` (0 is the one starting today), each day marked outside when past the window. */
export function stripDays(today: string, page: number, windowDays: number): StripDay[] {
  return Array.from({ length: STRIP_DAYS }, (_, i) => {
    const offset = page * STRIP_DAYS + i
    const key = shiftDay(today, offset)
    return { key, weekday: part(key, { weekday: 'short' }), date: utc(key).getUTCDate(), month: part(key, { month: 'short' }), outside: offset > windowDays }
  })
}

/** The strip's heading: "November 2026", or "Nov – Dec 2026" across a month's end. */
export function stripHeading(days: readonly StripDay[]): string {
  const first = days[0]?.key
  const last = days[days.length - 1]?.key
  if (!first || !last) return ''
  const [fy, fm] = first.split('-')
  const [ly, lm] = last.split('-')
  if (fy === ly && fm === lm) return part(first, { month: 'long', year: 'numeric' })
  if (fy === ly) return `${part(first, { month: 'short' })} – ${part(last, { month: 'short' })} ${ly}`
  return `${part(first, { month: 'short', year: 'numeric' })} – ${part(last, { month: 'short', year: 'numeric' })}`
}

export type TimedSlot = PublicSlot & { time: string }

/** The times by their day in `timeZone` (YYYY-MM-DD), each day's soonest first. */
export function slotsByDay(slots: readonly PublicSlot[], timeZone: string): Record<string, TimedSlot[]> {
  const out: Record<string, TimedSlot[]> = {}
  for (const slot of [...slots].sort((a, b) => Date.parse(a.start) - Date.parse(b.start))) {
    const key = todayKey(Date.parse(slot.start), timeZone)
    ;(out[key] ??= []).push({ ...slot, time: clockLabel(slot.start, timeZone) })
  }
  return out
}

/** The hosts as one line: "Ada Finch", "Ada Finch and Ben Ruiz", or (any one of them) "Ada Finch, Ben Ruiz or Cara Diaz". */
export function hostsLine(names: readonly string[], mode: HostMode): string {
  if (!names.length) return 'Your host'
  if (names.length === 1) return names[0]
  const joiner = mode === 'any' ? 'or' : 'and'
  return `${names.slice(0, -1).join(', ')} ${joiner} ${names[names.length - 1]}`
}

/** Under the hosts: who joins, when there are several. */
export function hostsNote(names: readonly string[], mode: HostMode): string | null {
  if (names.length < 2) return null
  return mode === 'any' ? 'One of them will meet you.' : 'They’ll all be there.'
}

interface ApiError {
  error?: unknown
  code?: unknown
  details?: unknown
}

const SOMETHING_WRONG = "That didn't go through. Try again in a moment."
const messageOf = (body: ApiError | null, fallback: string) => (body && typeof body.error === 'string' && body.error ? body.error : fallback)
const fieldOf = (body: ApiError | null) => {
  const field = body?.details && typeof body.details === 'object' ? (body.details as { field?: unknown }).field : null
  return typeof field === 'string' && field ? field : null
}

/** What a failed POST …/book means on the page. */
export type LinkBookFailure =
  | { kind: 'slot_taken' }
  | { kind: 'closed' }
  | { kind: 'missing' }
  /** A field to fix: name, email, phone, a question's id, or contact (email or mobile). */
  | { kind: 'field'; field: string; message: string }
  | { kind: 'message'; message: string }

/** A failed book call, read for the guest (null `body` for a network error). Pure. */
export function linkBookFailure(status: number, body: ApiError | null, host: string): LinkBookFailure {
  const code = body?.code
  if (status === 409) return { kind: 'slot_taken' }
  if (status === 410) return { kind: 'closed' }
  if (status === 404) return { kind: 'missing' }
  if (status === 400) {
    if (code === 'NEEDS_EMAIL') return { kind: 'field', field: 'email', message: messageOf(body, 'Add your email, so the invitation can reach you.') }
    if (code === 'NEEDS_CONTACT') return { kind: 'field', field: 'contact', message: messageOf(body, 'Add your email or a mobile number, so the confirmation can reach you.') }
    const field = fieldOf(body)
    if (field && field !== 'start') return { kind: 'field', field, message: messageOf(body, 'Check this one.') }
    return { kind: 'message', message: field === 'start' ? 'Pick a time.' : messageOf(body, SOMETHING_WRONG) }
  }
  if (status === 429) return { kind: 'message', message: messageOf(body, 'Too many tries just now. Try again in a little while.') }
  if (status === 503) return { kind: 'message', message: `We couldn't check ${host}'s calendar just now. Try again in a minute.` }
  return { kind: 'message', message: SOMETHING_WRONG }
}
