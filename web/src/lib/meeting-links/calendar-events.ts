/**
 * A scheduled meeting link on its host's calendar (server only; the service
 * role). Migration 586.
 *
 *   - Made with a start time from team chat: {@link addMeetingToCalendar}
 *     writes it to the calendar the host chose (or their default) among their
 *     connected Google or Outlook accounts in the workspace, once (the
 *     meeting's id is the idempotency key), our link as its location and the
 *     first line of its description, no provider video link; the meeting
 *     remembers the event and the account (586). No connected calendar: no
 *     provider event, and the app's calendar shows the meeting from the
 *     meeting table itself ({@link meetingCalendarEvents}).
 *   - A new link, a revoke, an end for everyone, a move or a rename:
 *     {@link meetingCalendarChanged} updates or removes that event on the same
 *     calendar. An account disconnected since (586 sets it null) or a provider
 *     that refuses: logged with ids, and the meeting's own change stands.
 *
 * Nothing here ever fails the meeting: every function returns what became of
 * the calendar and never throws. A booking's meeting (585) never comes here:
 * its booking keeps its own event. An unscheduled link gets no calendar entry.
 */
import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createCalendarEvent, deleteCalendarEvent, updateCalendarEvent, type CalendarEvent } from '@/lib/integrations/calendar'
import { writableCalendarAccounts } from '@/lib/time-offers/host-calendar'
import { meetingLink } from './link'
import { MEETING_MAX_MINUTES, MEETING_MIN_MINUTES, MEETING_TITLE_MAX, cleanMeetingTitle } from './shape'

/** The source the app's calendar marks a meeting it shows from the meeting table with. */
export const MEETING_CALENDAR_SOURCE = 'meeting_link'
/** A shown meeting's event id: never a provider's. */
export const MEETING_EVENT_PREFIX = 'meeting:'

/** The first line of a meeting's event description. */
export function joinLine(url: string): string {
  return `Join the meeting: ${url}`
}

export interface CalendarDeps {
  accounts?: typeof writableCalendarAccounts
  createEvent?: typeof createCalendarEvent
  updateEvent?: typeof updateCalendarEvent
  deleteEvent?: typeof deleteCalendarEvent
  now?: () => number
}

const idsOf = (meetingId: string, extra = '') => `meeting=${meetingId}${extra}`

/**
 * Put a scheduled meeting on its host's calendar. `accountId`: the calendar
 * they picked (ignored unless it is one of theirs and writable). Never throws.
 */
export async function addMeetingToCalendar(
  svc: SupabaseClient,
  args: { meeting: { id: string; title: string; startsAt: string; endsAt: string; url: string }; userId: string; workspaceId: string; accountId?: string | null },
  deps: CalendarDeps = {},
): Promise<{ written: 'provider'; accountId: string; eventId: string } | { written: 'app' } | { written: 'failed' }> {
  const { meeting } = args
  let accountId: string | null = null
  try {
    const accounts = await (deps.accounts ?? writableCalendarAccounts)(svc, args.userId, args.workspaceId)
    if (!accounts.length) return { written: 'app' }
    const account = accounts.find((a) => a.id === args.accountId) ?? accounts[0]
    accountId = account.id
    const event = await (deps.createEvent ?? createCalendarEvent)(
      args.userId,
      { title: meeting.title, description: joinLine(meeting.url), start: meeting.startsAt, end: meeting.endsAt, location: meeting.url },
      account.id,
      { video: false, idempotencyKey: meeting.id },
    )
    const { error } = await svc.from('meeting').update({ calendar_event_id: event.id, calendar_account_id: account.id }).eq('id', meeting.id)
    if (error) throw new Error(`the meeting didn't keep its event: ${error.message}`)
    console.info(`[meetings] ${idsOf(meeting.id)} account=${account.id} outcome=calendar_event`)
    return { written: 'provider', accountId: account.id, eventId: event.id }
  } catch (err) {
    console.warn(`[meetings] ${idsOf(meeting.id, accountId ? ` account=${accountId}` : '')} calendar event not written:`, err instanceof Error ? err.message.slice(0, 160) : 'unknown')
    return { written: 'failed' }
  }
}

export type MeetingCalendarChange =
  | { kind: 'relinked'; url: string }
  | { kind: 'revoked' }
  | { kind: 'ended' }
  | { kind: 'moved'; title?: string; startsAt?: string; endsAt?: string }

interface MeetingEventRow {
  calendar_event_id: string | null
  calendar_account_id: string | null
  host_member_id: string | null
  starts_at: string | null
  ends_at: string | null
}

/**
 * The meeting changed: its calendar event (if it has one) follows, on the
 * calendar it was written to. Never throws; says what became of the event.
 */
export async function meetingCalendarChanged(
  svc: SupabaseClient,
  meetingId: string,
  change: MeetingCalendarChange,
  deps: CalendarDeps = {},
): Promise<'none' | 'updated' | 'deleted' | 'unchanged' | 'skipped' | 'failed'> {
  try {
    const { data: m, error } = await svc
      .from('meeting')
      .select('calendar_event_id, calendar_account_id, host_member_id, starts_at, ends_at')
      .eq('id', meetingId)
      .maybeSingle<MeetingEventRow>()
    if (error) throw new Error(error.message)
    if (!m?.calendar_event_id) return 'none'
    if (!m.calendar_account_id || !m.host_member_id) {
      // Its account was disconnected since: nothing to write to.
      console.warn(`[meetings] ${idsOf(meetingId)} calendar event not changed: its account is gone`)
      return 'skipped'
    }
    const { data: host } = await svc.from('member').select('user_id').eq('id', m.host_member_id).maybeSingle<{ user_id: string }>()
    if (!host?.user_id) return 'skipped'
    const on = { accountId: m.calendar_account_id }
    switch (change.kind) {
      case 'revoked':
        await (deps.deleteEvent ?? deleteCalendarEvent)(host.user_id, m.calendar_event_id, on)
        await svc.from('meeting').update({ calendar_event_id: null }).eq('id', meetingId)
        return 'deleted'
      case 'relinked':
        await (deps.updateEvent ?? updateCalendarEvent)(host.user_id, m.calendar_event_id, { location: change.url, description: joinLine(change.url) }, on)
        return 'updated'
      case 'ended': {
        // Ended during its planned time: the event ends now. Before or after it: left as it is.
        const now = (deps.now ?? Date.now)()
        if (!m.starts_at || !m.ends_at || now < Date.parse(m.starts_at) || now >= Date.parse(m.ends_at)) return 'unchanged'
        await (deps.updateEvent ?? updateCalendarEvent)(host.user_id, m.calendar_event_id, { end: new Date(now).toISOString() }, on)
        return 'updated'
      }
      case 'moved': {
        const updates: { title?: string; start?: string; end?: string } = {}
        if (change.title) updates.title = change.title
        if (change.startsAt) updates.start = change.startsAt
        if (change.endsAt) updates.end = change.endsAt
        if (!Object.keys(updates).length) return 'unchanged'
        await (deps.updateEvent ?? updateCalendarEvent)(host.user_id, m.calendar_event_id, updates, on)
        return 'updated'
      }
    }
  } catch (err) {
    console.warn(`[meetings] ${idsOf(meetingId)} calendar event not changed (${change.kind}):`, err instanceof Error ? err.message.slice(0, 160) : 'unknown')
    return 'failed'
  }
}

export type MeetingChangeResult = { ok: true; title: string; startsAt: string; endsAt: string } | { ok: false; status: 400 | 403 | 404; error: string }

/**
 * The host moves or renames a scheduled meeting (from the app's calendar):
 * its window follows (15 minutes before, 2 hours after, as 574's meeting_make
 * sets one), its conversation takes the new name, and its calendar event (if
 * it has one) follows. A booking's meeting is moved by its booking only.
 */
export async function changeMeeting(
  svc: SupabaseClient,
  args: { meetingId: string; userId: string; title?: string; startsAt?: string; endsAt?: string },
  deps: CalendarDeps = {},
): Promise<MeetingChangeResult> {
  const { data: m } = await svc
    .from('meeting')
    .select('id, channel_id, host_member_id, title, starts_at, ends_at, revoked_at, booking_id')
    .eq('id', args.meetingId)
    .maybeSingle<{ id: string; channel_id: string; host_member_id: string | null; title: string; starts_at: string | null; ends_at: string | null; revoked_at: string | null; booking_id: string | null }>()
  if (!m) return { ok: false, status: 404, error: 'No such meeting' }
  const { data: host } = m.host_member_id ? await svc.from('member').select('user_id').eq('id', m.host_member_id).maybeSingle<{ user_id: string }>() : { data: null }
  if (!host || host.user_id !== args.userId) return { ok: false, status: 403, error: 'Only the host can change this meeting' }
  if (m.booking_id) return { ok: false, status: 400, error: 'A booked meeting moves with its booking' }
  if (m.revoked_at || !m.starts_at || !m.ends_at) return { ok: false, status: 400, error: 'This meeting has no time to change' }
  const title = args.title !== undefined ? cleanMeetingTitle(args.title.slice(0, MEETING_TITLE_MAX + 40)) : m.title
  if (!title) return { ok: false, status: 400, error: 'Give the meeting a title of up to 80 characters.' }
  const startsAt = args.startsAt ?? m.starts_at
  const endsAt = args.endsAt ?? (args.startsAt ? new Date(Date.parse(args.startsAt) + (Date.parse(m.ends_at) - Date.parse(m.starts_at))).toISOString() : m.ends_at)
  const minutes = Math.round((Date.parse(endsAt) - Date.parse(startsAt)) / 60_000)
  if (!Number.isFinite(minutes) || minutes < MEETING_MIN_MINUTES || minutes > MEETING_MAX_MINUTES) return { ok: false, status: 400, error: 'A meeting is 5 minutes to 8 hours long.' }
  const start = new Date(startsAt)
  const end = new Date(endsAt)
  const renamed = title !== m.title
  const { error } = await svc
    .from('meeting')
    .update({
      title,
      starts_at: start.toISOString(),
      ends_at: end.toISOString(),
      opens_at: new Date(start.getTime() - 15 * 60_000).toISOString(),
      closes_at: new Date(end.getTime() + 2 * 60 * 60_000).toISOString(),
    })
    .eq('id', m.id)
  if (error) return { ok: false, status: 400, error: 'The meeting could not be changed.' }
  if (renamed) await svc.from('team_chat_channel').update({ name: title }).eq('id', m.channel_id)
  await meetingCalendarChanged(svc, m.id, { kind: 'moved', title: renamed ? title : undefined, startsAt: start.toISOString(), endsAt: end.toISOString() }, deps)
  console.info(`[meetings] ${idsOf(m.id)} outcome=moved`)
  return { ok: true, title, startsAt: start.toISOString(), endsAt: end.toISOString() }
}

/**
 * The host's scheduled meeting links in a range, as the app's calendar shows
 * them when no provider event stands for them (no connected calendar, or one
 * that wasn't written). Their link is the event's location and conference
 * link (so the calendar's Join opens the meeting). Throws on a failed read.
 */
export async function meetingCalendarEvents(
  svc: SupabaseClient,
  userId: string,
  range: { timeMin: string; timeMax: string; workspaceId?: string },
): Promise<CalendarEvent[]> {
  let members = svc.from('member').select('id').eq('user_id', userId)
  if (range.workspaceId) members = members.eq('workspace_id', range.workspaceId)
  const { data: mine, error: memberError } = await members
  if (memberError) throw new Error(memberError.message)
  const ids = ((mine ?? []) as Array<{ id: string }>).map((m) => m.id)
  if (!ids.length) return []
  const { data, error } = await svc
    .from('meeting')
    .select('id, title, starts_at, ends_at, token_nonce, calendar_event_id, booking_id, revoked_at')
    .in('host_member_id', ids)
    .is('revoked_at', null)
    .is('booking_id', null)
    .is('calendar_event_id', null)
    .not('starts_at', 'is', null)
    .lte('starts_at', range.timeMax)
    .gte('ends_at', range.timeMin)
    .limit(200)
  if (error) throw new Error(error.message)
  return ((data ?? []) as Array<{ id: string; title: string; starts_at: string; ends_at: string; token_nonce: string | null }>)
    .filter((m) => !!m.token_nonce)
    .map((m): CalendarEvent => {
      const url = meetingLink(m.id, m.token_nonce as string)
      return {
        id: `${MEETING_EVENT_PREFIX}${m.id}`,
        title: m.title,
        description: joinLine(url),
        start: m.starts_at,
        end: m.ends_at,
        isAllDay: false,
        location: url,
        attendees: [],
        conferenceUrl: url,
        calendarName: 'Meeting links',
        source: MEETING_CALENDAR_SOURCE,
      }
    })
}

/** A shown meeting's id from its calendar event id, or null for any other event. */
export function meetingIdOfEvent(eventId: string | null | undefined): string | null {
  if (!eventId || !eventId.startsWith(MEETING_EVENT_PREFIX)) return null
  const id = eventId.slice(MEETING_EVENT_PREFIX.length)
  return /^[0-9a-f-]{36}$/i.test(id) ? id : null
}

/** The meeting whose calendar event this provider event is (the host's own), or null. */
export async function meetingOfProviderEvent(svc: SupabaseClient, userId: string, eventId: string): Promise<string | null> {
  const { data } = await svc.from('meeting').select('id, host_member_id').eq('calendar_event_id', eventId).limit(1).maybeSingle<{ id: string; host_member_id: string | null }>()
  if (!data?.host_member_id) return null
  const { data: host } = await svc.from('member').select('user_id').eq('id', data.host_member_id).maybeSingle<{ user_id: string }>()
  return host?.user_id === userId ? data.id : null
}
