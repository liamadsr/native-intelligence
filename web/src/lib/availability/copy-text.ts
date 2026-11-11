/**
 * "Copy availability" in the calendar's toolbar: the person's free time for
 * a range, as plain text to paste into an email or a chat:
 *
 *   My availability (EST):
 *   Tue, Nov 12: 9:00 AM – 11:30 AM, 2:00 PM – 6:00 PM
 *
 * Worked out on the server by the same engine as find_times (./find-times.ts:
 * working hours, every calendar that counts, all-day events), with no gap
 * kept around meetings (the person shares their open time, not a meeting
 * slot) and nothing shorter than half an hour. A calendar that can't be read
 * is unknown: the answer says so instead of a guess.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { getServiceClient } from '@/lib/admin'
import { isTimeZone } from '@/lib/chat-cards/calendar'
import { getCalendarProvider } from '@/lib/integrations/calendar'
import type { Span } from './engine'
import { readFreeTime, type FindTimesDeps } from './find-times'
import { readWorkingHours } from './schedule'
import { addDays, localDate, zonedTime, zoneAbbreviation } from './zone'
import { type CopyRange } from './copy-ranges'

export { COPY_RANGES, COPY_RANGE_LABELS, isCopyRange, type CopyRange } from './copy-ranges'

/** The shortest stretch worth sharing. */
const MIN_MINUTES = 30

/**
 * The range as instants, from now to the end of a local day: today's end,
 * the end of this week (Saturday, as the calendar's weeks run Sunday to
 * Saturday), or the end of the 7th or 14th day counting today. Pure.
 */
export function copyRangeSpan(range: CopyRange, now: number, timeZone: string): Span {
  const today = localDate(now, timeZone)
  const days = range === 'today' ? 1 : range === 'this_week' ? 7 - today.weekday : range === 'next_7_days' ? 7 : 14
  return { start: now, end: zonedTime(addDays(today, days), '00:00', timeZone) }
}

const tidy = (s: string) => s.replace(/[  ]/g, ' ')

/**
 * The free time as the text to paste (see the header). Across a
 * daylight-saving change the heading names the place ("New York time") and
 * each day its own short name ("Fri, Oct 30 (EDT): ..."). Pure.
 */
export function formatAvailabilityText(free: readonly Span[], timeZone: string, now: number): string {
  const sorted = [...free].sort((a, b) => a.start - b.start)
  const zoneAt = (at: number) => zoneAbbreviation(timeZone, at) ?? timeZone
  const shifts = new Set(sorted.map((s) => zoneAt(s.start))).size > 1
  const zone = shifts ? `${(timeZone.split('/').pop() ?? timeZone).replace(/_/g, ' ')} time` : zoneAt(sorted[0]?.start ?? now)
  const dayOf = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric' })
  const clock = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' })
  const days = new Map<string, string[]>()
  for (const span of sorted) {
    const day = `${tidy(dayOf.format(new Date(span.start)))}${shifts ? ` (${zoneAt(span.start)})` : ''}`
    const list = days.get(day) ?? []
    list.push(`${tidy(clock.format(new Date(span.start)))} – ${tidy(clock.format(new Date(span.end)))}`)
    days.set(day, list)
  }
  const lines = [...days].map(([day, spans]) => `${day}: ${spans.join(', ')}`)
  return [`My availability (${zone}):`, ...(lines.length ? lines : ['No open time in this range.'])].join('\n')
}

export type AvailabilityTextResult = { known: true; text: string; timeZone: string } | { known: false; reason: string }

export interface AvailabilityTextDeps extends FindTimesDeps {
  supabase?: SupabaseClient
  calendarProvider?: typeof getCalendarProvider
}

/** The person's free time for the range, as text, or why it is unknown. */
export async function availabilityText(
  input: { userId: string; workspaceId: string; range: CopyRange; browserTimeZone?: string | null; now: number },
  deps: AvailabilityTextDeps = {},
): Promise<AvailabilityTextResult> {
  const supabase = deps.supabase ?? getServiceClient()
  if (!(await (deps.calendarProvider ?? getCalendarProvider)(input.userId))) return { known: false, reason: 'No calendar is connected' }
  let hours
  try {
    hours = await readWorkingHours(supabase, { userId: input.userId, workspaceId: input.workspaceId })
  } catch (err) {
    return { known: false, reason: err instanceof Error ? err.message : 'Working hours could not be read' }
  }
  // As find_times: with no zone named for the hours, the browser's is the freshest one known.
  const timeZone = hours.zoneSource === 'member' && isTimeZone(input.browserTimeZone) ? input.browserTimeZone : hours.timeZone
  const span = copyRangeSpan(input.range, input.now, timeZone)
  const read = await readFreeTime(
    { userId: input.userId, workspaceId: input.workspaceId, schedule: { ...hours, timeZone }, from: span.start, to: span.end, durationMinutes: MIN_MINUTES, bufferMinutes: 0, now: input.now },
    { listEvents: deps.listEvents },
  )
  if (!read.known) return { known: false, reason: read.reason }
  return { known: true, timeZone, text: formatAvailabilityText(read.free, timeZone, input.now) }
}
