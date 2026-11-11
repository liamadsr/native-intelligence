import { tool } from 'ai'
import { z } from 'zod'
import { getServiceClient } from '@/lib/admin'
import { getCalendarProvider } from '@/lib/integrations/calendar'
import { isoInZone, readRangeEdge } from '@/lib/integrations/calendar-zone'
import { isTimeZone } from '@/lib/chat-cards/calendar'
import { findTimes, FIND_TIMES_MAX_DAYS } from '@/lib/availability/find-times'
import { readWorkingHours, saveWorkingHours, type WorkingHours } from '@/lib/availability/schedule'
import type { DayRange } from '@/lib/availability/engine'

const DAY_MS = 24 * 60 * 60_000
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const

const rangeSchema = z.object({
  start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).describe('HH:MM, 24-hour'),
  end: z.string().regex(/^(([01]\d|2[0-3]):[0-5]\d|24:00)$/).describe('HH:MM, 24-hour, after the start'),
})

/** Working hours as a model reads them: each weekday by name, and the dated changes. */
function hoursForModel(hours: WorkingHours) {
  return {
    time_zone: hours.timeZone,
    time_zone_follows_the_person: hours.zoneSource === 'member',
    is_default: !hours.saved,
    week: Object.fromEntries(WEEKDAYS.map((name, i) => [name, hours.weekly[i]])),
    dated_changes: hours.overrides,
  }
}

/** A stretch of time as a model reads it: both ends in the person's zone, and a line to say aloud. */
function spanForModel(span: { start: number; end: number }, timeZone: string) {
  const day = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(span.start))
  const clock = (at: number) => new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(new Date(at))
  return { start: isoInZone(span.start, timeZone), end: isoInZone(span.end, timeZone), label: `${day}, ${clock(span.start)} to ${clock(span.end)}` }
}

/**
 * Availability (src/lib/availability): when the person can meet, from their
 * working hours and every calendar of theirs that counts as busy, and the
 * working hours themselves.
 */
export function createAvailabilityTools(userId: string, workspaceId?: string, zone?: { timeZone?: string | null }) {
  const person = { userId, workspaceId: workspaceId ?? '' }
  return {
    find_times: tool({
      description:
        "When the person is free to meet: their working hours minus everything busy on every calendar of theirs that counts (events marked free and invites they declined don't count), with a short gap kept around existing meetings. " +
        'Returns `suggested` (up to three times on different days, ready to offer) and `free` (every free stretch in the range, to pick another time from). ' +
        "Every time is in the person's time zone (`time_zone`), written with its offset. " +
        'When a calendar cannot be read the answer is `unknown`, never a guess: say which calendar and do not offer times.',
      inputSchema: z.object({
        duration_minutes: z.number().int().min(5).max(480).optional().describe('How long the meeting is (default 30)'),
        from: z.string().min(1).max(40).optional().describe("Start of the range: an ISO date or date-time in the person's time zone. Default: now"),
        to: z.string().min(1).max(40).optional().describe(`End of the range: an ISO date (covers that whole day) or date-time. Default: 7 days after the start. At most ${FIND_TIMES_MAX_DAYS} days after it`),
        buffer_minutes: z.number().int().min(0).max(120).optional().describe('Minutes kept clear before and after existing meetings (default 10)'),
      }),
      execute: async ({ duration_minutes, from, to, buffer_minutes }) => {
        const supabase = getServiceClient()
        const provider = await getCalendarProvider(userId)
        if (!provider) {
          return { success: false, error: 'No calendar connected. Offer the person a Connect card: call connect with provider "google" or "microsoft" and capability "calendar". Never ask for a password or token.' }
        }
        let hours: WorkingHours
        try {
          hours = await readWorkingHours(supabase, person)
        } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : 'Working hours could not be read' }
        }
        // With no zone named for their hours, this turn's browser zone is the freshest one known.
        const timeZone = hours.zoneSource === 'member' && isTimeZone(zone?.timeZone) ? zone.timeZone : hours.timeZone
        const now = Date.now()
        const start = from ? readRangeEdge(from, timeZone, 'start') : now
        if (start === null) return { success: false, error: `Could not read from (${from}). Use an ISO date like 2026-11-02.` }
        const end = to ? readRangeEdge(to, timeZone, 'end') : start + 7 * DAY_MS
        if (end === null) return { success: false, error: `Could not read to (${to}). Use an ISO date like 2026-11-08.` }
        if (end <= Math.max(start, now)) return { success: false, error: 'The range is over: `to` must be after `from` and after now.' }
        if (end - start > FIND_TIMES_MAX_DAYS * DAY_MS) return { success: false, error: `The range is at most ${FIND_TIMES_MAX_DAYS} days. Ask for a shorter one.` }

        const durationMinutes = duration_minutes ?? 30
        const bufferMinutes = buffer_minutes ?? 10
        const found = await findTimes({ userId, workspaceId, schedule: { ...hours, timeZone }, from: start, to: end, durationMinutes, bufferMinutes, now })
        if (!found.known) {
          return { success: false, unknown: true, error: `Free time is unknown: ${found.reason}. Say so; never offer a time on a calendar that could not be read.` }
        }
        return {
          success: true,
          time_zone: timeZone,
          duration_minutes: durationMinutes,
          buffer_minutes: bufferMinutes,
          working_hours_are_default: !hours.saved,
          suggested: found.suggested.map((span) => spanForModel(span, timeZone)),
          free: found.free.map((span) => spanForModel(span, timeZone)),
          ...(found.free.length ? {} : { note: 'Nothing is free in this range inside their working hours. Say so, and offer a wider range or a shorter meeting.' }),
        }
      },
    }),

    get_working_hours: tool({
      description: "The person's working hours: each weekday's ranges, the dated changes (a day off, different hours on one date) and the time zone they are in. `is_default` means they never set any (weekdays 9 to 6).",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          return { success: true, ...hoursForModel(await readWorkingHours(getServiceClient(), person)) }
        } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : 'Working hours could not be read' }
        }
      },
    }),

    set_working_hours: tool({
      description:
        "Change the person's working hours, which decide the times find_times offers. Pass only what changes: `week` replaces the days it names (a day with no ranges is a day off) and leaves the others; `dates` sets one date's hours (no ranges: off that day); `clear_dates` puts dates back on the weekly pattern. " +
        'Only on what the person said about their own hours.',
      inputSchema: z.object({
        week: z.partialRecord(z.enum(WEEKDAYS), z.array(rangeSchema).max(6)).optional().describe('The weekdays to change, each with its ranges'),
        dates: z.record(z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.array(rangeSchema).max(6)).optional().describe('ISO dates to set, each with its ranges (empty: a day off)'),
        clear_dates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).max(60).optional().describe('ISO dates to put back on the weekly pattern'),
        time_zone: z.string().max(64).nullable().optional().describe('An IANA zone the hours are always in, or null to follow the zone the person is in (the default)'),
      }),
      execute: async ({ week, dates, clear_dates, time_zone }) => {
        const supabase = getServiceClient()
        try {
          let weekly: DayRange[][] | undefined
          if (week && Object.keys(week).length) {
            const current = await readWorkingHours(supabase, person)
            weekly = WEEKDAYS.map((name, i) => week[name] ?? current.weekly[i])
          }
          const saved = await saveWorkingHours(supabase, person, { weekly, setOverrides: dates, clearOverrides: clear_dates, ...(time_zone !== undefined ? { timeZone: time_zone } : {}) })
          return { success: true, ...hoursForModel(saved) }
        } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : 'Working hours could not be saved' }
        }
      },
    }),
  }
}
