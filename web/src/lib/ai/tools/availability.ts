import { tool } from 'ai'
import { z } from 'zod'
import { getServiceClient } from '@/lib/admin'
import { getCalendarProvider } from '@/lib/integrations/calendar'
import { isoInZone, readRangeEdge } from '@/lib/integrations/calendar-zone'
import { isTimeZone } from '@/lib/chat-cards/calendar'
import { findTimes, FIND_TIMES_MAX_DAYS, FREE_WINDOWS_MAX } from '@/lib/availability/find-times'
import { readWorkingHours, saveWorkingHours, type WorkingHours } from '@/lib/availability/schedule'
import type { DayRange, Span } from '@/lib/availability/engine'
import { findWorkspacePeople, TEAM_MAX_PEOPLE } from '@/lib/availability/people'
import { findTimesTogether, type PersonCoverage } from '@/lib/availability/team'
import { AVAILABILITY_SHARING, readSharing, saveSharing, type AvailabilitySharing } from '@/lib/availability/sharing'

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

const spansForModel = (spans: readonly Span[], timeZone: string) => spans.map((span) => spanForModel(span, timeZone))

/** A `free` list that was cut, said so: where it stops, and that more follows. */
function truncatedForModel(freeUntil: number | undefined, timeZone: string) {
  if (freeUntil === undefined) return {}
  const until = isoInZone(freeUntil, timeZone)
  return { truncated: true, free_until: until, more: `The free list stops at ${until}; more free time follows. Ask again from there for later times, and never say nothing is free after it.` }
}

/** One person of a group as a model reads them: whether their time is known, and their zone. Never their events. */
function personForModel(person: PersonCoverage) {
  return {
    name: person.name,
    ...(person.isRequester ? { you: true } : {}),
    coverage: person.coverage,
    ...(person.reason ? { reason: person.reason } : {}),
    time_zone: person.timeZone,
  }
}

/**
 * Availability (src/lib/availability): when the person can meet, alone or
 * with teammates in the workspace, from working hours and every calendar
 * that counts as busy; the working hours themselves; and whether teammates
 * may see when the person is busy.
 *
 * `omitGrants` (a guest's or a linked agent's turn, CreateToolsOptions):
 * such a turn may read the person's own free time, never their teammates'.
 */
export function createAvailabilityTools(userId: string, workspaceId?: string, zone?: { timeZone?: string | null; omitGrants?: boolean }) {
  const person = { userId, workspaceId: workspaceId ?? '' }
  return {
    find_times: tool({
      description:
        "When the person is free to meet: their working hours minus everything busy on every calendar of theirs that counts (events marked free and invites they declined don't count), with a short gap kept around existing meetings. " +
        "With `people` (teammates in this workspace, by name or email), when everyone is free: each person's own working hours in their own zone and their busy time, never what their events are. " +
        'Returns `suggested` (up to three times on different days, ready to offer) and `free` (the free stretches in the range, soonest first, to pick another time from); with `people`, those are the times that work for everyone, and `people` says for each person whether their time is known. ' +
        `\`free\` lists at most ${FREE_WINDOWS_MAX} stretches: when it was cut, \`truncated\` is true and \`free_until\` says where the list stops. There is more free time after it: never say nothing is free then; ask again from \`free_until\` for later times. ` +
        "Every time is in the person's time zone (`time_zone`), written with its offset. " +
        'When a calendar cannot be read, or a teammate does not share their availability, the answer is `unknown`, never a guess: say who and why and do not offer times. ' +
        "Only workspace members can be included: an outside guest's calendar cannot be seen.",
      inputSchema: z.object({
        duration_minutes: z.number().int().min(5).max(480).optional().describe('How long the meeting is (default 30)'),
        from: z.string().min(1).max(40).optional().describe("Start of the range: an ISO date or date-time in the person's time zone. Default: now"),
        to: z.string().min(1).max(40).optional().describe(`End of the range: an ISO date (covers that whole day) or date-time. Default: 7 days after the start. At most ${FIND_TIMES_MAX_DAYS} days after it`),
        buffer_minutes: z.number().int().min(0).max(120).optional().describe('Minutes kept clear before and after existing meetings (default 10)'),
        people: z
          .array(z.string().min(1).max(200))
          .max(TEAM_MAX_PEOPLE - 1)
          .optional()
          .describe(`Teammates in this workspace to find a time with, each by display name or sign-in email (the person is always included; at most ${TEAM_MAX_PEOPLE - 1}). Never an outside guest.`),
      }),
      execute: async ({ duration_minutes, from, to, buffer_minutes, people }) => {
        const supabase = getServiceClient()
        const asked = (people ?? []).map((p) => p.trim()).filter(Boolean)
        if (asked.length && zone?.omitGrants) {
          return { success: false, error: "Teammates' availability is read only on the person's own turn. Find a time on the person's calendar alone." }
        }
        if (asked.length && !workspaceId) return { success: false, error: 'Teammates can be included only in a workspace.' }
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
        // No zone anywhere: their hours would be read in UTC (9 AM UTC is 4 AM in New York).
        if (!hours.zoneKnown && !isTimeZone(zone?.timeZone)) {
          return { success: false, unknown: true, error: "Free time is unknown: the person's time zone isn't known. Ask which time zone they are in, save it with set_working_hours (time_zone), then try again." }
        }
        const now = Date.now()
        const start = from ? readRangeEdge(from, timeZone, 'start') : now
        if (start === null) return { success: false, error: `Could not read from (${from}). Use an ISO date like 2026-11-02.` }
        const end = to ? readRangeEdge(to, timeZone, 'end') : start + 7 * DAY_MS
        if (end === null) return { success: false, error: `Could not read to (${to}). Use an ISO date like 2026-11-08.` }
        if (end <= Math.max(start, now)) return { success: false, error: 'The range is over: `to` must be after `from` and after now.' }
        if (end - start > FIND_TIMES_MAX_DAYS * DAY_MS) return { success: false, error: `The range is at most ${FIND_TIMES_MAX_DAYS} days. Ask for a shorter one.` }

        const durationMinutes = duration_minutes ?? 30
        const bufferMinutes = buffer_minutes ?? 10
        const schedule = { ...hours, timeZone }

        if (asked.length && workspaceId) {
          let resolved
          try {
            resolved = await findWorkspacePeople(supabase, workspaceId, userId, asked)
          } catch (err) {
            return { success: false, error: err instanceof Error ? err.message : 'Workspace members could not be read' }
          }
          if (!resolved.ok) return { success: false, error: resolved.error }
          if (resolved.requester.role === 'guest') return { success: false, error: "A workspace guest can't see teammates' availability. Find a time on the person's calendar alone." }
          if (resolved.others.length) {
            const together = await findTimesTogether(
              { workspaceId, requester: { userId, name: resolved.requester.name, schedule }, others: resolved.others, from: start, to: end, durationMinutes, bufferMinutes, now },
              { supabase },
            )
            const group = together.people.map(personForModel)
            if (!together.known) {
              const missing = together.people.filter((p) => p.coverage === 'unknown').map((p) => `${p.isRequester ? 'you' : p.name}: ${p.reason}`)
              return {
                success: false,
                unknown: true,
                time_zone: timeZone,
                duration_minutes: durationMinutes,
                people: group,
                error: `Free time together is unknown (${missing.join('; ')}). Say who and why; never offer a time that leaves someone out. Offer to find a time without them.`,
              }
            }
            return {
              success: true,
              time_zone: timeZone,
              duration_minutes: durationMinutes,
              buffer_minutes: bufferMinutes,
              working_hours_are_default: !hours.saved,
              people: group,
              suggested: spansForModel(together.suggested, timeZone),
              free: spansForModel(together.free, timeZone),
              ...truncatedForModel(together.freeUntil, timeZone),
              ...(together.free.length ? {} : { note: 'No time in this range works for everyone inside their working hours. Say so, and offer a wider range, a shorter meeting or fewer people.' }),
            }
          }
          // Only the person themselves was named: their own time, as below.
        }

        const found = await findTimes({ userId, workspaceId, schedule, from: start, to: end, durationMinutes, bufferMinutes, now })
        if (!found.known) {
          return { success: false, unknown: true, error: `Free time is unknown: ${found.reason}. Say so; never offer a time on a calendar that could not be read.` }
        }
        return {
          success: true,
          time_zone: timeZone,
          duration_minutes: durationMinutes,
          buffer_minutes: bufferMinutes,
          working_hours_are_default: !hours.saved,
          suggested: spansForModel(found.suggested, timeZone),
          free: spansForModel(found.free, timeZone),
          ...truncatedForModel(found.freeUntil, timeZone),
          ...(found.free.length ? {} : { note: 'Nothing is free in this range inside their working hours. Say so, and offer a wider range or a shorter meeting.' }),
        }
      },
    }),

    get_working_hours: tool({
      description:
        "The person's working hours: each weekday's ranges, the dated changes (a day off, different hours on one date) and the time zone they are in. `is_default` means they never set any (weekdays 9 to 6). " +
        "`availability_sharing`: whether teammates in this workspace may see when they are busy ('busy_only', the default: busy times only, never what an event is) or not ('none').",
      inputSchema: z.object({}),
      execute: async () => {
        const supabase = getServiceClient()
        try {
          const [hours, sharing] = await Promise.all([readWorkingHours(supabase, person), workspaceId ? readSharing(supabase, person).catch(() => null) : Promise.resolve(null)])
          return { success: true, ...hoursForModel(hours), ...(sharing ? { availability_sharing: sharing } : {}) }
        } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : 'Working hours could not be read' }
        }
      },
    }),

    set_working_hours: tool({
      description:
        "Change the person's working hours, which decide the times find_times offers. Pass only what changes: `week` replaces the days it names (a day with no ranges is a day off) and leaves the others; `dates` sets one date's hours (no ranges: off that day); `clear_dates` puts dates back on the weekly pattern. " +
        "`availability_sharing` sets whether teammates in this workspace may see when the person is busy: 'busy_only' (busy times only, never what an event is) or 'none'. " +
        'Only on what the person said about their own hours or sharing.',
      inputSchema: z.object({
        week: z.partialRecord(z.enum(WEEKDAYS), z.array(rangeSchema).max(6)).optional().describe('The weekdays to change, each with its ranges'),
        dates: z.record(z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.array(rangeSchema).max(6)).optional().describe('ISO dates to set, each with its ranges (empty: a day off)'),
        clear_dates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).max(60).optional().describe('ISO dates to put back on the weekly pattern'),
        time_zone: z.string().max(64).nullable().optional().describe('An IANA zone the hours are always in, or null to follow the zone the person is in (the default)'),
        availability_sharing: z.enum(AVAILABILITY_SHARING).optional().describe("Whether teammates in this workspace may see when the person is busy: 'busy_only' or 'none'"),
      }),
      execute: async ({ week, dates, clear_dates, time_zone, availability_sharing }) => {
        const supabase = getServiceClient()
        try {
          let sharing: AvailabilitySharing | undefined
          if (availability_sharing) {
            if (!workspaceId) return { success: false, error: 'Availability sharing is set per workspace, and there is none here.' }
            sharing = await saveSharing(supabase, person, availability_sharing)
          }
          const hoursChange = !!(week && Object.keys(week).length) || dates !== undefined || clear_dates !== undefined || time_zone !== undefined
          if (!hoursChange && sharing) return { success: true, ...hoursForModel(await readWorkingHours(supabase, person)), availability_sharing: sharing }
          let weekly: DayRange[][] | undefined
          if (week && Object.keys(week).length) {
            const current = await readWorkingHours(supabase, person)
            weekly = WEEKDAYS.map((name, i) => week[name] ?? current.weekly[i])
          }
          const saved = await saveWorkingHours(supabase, person, { weekly, setOverrides: dates, clearOverrides: clear_dates, ...(time_zone !== undefined ? { timeZone: time_zone } : {}) })
          return { success: true, ...hoursForModel(saved), ...(sharing ? { availability_sharing: sharing } : {}) }
        } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : 'Working hours could not be saved' }
        }
      },
    }),
  }
}
