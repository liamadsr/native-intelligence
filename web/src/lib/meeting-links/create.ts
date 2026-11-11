/**
 * Making a meeting link (server only): the one function every place that
 * wants a link calls. The team chat dialog's route, a calendar event the app
 * makes with "Add a meeting link" (the event's route and the agent's
 * create_calendar_event), and a booked meeting's location (the booking
 * side's to call).
 *
 * As the person (their Supabase client: 574's meeting_create checks they
 * are a member of the workspace and makes them the host), or with the
 * service role for a member the server already knows (`hostMemberId`:
 * 574's meeting_create_for checks they are the workspace's). The server picks
 * the meeting's id and derives the token from it (src/lib/meeting-links/link.ts);
 * only the token's hash reaches the database.
 */
import 'server-only'
import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { TeamChatError } from '@/lib/team-chat/store'
import { insertMeeting, replaceMeetingLink } from './store'
import { meetingLink, meetingToken, newTokenNonce, tokenDigest } from './link'
import { MEETING_DEFAULT_MINUTES, MEETING_MAX_MINUTES, MEETING_MIN_MINUTES, cleanMeetingTitle } from './shape'

export interface MeetingLinkInput {
  workspaceId: string
  title: string
  /** When it starts (ISO), or null: a link that works from now for 30 days. */
  startsAt?: string | null
  /** How long it is planned to last (with a start), 5 to 480 minutes; 30 when not given. */
  minutes?: number | null
  /**
   * With the service role only: the member who hosts it (the agent's calendar
   * tool, a booked meeting). Without it, the client is the person's and they
   * are the host.
   */
  hostMemberId?: string
}

export interface MeetingLink {
  meetingId: string
  channelId: string
  url: string
  title: string
  opensAt: string
  closesAt: string
}

/** Make a meeting and its link, as the person. Throws a TeamChatError ('bad_request' for a bad title or time). */
export async function createMeetingLink(supabase: SupabaseClient, input: MeetingLinkInput): Promise<MeetingLink> {
  const title = cleanMeetingTitle(input.title)
  if (!title) throw new TeamChatError('bad_request', 'Give the meeting a title of up to 80 characters.')
  let startsAt: string | null = null
  if (input.startsAt) {
    const at = Date.parse(input.startsAt)
    if (!Number.isFinite(at)) throw new TeamChatError('bad_request', 'Pick a start time.')
    startsAt = new Date(at).toISOString()
  }
  const minutes = input.minutes ?? (startsAt ? MEETING_DEFAULT_MINUTES : null)
  if (minutes !== null && (!Number.isInteger(minutes) || minutes < MEETING_MIN_MINUTES || minutes > MEETING_MAX_MINUTES)) {
    throw new TeamChatError('bad_request', 'A meeting is 5 minutes to 8 hours long.')
  }
  const meetingId = randomUUID()
  const nonce = newTokenNonce()
  const made = await insertMeeting(supabase, {
    meetingId,
    workspaceId: input.workspaceId,
    title,
    tokenDigest: tokenDigest(meetingToken(meetingId, nonce)),
    tokenNonce: nonce,
    startsAt,
    minutes,
    ...(input.hostMemberId ? { hostMemberId: input.hostMemberId } : {}),
  })
  console.info(`[meetings] meeting=${made.meetingId} channel=${made.channelId} scheduled=${!!startsAt}`)
  return { meetingId: made.meetingId, channelId: made.channelId, url: meetingLink(made.meetingId, nonce), title, opensAt: made.opensAt, closesAt: made.closesAt }
}

/**
 * The host replaces a meeting's link (a leaked one, say): a new random nonce,
 * so a new token; the old link stops working at once. The meeting and its
 * conversation stay. As the person (574's meeting_new_link: the host only).
 */
export async function newMeetingLink(supabase: SupabaseClient, meetingId: string): Promise<string> {
  const nonce = newTokenNonce()
  await replaceMeetingLink(supabase, { meetingId, tokenDigest: tokenDigest(meetingToken(meetingId, nonce)), tokenNonce: nonce })
  console.info(`[meetings] meeting=${meetingId} outcome=new_link`)
  return meetingLink(meetingId, nonce)
}

/** The words a calendar event carries for a meeting link: its location, and a line for its description. */
export function meetingLinkForEvent(url: string): { location: string; descriptionLine: string } {
  return { location: url, descriptionLine: `Join the meeting: ${url}` }
}
