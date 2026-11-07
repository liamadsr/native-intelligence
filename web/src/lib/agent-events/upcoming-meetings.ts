/**
 * The person's upcoming meetings, read from their CALENDAR (A6 review fix:
 * meeting prep and meeting-soon were starved).
 *
 * Before, both read pending captures (`auto_capture_status = 'pending'`),
 * whose only writer is syncCalendarToCaptures, which nothing schedules (an
 * uncalled route and the model's `sync_calendar` tool), so neither ever saw a
 * meeting, and a desktop calendar event was never "prep ready".
 *
 * WHY THE CALENDAR, NOT A SCHEDULED SYNC. Scheduling the calendar→captures
 * sync would make every meeting with two attendees in the next week a pending
 * capture: rows in the person's Captures list and calendar badges, and CRM
 * contacts created for every attendee on a timer, for everyone, whether or not
 * they use the always-on agent. Reading the calendar directly changes nothing
 * the person sees, costs one bounded provider read per calendar account per
 * pass, and only for people with a home thread whose workspace is neither
 * paused nor dormant.
 *
 * PER WORKSPACE (A6 review): a calendar account counts in the workspaces it is
 * linked to, or else only in the one it was connected in; the desktop's local
 * events in the workspace they are filed under. Never every workspace a
 * person is in. An account whose token is gone is marked and retried once a
 * day, not every pass.
 *
 * Sources, merged and deduped (same start and title, or the same calendar
 * event id):
 *   • calendar events (ref 'calendar_event', or 'local_calendar_event' for
 *     the desktop's), not all-day, not cancelled, and not ones the person
 *     declined (their own attendee entry on that account says 'declined',
 *     Google's and Microsoft Graph's word alike);
 *   • pending captures still made by the `sync_calendar` tool (ref
 *     'capture'), with the eval fence (`is_eval`), not demo or archived.
 *
 * Every meeting gets a stable `meetingKey` (a hash of its source and id: ids
 * can be long or hold ':'), shared by its meeting-soon rows and its prep
 * helper's idempotency key, so each can find the other. It keeps its series
 * identity too (meeting-series.ts deriveSeriesIdentity: the series key and
 * the iCalendar UID), so its prep can name the previous meeting of the
 * series (meeting-prep.ts previousOccurrence).
 */
import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { CalendarEvent } from '@/lib/integrations/calendar'
import { deriveSeriesIdentity } from '@/lib/integrations/meeting-series'

export type MeetingRef = 'calendar_event' | 'local_calendar_event' | 'capture'

export interface UpcomingMeeting {
  ref: MeetingRef
  /** The provider event id, the local event's external id, or the capture id. */
  id: string
  /** sha256(`<ref>:<id>`), 40 hex: the meeting's stable key. */
  meetingKey: string
  workspaceId: string
  userId: string
  title: string | null
  startIso: string
  /** Its end, when the source gives one after its start (a meeting's "happening now" lasts until it). */
  endIso?: string | null
  /** Attendee addresses, lower-cased (the person's own included, when listed). */
  attendees: string[]
  /** The calendar event id (get_meeting_prep's event_id), when known. */
  calendarEventId: string | null
  /** The pending capture standing for it, when one exists. */
  captureId: string | null
  /** Its recurring series (captures.series_key's value), when it has one. */
  seriesKey?: string | null
  /** Its iCalendar UID (captures.ical_uid's value), when known. */
  icalUid?: string | null
  /** A provider calendar event: the connected account it was read from (the meeting-changes watch trusts only a complete read of it). */
  accountId?: string | null
  /** A provider calendar event: the person organizes it (their own change is never news to them). */
  mine?: boolean
  /** A provider calendar event: how many people besides the person are invited (rooms left out). */
  others?: number
  /** Only in a `details` or `text` read (the look-ahead, meeting prep's check): where it is, as the calendar says it. */
  location?: string | null
  /** Only in a `details` or `text` read: the event's description (Microsoft's is its preview only), clipped. */
  description?: string | null
  /** Only in a `details` read: an all-day event. */
  allDay?: boolean
  /**
   * Only in a `details` read: a provider all-day event's date (YYYY-MM-DD):
   * Google's start is the bare date, Microsoft's that date's midnight in UTC.
   * Null for a timed event, and for a desktop one, whose start is local
   * midnight: its date is read in the person's zone (look-ahead candidates.ts).
   */
  allDayDate?: string | null
  /**
   * Only in a `details` read of a provider event: the person organizes it or
   * said yes to it (their own attendee entry, Google's; the event's own
   * answer, Microsoft's). False for an invite they haven't answered or
   * answered maybe (a stranger's invite lands so); null when the source can't
   * say (the desktop's).
   */
  accepted?: boolean | null
  /** Only in a `details` or `text` read: the organizer's address, lower case (Microsoft lists them apart from the attendees). */
  organizer?: string | null
  /**
   * Only in a `details` read of a provider event: the organizer is on the
   * event as an attendee who accepted. Google's shape for an invite its
   * organizer made in Google Calendar (they're listed, organizer and
   * accepted); Microsoft lists the organizer apart, so never there. The
   * look-ahead texts a guest's unanswered invite only with it (an emailed
   * invite can name anyone as its organizer: candidates.ts guestConfirmed).
   */
  organizerAccepted?: boolean
  /** Only in a `details` or `text` read: it repeats (a series), as the source says. */
  recurring?: boolean
}

/**
 * How a read is widened. `details` (the look-ahead, src/lib/look-ahead/):
 * all-day events too (their window is the provider's, by date), and each
 * event's location, description, organizer and recurrence kept. `text` (the
 * meeting pass: prep's check, meeting.needs_prep, reads what an event is
 * about): those four kept, timed events only. Every other caller reads as
 * before: timed events only, without them.
 */
export interface MeetingReadOptions {
  details?: boolean
  text?: boolean
}

/** A description kept in a `details` read is clipped to this. */
const DESCRIPTION_MAX = 1_000

/**
 * Everything one read of the window saw (readMeetingWindow): the meetings, and
 * what the meeting-changes watch (./meeting-changes.ts) needs besides them.
 */
export interface MeetingWindowRead {
  meetings: UpcomingMeeting[]
  /** Provider events in the window marked cancelled (Google's status, Outlook's isCancelled). */
  cancelled: UpcomingMeeting[]
  /** The meeting keys of provider events the person declined. */
  declined: Set<string>
  /** Accounts read in full this time: the read worked and was not cut at the per-read cap. */
  completeAccounts: Set<string>
}

export interface MeetingPerson {
  workspaceId: string
  userId: string
  /** Their home thread: a prep reports there. */
  conversationId: string
}

/** People read per page (the pass pages through everyone; MEETING_PEOPLE_PAGES bounds it). */
export const MEETING_PEOPLE_PAGE = 500
/** The most pages one pass reads (20,000 people). */
export const MEETING_PEOPLE_PAGES = 40
/** At most this many meetings per person per read. */
export const MAX_EVENTS = 50

/** The meeting's stable key. Pure. */
export function meetingKey(ref: MeetingRef, id: string): string {
  return createHash('sha256').update(`${ref}:${id}`).digest('hex').slice(0, 40)
}

/**
 * One page of everyone with a home thread (the always-on agent's people), in
 * a stable order (id). The pass reads pages until one comes back short.
 * Throws on a failed read (the cron step retries).
 */
export async function findMeetingPeople(supabase: SupabaseClient, page = 0, pageSize = MEETING_PEOPLE_PAGE): Promise<MeetingPerson[]> {
  const { data, error } = await supabase
    .from('chat_conversations')
    .select('id, user_id, workspace_id')
    .eq('is_home', true)
    .order('id', { ascending: true })
    .range(page * pageSize, page * pageSize + pageSize - 1)
  if (error) throw new Error(`home threads read failed: ${error.message}`)
  return ((data as Array<Record<string, unknown>> | null) ?? []).flatMap((r) =>
    typeof r.id === 'string' && typeof r.user_id === 'string' && typeof r.workspace_id === 'string'
      ? [{ conversationId: r.id, userId: r.user_id, workspaceId: r.workspace_id }]
      : [],
  )
}

function lowerEmails(values: unknown): string[] {
  return (Array.isArray(values) ? values : [])
    .map((v) => (typeof v === 'string' ? v : v && typeof v === 'object' && typeof (v as { email?: unknown }).email === 'string' ? (v as { email: string }).email : ''))
    .map((v) => v.trim().toLowerCase())
    .filter((v) => v.includes('@'))
}

/** An end as ISO, only when it reads and falls after the start; else null. */
function endIsoAfter(end: unknown, startMs: number): string | null {
  const ms = typeof end === 'string' ? Date.parse(end) : NaN
  return Number.isFinite(ms) && ms > startMs ? new Date(ms).toISOString() : null
}

function dedupeKeyOf(m: Pick<UpcomingMeeting, 'startIso' | 'title'>): string {
  return `${Date.parse(m.startIso)}|${(m.title ?? '').trim().toLowerCase()}`
}

/** A connected calendar account, as the pass reads it. */
export interface CalendarAccount {
  id: string
  provider: 'google' | 'microsoft'
}

/** What one account's read gave: its events, or that its token is gone (expired or revoked). */
export type AccountRead = { events: CalendarEvent[] } | 'no_token'

export interface UpcomingMeetingDeps {
  /** One account's events (getValidTokenForAccount + listAccountEvents); tests pass a stub. */
  listAccount?: (account: CalendarAccount, options: { timeMin: string; timeMax: string; maxResults: number }) => Promise<AccountRead>
  nowMs?: number
}

/** An account whose token was gone is tried again after this long (not every pass forever). */
export const ACCOUNT_RETRY_AFTER_MS = 24 * 60 * 60_000
/** A desktop calendar row older than this is stale (the desktop stopped pushing). */
export const LOCAL_CALENDAR_STALE_MS = 3 * 24 * 60 * 60_000

async function defaultListAccount(account: CalendarAccount, options: { timeMin: string; timeMax: string; maxResults: number }): Promise<AccountRead> {
  const { getValidTokenForAccount } = await import('@/lib/oauth/token-manager')
  const token = await getValidTokenForAccount(account.id)
  if (!token) return 'no_token'
  const { listAccountEvents } = await import('@/lib/integrations/calendar')
  return { events: await listAccountEvents(account.provider, token.token, { ...options, strict: true }) }
}

/**
 * The person's calendar accounts that belong to THIS workspace (A6 review: a
 * person in two workspaces must not get a meeting's notice and prep in both,
 * nor a prep filed in the wrong one). An account linked to workspaces (the
 * account-workspace junction) belongs to exactly those; one linked to none
 * belongs only to the workspace it was connected in (connected_account
 * .workspace_id). An account whose token was gone within
 * ACCOUNT_RETRY_AFTER_MS is left out (tried again once a day). Never throws:
 * a failed read is no accounts.
 */
export async function workspaceCalendarAccounts(
  supabase: SupabaseClient,
  person: Pick<MeetingPerson, 'workspaceId' | 'userId'>,
  nowMs: number,
): Promise<Array<CalendarAccount & { failedAt: string | null; email: string | null }>> {
  try {
    const read = (cols: string) =>
      supabase.from('connected_account').select(cols).eq('user_id', person.userId).eq('capability', 'calendar').eq('is_enabled', true)
    let res = await read('id, provider, workspace_id, account_email, agent_read_failed_at')
    // A database without migration 340's column: no back-off, the rest as usual.
    if (res.error) res = await read('id, provider, workspace_id, account_email')
    if (res.error) return []
    const accounts = ((res.data as unknown as Array<Record<string, unknown>> | null) ?? []).filter(
      (a) => typeof a.id === 'string' && (a.provider === 'google' || a.provider === 'microsoft'),
    )
    if (!accounts.length) return []
    const { data: links, error: linkError } = await supabase
      .from('connected_account_workspace')
      .select('account_id, workspace_id')
      .in('account_id', accounts.map((a) => a.id as string))
    if (linkError) return []
    const linked = new Map<string, Set<string>>()
    for (const l of (links as Array<{ account_id?: unknown; workspace_id?: unknown }> | null) ?? []) {
      if (typeof l.account_id !== 'string' || typeof l.workspace_id !== 'string') continue
      const set = linked.get(l.account_id) ?? new Set<string>()
      set.add(l.workspace_id)
      linked.set(l.account_id, set)
    }
    return accounts
      .filter((a) => {
        const set = linked.get(a.id as string)
        return set && set.size ? set.has(person.workspaceId) : a.workspace_id === person.workspaceId
      })
      .filter((a) => !(typeof a.agent_read_failed_at === 'string' && nowMs - Date.parse(a.agent_read_failed_at) < ACCOUNT_RETRY_AFTER_MS))
      .map((a) => ({
        id: a.id as string,
        provider: a.provider as CalendarAccount['provider'],
        failedAt: typeof a.agent_read_failed_at === 'string' ? a.agent_read_failed_at : null,
        email: typeof a.account_email === 'string' && a.account_email.includes('@') ? a.account_email.trim().toLowerCase() : null,
      }))
  } catch {
    return []
  }
}

/**
 * The person declined this event: their own attendee entry (the account's
 * address) says 'declined' (Google's responseStatus and Microsoft Graph's
 * status.response use the same word). Pure.
 */
export function declinedBy(e: Pick<CalendarEvent, 'attendeeDetails'>, ownEmail: string | null): boolean {
  if (!ownEmail || !Array.isArray(e.attendeeDetails)) return false
  return e.attendeeDetails.some(
    (d) => typeof d?.email === 'string' && d.email.trim().toLowerCase() === ownEmail && typeof d.responseStatus === 'string' && d.responseStatus.toLowerCase() === 'declined',
  )
}

/** The event's organizer is on it as an attendee who accepted (see UpcomingMeeting.organizerAccepted). Pure. */
export function organizerAttendsAccepted(e: Pick<CalendarEvent, 'organizer' | 'attendeeDetails'>): boolean {
  const organizer = typeof e.organizer === 'string' ? e.organizer.trim().toLowerCase() : ''
  if (!organizer || !Array.isArray(e.attendeeDetails)) return false
  return e.attendeeDetails.some(
    (d) => typeof d?.email === 'string' && d.email.trim().toLowerCase() === organizer && typeof d.responseStatus === 'string' && d.responseStatus.toLowerCase() === 'accepted',
  )
}

/** The person's own answer to an event (their attendee entry on that account), lower case, or null. Pure. */
export function ownResponse(e: Pick<CalendarEvent, 'attendeeDetails'>, ownEmail: string | null): string | null {
  if (!ownEmail || !Array.isArray(e.attendeeDetails)) return null
  const mine = e.attendeeDetails.find((d) => typeof d?.email === 'string' && d.email.trim().toLowerCase() === ownEmail)
  return typeof mine?.responseStatus === 'string' ? mine.responseStatus.toLowerCase() : null
}

/** Mark (or clear) an account's gone token, for the once-a-day retry. Never throws. */
async function markAccountRead(supabase: SupabaseClient, accountId: string, failedAt: string | null): Promise<void> {
  try {
    await supabase.from('connected_account').update({ agent_read_failed_at: failedAt }).eq('id', accountId)
  } catch {
    // A database without the column: no back-off.
  }
}

/**
 * The person's meetings in THIS workspace starting in (from, to], oldest
 * first, each once: its calendar accounts (workspaceCalendarAccounts, read in
 * parallel), the desktop's local events filed under this workspace, and
 * pending captures (the eval fence). A failed source degrades to the others.
 * Never throws.
 */
export async function listUpcomingMeetings(
  supabase: SupabaseClient,
  person: Pick<MeetingPerson, 'workspaceId' | 'userId'>,
  window: { fromMs: number; toMs: number },
  deps: UpcomingMeetingDeps = {},
): Promise<UpcomingMeeting[]> {
  return (await readMeetingWindow(supabase, person, window, deps)).meetings
}

/** The person organizes this event (the account's own address is its organizer). Pure. */
export function organizedBy(e: Pick<CalendarEvent, 'organizer' | 'attendeeDetails'>, ownEmail: string | null): boolean {
  if (!ownEmail) return false
  if (typeof e.organizer === 'string' && e.organizer.trim().toLowerCase() === ownEmail) return true
  return Array.isArray(e.attendeeDetails) && e.attendeeDetails.some((d) => d?.isOrganizer === true && typeof d.email === 'string' && d.email.trim().toLowerCase() === ownEmail)
}

/**
 * listUpcomingMeetings' one read, with what the meeting-changes watch needs
 * besides the meetings (MeetingWindowRead): the provider events marked
 * cancelled and the ones the person declined (both left out of `meetings`, as
 * before), and which accounts were read in full. Never throws.
 */
export async function readMeetingWindow(
  supabase: SupabaseClient,
  person: Pick<MeetingPerson, 'workspaceId' | 'userId'>,
  window: { fromMs: number; toMs: number },
  deps: UpcomingMeetingDeps = {},
  options: MeetingReadOptions = {},
): Promise<MeetingWindowRead> {
  const details = options.details === true
  // What an event is about: its place, words, organizer and recurrence (a `details` read keeps them too).
  const text = details || options.text === true
  const fromIso = new Date(window.fromMs).toISOString()
  const toIso = new Date(window.toMs).toISOString()
  const nowMs = deps.nowMs ?? window.fromMs
  const out: UpcomingMeeting[] = []
  const cancelled: UpcomingMeeting[] = []
  const declined = new Set<string>()
  const completeAccounts = new Set<string>()
  const seen = new Set<string>()
  const seenEventIds = new Set<string>()
  const push = (ref: MeetingRef, e: CalendarEvent, account?: { id: string; email: string | null }) => {
    if (!e?.id || !e.start || (e.isAllDay && !details)) return
    const startMs = Date.parse(e.start)
    if (!Number.isFinite(startMs)) return
    // An all-day event's window is the provider's (by date): its start is a
    // date, read as UTC midnight, which no instant window places right.
    if (!e.isAllDay && (startMs <= window.fromMs || startMs > window.toMs)) return
    const series = deriveSeriesIdentity({ id: e.id, start: e.start, seriesMasterId: e.seriesMasterId, icalUid: e.icalUid, hasRecurrence: e.hasRecurrence, source: e.source })
    const attendees = [...new Set([...lowerEmails(e.attendees), ...lowerEmails(e.attendeeDetails)])]
    const m: UpcomingMeeting = {
      ref,
      id: e.id.slice(0, 300),
      meetingKey: meetingKey(ref, e.id),
      workspaceId: person.workspaceId,
      userId: person.userId,
      title: typeof e.title === 'string' ? e.title : null,
      startIso: new Date(startMs).toISOString(),
      endIso: endIsoAfter(e.end, startMs),
      attendees,
      calendarEventId: e.id,
      captureId: null,
      seriesKey: series.seriesKey,
      icalUid: series.icalUid,
      ...(account
        ? {
            accountId: account.id,
            mine: organizedBy(e, account.email),
            others: attendees.filter((a) => a !== account.email && !isResourceAddress(a)).length,
          }
        : {}),
      ...(text
        ? {
            location: typeof e.location === 'string' && e.location.trim() ? e.location.trim().slice(0, 300) : null,
            description: typeof e.description === 'string' && e.description.trim() ? e.description.trim().slice(0, DESCRIPTION_MAX) : null,
            recurring: !!(e.hasRecurrence || e.seriesMasterId),
            organizer: typeof e.organizer === 'string' && e.organizer.includes('@') ? e.organizer.trim().toLowerCase() : null,
          }
        : {}),
      ...(details
        ? {
            allDay: e.isAllDay === true,
            allDayDate: e.isAllDay && account && /^\d{4}-\d{2}-\d{2}/.test(e.start) ? e.start.slice(0, 10) : null,
            accepted: account
              ? organizedBy(e, account.email) || ownResponse(e, account.email) === 'accepted' || e.myResponse === 'accepted' || e.myResponse === 'organizer'
              : null,
            ...(account ? { organizerAccepted: organizerAttendsAccepted(e) } : {}),
          }
        : {}),
    }
    // Cancelled and declined events are no meetings of the person's; the watch still hears of them.
    if (typeof e.status === 'string' && e.status.toLowerCase() === 'cancelled') {
      if (account) cancelled.push(m)
      return
    }
    if (account && declinedBy(e, account.email)) {
      declined.add(m.meetingKey)
      return
    }
    const k = dedupeKeyOf(m)
    if (seen.has(k)) return
    seen.add(k)
    seenEventIds.add(e.id)
    out.push(m)
  }

  const accounts = await workspaceCalendarAccounts(supabase, person, nowMs)
  const listAccount = deps.listAccount ?? defaultListAccount
  // Strict: a calendar that fails to read throws (read null below), never an empty list.
  const reads = await Promise.all(
    accounts.map(async (a) => {
      try {
        return { a, read: await listAccount(a, { timeMin: fromIso, timeMax: toIso, maxResults: MAX_EVENTS }) }
      } catch {
        // A provider error is transient: tried again next pass.
        return { a, read: null }
      }
    }),
  )
  for (const { a, read } of reads) {
    if (read === 'no_token') {
      await markAccountRead(supabase, a.id, new Date(nowMs).toISOString())
      continue
    }
    if (!read) continue
    if (a.failedAt) await markAccountRead(supabase, a.id, null)
    // A read cut at the cap may have dropped the window's last meetings: not complete.
    if (read.events.length < MAX_EVENTS) completeAccounts.add(a.id)
    for (const e of read.events.slice(0, MAX_EVENTS)) push('calendar_event', e, { id: a.id, email: a.email })
  }

  // The desktop's local calendar, as filed under this workspace.
  try {
    let query = supabase
      .from('local_calendar_event')
      .select(text ? 'external_id, title, start_at, end_at, is_all_day, attendees, has_recurrence, location, description' : 'external_id, title, start_at, end_at, is_all_day, attendees, has_recurrence')
      .eq('user_id', person.userId)
      .eq('workspace_id', person.workspaceId)
      .gt('start_at', fromIso)
      .lte('start_at', toIso)
    if (!details) query = query.eq('is_all_day', false)
    const { data, error } = await query
      .gte('synced_at', new Date(nowMs - LOCAL_CALENDAR_STALE_MS).toISOString())
      .order('start_at', { ascending: true })
      .limit(MAX_EVENTS)
    if (!error) {
      for (const l of (data as unknown as Array<Record<string, unknown>> | null) ?? []) {
        if (typeof l.external_id !== 'string' || typeof l.start_at !== 'string') continue
        const allDay = l.is_all_day === true
        push('local_calendar_event', {
          id: l.external_id,
          title: typeof l.title === 'string' ? l.title : '',
          start: l.start_at,
          end: typeof l.end_at === 'string' ? l.end_at : l.start_at,
          attendees: Array.isArray(l.attendees) ? (l.attendees as string[]) : [],
          // EventKit's id is the whole series' (meeting-series.ts).
          hasRecurrence: l.has_recurrence === true,
          isAllDay: allDay,
          ...(typeof l.location === 'string' ? { location: l.location } : {}),
          ...(typeof l.description === 'string' ? { description: l.description } : {}),
          source: 'local_exchange',
        } as CalendarEvent)
      }
    }
  } catch {
    // The desktop's calendar is optional.
  }

  try {
    const { data, error } = await supabase
      .from('captures')
      .select('id, title, scheduled_start, scheduled_end, calendar_event_id, status, metadata, series_key, ical_uid')
      .eq('user_id', person.userId)
      .eq('workspace_id', person.workspaceId)
      .eq('auto_capture_status', 'pending')
      // Eval fixtures never get a meeting notice or a prep (docs/plans/evals.md §5.2).
      .neq('is_eval', true)
      .gt('scheduled_start', fromIso)
      .lte('scheduled_start', toIso)
      .order('scheduled_start', { ascending: true })
      .limit(MAX_EVENTS)
    if (!error) {
      for (const c of (data as Array<Record<string, unknown>> | null) ?? []) {
        if (typeof c.id !== 'string' || typeof c.scheduled_start !== 'string') continue
        if (c.status === 'archived' || (c.metadata as { demo?: unknown } | null)?.demo === true) continue
        const calendarEventId = typeof c.calendar_event_id === 'string' ? c.calendar_event_id : null
        const m: UpcomingMeeting = {
          ref: 'capture',
          id: c.id,
          meetingKey: meetingKey('capture', c.id),
          workspaceId: person.workspaceId,
          userId: person.userId,
          title: typeof c.title === 'string' ? c.title : null,
          startIso: new Date(Date.parse(c.scheduled_start)).toISOString(),
          endIso: endIsoAfter(c.scheduled_end, Date.parse(c.scheduled_start)),
          attendees: [],
          calendarEventId,
          captureId: c.id,
          seriesKey: typeof c.series_key === 'string' ? c.series_key : null,
          icalUid: typeof c.ical_uid === 'string' ? c.ical_uid : null,
        }
        // The calendar already stands for it: note the capture on that meeting instead.
        const twin = out.find((o) => (calendarEventId && o.calendarEventId === calendarEventId) || dedupeKeyOf(o) === dedupeKeyOf(m))
        if (twin) {
          twin.captureId ??= c.id
          twin.endIso ??= m.endIso
          twin.seriesKey ??= m.seriesKey
          twin.icalUid ??= m.icalUid
          continue
        }
        if (calendarEventId && seenEventIds.has(calendarEventId)) continue
        out.push(m)
      }
    }
  } catch {
    // The calendar's meetings still count.
  }
  return { meetings: out.sort((a, b) => Date.parse(a.startIso) - Date.parse(b.startIso)), cancelled, declined, completeAccounts }
}

/** A meeting room or resource calendar, not a person. Pure. */
export function isResourceAddress(email: string): boolean {
  return /@resource\.calendar\.google\.com$/.test(email) || /@group\.calendar\.google\.com$/.test(email)
}

/**
 * Who else a meeting has, for its prep (Liam, 2026-10-17: internal meetings
 * get a lighter prep): 'external' when someone is neither the person, a
 * workspace member, a room nor one of the person's guests; 'internal' when
 * everyone else invited is a member. A meeting with nobody else (a solo
 * calendar block, or only the person's guests: Liam, 2026-10-31) has no
 * audience and gets no prep.
 */
export type MeetingAudience = 'external' | 'internal'

/** Who else one meeting has besides the person (meetingAttendance). */
export interface MeetingAttendance {
  audience: MeetingAudience
  /** Invited people from outside: not the person, a member, a room or one of their guests. */
  outside: number
  /** Invited workspace members besides the person. */
  teammates: number
  /** Invited guests of the person's (`trusted`: their People tab's calendar addresses). */
  guests: number
  /** The other attendees' email domains, lower case, each once (never their names). */
  domains: string[]
}

/** The domain of an address, lower case, or null. Pure. */
function domainOf(email: string): string | null {
  const at = email.lastIndexOf('@')
  return at > 0 && at < email.length - 1 ? email.slice(at + 1).toLowerCase() : null
}

/** The person's guests' addresses, or how to read them when needed (meetingAttendance reads them only then). */
export type TrustedEmails = ReadonlySet<string> | (() => Promise<ReadonlySet<string>>)

/**
 * Each meeting's attendance (of one person; meetingKey → MeetingAttendance),
 * only for meetings with at least one OTHER person invited: an address that
 * is not the person's own (their connected accounts), not a room and not one
 * of their guests (`trusted`, src/lib/guests/store.ts trustedGuestEmails:
 * Liam, 2026-10-31, a trip of invites from his wife got a prep each). So an
 * event whose only other attendees are guests has none, and gets no prep.
 *
 * A workspace member is never a guest, whatever the guest list says (an
 * agent-linked teammate, or a teammate's address typed for a guest): the
 * member lookup covers every invited address, and only a non-member on the
 * list counts as a guest, so "Liam / Sam weekly" keeps its prep and its
 * teammate count. `trusted` may be a loader: it is called only when some
 * meeting invites someone besides the person (no read for a day of solo
 * blocks).
 *
 * Someone who is not a workspace member's sign-in address (nor a guest)
 * makes it 'external'. A pending capture with no attendees listed is checked
 * through its participants (one from outside who isn't a guest makes it
 * external); with none it counts as internal, since only a meeting with two
 * attendees or more becomes a pending capture (sync_calendar). A failed read
 * of the person's own addresses knows no audience (no prep, the safe side); a
 * failed member read counts everyone else as a member (the lighter prep, and
 * no one a guest); a failed guest read is no guests. Never throws.
 */
export async function meetingAttendance(
  supabase: SupabaseClient,
  person: Pick<MeetingPerson, 'workspaceId' | 'userId'>,
  meetings: readonly UpcomingMeeting[],
  deps: { memberEmails?: (workspaceId: string, emails: string[]) => Promise<Set<string>>; trusted?: TrustedEmails } = {},
): Promise<Map<string, MeetingAttendance>> {
  const out = new Map<string, MeetingAttendance>()
  if (!meetings.length) return out
  try {
    const { data: accounts, error } = await supabase.from('connected_account').select('account_email').eq('user_id', person.userId)
    if (error) return out
    const own = new Set(lowerEmails(((accounts as Array<{ account_email?: unknown }> | null) ?? []).map((a) => a.account_email)))
    const invited = (m: UpcomingMeeting) => m.attendees.filter((e) => !own.has(e) && !isResourceAddress(e))
    const all = [...new Set(meetings.flatMap(invited))]
    const bare = meetings.filter((m) => m.ref === 'capture' && m.attendees.length === 0 && m.captureId)
    // The guest list, read only when someone besides the person is invited somewhere.
    const source = deps.trusted
    const trusted: ReadonlySet<string> =
      !source || (!all.length && !bare.length)
        ? new Set<string>()
        : typeof source === 'function'
          ? await Promise.resolve()
              .then(source)
              .catch(() => new Set<string>())
          : source
    const memberEmails =
      deps.memberEmails ??
      (async (workspaceId: string, emails: string[]) => {
        const { findMembersByEmail } = await import('@/lib/workspace-member-emails')
        return new Set((await findMembersByEmail(workspaceId, emails)).keys())
      })
    const members = all.length ? await memberEmails(person.workspaceId, all).catch(() => new Set(all)) : new Set<string>()
    const isGuest = (e: string) => trusted.has(e) && !members.has(e)
    const domains = (emails: readonly string[]) => [...new Set(emails.map(domainOf).filter((d): d is string => !!d))]
    for (const m of meetings) {
      const everyone = invited(m)
      const rest = everyone.filter((e) => !isGuest(e))
      if (!rest.length) continue
      const outside = rest.filter((e) => !members.has(e)).length
      out.set(m.meetingKey, {
        audience: outside > 0 ? 'external' : 'internal',
        outside,
        teammates: rest.length - outside,
        guests: everyone.length - rest.length,
        domains: domains(everyone),
      })
    }
    // Pending captures with no attendee list: their participants.
    if (bare.length) {
      const { data: parts, error: partError } = await supabase
        .from('capture_participant')
        .select('capture_id, member_id, external_email')
        .in('capture_id', bare.map((m) => m.captureId as string))
        .is('member_id', null)
        .limit(1000)
      const external = new Map<unknown, string[]>()
      for (const p of partError ? [] : ((parts as Array<{ capture_id?: unknown; external_email?: unknown }> | null) ?? [])) {
        if (typeof p.external_email !== 'string' || !p.external_email.trim()) continue
        external.set(p.capture_id, [...(external.get(p.capture_id) ?? []), p.external_email.trim().toLowerCase()])
      }
      for (const m of bare) {
        const emails = external.get(m.captureId) ?? []
        const outside = emails.filter((e) => !trusted.has(e)).length
        out.set(m.meetingKey, { audience: outside > 0 ? 'external' : 'internal', outside, teammates: 0, guests: emails.length - outside, domains: domains(emails) })
      }
    }
  } catch {
    // No audience known: no prep.
  }
  return out
}

/**
 * Each meeting's audience (meetingKey → MeetingAudience): meetingAttendance's,
 * for a caller that needs only that. Never throws.
 */
export async function meetingAudiences(
  supabase: SupabaseClient,
  person: Pick<MeetingPerson, 'workspaceId' | 'userId'>,
  meetings: readonly UpcomingMeeting[],
  deps: { memberEmails?: (workspaceId: string, emails: string[]) => Promise<Set<string>>; trusted?: TrustedEmails } = {},
): Promise<Map<string, MeetingAudience>> {
  const attendance = await meetingAttendance(supabase, person, meetings, deps)
  return new Map([...attendance].map(([key, a]) => [key, a.audience]))
}
