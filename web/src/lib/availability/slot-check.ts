/**
 * Whether specific times are free on a person's calendar right now: before
 * they are offered to someone (src/lib/time-offers/offers.ts), and again live
 * when one is picked or a booking moves. Every calendar that counts and
 * every claim on their time (./busy.ts), read strictly: a calendar that
 * can't be read is unknown, never free. Working hours are not checked here:
 * the person chose these times.
 *
 * A time is busy when a timed busy block overlaps it, or an all-day block
 * takes its local day (./zone.ts allDayTakesDay, as the engine reads a day off).
 */
import { busyBlocks } from '@/lib/guests/free-busy'
import { hasCountedCalendar, listCountedEvents } from './busy'
import type { ClaimExceptions } from './claims'
import type { Span } from './engine'
import { allDayTakesDay, localDate } from './zone'

const DAY_MS = 24 * 60 * 60_000

export type SpansFreeResult = { known: true; busy: boolean[] } | { known: false; reason: string }

export interface SpansFreeInput {
  userId: string
  workspaceId?: string
  /** The person's zone, for which local day an all-day event takes. */
  timeZone: string
  spans: readonly Span[]
  /** Their own claims to leave out (an offer's own holds, a booking's own claim). */
  exceptClaims?: ClaimExceptions
  /** A calendar event to leave out: a booking's own provider event while it moves. */
  exceptEventId?: string | null
}

export interface SpansFreeDeps {
  listEvents?: typeof listCountedEvents
  hasCalendar?: (userId: string, workspaceId: string | undefined) => Promise<boolean>
}

/** For each span, whether something is on the person's calendar then (see the header). */
export async function checkSpansFree(input: SpansFreeInput, deps: SpansFreeDeps = {}): Promise<SpansFreeResult> {
  if (!input.spans.length) return { known: true, busy: [] }
  try {
    if (!(await (deps.hasCalendar ?? ((u, w) => hasCountedCalendar(u, w)))(input.userId, input.workspaceId))) {
      return { known: false, reason: 'no calendar is connected' }
    }
  } catch (err) {
    return { known: false, reason: err instanceof Error ? err.message : 'a calendar could not be read' }
  }
  const from = Math.min(...input.spans.map((s) => s.start))
  const to = Math.max(...input.spans.map((s) => s.end))
  // The day before and after, so an all-day event's UTC midnights are seen.
  const timeMin = new Date(from - DAY_MS).toISOString()
  const timeMax = new Date(to + DAY_MS).toISOString()
  let events
  try {
    events = await (deps.listEvents ?? listCountedEvents)(input.userId, { timeMin, timeMax, maxResults: 500, workspaceId: input.workspaceId, strict: true, exceptClaims: input.exceptClaims })
  } catch (err) {
    return { known: false, reason: err instanceof Error ? err.message : 'a calendar could not be read' }
  }
  const blocks = busyBlocks(input.exceptEventId ? events.filter((e) => e.id !== input.exceptEventId) : events, timeMin, timeMax).map((b) => ({ start: Date.parse(b.start), end: Date.parse(b.end), allDay: b.allDay === true }))
  const busy = input.spans.map((span) => {
    const day = localDate(span.start, input.timeZone)
    return blocks.some((b) => (b.allDay ? allDayTakesDay(b, day, input.timeZone) : b.start < span.end && b.end > span.start))
  })
  return { known: true, busy }
}
