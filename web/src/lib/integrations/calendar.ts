import { getValidToken, getValidTokenForAccount, getValidTokenForCapability, getAllValidTokens } from '@/lib/oauth/token-manager'
import { getServiceClient } from '@/lib/admin'
import { meetingUrlIn } from '@/lib/meeting-links/shape'

/**
 * One attendee with the display name the provider gave us.
 *
 * `CalendarEvent.attendees` is a bare `string[]` and has many consumers
 * (local_calendar_event rows, createEvent request bodies, the IEvent adapter),
 * so it stays exactly as it is. This parallel field carries the name Google
 * (`displayName`) and Microsoft (`emailAddress.name`) actually send, which the
 * flattening used to throw away — and which the CRM needs, because a contact
 * whose name is its own email address is refused by the noise filter.
 */
export interface CalendarEventAttendee {
  email: string
  name?: string
  isOrganizer?: boolean
  responseStatus?: string
}

/**
 * An event's video call: the provider's own (Meet, Teams, a Zoom add-on), else
 * one of our meeting links written into its location or description (phase
 * 7: an event the app made with "Add a meeting link", or one a person pasted
 * ours into), so it shows Join too. Only the app's own origins count.
 */
export function conferenceUrlOf(provider: string | null | undefined, location: string | null | undefined, description: string | null | undefined): string | undefined {
  return provider || meetingUrlIn(location) || meetingUrlIn(description) || undefined
}

export interface CalendarEvent {
  id: string
  title: string
  description?: string
  start: string
  end: string
  location?: string
  attendees?: string[]
  /** Same attendees as `attendees`, with display names preserved. */
  attendeeDetails?: CalendarEventAttendee[]
  isAllDay?: boolean
  status?: string
  htmlLink?: string
  organizer?: string
  conferenceUrl?: string
  calendarName?: string
  hasRecurrence?: boolean
  // Recurring-series identity (see src/lib/integrations/meeting-series.ts):
  // Google recurringEventId / Microsoft seriesMasterId — per-mailbox master id
  seriesMasterId?: string
  // iCalendar UID — series-scoped AND identical across attendees' mailboxes,
  // so it groups different users' captures of the same meeting
  icalUid?: string
  // Multi-account fields
  accountId?: string
  accountEmail?: string
  accountColor?: string
  calendarId?: string
  // "local_exchange" for EventKit events, undefined for OAuth
  source?: string
  /**
   * The account owner's own answer, where the provider gives it on the event
   * itself (Microsoft Graph's responseStatus.response: 'organizer',
   * 'accepted', 'tentativelyAccepted', 'notResponded'…). Google's comes on
   * the owner's attendee entry instead.
   */
  myResponse?: string
  /**
   * The event is marked as free time on its calendar (Google's transparency
   * 'transparent', Outlook's showAs 'free': a birthday, a reminder, an FYI
   * hold). It never counts as busy (src/lib/guests/free-busy.ts).
   */
  transparent?: boolean
  // Which provider minted the event id — determines its recurrence semantics
  provider?: 'google' | 'microsoft' | 'local_exchange'
}

export interface SubCalendar {
  id: string
  summary: string
  backgroundColor?: string
  primary?: boolean
  accessRole?: string
  /** Outlook: the address of the mailbox the calendar belongs to (a calendar shared with the person carries someone else's). */
  ownerEmail?: string
}

interface ListEventsOptions {
  timeMin?: string
  timeMax?: string
  maxResults?: number
  accountIds?: string[]
  calendarIds?: Record<string, string[]> // { accountId: [calendarId, ...] }
  workspaceId?: string // filter accounts to those assigned to this workspace
  /**
   * A calendar that fails to read throws instead of being skipped. The agent's
   * meeting pass reads strictly: "this meeting is gone" (a cancellation, the
   * meeting-changes watch) must never be a read that failed. So does a
   * customer's booking (src/lib/customers/slots.ts): a time is never "free"
   * because the calendar couldn't be read. In listCalendarEventsUnified an
   * account whose sign-in can't be renewed, or no calendar at all, throws too.
   */
  strict?: boolean
  /**
   * Told about each calendar a non-strict read leaves out (a provider error,
   * an account whose sign-in can't be renewed, the desktop's Exchange rows
   * failing to load), so a caller can say its list is partial instead of
   * passing it off as the whole range. Never called under `strict`, which
   * throws instead.
   */
  onSkipped?: (skipped: CalendarSkip) => void
  /**
   * The app's own calendar view: the person's scheduled meeting links that no
   * provider event stands for (src/lib/meeting-links/calendar-events.ts) are
   * shown too. Off for every other reader (the agents, the watches, the CRM).
   */
  includeMeetingLinks?: boolean
}

/** A calendar a non-strict read left out, and why (ListEventsOptions.onSkipped). */
export interface CalendarSkip {
  provider: 'google' | 'microsoft' | 'local_exchange'
  accountEmail?: string
  reason: string
}

/**
 * Get the connected calendar provider for a user, or null if none connected.
 * Returns 'local_exchange' if the user only has cached exchange events from the desktop app.
 */
export async function getCalendarProvider(
  userId: string,
): Promise<'google' | 'microsoft' | 'local_exchange' | null> {
  // All three checks in parallel — this runs on the hot calendar-events path,
  // where three sequential round-trips were pure added latency. The local
  // exchange count is a cheap head query, so probing it eagerly costs less
  // than serializing on the token lookups.
  const supabase = getServiceClient()
  const [google, microsoft, localCount] = await Promise.all([
    getValidToken(userId, 'google', 'calendar'),
    getValidToken(userId, 'microsoft', 'calendar'),
    supabase
      .from('local_calendar_event')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .limit(1)
      .then(({ count }) => count ?? 0),
  ])
  if (google) return 'google'
  if (microsoft) return 'microsoft'
  if (localCount > 0) return 'local_exchange'
  return null
}

/**
 * List calendar events from ALL enabled calendar accounts (unified view).
 */
export async function listCalendarEventsUnified(
  userId: string,
  options: ListEventsOptions = {},
): Promise<CalendarEvent[]> {
  const supabase = getServiceClient()

  // The local Exchange rows don't depend on the account lookup — run that
  // query concurrently with the whole accounts → tokens → provider-API chain.
  //
  // NOTE: We intentionally do NOT filter by workspace_id here. Local exchange events
  // are user-level (from macOS Calendar.app) and should be visible regardless of which
  // workspace is active — the workspace_id on the row is just for storage/RLS purposes.
  const timeMin = options.timeMin || new Date().toISOString()
  const timeMax = options.timeMax || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
  const localEventsPromise = supabase
    .from('local_calendar_event')
    .select('*')
    .eq('user_id', userId)
    .gte('end_at', timeMin)
    .lte('start_at', timeMax)
    .order('start_at', { ascending: true })
    .then(({ data: localRows, error }): CalendarEvent[] => {
      // Strict: the desktop's Exchange rows failing to load are unread, never "no events".
      if (error && options.strict) throw new Error(`Exchange calendar could not be read: ${error.message}`)
      if (error) options.onSkipped?.({ provider: 'local_exchange', reason: error.message })
      return (localRows || []).map((row) => ({
        id: row.external_id,
        title: row.title,
        description: row.description || undefined,
        start: row.start_at,
        end: row.end_at,
        isAllDay: row.is_all_day,
        location: row.location || undefined,
        organizer: row.organizer || undefined,
        attendees: Array.isArray(row.attendees) ? row.attendees : [],
        conferenceUrl: conferenceUrlOf(row.conference_url, row.location, row.description),
        calendarName: row.calendar_name || 'Exchange (Local)',
        calendarId: row.calendar_id || undefined,
        hasRecurrence: row.has_recurrence || false,
        source: 'local_exchange',
        provider: 'local_exchange',
      }))
    })

  const oauthEventsPromise = (async (): Promise<CalendarEvent[]> => {
    // If workspace scoping is requested, get account IDs from junction table first
    let workspaceScopedIds: string[] | null = null
    if (options.workspaceId) {
      const { data: junctionRows, error: junctionError } = await supabase
        .from('connected_account_workspace')
        .select('account_id')
        .eq('workspace_id', options.workspaceId)
      // Strict: an unread junction would fall through to the legacy read, a partial one.
      if (junctionError && options.strict) throw new Error(`Calendar accounts could not be read: ${junctionError.message}`)
      workspaceScopedIds = (junctionRows || []).map((r) => r.account_id)
      // Don't early-return when empty — local exchange events may still exist
    }

    // Get all enabled calendar accounts
    let accountQuery = supabase
      .from('connected_account')
      .select('id, provider, account_email, color')
      .eq('user_id', userId)
      .eq('capability', 'calendar')
      .eq('is_enabled', true)

    // Apply workspace scope if available
    if (workspaceScopedIds) {
      accountQuery = accountQuery.in('id', workspaceScopedIds)
    }

    if (options.accountIds?.length) {
      accountQuery = accountQuery.in('id', options.accountIds)
    }

    const { data: accounts, error: accountsError } = await accountQuery
    if (accountsError && options.strict) throw new Error(`Calendar accounts could not be read: ${accountsError.message}`)

    // Fetch OAuth events from all accounts in parallel
    if (accounts?.length) {
      // A skipped calendar is reported with the account it belongs to.
      const skip = (account: { provider: string; account_email: string | null }, reason: string) =>
        options.onSkipped?.({ provider: account.provider === 'google' ? 'google' : 'microsoft', accountEmail: account.account_email ?? undefined, reason })
      const results = await Promise.allSettled(
        accounts.map(async (account) => {
          const tokenResult = await getValidTokenForAccount(account.id)
          if (!tokenResult) {
            if (options.strict) throw new Error('A calendar account needs signing in again')
            skip(account, 'it needs signing in again')
            return []
          }

          const accountCalendarIds = options.calendarIds?.[account.id]
          // An account named with no calendars is left out (none of its calendars is wanted), not read as its primary.
          if (accountCalendarIds && accountCalendarIds.length === 0) return []
          const accountOptions: ListEventsOptions = options.onSkipped ? { ...options, onSkipped: (s) => skip(account, s.reason) } : options

          let events: CalendarEvent[]
          if (account.provider === 'google') {
            events = await listGoogleEvents(tokenResult.token, accountOptions, accountCalendarIds)
          } else {
            events = await listMicrosoftEvents(tokenResult.token, accountOptions, accountCalendarIds)
          }

          return events.map(e => ({
            ...e,
            accountId: account.id,
            accountEmail: account.account_email,
            accountColor: account.color,
          }))
        }),
      )
      const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
      if (failed && options.strict) throw failed.reason instanceof Error ? failed.reason : new Error(String(failed.reason))
      results.forEach((r, i) => {
        if (r.status === 'rejected') skip(accounts[i], r.reason instanceof Error ? r.reason.message : String(r.reason))
      })
      return results
        .filter((r) => r.status === 'fulfilled')
        .flatMap(r => (r as PromiseFulfilledResult<CalendarEvent[]>).value)
    }
    // Fallback to legacy single-account behavior — only for a user with no
    // calendar accounts at all. When the workspace junction or an account
    // filter narrowed them all away, the legacy path (first token, no scope)
    // would show exactly the accounts that were filtered out.
    if (workspaceScopedIds || options.accountIds?.length) {
      const { count } = await supabase
        .from('connected_account')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('capability', 'calendar')
        .eq('is_enabled', true)
      if (count) {
        if (options.strict) throw new Error('No calendar account is assigned to this workspace')
        return []
      }
    }
    try {
      return await listCalendarEvents(userId, options)
    } catch (err) {
      if (options.strict) {
        // The desktop's Exchange rows are a calendar too: a person with only
        // those has no other calendar to read here, which is not a failure.
        if (err instanceof Error && err.message === NO_CALENDAR_PROVIDER) {
          const local = await supabase.from('local_calendar_event').select('id', { count: 'exact', head: true }).eq('user_id', userId).limit(1)
          if (local.error) throw new Error(`Exchange calendar could not be read: ${local.error.message}`)
          if ((local.count ?? 0) > 0) return []
        }
        throw err
      }
      // No OAuth accounts — oauthEvents stays empty
      return []
    }
  })()

  // Meeting links (phase 7): only for the app's calendar view; a read that fails leaves them out, never the calendar.
  const meetingEventsPromise: Promise<CalendarEvent[]> = options.includeMeetingLinks
    ? import('@/lib/meeting-links/calendar-events')
        .then(({ meetingCalendarEvents }) => meetingCalendarEvents(supabase, userId, { timeMin, timeMax, workspaceId: options.workspaceId }))
        .catch((err: unknown) => {
          console.warn('[calendar] meeting links not read:', err instanceof Error ? err.message.slice(0, 160) : 'unknown')
          return []
        })
    : Promise.resolve([])

  const [oauthEvents, localEvents, meetingEvents] = await Promise.all([oauthEventsPromise, localEventsPromise, meetingEventsPromise])

  // A meeting link a provider event already carries (the calendar dialog's "Add a meeting link", a booking) shows once: the provider's.
  const carried = new Set([...oauthEvents, ...localEvents].map((e) => e.conferenceUrl).filter((u): u is string => !!u))
  const ownMeetings = meetingEvents.filter((e) => !e.conferenceUrl || !carried.has(e.conferenceUrl))

  // Merge all events, sort by start time
  const allEvents = [...oauthEvents, ...localEvents, ...ownMeetings]
    .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())

  // Dedup: if same event title + start + end appears across accounts, keep first
  const seen = new Set<string>()
  return allEvents.filter(e => {
    const key = `${e.title}|${e.start}|${e.end}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * List sub-calendars for a Google account.
 */
export async function listGoogleCalendars(
  accessToken: string,
): Promise<SubCalendar[]> {
  const res = await fetch(
    'https://www.googleapis.com/calendar/v3/users/me/calendarList',
    { headers: { Authorization: `Bearer ${accessToken}` } },
  )

  if (!res.ok) throw new Error(`Google CalendarList API error: ${res.status}`)
  const data = await res.json()

  return (data.items || []).map((cal: any) => ({
    id: cal.id,
    summary: cal.summary || cal.id,
    backgroundColor: cal.backgroundColor,
    primary: cal.primary ?? false,
    accessRole: cal.accessRole,
  }))
}

/**
 * List sub-calendars for a Microsoft account.
 */
export async function listMicrosoftCalendars(
  accessToken: string,
): Promise<SubCalendar[]> {
  const res = await fetch(
    'https://graph.microsoft.com/v1.0/me/calendars',
    { headers: { Authorization: `Bearer ${accessToken}` } },
  )

  if (!res.ok) throw new Error(`Microsoft Calendars API error: ${res.status}`)
  const data = await res.json()

  return (data.value || []).map((cal: any) => ({
    id: cal.id,
    summary: cal.name || cal.id,
    backgroundColor: cal.hexColor ? `#${cal.hexColor}` : undefined,
    primary: cal.isDefaultCalendar ?? false,
    accessRole: cal.canEdit ? 'owner' : 'reader',
    ownerEmail: typeof cal.owner?.address === 'string' ? cal.owner.address : undefined,
  }))
}

const NO_CALENDAR_PROVIDER = 'No calendar provider connected'

/**
 * Legacy single-account list events (backward compatibility).
 */
export async function listCalendarEvents(
  userId: string,
  options: ListEventsOptions = {},
): Promise<CalendarEvent[]> {
  const google = await getValidToken(userId, 'google', 'calendar')
  if (google) return listGoogleEvents(google.token, options)

  const microsoft = await getValidToken(userId, 'microsoft', 'calendar')
  if (microsoft) return listMicrosoftEvents(microsoft.token, options)

  throw new Error(NO_CALENDAR_PROVIDER)
}

/**
 * One connected calendar account's events (no merge with other accounts or the
 * desktop's local events, no legacy fallback): the always-on meeting pass
 * attributes each account to a workspace itself (agent-events/upcoming-meetings.ts).
 * Throws on a provider error.
 */
export async function listAccountEvents(
  provider: 'google' | 'microsoft',
  accessToken: string,
  options: { timeMin: string; timeMax: string; maxResults?: number; strict?: boolean },
): Promise<CalendarEvent[]> {
  return provider === 'google' ? listGoogleEvents(accessToken, options) : listMicrosoftEvents(accessToken, options)
}

/** The event a create writes. */
export interface NewCalendarEvent {
  title: string
  description?: string
  start: string
  end: string
  location?: string
  attendees?: string[]
  isAllDay?: boolean
}

/**
 * What a caller may ask of a create beyond the event itself. All optional:
 * without them a create is what it always was.
 */
export interface CreateEventOptions {
  /**
   * The provider emails each attendee their invitation (Google:
   * sendUpdates=all; Microsoft always does). The invitation is the
   * calendar entry: no .ics is built here.
   */
  sendInvites?: boolean
  /**
   * A video link with the event: Google Meet (conferenceData.createRequest),
   * Microsoft Teams (isOnlineMeeting). An account that can't make one gets
   * the event without a link, never no event.
   */
  video?: boolean
  /**
   * The caller's stable key for this one event: the same key never makes a
   * second event, so a retry after a crash is safe. Google: a client-chosen
   * event id derived from it (a 409 reads the existing one back); Microsoft:
   * transactionId.
   */
  idempotencyKey?: string
}

/** An update or delete's account and whether the provider tells the attendees (Google: sendUpdates=all; Microsoft always does). */
export interface ChangeEventOptions {
  /** The connected account the event is on; without it, Google first then Microsoft, as before. */
  accountId?: string
  notifyAttendees?: boolean
}

/**
 * A Google event id for a caller's key: Google lets a client choose the id
 * of a new event (5 to 1024 characters of base32hex: 0-9 and a-v), so the
 * same key always names the same event. A uuid's hex digits are all
 * base32hex already. Pure.
 */
export function googleEventIdFor(key: string): string {
  const id = `ni${key.toLowerCase().replace(/[^0-9a-v]/g, '')}`
  return id.slice(0, 1024)
}

/** A connected account's provider and a live token for it. Throws when it can't be used. */
async function accountToken(accountId: string): Promise<{ provider: 'google' | 'microsoft'; token: string }> {
  const tokenResult = await getValidTokenForAccount(accountId)
  if (!tokenResult) throw new Error('No valid token for account')
  const supabase = getServiceClient()
  const { data: account } = await supabase.from('connected_account').select('provider').eq('id', accountId).single()
  if (account?.provider === 'google' || account?.provider === 'microsoft') return { provider: account.provider, token: tokenResult.token }
  throw new Error('Unknown provider for account')
}

export async function createCalendarEvent(
  userId: string,
  event: NewCalendarEvent,
  accountId?: string,
  options: CreateEventOptions = {},
): Promise<CalendarEvent> {
  if (accountId) {
    const { provider, token } = await accountToken(accountId)
    const created = provider === 'google' ? await createGoogleEvent(token, event, options) : await createMicrosoftEvent(token, event, options)
    return { ...created, accountId }
  }

  // Legacy: use first available provider
  const google = await getValidToken(userId, 'google', 'calendar')
  if (google) return createGoogleEvent(google.token, event, options)

  const microsoft = await getValidToken(userId, 'microsoft', 'calendar')
  if (microsoft) return createMicrosoftEvent(microsoft.token, event, options)

  throw new Error('No calendar provider connected')
}

export async function updateCalendarEvent(
  userId: string,
  eventId: string,
  updates: {
    title?: string
    description?: string
    start?: string
    end?: string
    location?: string
    /** The whole attendee list, replacing the event's (a group meeting's guest who dropped out). */
    attendees?: string[]
  },
  options: ChangeEventOptions = {},
): Promise<CalendarEvent> {
  if (options.accountId) {
    const { provider, token } = await accountToken(options.accountId)
    return provider === 'google' ? updateGoogleEvent(token, eventId, updates, options.notifyAttendees === true) : updateMicrosoftEvent(token, eventId, updates)
  }

  const google = await getValidToken(userId, 'google', 'calendar')
  if (google) return updateGoogleEvent(google.token, eventId, updates, options.notifyAttendees === true)

  const microsoft = await getValidToken(userId, 'microsoft', 'calendar')
  if (microsoft) return updateMicrosoftEvent(microsoft.token, eventId, updates)

  throw new Error('No calendar provider connected')
}

/**
 * The attendee addresses on an existing event, lower-cased, read from the
 * same provider updateCalendarEvent / deleteCalendarEvent would write to
 * (Google first, then Microsoft). The outward gate
 * (src/lib/safety/outward-gate.ts) reads it before an update or delete,
 * because editing or cancelling a meeting makes the provider email its
 * attendees. Null when it could not be read (the gate then holds the call).
 */
export async function getCalendarEventAttendees(userId: string, eventId: string): Promise<string[] | null> {
  try {
    const google = await getValidToken(userId, 'google', 'calendar')
    if (google) {
      const res = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}?fields=attendees(email)`,
        { headers: { Authorization: `Bearer ${google.token}` } },
      )
      if (!res.ok) return null
      const data = (await res.json()) as { attendees?: Array<{ email?: string }> }
      return (data.attendees ?? []).map((a) => (a.email ?? '').trim().toLowerCase()).filter(Boolean)
    }
    const microsoft = await getValidToken(userId, 'microsoft', 'calendar')
    if (microsoft) {
      const res = await fetch(
        `https://graph.microsoft.com/v1.0/me/events/${encodeURIComponent(eventId)}?$select=attendees`,
        { headers: { Authorization: `Bearer ${microsoft.token}` } },
      )
      if (!res.ok) return null
      const data = (await res.json()) as { attendees?: Array<{ emailAddress?: { address?: string } }> }
      return (data.attendees ?? []).map((a) => (a.emailAddress?.address ?? '').trim().toLowerCase()).filter(Boolean)
    }
    return null
  } catch {
    return null
  }
}

/**
 * Delete the event a caller's key made (CreateEventOptions.idempotencyKey),
 * if it made one, telling its attendees: Google's event by the id the key
 * names, Microsoft's by its transactionId. 'none' when there is no such
 * event. Throws when that can't be told.
 */
export async function deleteCalendarEventByKey(userId: string, key: string, options: { accountId?: string } = {}): Promise<'deleted' | 'none'> {
  let provider: 'google' | 'microsoft'
  let token: string
  if (options.accountId) ({ provider, token } = await accountToken(options.accountId))
  else {
    const google = await getValidToken(userId, 'google', 'calendar')
    const microsoft = google ? null : await getValidToken(userId, 'microsoft', 'calendar')
    if (google) ({ provider, token } = { provider: 'google', token: google.token })
    else if (microsoft) ({ provider, token } = { provider: 'microsoft', token: microsoft.token })
    else throw new Error('No calendar provider connected')
  }
  if (provider === 'google') {
    const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(googleEventIdFor(key))}?sendUpdates=all`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })
    if (res.ok) return 'deleted'
    if (res.status === 404 || res.status === 410) return 'none'
    throw new Error(`Google Calendar delete error: ${res.status}`)
  }
  const filter = encodeURIComponent(`transactionId eq '${key.replace(/'/g, "''")}'`)
  const found = await fetch(`https://graph.microsoft.com/v1.0/me/events?$filter=${filter}&$select=id&$top=1`, { headers: { Authorization: `Bearer ${token}` } })
  if (!found.ok) throw new Error(`Microsoft Calendar lookup error: ${found.status}`)
  const id = ((await found.json()) as { value?: Array<{ id?: string }> }).value?.[0]?.id
  if (!id) return 'none'
  await deleteMicrosoftEvent(token, id, true)
  return 'deleted'
}

export async function deleteCalendarEvent(
  userId: string,
  eventId: string,
  options: ChangeEventOptions = {},
): Promise<void> {
  const notify = options.notifyAttendees === true
  if (options.accountId) {
    const { provider, token } = await accountToken(options.accountId)
    return provider === 'google' ? deleteGoogleEvent(token, eventId, notify) : deleteMicrosoftEvent(token, eventId, notify)
  }

  const google = await getValidToken(userId, 'google', 'calendar')
  if (google) return deleteGoogleEvent(google.token, eventId, notify)

  const microsoft = await getValidToken(userId, 'microsoft', 'calendar')
  if (microsoft) return deleteMicrosoftEvent(microsoft.token, eventId, notify)

  throw new Error('No calendar provider connected')
}

// ---------------------------------------------------------------------------
// Google Calendar API v3
// ---------------------------------------------------------------------------

/** The most pages a strict events read follows per calendar before it gives up (and throws). */
export const STRICT_READ_MAX_PAGES = 10

async function listGoogleEvents(
  accessToken: string,
  options: ListEventsOptions,
  calendarIds?: string[],
): Promise<CalendarEvent[]> {
  const ensureRfc3339 = (dt: string) =>
    /[Zz]|[+-]\d{2}:\d{2}$/.test(dt) ? dt : dt + 'Z'

  const timeMin = ensureRfc3339(options.timeMin || new Date().toISOString())
  const timeMax = ensureRfc3339(
    options.timeMax ||
      new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  )

  // If specific calendar IDs are given, fetch from each; otherwise just primary.
  // Sub-calendars fetch concurrently — a failed one is logged and skipped
  // without sinking the rest.
  const calendarsToFetch = calendarIds?.length ? calendarIds : ['primary']

  const perCalendar = await Promise.all(
    calendarsToFetch.map(async (calId): Promise<CalendarEvent[]> => {
      const params = new URLSearchParams({
        timeMin,
        timeMax,
        maxResults: String(options.maxResults || 50),
        singleEvents: 'true',
        orderBy: 'startTime',
      })

      // A non-strict read takes the first page, as it always has. A strict
      // one follows the pages to the end: an event past the first page is
      // busy time all the same.
      const items: any[] = []
      let summary: string | undefined
      for (let page = 0; ; page++) {
        const res = await fetch(
          `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events?${params}&conferenceDataVersion=1`,
          { headers: { Authorization: `Bearer ${accessToken}` } },
        ).catch(() => null)

        if (!res?.ok) {
          console.error(`Google Calendar API error for ${calId}: ${res?.status ?? 'network error'}`)
          if (options.strict) throw new Error(`Google Calendar API error: ${res?.status ?? 'network error'}`)
          options.onSkipped?.({ provider: 'google', reason: `Google Calendar API error: ${res?.status ?? 'network error'}` })
          return []
        }

        const data = await res.json()
        summary ??= data.summary
        items.push(...(data.items || []))
        if (!options.strict || typeof data.nextPageToken !== 'string' || !data.nextPageToken) break
        if (page + 1 >= STRICT_READ_MAX_PAGES) throw new Error('Google Calendar has more events in this range than can be read at once')
        params.set('pageToken', data.nextPageToken)
      }

      return items.map(
        (e: any): CalendarEvent => {
          const entryPoints = e.conferenceData?.entryPoints as Array<Record<string, string>> | undefined
          const videoEntry = entryPoints?.find((ep) => ep.entryPointType === 'video')

          return {
            id: e.id as string,
            title: (e.summary as string) || '(No title)',
            description: e.description as string | undefined,
            start: e.start?.dateTime || e.start?.date || '',
            end: e.end?.dateTime || e.end?.date || '',
            location: e.location as string | undefined,
            attendees: (e.attendees || []).map((a: Record<string, string>) => a.email),
            attendeeDetails: mapGoogleAttendees(e.attendees),
            isAllDay: !!e.start?.date,
            status: e.status as string,
            ...(e.transparency === 'transparent' ? { transparent: true } : {}),
            ...(typeof googleSelfResponse(e.attendees) === 'string' ? { myResponse: googleSelfResponse(e.attendees) } : {}),
            htmlLink: e.htmlLink as string,
            organizer: e.organizer?.email as string | undefined,
            conferenceUrl: conferenceUrlOf(videoEntry?.uri, e.location, e.description),
            calendarName: summary || 'Google Calendar',
            hasRecurrence: !!e.recurringEventId,
            seriesMasterId: (e.recurringEventId as string) || undefined,
            icalUid: (e.iCalUID as string) || undefined,
            provider: 'google',
            calendarId: calId,
          }
        },
      )
    }),
  )

  return perCalendar.flat()
}

/** A Google event as a create (or its read back) returns it, with its video link and where it was written. */
function parseCreatedGoogleEvent(e: any): CalendarEvent {
  const entryPoints = e.conferenceData?.entryPoints as Array<Record<string, string>> | undefined
  const video = entryPoints?.find((ep) => ep.entryPointType === 'video')?.uri ?? (typeof e.hangoutLink === 'string' ? e.hangoutLink : undefined)
  return {
    id: e.id,
    title: e.summary || '(No title)',
    description: e.description,
    start: e.start?.dateTime || e.start?.date || '',
    end: e.end?.dateTime || e.end?.date || '',
    location: e.location,
    isAllDay: !!e.start?.date,
    htmlLink: e.htmlLink,
    ...(video ? { conferenceUrl: video } : {}),
    provider: 'google',
    calendarId: 'primary',
  }
}

async function createGoogleEvent(
  accessToken: string,
  event: NewCalendarEvent,
  options: CreateEventOptions = {},
): Promise<CalendarEvent> {
  const body: Record<string, unknown> = {
    summary: event.title,
    description: event.description,
    location: event.location,
    start: event.isAllDay
      ? { date: event.start.split('T')[0] }
      : { dateTime: event.start },
    end: event.isAllDay
      ? { date: event.end.split('T')[0] }
      : { dateTime: event.end },
  }

  if (event.attendees?.length) {
    body.attendees = event.attendees.map((email) => ({ email }))
  }
  const eventId = options.idempotencyKey ? googleEventIdFor(options.idempotencyKey) : null
  if (eventId) body.id = eventId

  const post = async (withVideo: boolean) => {
    const params = new URLSearchParams()
    if (options.sendInvites) params.set('sendUpdates', 'all')
    if (withVideo) params.set('conferenceDataVersion', '1')
    const payload = withVideo
      ? { ...body, conferenceData: { createRequest: { requestId: options.idempotencyKey ?? crypto.randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } } } }
      : body
    const query = params.toString()
    return fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events${query ? `?${query}` : ''}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    })
  }

  let res = await post(options.video === true)
  // An account that can't make a Meet link: the event, without one.
  if (res.status === 400 && options.video === true) res = await post(false)
  // The same key made this event already (a retry after a crash): read it back.
  if (res.status === 409 && eventId) {
    const existing = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}?conferenceDataVersion=1`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!existing.ok) throw new Error(`Google Calendar create error: 409, read back ${existing.status}`)
    const e = await existing.json()
    if (e.status === 'cancelled') throw new Error('Google Calendar create error: the event was deleted')
    return parseCreatedGoogleEvent(e)
  }
  if (!res.ok) throw new Error(`Google Calendar create error: ${res.status}`)
  return parseCreatedGoogleEvent(await res.json())
}

async function updateGoogleEvent(
  accessToken: string,
  eventId: string,
  updates: {
    title?: string
    description?: string
    start?: string
    end?: string
    location?: string
    attendees?: string[]
  },
  notifyAttendees = false,
): Promise<CalendarEvent> {
  const body: Record<string, unknown> = {}
  if (updates.title) body.summary = updates.title
  if (updates.description !== undefined) body.description = updates.description
  if (updates.location !== undefined) body.location = updates.location
  if (updates.start) body.start = { dateTime: updates.start }
  if (updates.end) body.end = { dateTime: updates.end }
  if (updates.attendees) body.attendees = updates.attendees.map((email) => ({ email }))

  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventId}${notifyAttendees ? '?sendUpdates=all' : ''}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
  )

  if (!res.ok) throw new Error(`Google Calendar update error: ${res.status}`)
  const e = await res.json()

  return {
    id: e.id,
    title: e.summary || '(No title)',
    start: e.start?.dateTime || e.start?.date || '',
    end: e.end?.dateTime || e.end?.date || '',
    location: e.location,
    htmlLink: e.htmlLink,
  }
}

async function deleteGoogleEvent(
  accessToken: string,
  eventId: string,
  notifyAttendees = false,
): Promise<void> {
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventId}${notifyAttendees ? '?sendUpdates=all' : ''}`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  )

  if (!res.ok && res.status !== 410)
    throw new Error(`Google Calendar delete error: ${res.status}`)
}

// ---------------------------------------------------------------------------
// Microsoft Graph API
// ---------------------------------------------------------------------------

async function listMicrosoftEvents(
  accessToken: string,
  options: ListEventsOptions,
  calendarIds?: string[],
): Promise<CalendarEvent[]> {
  const timeMin = options.timeMin || new Date().toISOString()
  const timeMax =
    options.timeMax ||
    new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()

  const params = new URLSearchParams({
    startDateTime: timeMin,
    endDateTime: timeMax,
    $top: String(options.maxResults || 50),
    $orderby: 'start/dateTime',
  })

  // If specific calendar IDs are given, fetch from each concurrently (a failed
  // one is logged and skipped); otherwise use default calendarview
  if (calendarIds?.length) {
    const perCalendar = await Promise.all(
      calendarIds.map(async (calId): Promise<CalendarEvent[]> => {
        const res = await fetch(
          `https://graph.microsoft.com/v1.0/me/calendars/${calId}/calendarview?${params}`,
          { headers: { Authorization: `Bearer ${accessToken}` } },
        ).catch(() => null)
        if (!res?.ok) {
          console.error(`Microsoft Calendar API error for ${calId}: ${res?.status ?? 'network error'}`)
          if (options.strict) throw new Error(`Microsoft Calendar API error: ${res?.status ?? 'network error'}`)
          options.onSkipped?.({ provider: 'microsoft', reason: `Microsoft Calendar API error: ${res?.status ?? 'network error'}` })
          return []
        }
        const data = await res.json()
        return parseMicrosoftEvents(await microsoftRestPages(accessToken, data, options), calId)
      }),
    )
    return perCalendar.flat()
  }

  const res = await fetch(
    `https://graph.microsoft.com/v1.0/me/calendarview?${params}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  )
  if (!res.ok) throw new Error(`Microsoft Calendar API error: ${res.status}`)
  const data = await res.json()
  return parseMicrosoftEvents(await microsoftRestPages(accessToken, data, options))
}

/**
 * A calendar view's items: the first page's alone for a non-strict read (as
 * it always was), every page for a strict one (an event past the first page
 * is busy time all the same). A strict read that fails on a later page, or
 * runs past STRICT_READ_MAX_PAGES, throws: it never returns part of the range.
 */
async function microsoftRestPages(accessToken: string, first: { value?: any[]; '@odata.nextLink'?: string }, options: ListEventsOptions): Promise<any[]> {
  const items = [...(first.value || [])]
  if (!options.strict) return items
  let next = first['@odata.nextLink']
  for (let page = 1; typeof next === 'string' && next; page++) {
    if (page >= STRICT_READ_MAX_PAGES) throw new Error('Microsoft Calendar has more events in this range than can be read at once')
    const res = await fetch(next, { headers: { Authorization: `Bearer ${accessToken}` } }).catch(() => null)
    if (!res?.ok) throw new Error(`Microsoft Calendar API error: ${res?.status ?? 'network error'}`)
    const data = await res.json()
    items.push(...(data.value || []))
    next = data['@odata.nextLink']
  }
  return items
}

/** The account owner's own answer on a Google event (their attendee entry, marked `self`), when they are a guest on it. */
function googleSelfResponse(raw: unknown): string | undefined {
  if (!Array.isArray(raw)) return undefined
  const self = (raw as Array<Record<string, unknown>>).find((a) => a?.self === true)
  return typeof self?.responseStatus === 'string' ? self.responseStatus : undefined
}

/**
 * Google attendee → CalendarEventAttendee, keeping `displayName`.
 * Entries with no real address (Google can return resource rows without one)
 * are dropped rather than passed on as fake contacts.
 */
function mapGoogleAttendees(raw: unknown): CalendarEventAttendee[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: CalendarEventAttendee[] = []
  for (const a of raw as Array<Record<string, unknown>>) {
    const email = typeof a?.email === 'string' ? a.email.trim() : ''
    if (!email.includes('@')) continue
    out.push({
      email,
      name: typeof a.displayName === 'string' && a.displayName.trim() ? a.displayName.trim() : undefined,
      isOrganizer: a.organizer === true || undefined,
      responseStatus: typeof a.responseStatus === 'string' ? a.responseStatus : undefined,
    })
  }
  return out
}

/**
 * Microsoft Graph attendee → CalendarEventAttendee.
 *
 * Graph puts the address and name under `emailAddress`, the accept/decline
 * state under `status.response`, and the organizer on the EVENT (`e.organizer`)
 * rather than on an attendee — so `isOrganizer` is resolved by comparing
 * addresses, not by reading an attendee flag. Graph's `attendee.type` is
 * required/optional/resource, which is a different axis entirely.
 */
function mapMicrosoftAttendees(raw: unknown, organizerEmail?: string): CalendarEventAttendee[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const organizer = organizerEmail?.trim().toLowerCase()
  const out: CalendarEventAttendee[] = []
  for (const a of raw as Array<Record<string, any>>) {
    const email = typeof a?.emailAddress?.address === 'string' ? a.emailAddress.address.trim() : ''
    if (!email.includes('@')) continue
    const name = typeof a?.emailAddress?.name === 'string' ? a.emailAddress.name.trim() : ''
    out.push({
      email,
      // Graph mirrors the address into `name` when it has no real display
      // name; that is exactly the value the CRM must not store as a name.
      name: name && name.toLowerCase() !== email.toLowerCase() ? name : undefined,
      isOrganizer: (!!organizer && email.toLowerCase() === organizer) || undefined,
      responseStatus: typeof a?.status?.response === 'string' ? a.status.response : undefined,
    })
  }
  return out
}

function parseMicrosoftEvents(items: any[], calendarId?: string): CalendarEvent[] {
  return items.map(
    (e: any): CalendarEvent => ({
      id: e.id as string,
      title: (e.subject as string) || '(No title)',
      description: (e.bodyPreview as string) || undefined,
      start: e.start?.dateTime
        ? new Date(e.start.dateTime + 'Z').toISOString()
        : '',
      end: e.end?.dateTime
        ? new Date(e.end.dateTime + 'Z').toISOString()
        : '',
      location: e.location?.displayName || undefined,
      attendees: (e.attendees || []).map(
        (a: any) => a.emailAddress?.address || '',
      ),
      attendeeDetails: mapMicrosoftAttendees(
        e.attendees,
        e.organizer?.emailAddress?.address as string | undefined,
      ),
      isAllDay: e.isAllDay as boolean,
      ...(typeof e.responseStatus?.response === 'string' ? { myResponse: e.responseStatus.response as string } : {}),
      ...(e.showAs === 'free' ? { transparent: true } : {}),
      // An organizer's cancellation stays on an attendee's Outlook calendar
      // (isCancelled) until they remove it: Google's word for it, so readers
      // that skip cancelled meetings skip it too.
      ...(e.isCancelled === true ? { status: 'cancelled' } : {}),
      htmlLink: e.webLink as string,
      organizer: e.organizer?.emailAddress?.address as string | undefined,
      conferenceUrl: conferenceUrlOf(e.onlineMeeting?.joinUrl || e.onlineMeetingUrl, e.location?.displayName, e.bodyPreview),
      calendarName: 'Outlook Calendar',
      hasRecurrence: !!e.seriesMasterId,
      seriesMasterId: (e.seriesMasterId as string) || undefined,
      icalUid: (e.iCalUId as string) || undefined,
      provider: 'microsoft',
      calendarId,
    }),
  )
}

/**
 * A time for Graph's `{ dateTime, timeZone: 'UTC' }`: an instant with an
 * offset or a Z (what get_calendar_events now hands the model, in the
 * person's zone) as its UTC wall time, so "07:00-05:00" lands at 07:00 local
 * and not at 07:00 UTC. A wall time with no offset (or anything unreadable)
 * goes as it was. Pure.
 */
export function graphUtcDateTime(value: string): string {
  if (!/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(value.trim())) return value
  const at = Date.parse(value)
  return Number.isFinite(at) ? new Date(at).toISOString().replace(/Z$/, '') : value
}

async function createMicrosoftEvent(
  accessToken: string,
  event: NewCalendarEvent,
  options: CreateEventOptions = {},
): Promise<CalendarEvent> {
  const body: Record<string, unknown> = {
    subject: event.title,
    body: event.description
      ? { contentType: 'Text', content: event.description }
      : undefined,
    isAllDay: event.isAllDay || false,
    start: {
      dateTime: graphUtcDateTime(event.start),
      timeZone: 'UTC',
    },
    end: {
      dateTime: graphUtcDateTime(event.end),
      timeZone: 'UTC',
    },
  }

  if (event.location) {
    body.location = { displayName: event.location }
  }

  if (event.attendees?.length) {
    body.attendees = event.attendees.map((email) => ({
      emailAddress: { address: email },
      type: 'required',
    }))
  }

  // Graph makes one event per transactionId: a retry with the same key gets the first one back.
  if (options.idempotencyKey) body.transactionId = options.idempotencyKey

  const post = (withVideo: boolean) =>
    fetch('https://graph.microsoft.com/v1.0/me/events', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(withVideo ? { ...body, isOnlineMeeting: true, onlineMeetingProvider: 'teamsForBusiness' } : body),
    })

  let res = await post(options.video === true)
  // An account that can't make a Teams meeting (a personal Outlook account): the event, without a link.
  if (res.status === 400 && options.video === true) res = await post(false)

  if (!res.ok) throw new Error(`Microsoft Calendar create error: ${res.status}`)
  const e = await res.json()
  const joinUrl = typeof e.onlineMeeting?.joinUrl === 'string' ? e.onlineMeeting.joinUrl : undefined

  return {
    id: e.id,
    title: e.subject || '(No title)',
    start: e.start?.dateTime
      ? new Date(e.start.dateTime + 'Z').toISOString()
      : '',
    end: e.end?.dateTime ? new Date(e.end.dateTime + 'Z').toISOString() : '',
    location: e.location?.displayName,
    isAllDay: e.isAllDay,
    htmlLink: e.webLink,
    ...(joinUrl ? { conferenceUrl: joinUrl } : {}),
    provider: 'microsoft',
    calendarId: 'default',
  }
}

async function updateMicrosoftEvent(
  accessToken: string,
  eventId: string,
  updates: {
    title?: string
    description?: string
    start?: string
    end?: string
    location?: string
    attendees?: string[]
  },
): Promise<CalendarEvent> {
  const body: Record<string, unknown> = {}
  if (updates.title) body.subject = updates.title
  if (updates.description !== undefined) {
    body.body = { contentType: 'Text', content: updates.description }
  }
  if (updates.location !== undefined) {
    body.location = { displayName: updates.location }
  }
  if (updates.start) body.start = { dateTime: graphUtcDateTime(updates.start), timeZone: 'UTC' }
  if (updates.end) body.end = { dateTime: graphUtcDateTime(updates.end), timeZone: 'UTC' }
  if (updates.attendees) body.attendees = updates.attendees.map((address) => ({ emailAddress: { address }, type: 'required' }))

  const res = await fetch(
    `https://graph.microsoft.com/v1.0/me/events/${eventId}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
  )

  if (!res.ok) throw new Error(`Microsoft Calendar update error: ${res.status}`)
  const e = await res.json()

  return {
    id: e.id,
    title: e.subject || '(No title)',
    start: e.start?.dateTime
      ? new Date(e.start.dateTime + 'Z').toISOString()
      : '',
    end: e.end?.dateTime ? new Date(e.end.dateTime + 'Z').toISOString() : '',
    location: e.location?.displayName,
    htmlLink: e.webLink,
  }
}

async function deleteMicrosoftEvent(
  accessToken: string,
  eventId: string,
  notifyAttendees = false,
): Promise<void> {
  // The organizer's cancel: Graph sends the attendees a cancellation and removes the event.
  // Not the organizer, or nobody to tell: a plain delete.
  if (notifyAttendees) {
    const cancelled = await fetch(`https://graph.microsoft.com/v1.0/me/events/${eventId}/cancel`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ comment: 'This meeting was cancelled.' }),
    })
    if (cancelled.ok || cancelled.status === 404) return
  }
  const res = await fetch(
    `https://graph.microsoft.com/v1.0/me/events/${eventId}`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  )

  if (!res.ok && res.status !== 404)
    throw new Error(`Microsoft Calendar delete error: ${res.status}`)
}
