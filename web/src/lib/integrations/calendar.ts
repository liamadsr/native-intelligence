import { getValidToken, getValidTokenForAccount, getValidTokenForCapability, getAllValidTokens } from '@/lib/oauth/token-manager'
import { getServiceClient } from '@/lib/admin'

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
  // Which provider minted the event id — determines its recurrence semantics
  provider?: 'google' | 'microsoft' | 'local_exchange'
}

export interface SubCalendar {
  id: string
  summary: string
  backgroundColor?: string
  primary?: boolean
  accessRole?: string
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
        conferenceUrl: row.conference_url || undefined,
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
      const { data: junctionRows } = await supabase
        .from('connected_account_workspace')
        .select('account_id')
        .eq('workspace_id', options.workspaceId)
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

    const { data: accounts } = await accountQuery

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
      if (options.strict) throw err
      // No OAuth accounts — oauthEvents stays empty
      return []
    }
  })()

  const [oauthEvents, localEvents] = await Promise.all([oauthEventsPromise, localEventsPromise])

  // Merge all events, sort by start time
  const allEvents = [...oauthEvents, ...localEvents]
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
  }))
}

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

  throw new Error('No calendar provider connected')
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

export async function createCalendarEvent(
  userId: string,
  event: {
    title: string
    description?: string
    start: string
    end: string
    location?: string
    attendees?: string[]
    isAllDay?: boolean
  },
  accountId?: string,
): Promise<CalendarEvent> {
  if (accountId) {
    const tokenResult = await getValidTokenForAccount(accountId)
    if (!tokenResult) throw new Error('No valid token for account')

    const supabase = getServiceClient()
    const { data: account } = await supabase
      .from('connected_account')
      .select('provider')
      .eq('id', accountId)
      .single()

    if (account?.provider === 'google') return createGoogleEvent(tokenResult.token, event)
    if (account?.provider === 'microsoft') return createMicrosoftEvent(tokenResult.token, event)
    throw new Error('Unknown provider for account')
  }

  // Legacy: use first available provider
  const google = await getValidToken(userId, 'google', 'calendar')
  if (google) return createGoogleEvent(google.token, event)

  const microsoft = await getValidToken(userId, 'microsoft', 'calendar')
  if (microsoft) return createMicrosoftEvent(microsoft.token, event)

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
  },
): Promise<CalendarEvent> {
  const google = await getValidToken(userId, 'google', 'calendar')
  if (google) return updateGoogleEvent(google.token, eventId, updates)

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

export async function deleteCalendarEvent(
  userId: string,
  eventId: string,
): Promise<void> {
  const google = await getValidToken(userId, 'google', 'calendar')
  if (google) return deleteGoogleEvent(google.token, eventId)

  const microsoft = await getValidToken(userId, 'microsoft', 'calendar')
  if (microsoft) return deleteMicrosoftEvent(microsoft.token, eventId)

  throw new Error('No calendar provider connected')
}

// ---------------------------------------------------------------------------
// Google Calendar API v3
// ---------------------------------------------------------------------------

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

      return (data.items || []).map(
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
            htmlLink: e.htmlLink as string,
            organizer: e.organizer?.email as string | undefined,
            conferenceUrl: videoEntry?.uri,
            calendarName: data.summary || 'Google Calendar',
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

async function createGoogleEvent(
  accessToken: string,
  event: {
    title: string
    description?: string
    start: string
    end: string
    location?: string
    attendees?: string[]
    isAllDay?: boolean
  },
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

  const res = await fetch(
    'https://www.googleapis.com/calendar/v3/calendars/primary/events',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
  )

  if (!res.ok) throw new Error(`Google Calendar create error: ${res.status}`)
  const e = await res.json()

  return {
    id: e.id,
    title: e.summary || '(No title)',
    description: e.description,
    start: e.start?.dateTime || e.start?.date || '',
    end: e.end?.dateTime || e.end?.date || '',
    location: e.location,
    isAllDay: !!e.start?.date,
    htmlLink: e.htmlLink,
  }
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
  },
): Promise<CalendarEvent> {
  const body: Record<string, unknown> = {}
  if (updates.title) body.summary = updates.title
  if (updates.description !== undefined) body.description = updates.description
  if (updates.location !== undefined) body.location = updates.location
  if (updates.start) body.start = { dateTime: updates.start }
  if (updates.end) body.end = { dateTime: updates.end }

  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventId}`,
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
): Promise<void> {
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventId}`,
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
        return parseMicrosoftEvents(data.value || [], calId)
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
  return parseMicrosoftEvents(data.value || [])
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
      // An organizer's cancellation stays on an attendee's Outlook calendar
      // (isCancelled) until they remove it: Google's word for it, so readers
      // that skip cancelled meetings skip it too.
      ...(e.isCancelled === true ? { status: 'cancelled' } : {}),
      htmlLink: e.webLink as string,
      organizer: e.organizer?.emailAddress?.address as string | undefined,
      conferenceUrl: e.onlineMeeting?.joinUrl || e.onlineMeetingUrl || undefined,
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
  event: {
    title: string
    description?: string
    start: string
    end: string
    location?: string
    attendees?: string[]
    isAllDay?: boolean
  },
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

  const res = await fetch('https://graph.microsoft.com/v1.0/me/events', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) throw new Error(`Microsoft Calendar create error: ${res.status}`)
  const e = await res.json()

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
): Promise<void> {
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
