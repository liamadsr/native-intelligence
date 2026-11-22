/**
 * Answering an invitation on the person's calendar: the requests Google and
 * Microsoft are sent (recorded shapes: URL, method, body), which copy of the
 * event is answered, and what each failure is called. People, accounts and
 * tokens are made up; nothing here reaches a network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  accounts: [] as Array<{ id: string; provider: string; account_email: string | null }>,
  links: [] as Array<{ account_id: string }>,
  accountsError: null as { message: string } | null,
  tokens: {} as Record<string, string | null>,
  demo: false,
  queries: [] as Array<{ table: string; filters: Record<string, unknown> }>,
}))

vi.mock('@/lib/admin', () => ({
  getServiceClient: () => ({
    from(table: string) {
      const filters: Record<string, unknown> = {}
      state.queries.push({ table, filters })
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (column: string, value: unknown) => {
          filters[column] = value
          return builder
        },
        order: () => builder,
        then: (resolve: (v: unknown) => unknown) =>
          resolve(table === 'connected_account' ? { data: state.accounts, error: state.accountsError } : { data: state.links, error: null }),
      }
      return builder
    },
  }),
}))
vi.mock('@/lib/oauth/token-manager', () => ({
  getValidTokenForAccount: vi.fn(async (id: string) => (state.tokens[id] ? { token: state.tokens[id], email: null, accountId: id } : null)),
}))
vi.mock('@/lib/demo/demo-mode', () => ({ isDemoWorkspace: vi.fn(async () => state.demo) }))

import { RsvpError, invitationStatus, respondToInvitation } from '../calendar-rsvp'

const SCOPE = { userId: 'user-1', workspaceId: 'ws-1' }
const UID = 'evt-7781@example.com'

interface Call {
  url: string
  method: string
  body: unknown
  auth: string | null
}
let calls: Call[]
let respond: (call: Call) => { status: number; json?: unknown }
const originalFetch = globalThis.fetch

beforeEach(() => {
  state.accounts = [{ id: 'acc-g', provider: 'google', account_email: 'sam@example.com' }]
  state.links = [{ account_id: 'acc-g' }, { account_id: 'acc-m' }]
  state.accountsError = null
  state.tokens = { 'acc-g': 'g-token', 'acc-m': 'm-token' }
  state.demo = false
  state.queries = []
  calls = []
  respond = () => ({ status: 200, json: {} })
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      auth: (init?.headers as Record<string, string> | undefined)?.Authorization ?? null,
    }
    calls.push(call)
    const { status, json } = respond(call)
    return { ok: status >= 200 && status < 300, status, json: async () => json ?? {} } as Response
  }) as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

const GOOGLE_EVENT = {
  id: 'g-evt-1',
  status: 'confirmed',
  htmlLink: 'https://calendar.example.com/event?eid=g-evt-1',
  organizer: { email: 'priya@example.org' },
  attendees: [
    { email: 'priya@example.org', displayName: 'Priya Natarajan', organizer: true, responseStatus: 'accepted' },
    { email: 'sam@example.com', self: true, responseStatus: 'needsAction' },
    { email: 'dana@example.org', responseStatus: 'tentative', optional: true },
  ],
}
const MICROSOFT_EVENT = {
  id: 'AAMk-evt=1',
  webLink: 'https://outlook.example.com/calendar/item/AAMk-evt',
  isOrganizer: false,
  isCancelled: false,
  type: 'singleInstance',
  responseStatus: { response: 'notResponded' },
}

describe('invitationStatus', () => {
  it('finds the event on Google by its iCalendar UID, on the primary calendar, and reads the person’s own answer', async () => {
    respond = () => ({ status: 200, json: { items: [GOOGLE_EVENT] } })
    const status = await invitationStatus(SCOPE, UID)
    expect(status).toEqual({
      found: true,
      provider: 'google',
      accountId: 'acc-g',
      accountEmail: 'sam@example.com',
      response: 'pending',
      link: 'https://calendar.example.com/event?eid=g-evt-1',
      canAnswer: true,
    })
    expect(calls).toHaveLength(1)
    const url = new URL(calls[0].url)
    expect(url.origin + url.pathname).toBe('https://www.googleapis.com/calendar/v3/calendars/primary/events')
    expect(url.searchParams.get('iCalUID')).toBe(UID)
    expect(calls[0].method).toBe('GET')
    expect(calls[0].auth).toBe('Bearer g-token')
  })

  it('reads only the person’s own enabled calendar accounts, and only those linked to this workspace', async () => {
    state.accounts = [
      { id: 'acc-g', provider: 'google', account_email: 'sam@example.com' },
      { id: 'acc-elsewhere', provider: 'google', account_email: 'sam@other.example' },
    ]
    respond = () => ({ status: 200, json: { items: [] } })
    expect(await invitationStatus(SCOPE, UID)).toEqual({ found: false, reason: 'not_found' })
    expect(calls).toHaveLength(1) // acc-elsewhere is not linked here: never read
    const accounts = state.queries.find((q) => q.table === 'connected_account')!
    expect(accounts.filters).toEqual({ user_id: 'user-1', capability: 'calendar', is_enabled: true })
    expect(state.queries.find((q) => q.table === 'connected_account_workspace')!.filters).toEqual({ workspace_id: 'ws-1' })
  })

  it('finds the event on Microsoft by iCalUId, the quote in a UID escaped', async () => {
    state.accounts = [{ id: 'acc-m', provider: 'microsoft', account_email: 'sam@example.net' }]
    respond = () => ({ status: 200, json: { value: [{ ...MICROSOFT_EVENT, responseStatus: { response: 'tentativelyAccepted' } }] } })
    const status = await invitationStatus(SCOPE, "it's-1@example.com")
    expect(status).toMatchObject({ found: true, provider: 'microsoft', response: 'tentative', canAnswer: true, link: 'https://outlook.example.com/calendar/item/AAMk-evt' })
    const url = new URL(calls[0].url)
    expect(url.origin + url.pathname).toBe('https://graph.microsoft.com/v1.0/me/events')
    expect(url.searchParams.get('$filter')).toBe("iCalUId eq 'it''s-1@example.com'")
    expect(calls[0].auth).toBe('Bearer m-token')
  })

  it('says why an event that is there can’t be answered: the organizer’s own, one the person is not a guest of, a cancelled one', async () => {
    respond = () => ({ status: 200, json: { items: [{ ...GOOGLE_EVENT, organizer: { self: true }, attendees: [{ email: 'dana@example.org' }] }] } })
    expect(await invitationStatus(SCOPE, UID)).toMatchObject({ found: true, canAnswer: false, blocked: 'organizer', response: 'accepted' })
    respond = () => ({ status: 200, json: { items: [{ ...GOOGLE_EVENT, attendees: [{ email: 'list@example.org' }] }] } })
    expect(await invitationStatus(SCOPE, UID)).toMatchObject({ found: true, canAnswer: false, blocked: 'not_invited', response: null })
    respond = () => ({ status: 200, json: { items: [{ ...GOOGLE_EVENT, status: 'cancelled' }] } })
    expect(await invitationStatus(SCOPE, UID)).toMatchObject({ found: true, canAnswer: false, blocked: 'cancelled' })
  })

  it('answers the series, not one changed occurrence that shares its UID', async () => {
    respond = () => ({ status: 200, json: { items: [{ ...GOOGLE_EVENT, id: 'g-evt-1_20261203', recurringEventId: 'g-evt-1' }, GOOGLE_EVENT] } })
    await respondToInvitation(SCOPE, UID, 'accepted')
    expect(calls[1].url).toContain('/events/g-evt-1?')
  })

  it('names what is in the way when the event is nowhere: no calendar, a sign-in to renew, a calendar that would not read', async () => {
    state.accounts = []
    expect(await invitationStatus(SCOPE, UID)).toEqual({ found: false, reason: 'no_calendar' })

    state.accounts = [{ id: 'acc-g', provider: 'google', account_email: 'sam@example.com' }]
    state.tokens = {}
    expect(await invitationStatus(SCOPE, UID)).toEqual({ found: false, reason: 'reconnect', accountEmail: 'sam@example.com' })
    expect(calls).toHaveLength(0)

    state.tokens = { 'acc-g': 'g-token' }
    respond = () => ({ status: 403 })
    expect(await invitationStatus(SCOPE, UID)).toEqual({ found: false, reason: 'reconnect', accountEmail: 'sam@example.com' })
    respond = () => ({ status: 503 })
    expect(await invitationStatus(SCOPE, UID)).toEqual({ found: false, reason: 'unreadable' })
  })

  it('prefers the copy the person can answer over their own organizer copy on another account', async () => {
    state.accounts = [
      { id: 'acc-g', provider: 'google', account_email: 'sam@example.com' },
      { id: 'acc-m', provider: 'microsoft', account_email: 'sam@example.net' },
    ]
    respond = (call) =>
      call.url.includes('googleapis')
        ? { status: 200, json: { items: [{ ...GOOGLE_EVENT, organizer: { self: true }, attendees: [] }] } }
        : { status: 200, json: { value: [MICROSOFT_EVENT] } }
    expect(await invitationStatus(SCOPE, UID)).toMatchObject({ provider: 'microsoft', canAnswer: true })
  })

  it('reads and answers nothing from inside a demo workspace', async () => {
    state.demo = true
    expect(await invitationStatus(SCOPE, UID)).toEqual({ found: false, reason: 'no_calendar' })
    await expect(respondToInvitation(SCOPE, UID, 'accepted')).rejects.toMatchObject({ code: 'no_calendar' })
    expect(calls).toHaveLength(0)
  })

  it('throws when the accounts themselves can’t be read (never "not on a calendar")', async () => {
    state.accountsError = { message: 'boom' }
    await expect(invitationStatus(SCOPE, UID)).rejects.toThrow('could not read calendar accounts')
  })
})

describe('respondToInvitation', () => {
  it('Google: patches the person’s own attendee entry, the other guests untouched, and has Google tell the organizer', async () => {
    respond = (call) => (call.method === 'GET' ? { status: 200, json: { items: [GOOGLE_EVENT] } } : { status: 200, json: {} })
    const status = await respondToInvitation(SCOPE, UID, 'tentative')
    expect(status).toMatchObject({ found: true, provider: 'google', response: 'tentative', canAnswer: true })
    expect(calls).toHaveLength(2)
    expect(calls[1]).toEqual({
      url: 'https://www.googleapis.com/calendar/v3/calendars/primary/events/g-evt-1?sendUpdates=all',
      method: 'PATCH',
      auth: 'Bearer g-token',
      body: {
        attendees: [
          { email: 'priya@example.org', displayName: 'Priya Natarajan', organizer: true, responseStatus: 'accepted' },
          { email: 'sam@example.com', self: true, responseStatus: 'tentative' },
          { email: 'dana@example.org', responseStatus: 'tentative', optional: true },
        ],
      },
    })
  })

  it.each([
    ['accepted', 'accept'],
    ['declined', 'decline'],
    ['tentative', 'tentativelyAccept'],
  ] as const)('Microsoft: "%s" posts the event’s %s action and sends the response', async (answer, action) => {
    state.accounts = [{ id: 'acc-m', provider: 'microsoft', account_email: 'sam@example.net' }]
    respond = (call) => (call.method === 'GET' ? { status: 200, json: { value: [MICROSOFT_EVENT] } } : { status: 202 })
    const status = await respondToInvitation(SCOPE, UID, answer)
    expect(status).toMatchObject({ provider: 'microsoft', response: answer, accountEmail: 'sam@example.net' })
    expect(calls[1]).toEqual({
      url: `https://graph.microsoft.com/v1.0/me/events/AAMk-evt%3D1/${action}`,
      method: 'POST',
      auth: 'Bearer m-token',
      body: { sendResponse: true },
    })
  })

  it('writes nothing when the event is on no connected calendar', async () => {
    respond = () => ({ status: 200, json: { items: [] } })
    const err = await respondToInvitation(SCOPE, UID, 'accepted').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RsvpError)
    expect(err).toMatchObject({ code: 'not_on_calendar' })
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([])
  })

  it('writes nothing for the organizer’s own event', async () => {
    respond = () => ({ status: 200, json: { items: [{ ...GOOGLE_EVENT, organizer: { self: true }, attendees: [] }] } })
    await expect(respondToInvitation(SCOPE, UID, 'declined')).rejects.toMatchObject({ code: 'organizer' })
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([])
  })

  it('names a refused reply: a sign-in to renew, an event gone since, a calendar that didn’t take it', async () => {
    const outcome = async (status: number) => {
      respond = (call) => (call.method === 'GET' ? { status: 200, json: { items: [GOOGLE_EVENT] } } : { status })
      return respondToInvitation(SCOPE, UID, 'accepted').catch((e: RsvpError) => ({ code: e.code, account: e.accountEmail }))
    }
    expect(await outcome(401)).toEqual({ code: 'reconnect', account: 'sam@example.com' })
    expect(await outcome(403)).toEqual({ code: 'reconnect', account: 'sam@example.com' })
    expect(await outcome(404)).toEqual({ code: 'gone', account: 'sam@example.com' })
    expect(await outcome(410)).toEqual({ code: 'gone', account: 'sam@example.com' })
    expect(await outcome(500)).toEqual({ code: 'provider', account: 'sam@example.com' })
  })

  it('names a calendar whose sign-in can’t be renewed', async () => {
    state.tokens = {}
    await expect(respondToInvitation(SCOPE, UID, 'accepted')).rejects.toMatchObject({ code: 'reconnect', accountEmail: 'sam@example.com' })
    expect(calls).toHaveLength(0)
  })
})

describe('the scopes a reply uses', () => {
  it('are ones the app already asks for: Google calendar.events, Microsoft Calendars.ReadWrite', async () => {
    const { OAUTH_CONFIG } = await import('@/lib/oauth/config')
    expect(OAUTH_CONFIG.google.scopes.calendar).toContain('https://www.googleapis.com/auth/calendar.events')
    expect(OAUTH_CONFIG.microsoft.scopes.calendar).toContain('Calendars.ReadWrite')
  })
})
