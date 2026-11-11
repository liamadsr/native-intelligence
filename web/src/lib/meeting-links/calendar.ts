/**
 * A calendar event the app makes, with a meeting link when one is asked for
 * (calls plan, phase 7; server only). Never added on its own: the event
 * dialog's "Add a meeting link" and the agent's create_calendar_event
 * (add_meeting_link) ask for it.
 *
 * The link goes in the event's location (the field every calendar shows and
 * our own reader checks first, src/lib/integrations/calendar.ts), or, when
 * the person typed a location of their own, in the first line of its
 * description. Either way an event of ours shows Join, which opens the
 * meeting in the app.
 */
import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { teamCallsConfig } from '@/lib/team-calls/livekit'
import { createMeetingLink, meetingLinkForEvent, type MeetingLink } from './create'
import { MEETING_DEFAULT_MINUTES, MEETING_MAX_MINUTES, MEETING_MIN_MINUTES } from './shape'

/** A meeting's planned length from an event's times, within the bounds a meeting has. */
export function meetingMinutesOf(start: string, end: string): number {
  const span = (Date.parse(end) - Date.parse(start)) / 60_000
  if (!Number.isFinite(span) || span <= 0) return MEETING_DEFAULT_MINUTES
  return Math.min(MEETING_MAX_MINUTES, Math.max(MEETING_MIN_MINUTES, Math.round(span)))
}

/** Where a meeting link goes on an event: its location, or the top of its description when it has a location already. */
export function eventFieldsWithLink(event: { location?: string | null; description?: string | null }, url: string): { location: string | undefined; description: string | undefined } {
  const { location, descriptionLine } = meetingLinkForEvent(url)
  const typed = event.location?.trim()
  const notes = event.description?.trim()
  if (!typed) return { location, description: notes ? `${descriptionLine}\n\n${notes}` : descriptionLine }
  return { location: typed, description: notes ? `${descriptionLine}\n\n${notes}` : descriptionLine }
}

export type EventMeetingLink = { ok: true; link: MeetingLink; location: string | undefined; description: string | undefined } | { ok: false; error: string }

/**
 * A meeting link for an event about to be made, named and timed as the event
 * is. `hostMemberId` with the service role (the agent's tool), none with the
 * person's own client (the dialog). Never throws.
 */
export async function meetingLinkForNewEvent(
  supabase: SupabaseClient,
  event: { workspaceId: string; title: string; start: string; end: string; isAllDay?: boolean; location?: string | null; description?: string | null; hostMemberId?: string },
): Promise<EventMeetingLink> {
  if (!teamCallsConfig()) return { ok: false, error: 'Meeting links aren’t available here.' }
  if (event.isAllDay) return { ok: false, error: 'An all-day event can’t have a meeting link.' }
  try {
    const link = await createMeetingLink(supabase, {
      workspaceId: event.workspaceId,
      title: event.title.slice(0, 80),
      startsAt: event.start,
      minutes: meetingMinutesOf(event.start, event.end),
      ...(event.hostMemberId ? { hostMemberId: event.hostMemberId } : {}),
    })
    return { ok: true, link, ...eventFieldsWithLink(event, link.url) }
  } catch (err) {
    return { ok: false, error: err instanceof Error && err.message && !err.message.includes(':') ? err.message : 'The meeting link couldn’t be made.' }
  }
}
