/**
 * Answering a calendar invitation (Yes / No / Maybe) as the person, on the
 * calendar the invitation landed on: the mail view's invitation card
 * (src/components/email/email-invite-card.tsx) through /api/calendar/rsvp.
 *
 * The event is found by the invitation's iCalendar UID on the person's OWN
 * enabled calendar accounts linked to this workspace (the same accounts the
 * Calendar page reads here), never by an event id the browser names.
 *
 * Scopes: only what the app already asks for (src/lib/oauth/config.ts).
 *  - Google, `calendar.events`: events.list by iCalUID, then events.patch of
 *    the person's own attendee entry with sendUpdates=all, so the organizer
 *    gets the reply the way Google Calendar's own buttons send it.
 *  - Microsoft, `Calendars.ReadWrite`: /me/events filtered by iCalUId, then
 *    the event's accept / tentativelyAccept / decline action with
 *    sendResponse. Outlook removes a declined event from the calendar, as its
 *    own Decline does.
 *
 * A repeating event can be answered whole (the default) or one occurrence at
 * a time: Google's events.instances and Graph's /events/{id}/instances give
 * the next occurrence its own id, which takes the same reply (no further
 * scope). "This event" is that next occurrence.
 *
 * Invitations land on the account's own (primary / default) calendar, so that
 * is the one read. An event only on the desktop's local Exchange calendar
 * (EventKit) has no provider call here and reads as not found.
 *
 * A demo workspace has no calendar (calendar-here.ts): nothing is read or
 * answered from inside one.
 */
import { getServiceClient } from '@/lib/admin'
import { getValidTokenForAccount } from '@/lib/oauth/token-manager'
import { isDemoWorkspace } from '@/lib/demo/demo-mode'

export type RsvpAnswer = 'accepted' | 'declined' | 'tentative'
export type RsvpResponse = RsvpAnswer | 'pending'

export const RSVP_ANSWERS: readonly RsvpAnswer[] = ['accepted', 'declined', 'tentative']

/** An iCalendar UID longer than this is not looked up (real ones are well under 300). */
export const RSVP_UID_MAX = 1024

/** A provider call that takes longer than this is given up on. */
const PROVIDER_TIMEOUT_MS = 15_000

export type RsvpProvider = 'google' | 'microsoft'

/** Why the event can't be answered from here though it is on a calendar. */
export type RsvpBlocked = 'organizer' | 'not_invited' | 'cancelled'

export interface RsvpFound {
  found: true
  provider: RsvpProvider
  accountId: string
  accountEmail: string | null
  /** The person's answer as the calendar holds it; null when they are not a guest. */
  response: RsvpResponse | null
  /** The event in the provider's own calendar (http/https), when it gives one. */
  link: string | null
  canAnswer: boolean
  blocked?: RsvpBlocked
  /** The event repeats. */
  recurring?: boolean
  /**
   * A repeating event's next occurrence (an instant, or a date for an all-day
   * one), when it can be answered on its own: what "This event" means on the
   * card. Absent: only the whole series can be answered.
   */
  nextOccurrence?: string
  /** After a reply: what it was for. */
  answered?: RsvpWhich
}

/** What a reply is for: every event of a series (and any single event), or one occurrence of a series. */
export type RsvpWhich = 'series' | 'occurrence'
export const RSVP_WHICH: readonly RsvpWhich[] = ['series', 'occurrence']

export interface RsvpNotFound {
  found: false
  /**
   * no_calendar: no calendar account is linked to this workspace.
   * reconnect:   a calendar's sign-in can't be renewed, and no other calendar holds the event.
   * unreadable:  a calendar couldn't be read just now, and no other holds the event.
   * not_found:   every calendar was read and none holds the event.
   */
  reason: 'no_calendar' | 'reconnect' | 'unreadable' | 'not_found'
  /** The account that needs signing in again (reason 'reconnect'). */
  accountEmail?: string | null
}

export type RsvpStatus = RsvpFound | RsvpNotFound

export type RsvpErrorCode =
  | 'not_on_calendar'
  | 'no_calendar'
  | 'reconnect'
  | 'unreadable'
  | 'organizer'
  | 'not_invited'
  | 'cancelled'
  | 'gone'
  | 'provider'
  | 'no_occurrence'

/** An answer that wasn't given, and why, in words the card can show. */
export class RsvpError extends Error {
  constructor(
    public readonly code: RsvpErrorCode,
    message: string,
    public readonly accountEmail: string | null = null,
  ) {
    super(message)
    this.name = 'RsvpError'
  }
}

export interface RsvpScope {
  userId: string
  workspaceId: string
}

interface Account {
  id: string
  provider: RsvpProvider
  account_email: string | null
}

/** One account's copy of the event, with what a reply needs. */
interface Located extends RsvpFound {
  eventId: string
  /** Google: the event's whole attendee list, sent back with the person's entry changed. */
  googleAttendees?: Array<Record<string, unknown>>
  /** A repeating event's next occurrence, when the provider gave one. */
  occurrence?: { eventId: string; start: string; googleAttendees?: Array<Record<string, unknown>> }
}

class ProviderHttpError extends Error {
  constructor(public readonly status: number, what: string) {
    super(`${what}: ${status}`)
  }
}

function httpLink(value: unknown): string | null {
  return typeof value === 'string' && /^https?:\/\//i.test(value) ? value : null
}

async function providerFetch(url: string, token: string, init: { method?: string; body?: unknown } = {}): Promise<Response> {
  return fetch(url, {
    method: init.method ?? 'GET',
    headers: { Authorization: `Bearer ${token}`, ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  })
}

/** The person's enabled calendar accounts linked to this workspace, oldest first. */
async function accountsHere(scope: RsvpScope): Promise<Account[]> {
  if (await isDemoWorkspace(scope.workspaceId)) return []
  const supabase = getServiceClient()
  const [{ data: accounts, error }, { data: links, error: linksError }] = await Promise.all([
    supabase
      .from('connected_account')
      .select('id, provider, account_email')
      .eq('user_id', scope.userId)
      .eq('capability', 'calendar')
      .eq('is_enabled', true)
      .order('created_at', { ascending: true }),
    supabase.from('connected_account_workspace').select('account_id').eq('workspace_id', scope.workspaceId),
  ])
  if (error || linksError) throw new Error(`could not read calendar accounts: ${(error ?? linksError)!.message}`)
  const linked = new Set(((links ?? []) as Array<{ account_id: string }>).map((l) => l.account_id))
  return ((accounts ?? []) as Array<{ id: string; provider: string; account_email: string | null }>).filter(
    (a): a is Account => linked.has(a.id) && (a.provider === 'google' || a.provider === 'microsoft'),
  )
}

// ---------------------------------------------------------------------------
// Google Calendar API v3
// ---------------------------------------------------------------------------

const GOOGLE_EVENTS = 'https://www.googleapis.com/calendar/v3/calendars/primary/events'

function googleResponse(value: unknown): RsvpResponse | null {
  switch (value) {
    case 'accepted':
      return 'accepted'
    case 'declined':
      return 'declined'
    case 'tentative':
      return 'tentative'
    case 'needsAction':
      return 'pending'
    default:
      return null
  }
}

async function locateGoogle(account: Account, token: string, uid: string): Promise<Located | null> {
  const params = new URLSearchParams({
    iCalUID: uid,
    maxResults: '10',
    fields: 'items(id,status,htmlLink,recurringEventId,recurrence,organizer(self),attendees)',
  })
  const res = await providerFetch(`${GOOGLE_EVENTS}?${params}`, token)
  if (!res.ok) throw new ProviderHttpError(res.status, 'Google Calendar read error')
  const items = (((await res.json()) as { items?: Array<Record<string, unknown>> }).items ?? []).filter((e) => typeof e.id === 'string')
  // A series and its changed occurrences share the UID: the series itself is the one the invitation is for.
  const event = items.find((e) => !e.recurringEventId && e.status !== 'cancelled') ?? items.find((e) => !e.recurringEventId) ?? items[0]
  if (!event) return null
  const attendees = Array.isArray(event.attendees) ? (event.attendees as Array<Record<string, unknown>>) : []
  const self = attendees.find((a) => a.self === true)
  const organizer = (event.organizer as { self?: boolean } | undefined)?.self === true
  const blocked: RsvpBlocked | undefined = event.status === 'cancelled' ? 'cancelled' : !self ? (organizer ? 'organizer' : 'not_invited') : undefined
  const recurring = Array.isArray(event.recurrence) && event.recurrence.length > 0
  const occurrence = recurring && !blocked ? await nextGoogleOccurrence(token, event.id as string) : undefined
  return {
    found: true,
    provider: 'google',
    ...(recurring ? { recurring: true } : {}),
    ...(occurrence ? { occurrence } : {}),
    accountId: account.id,
    accountEmail: account.account_email,
    eventId: event.id as string,
    response: self ? googleResponse(self.responseStatus) ?? 'pending' : organizer ? 'accepted' : null,
    link: httpLink(event.htmlLink),
    canAnswer: !blocked,
    ...(blocked ? { blocked } : {}),
    googleAttendees: attendees,
  }
}

/**
 * A repeating Google event's next occurrence that the person is a guest of:
 * events.instances from now, the first that isn't cancelled. Each instance has
 * an id and an attendee list of its own, which is what a reply to it patches.
 * Undefined when there is none, or it can't be read (the series can still be
 * answered).
 */
async function nextGoogleOccurrence(token: string, eventId: string): Promise<Located['occurrence']> {
  try {
    const params = new URLSearchParams({ timeMin: new Date().toISOString(), maxResults: '5', fields: 'items(id,status,start,attendees)' })
    const res = await providerFetch(`${GOOGLE_EVENTS}/${encodeURIComponent(eventId)}/instances?${params}`, token)
    if (!res.ok) return undefined
    const items = ((await res.json()) as { items?: Array<Record<string, unknown>> }).items ?? []
    for (const item of items) {
      const start = item.start as { dateTime?: unknown; date?: unknown } | undefined
      const when = typeof start?.dateTime === 'string' ? start.dateTime : typeof start?.date === 'string' ? start.date : null
      const attendees = Array.isArray(item.attendees) ? (item.attendees as Array<Record<string, unknown>>) : []
      if (typeof item.id !== 'string' || item.status === 'cancelled' || !when || !attendees.some((a) => a.self === true)) continue
      return { eventId: item.id, start: when, googleAttendees: attendees }
    }
  } catch {
    // The series can still be answered.
  }
  return undefined
}

async function answerGoogle(token: string, at: Pick<Located, 'eventId' | 'googleAttendees'>, answer: RsvpAnswer): Promise<void> {
  // The whole list goes back (a patch replaces it); only the person's own entry changes.
  const attendees = (at.googleAttendees ?? []).map((a) => (a.self === true ? { ...a, responseStatus: answer } : a))
  const res = await providerFetch(`${GOOGLE_EVENTS}/${encodeURIComponent(at.eventId)}?sendUpdates=all`, token, { method: 'PATCH', body: { attendees } })
  if (!res.ok) throw new ProviderHttpError(res.status, 'Google Calendar reply error')
}

// ---------------------------------------------------------------------------
// Microsoft Graph
// ---------------------------------------------------------------------------

const GRAPH_EVENTS = 'https://graph.microsoft.com/v1.0/me/events'

function microsoftResponse(value: unknown): RsvpResponse | null {
  switch (value) {
    case 'accepted':
    case 'organizer':
      return 'accepted'
    case 'declined':
      return 'declined'
    case 'tentativelyAccepted':
      return 'tentative'
    case 'notResponded':
    case 'none':
      return 'pending'
    default:
      return null
  }
}

const MICROSOFT_ACTION: Record<RsvpAnswer, string> = { accepted: 'accept', declined: 'decline', tentative: 'tentativelyAccept' }

async function locateMicrosoft(account: Account, token: string, uid: string): Promise<Located | null> {
  const params = new URLSearchParams({
    $filter: `iCalUId eq '${uid.replace(/'/g, "''")}'`,
    $select: 'id,webLink,isOrganizer,isCancelled,responseStatus,type',
    $top: '10',
  })
  const res = await providerFetch(`${GRAPH_EVENTS}?${params}`, token)
  if (!res.ok) throw new ProviderHttpError(res.status, 'Microsoft Calendar read error')
  const items = (((await res.json()) as { value?: Array<Record<string, unknown>> }).value ?? []).filter((e) => typeof e.id === 'string')
  // The series (or the single event), not one changed occurrence of it.
  const event = items.find((e) => e.type === 'seriesMaster' || e.type === 'singleInstance') ?? items[0]
  if (!event) return null
  const organizer = event.isOrganizer === true
  const blocked: RsvpBlocked | undefined = event.isCancelled === true ? 'cancelled' : organizer ? 'organizer' : undefined
  const recurring = event.type === 'seriesMaster'
  const occurrence = recurring && !blocked ? await nextMicrosoftOccurrence(token, event.id as string) : undefined
  return {
    found: true,
    provider: 'microsoft',
    ...(recurring ? { recurring: true } : {}),
    ...(occurrence ? { occurrence } : {}),
    accountId: account.id,
    accountEmail: account.account_email,
    eventId: event.id as string,
    response: organizer ? 'accepted' : microsoftResponse((event.responseStatus as { response?: unknown } | undefined)?.response) ?? 'pending',
    link: httpLink(event.webLink),
    canAnswer: !blocked,
    ...(blocked ? { blocked } : {}),
  }
}

/** How far ahead a repeating Outlook event's next occurrence is looked for. */
const OCCURRENCE_HORIZON_MS = 366 * 24 * 60 * 60 * 1000

/**
 * A repeating Outlook event's next occurrence: the series' instances from
 * now, the earliest that isn't cancelled. An occurrence has an id of its own,
 * which takes the same accept / decline / tentativelyAccept actions.
 */
async function nextMicrosoftOccurrence(token: string, eventId: string): Promise<Located['occurrence']> {
  try {
    const now = Date.now()
    const params = new URLSearchParams({
      startDateTime: new Date(now).toISOString(),
      endDateTime: new Date(now + OCCURRENCE_HORIZON_MS).toISOString(),
      $select: 'id,start,isAllDay,isCancelled',
      $top: '10',
    })
    const res = await providerFetch(`${GRAPH_EVENTS}/${encodeURIComponent(eventId)}/instances?${params}`, token)
    if (!res.ok) return undefined
    const items = ((await res.json()) as { value?: Array<Record<string, unknown>> }).value ?? []
    const upcoming = items
      .map((item) => {
        const text = (item.start as { dateTime?: unknown } | undefined)?.dateTime
        if (typeof item.id !== 'string' || item.isCancelled === true || typeof text !== 'string') return null
        // An all-day occurrence is its date; a timed one an instant (Graph answers in UTC wall time).
        const start = item.isAllDay === true ? text.slice(0, 10) : new Date(/(Z|[+-]\d{2}:?\d{2})$/.test(text) ? text : text + 'Z').toISOString()
        return { eventId: item.id, start }
      })
      .filter((o): o is { eventId: string; start: string } => o !== null)
      .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))
    return upcoming[0]
  } catch {
    return undefined
  }
}

async function answerMicrosoft(token: string, at: Pick<Located, 'eventId'>, answer: RsvpAnswer): Promise<void> {
  const res = await providerFetch(`${GRAPH_EVENTS}/${encodeURIComponent(at.eventId)}/${MICROSOFT_ACTION[answer]}`, token, {
    method: 'POST',
    body: { sendResponse: true },
  })
  if (!res.ok) throw new ProviderHttpError(res.status, 'Microsoft Calendar reply error')
}

// ---------------------------------------------------------------------------
// Find and answer
// ---------------------------------------------------------------------------

interface Search {
  located: (Located & { token: string }) | null
  miss: RsvpNotFound
}

/**
 * The invitation's event on the person's calendars here. A copy the person
 * can answer wins over one they can't (their own organizer copy on another
 * account); the accounts are read one after another, oldest first.
 */
async function search(scope: RsvpScope, uid: string): Promise<Search> {
  const accounts = await accountsHere(scope)
  if (accounts.length === 0) return { located: null, miss: { found: false, reason: 'no_calendar' } }
  let fallback: (Located & { token: string }) | null = null
  let reconnect: Account | null = null
  let unreadable = false
  for (const account of accounts) {
    const token = (await getValidTokenForAccount(account.id))?.token
    if (!token) {
      reconnect ??= account
      continue
    }
    try {
      const hit = account.provider === 'google' ? await locateGoogle(account, token, uid) : await locateMicrosoft(account, token, uid)
      if (!hit) continue
      if (hit.canAnswer) return { located: { ...hit, token }, miss: { found: false, reason: 'not_found' } }
      fallback ??= { ...hit, token }
    } catch (err) {
      if (err instanceof ProviderHttpError && (err.status === 401 || err.status === 403)) reconnect ??= account
      else unreadable = true
      console.warn('[calendar-rsvp] calendar not read:', err instanceof Error ? err.message.slice(0, 120) : 'unknown')
    }
  }
  const miss: RsvpNotFound = reconnect
    ? { found: false, reason: 'reconnect', accountEmail: reconnect.account_email }
    : { found: false, reason: unreadable ? 'unreadable' : 'not_found' }
  return { located: fallback, miss }
}

function publicStatus(at: Located): RsvpFound {
  return {
    found: true,
    provider: at.provider,
    accountId: at.accountId,
    accountEmail: at.accountEmail,
    response: at.response,
    link: at.link,
    canAnswer: at.canAnswer,
    ...(at.blocked ? { blocked: at.blocked } : {}),
    ...(at.recurring ? { recurring: true } : {}),
    ...(at.occurrence ? { nextOccurrence: at.occurrence.start } : {}),
  }
}

/** Where the invitation's event is on the person's calendars here, and the answer the calendar holds. Read-only. */
export async function invitationStatus(scope: RsvpScope, uid: string): Promise<RsvpStatus> {
  const { located, miss } = await search(scope, uid)
  return located ? publicStatus(located) : miss
}

const BLOCKED_MESSAGE: Record<RsvpBlocked, string> = {
  organizer: 'You organize this event, so there is no invitation to answer.',
  not_invited: 'You are not on this event’s guest list, so it can’t be answered from here.',
  cancelled: 'This event was cancelled.',
}

const MISS_ERROR: Record<RsvpNotFound['reason'], { code: RsvpErrorCode; message: string }> = {
  no_calendar: { code: 'no_calendar', message: 'No calendar is connected to this workspace.' },
  reconnect: { code: 'reconnect', message: 'Your calendar needs signing in again before this can be answered.' },
  unreadable: { code: 'unreadable', message: 'Your calendar couldn’t be read just now. Try again in a moment.' },
  not_found: { code: 'not_on_calendar', message: 'This event is not on a connected calendar.' },
}

/**
 * Answer the invitation as the person. Returns the calendar's state after the
 * reply; throws RsvpError (nothing was changed) when it can't be given.
 */
export async function respondToInvitation(scope: RsvpScope, uid: string, answer: RsvpAnswer, which: RsvpWhich = 'series'): Promise<RsvpFound> {
  const { located, miss } = await search(scope, uid)
  if (!located) {
    const { code, message } = MISS_ERROR[miss.reason]
    throw new RsvpError(code, message, miss.accountEmail ?? null)
  }
  if (!located.canAnswer) throw new RsvpError(located.blocked ?? 'not_invited', BLOCKED_MESSAGE[located.blocked ?? 'not_invited'], located.accountEmail)
  // One occurrence of a series: its own id (and, on Google, its own attendee list). The series is left as it was.
  const target = which === 'occurrence' ? located.occurrence : located
  if (!target) {
    throw new RsvpError(
      'no_occurrence',
      located.recurring ? 'This event has no upcoming occurrence to answer on its own. Answer all events instead.' : 'This event doesn’t repeat, so there is only one to answer.',
      located.accountEmail,
    )
  }
  try {
    if (located.provider === 'google') await answerGoogle(located.token, target, answer)
    else await answerMicrosoft(located.token, target, answer)
  } catch (err) {
    const status = err instanceof ProviderHttpError ? err.status : 0
    console.warn('[calendar-rsvp] reply not sent:', err instanceof Error ? err.message.slice(0, 120) : 'unknown')
    if (status === 401 || status === 403) throw new RsvpError('reconnect', MISS_ERROR.reconnect.message, located.accountEmail)
    if (status === 404 || status === 410) throw new RsvpError('gone', 'This event is no longer on your calendar.', located.accountEmail)
    throw new RsvpError('provider', 'Your calendar didn’t take the answer. Try again in a moment.', located.accountEmail)
  }
  // One occurrence answered: the series' own answer is unchanged, and is what the card keeps marked.
  return which === 'occurrence' ? { ...publicStatus(located), answered: 'occurrence' } : { ...publicStatus(located), response: answer, answered: 'series' }
}
