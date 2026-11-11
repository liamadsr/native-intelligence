import { tool } from 'ai'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  listCalendarEventsUnified,
  listCalendarEvents,
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
  getCalendarProvider,
} from '@/lib/integrations/calendar'
import type { CalendarEvent, CalendarSkip } from '@/lib/integrations/calendar'
import { isoInZone, readRangeEdge } from '@/lib/integrations/calendar-zone'
import { readMemberTimeZone } from '@/lib/agent-events/member-time-zone'
import { isTimeZone } from '@/lib/chat-cards/calendar'
import { wrapUntrusted } from '@/lib/email/untrusted'

const DAY_MS = 24 * 60 * 60_000

/**
 * An event as get_calendar_events hands it to a model: its description is
 * written by whoever sent the invite, so it goes inside the untrusted-content
 * marker (src/lib/email/untrusted.ts). The rest of the event keeps its shape.
 */
export function eventForModel<T extends Pick<CalendarEvent, 'description'>>(event: T): T {
  return event.description ? { ...event, description: wrapUntrusted(event.description, 'CALENDAR') ?? undefined } : event
}

/**
 * An event's times as the person reads them: in their zone, with the offset
 * (2026-11-05T07:00:00-05:00), whatever zone the provider answered in
 * (Exchange rows and Outlook come back in UTC, Google in the calendar's own
 * zone). One zone for every event, so a 12:00Z call is never read as noon.
 * An all-day event keeps its dates, and an unreadable time is left as it is.
 */
export function eventInZone<T extends Pick<CalendarEvent, 'start' | 'end' | 'isAllDay'>>(event: T, timeZone: string): T {
  if (event.isAllDay) return event
  const local = (iso: string) => {
    const at = Date.parse(iso)
    return Number.isFinite(at) ? isoInZone(at, timeZone) : iso
  }
  return { ...event, start: local(event.start), end: local(event.end) }
}

const SKIPPED_LABEL: Record<CalendarSkip['provider'], string> = {
  google: 'Google calendar',
  microsoft: 'Outlook calendar',
  local_exchange: 'Exchange calendar (from the Mac app)',
}

/** One line per calendar the read left out, so a partial list is never taken for the whole range. */
export function skippedWarnings(skipped: readonly CalendarSkip[]): string[] {
  return [...new Set(skipped.map((s) => `${SKIPPED_LABEL[s.provider]}${s.accountEmail ? ` ${s.accountEmail}` : ''} couldn't be read (${s.reason}): its events are missing from this list.`))]
}

/**
 * Where get_calendar_events finds the person's zone: the browser's this turn
 * (createTools' `timeZone`), else their saved one, read with `supabase`
 * (default: the service client).
 */
export interface CalendarZoneContext {
  supabase?: SupabaseClient
  timeZone?: string | null
}

/** The person's zone: the browser's, else readMemberTimeZone's chain, else UTC. Never throws. */
async function personZone(userId: string, workspaceId: string | undefined, zone: CalendarZoneContext | undefined): Promise<string> {
  const given = zone?.timeZone
  if (isTimeZone(given)) return given
  try {
    const supabase = zone?.supabase ?? (await import('@/lib/admin')).getServiceClient()
    return (await readMemberTimeZone(supabase, { workspaceId: workspaceId ?? '', userId })).timeZone
  } catch {
    return 'UTC'
  }
}

export function createCalendarTools(userId: string, workspaceId?: string, zone?: CalendarZoneContext) {
  return {
    get_calendar_events: tool({
      description:
        'Get calendar events for a date range. Returns events from ALL connected calendar accounts (Google, Outlook, and Exchange from the Mac app). Each event includes the source account info. ' +
        "Every time is in the person's time zone (`time_zone` in the answer), written with its offset; all-day events carry plain dates. " +
        'When the answer says `partial`, a calendar could not be read: its `warnings` say which, so never treat that list as the whole range.',
      inputSchema: z.object({
        start_date: z
          .string()
          .optional()
          .describe(
            "Start: an ISO date (2026-11-02, from the start of that day) or date-time. A date or a time with no offset is in the person's time zone. Defaults to now.",
          ),
        end_date: z
          .string()
          .optional()
          .describe(
            "End: an ISO date (2026-11-08 covers that whole day) or date-time, in the person's time zone like start_date. Defaults to 7 days after the start.",
          ),
        max_results: z
          .number()
          .optional()
          .default(10)
          .describe('Maximum number of events to return'),
        account_email: z
          .string()
          .optional()
          .describe('Filter events to a specific account email. If omitted, returns events from all accounts.'),
      }),
      execute: async ({ start_date, end_date, max_results, account_email }) => {
        const [provider, timeZone] = await Promise.all([getCalendarProvider(userId), personZone(userId, workspaceId, zone)])
        if (!provider) {
          return {
            success: false,
            error:
              'No calendar connected. Offer the person a Connect card: call connect with provider "google" or "microsoft" and capability "calendar". Never ask for a password or token.',
          }
        }

        // The range is read in the person's zone, then sent as instants. A
        // bare date used to go to the providers as written: Google refused it
        // (an empty list, skipped in silence) and Exchange read it as UTC
        // midnight, so "2026-11-02 to 2026-11-07" came back Exchange-only.
        const timeMin = start_date ? readRangeEdge(start_date, timeZone, 'start') : null
        if (start_date && timeMin === null) return { success: false, error: `Could not read start_date (${start_date}). Use an ISO date like 2026-11-02.` }
        const timeMax = end_date ? readRangeEdge(end_date, timeZone, 'end') : timeMin !== null ? timeMin + 7 * DAY_MS : null
        if (end_date && timeMax === null) return { success: false, error: `Could not read end_date (${end_date}). Use an ISO date like 2026-11-08.` }
        if (timeMin !== null && timeMax !== null && timeMax <= timeMin) return { success: false, error: 'end_date must be after start_date.' }

        try {
          const cap = Math.max(1, max_results ?? 10)
          const want = account_email?.trim().toLowerCase()
          const skipped: CalendarSkip[] = []

          // listCalendarEventsUnified passes maxResults to each provider, then
          // merges OAuth events with local Exchange rows. The merged result can
          // exceed `max_results` (e.g. 3 Google + 3 Exchange = 6 when caller
          // asked for 3). Over-fetch a bit (in case account_email filters out
          // some) and slice the final list to honor the contract.
          const events = await listCalendarEventsUnified(userId, {
            timeMin: timeMin !== null ? new Date(timeMin).toISOString() : undefined,
            timeMax: timeMax !== null ? new Date(timeMax).toISOString() : undefined,
            maxResults: cap,
            workspaceId,
            onSkipped: (s) => skipped.push(s),
          })

          // Filter by account_email if specified
          const filtered = want
            ? events.filter(e => e.accountEmail?.toLowerCase() === want)
            : events

          // Hard cap on the final returned list — agents rely on this for
          // token budgets and predictable behavior.
          const limited = filtered.slice(0, cap).map((e) => eventForModel(eventInZone(e, timeZone)))
          // A calendar the read left out (another account's, when one is named, is no loss here).
          const warnings = skippedWarnings(want ? skipped.filter((s) => !s.accountEmail || s.accountEmail.toLowerCase() === want) : skipped)

          return {
            success: true,
            time_zone: timeZone,
            events: limited,
            count: limited.length,
            requested_limit: cap,
            truncated: filtered.length > cap,
            ...(warnings.length ? { partial: true, warnings } : {}),
          }
        } catch (err) {
          return {
            success: false,
            error:
              err instanceof Error ? err.message : 'Failed to fetch events',
          }
        }
      },
    }),

    create_calendar_event: tool({
      description:
        'Create a new calendar event. Optionally specify which account to create it on via account_email.',
      inputSchema: z.object({
        title: z.string().describe('Event title/subject'),
        start: z
          .string()
          .describe('Start date/time in ISO 8601 format'),
        end: z.string().describe('End date/time in ISO 8601 format'),
        description: z
          .string()
          .optional()
          .describe('Event description or notes'),
        location: z.string().optional().describe('Event location'),
        attendees: z
          .array(z.string())
          .optional()
          .describe('Email addresses of attendees'),
        is_all_day: z
          .boolean()
          .optional()
          .default(false)
          .describe('Whether this is an all-day event'),
        account_email: z
          .string()
          .optional()
          .describe('Which calendar account to create the event on. Defaults to the primary account.'),
        add_meeting_link: z
          .boolean()
          .optional()
          .describe(
            'Add a meeting link of our own (a video call anyone invited can join from the event, guests without an account included) as the event\'s location. Only when the person asks for a call, a video meeting or a meeting link; never by default.',
          ),
      }),
      execute: async ({
        title,
        start,
        end,
        description,
        location,
        attendees,
        is_all_day,
        account_email,
        add_meeting_link,
      }) => {
        const provider = await getCalendarProvider(userId)
        if (!provider) {
          return {
            success: false,
            error:
              'No calendar connected. Offer the person a Connect card: call connect with provider "google" or "microsoft" and capability "calendar". Never ask for a password or token.',
          }
        }

        try {
          // If account_email specified, find the matching accountId
          let accountId: string | undefined
          if (account_email) {
            const { getServiceClient } = await import('@/lib/admin')
            const supabase = getServiceClient()
            let accountQuery = supabase
              .from('connected_account')
              .select('id')
              .eq('user_id', userId)
              .eq('capability', 'calendar')
              // Case-insensitive: the model often re-cases the address. The
              // ilike pattern is the literal address (its wildcards escaped).
              .ilike('account_email', account_email.trim().replace(/[\\%_]/g, '\\$&'))
            // If workspaceId available, scope to accounts assigned to this workspace
            if (workspaceId) {
              const { data: wsAccounts } = await supabase
                .from('connected_account_workspace')
                .select('account_id')
                .eq('workspace_id', workspaceId)
              const wsAccountIds = (wsAccounts || []).map((a) => a.account_id)
              if (wsAccountIds.length > 0) {
                accountQuery = accountQuery.in('id', wsAccountIds)
              }
            }
            const { data: account } = await accountQuery.limit(1).maybeSingle()
            accountId = account?.id
            // A named account that doesn't match must not fall back to the
            // first connected calendar (and send its invites from there).
            if (!accountId) {
              return { success: false, error: `No calendar account ${account_email} is connected here.` }
            }
          }

          // A meeting link, only when asked for (the person is its host; the tools run as the service role).
          let meetingUrl: string | null = null
          if (add_meeting_link) {
            if (!workspaceId) return { success: false, error: 'A meeting link needs a workspace.' }
            const { getServiceClient } = await import('@/lib/admin')
            const { meetingLinkForNewEvent } = await import('@/lib/meeting-links/calendar')
            const svc = getServiceClient()
            const { data: me } = await svc.from('member').select('id').eq('user_id', userId).eq('workspace_id', workspaceId).maybeSingle<{ id: string }>()
            if (!me) return { success: false, error: 'You are not a member of this workspace.' }
            const made = await meetingLinkForNewEvent(svc, { workspaceId, title, start, end, isAllDay: is_all_day, location, description, hostMemberId: me.id })
            if (!made.ok) return { success: false, error: made.error }
            meetingUrl = made.link.url
            location = made.location
            description = made.description
          }

          const event = await createCalendarEvent(userId, {
            title,
            start,
            end,
            description,
            location,
            attendees,
            isAllDay: is_all_day,
          }, accountId)

          return meetingUrl ? { success: true, event, meeting_link: meetingUrl } : { success: true, event }
        } catch (err) {
          return {
            success: false,
            error:
              err instanceof Error ? err.message : 'Failed to create event',
          }
        }
      },
    }),

    update_calendar_event: tool({
      description: 'Update an existing calendar event.',
      inputSchema: z.object({
        event_id: z.string().describe('The event ID to update'),
        title: z.string().optional().describe('New title'),
        description: z.string().optional().describe('New description'),
        start: z.string().optional().describe('New start date/time'),
        end: z.string().optional().describe('New end date/time'),
        location: z.string().optional().describe('New location'),
      }),
      execute: async ({ event_id, title, description, start, end, location }) => {
        const provider = await getCalendarProvider(userId)
        if (!provider) {
          return { success: false, error: 'No calendar connected.' }
        }

        try {
          const event = await updateCalendarEvent(userId, event_id, {
            title,
            description,
            start,
            end,
            location,
          })

          return { success: true, event }
        } catch (err) {
          return {
            success: false,
            error:
              err instanceof Error ? err.message : 'Failed to update event',
          }
        }
      },
    }),

    delete_calendar_event: tool({
      description: 'Delete a calendar event.',
      inputSchema: z.object({
        event_id: z.string().describe('The event ID to delete'),
      }),
      execute: async ({ event_id }) => {
        const provider = await getCalendarProvider(userId)
        if (!provider) {
          return { success: false, error: 'No calendar connected.' }
        }

        try {
          await deleteCalendarEvent(userId, event_id)
          return { success: true, message: 'Event deleted' }
        } catch (err) {
          return {
            success: false,
            error:
              err instanceof Error ? err.message : 'Failed to delete event',
          }
        }
      },
    }),
  }
}
