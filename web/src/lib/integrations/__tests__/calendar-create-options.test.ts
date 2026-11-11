/**
 * What a calendar write can ask of the provider (../calendar.ts), for a
 * booked meeting with an outside guest (src/lib/time-offers/): the provider
 * sends the attendee the invitation (Google sendUpdates=all), a video link
 * (Google Meet's createRequest, Teams' isOnlineMeeting; an account that can't
 * make one still gets the event), one event per key (Google: a client-chosen
 * id, a 409 read back; Microsoft: transactionId), and where it was written;
 * a move or a cancel on a named account tells the attendees. Without the
 * options, a create is what it always was. No network: fetch is stubbed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const hoisted = vi.hoisted(() => ({ provider: 'google' as string }))

vi.mock('@/lib/oauth/token-manager', () => ({
  getValidToken: vi.fn(async () => null),
  getValidTokenForCapability: vi.fn(),
  getAllValidTokens: vi.fn(),
  getValidTokenForAccount: vi.fn(async (id: string) => ({ token: `tok-${id}`, email: null, accountId: id })),
}))
vi.mock('@/lib/admin', () => ({
  getServiceClient: () => ({
    from: () => {
      const chain: Record<string, unknown> = {}
      for (const m of ['select', 'eq']) chain[m] = () => chain
      chain.single = async () => ({ data: { provider: hoisted.provider }, error: null })
      return chain
    },
  }),
}))

const { createCalendarEvent, deleteCalendarEvent, deleteCalendarEventByKey, googleEventIdFor, updateCalendarEvent } = await import('@/lib/integrations/calendar')

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

type Call = { url: string; method: string; body: Record<string, unknown> | null }
function stubFetch(responses: Array<{ status: number; body?: unknown }>): Call[] {
  const calls: Call[] = []
  let i = 0
  globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null })
    const r = responses[Math.min(i++, responses.length - 1)]
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status })
  }) as typeof fetch
  return calls
}

const BOOKING_ID = '6f0a8c1e-1b2c-4d5e-8f90-123456789abc'
const EVENT = { title: 'Intro call (Dana Reyes)', description: 'Booked through Native Intelligence', start: '2026-11-17T15:00:00.000Z', end: '2026-11-17T15:30:00.000Z', attendees: ['dana@initech.example'] }
const GOOGLE_EVENT = {
  id: googleEventIdFor(BOOKING_ID),
  summary: EVENT.title,
  start: { dateTime: EVENT.start },
  end: { dateTime: EVENT.end },
  conferenceData: { entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/abc-defg-hij' }] },
}

describe('googleEventIdFor', () => {
  it('a base32hex id (0-9, a-v), the same for the same key', () => {
    expect(googleEventIdFor(BOOKING_ID)).toBe('ni6f0a8c1e1b2c4d5e8f90123456789abc')
    expect(googleEventIdFor(BOOKING_ID)).toMatch(/^[0-9a-v]{5,1024}$/)
    // w, x, y and z are outside base32hex: dropped.
    expect(googleEventIdFor('Booking-XYZ_1')).toBe('nibooking1')
  })
})

describe('createCalendarEvent with options, on a Google account', () => {
  it('invites (sendUpdates=all), asks for a Meet link, names its own id; returns the link and where it went', async () => {
    hoisted.provider = 'google'
    const calls = stubFetch([{ status: 200, body: GOOGLE_EVENT }])
    const event = await createCalendarEvent('user-ava', EVENT, 'acct-g', { sendInvites: true, video: true, idempotencyKey: BOOKING_ID })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=all&conferenceDataVersion=1')
    expect(calls[0].body).toMatchObject({
      id: googleEventIdFor(BOOKING_ID),
      attendees: [{ email: 'dana@initech.example' }],
      conferenceData: { createRequest: { requestId: BOOKING_ID, conferenceSolutionKey: { type: 'hangoutsMeet' } } },
    })
    expect(event).toMatchObject({ id: googleEventIdFor(BOOKING_ID), conferenceUrl: 'https://meet.google.com/abc-defg-hij', accountId: 'acct-g', calendarId: 'primary', provider: 'google' })
  })

  it('the same key again (a retry after a crash): the 409 reads the existing event back, never a second', async () => {
    const calls = stubFetch([{ status: 409, body: { error: 'duplicate' } }, { status: 200, body: GOOGLE_EVENT }])
    const event = await createCalendarEvent('user-ava', EVENT, 'acct-g', { sendInvites: true, idempotencyKey: BOOKING_ID })
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ['POST', 'https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=all'],
      ['GET', `https://www.googleapis.com/calendar/v3/calendars/primary/events/${googleEventIdFor(BOOKING_ID)}?conferenceDataVersion=1`],
    ])
    expect(event.id).toBe(googleEventIdFor(BOOKING_ID))
    // An event that was deleted since is not "already made".
    stubFetch([{ status: 409 }, { status: 200, body: { ...GOOGLE_EVENT, status: 'cancelled' } }])
    await expect(createCalendarEvent('user-ava', EVENT, 'acct-g', { idempotencyKey: BOOKING_ID })).rejects.toThrow('the event was deleted')
  })

  it('an account that cannot make a Meet link still gets the event, without one', async () => {
    const calls = stubFetch([{ status: 400 }, { status: 200, body: { ...GOOGLE_EVENT, conferenceData: undefined } }])
    const event = await createCalendarEvent('user-ava', EVENT, 'acct-g', { video: true, idempotencyKey: BOOKING_ID })
    expect(calls[1].url).toBe('https://www.googleapis.com/calendar/v3/calendars/primary/events')
    expect(calls[1].body?.conferenceData).toBeUndefined()
    expect(event.conferenceUrl).toBeUndefined()
  })

  it('without options, the create it always was', async () => {
    const calls = stubFetch([{ status: 200, body: GOOGLE_EVENT }])
    await createCalendarEvent('user-ava', EVENT, 'acct-g')
    expect(calls[0].url).toBe('https://www.googleapis.com/calendar/v3/calendars/primary/events')
    expect(calls[0].body?.id).toBeUndefined()
    expect(calls[0].body?.conferenceData).toBeUndefined()
  })
})

describe('createCalendarEvent with options, on an Outlook account', () => {
  it('one event per transactionId, a Teams link asked for and returned', async () => {
    hoisted.provider = 'microsoft'
    const calls = stubFetch([{ status: 201, body: { id: 'AAMk-1', subject: EVENT.title, start: { dateTime: '2026-11-17T15:00:00.0000000' }, end: { dateTime: '2026-11-17T15:30:00.0000000' }, onlineMeeting: { joinUrl: 'https://teams.example/l/meetup' } } }])
    const event = await createCalendarEvent('user-ava', EVENT, 'acct-m', { sendInvites: true, video: true, idempotencyKey: BOOKING_ID })
    expect(calls[0].url).toBe('https://graph.microsoft.com/v1.0/me/events')
    expect(calls[0].body).toMatchObject({ transactionId: BOOKING_ID, isOnlineMeeting: true, onlineMeetingProvider: 'teamsForBusiness', attendees: [{ emailAddress: { address: 'dana@initech.example' }, type: 'required' }] })
    expect(event).toMatchObject({ id: 'AAMk-1', conferenceUrl: 'https://teams.example/l/meetup', accountId: 'acct-m', provider: 'microsoft' })
  })

  it('a personal account that cannot make a Teams meeting gets the event without a link', async () => {
    hoisted.provider = 'microsoft'
    const calls = stubFetch([{ status: 400 }, { status: 201, body: { id: 'AAMk-2', subject: EVENT.title, start: { dateTime: '2026-11-17T15:00:00' }, end: { dateTime: '2026-11-17T15:30:00' } } }])
    const event = await createCalendarEvent('user-ava', EVENT, 'acct-m', { video: true, idempotencyKey: BOOKING_ID })
    expect(calls[1].body?.isOnlineMeeting).toBeUndefined()
    expect(calls[1].body?.transactionId).toBe(BOOKING_ID)
    expect(event.conferenceUrl).toBeUndefined()
  })
})

describe('updateCalendarEvent and deleteCalendarEvent on a named account', () => {
  it('Google: the move and the cancel tell the attendees (sendUpdates=all)', async () => {
    hoisted.provider = 'google'
    const calls = stubFetch([{ status: 200, body: GOOGLE_EVENT }, { status: 204 }])
    await updateCalendarEvent('user-ava', 'ni123', { start: EVENT.start, end: EVENT.end }, { accountId: 'acct-g', notifyAttendees: true })
    await deleteCalendarEvent('user-ava', 'ni123', { accountId: 'acct-g', notifyAttendees: true })
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ['PATCH', 'https://www.googleapis.com/calendar/v3/calendars/primary/events/ni123?sendUpdates=all'],
      ['DELETE', 'https://www.googleapis.com/calendar/v3/calendars/primary/events/ni123?sendUpdates=all'],
    ])
  })

  it("Outlook: the organizer's cancel sends the cancellation; not the organizer, a plain delete", async () => {
    hoisted.provider = 'microsoft'
    const calls = stubFetch([{ status: 202 }])
    await deleteCalendarEvent('user-ava', 'AAMk-1', { accountId: 'acct-m', notifyAttendees: true })
    expect(calls.map((c) => [c.method, c.url])).toEqual([['POST', 'https://graph.microsoft.com/v1.0/me/events/AAMk-1/cancel']])
    const fallback = stubFetch([{ status: 400 }, { status: 204 }])
    await deleteCalendarEvent('user-ava', 'AAMk-1', { accountId: 'acct-m', notifyAttendees: true })
    expect(fallback.map((c) => c.method)).toEqual(['POST', 'DELETE'])
  })
})

describe('the event a key made, taken off again (a booking failed after the provider may have made it)', () => {
  it('Google: by the id the key names, its attendees told; none there is none', async () => {
    hoisted.provider = 'google'
    const calls = stubFetch([{ status: 204 }])
    expect(await deleteCalendarEventByKey('user-ava', BOOKING_ID, { accountId: 'acct-g' })).toBe('deleted')
    expect(calls).toEqual([{ url: `https://www.googleapis.com/calendar/v3/calendars/primary/events/${googleEventIdFor(BOOKING_ID)}?sendUpdates=all`, method: 'DELETE', body: null }])
    stubFetch([{ status: 404 }])
    expect(await deleteCalendarEventByKey('user-ava', BOOKING_ID, { accountId: 'acct-g' })).toBe('none')
    stubFetch([{ status: 500 }])
    await expect(deleteCalendarEventByKey('user-ava', BOOKING_ID, { accountId: 'acct-g' })).rejects.toThrow('500')
  })

  it('Microsoft: found by its transactionId, then cancelled with its attendees told; none found is none', async () => {
    hoisted.provider = 'microsoft'
    const calls = stubFetch([{ status: 200, body: { value: [{ id: 'AAMk-9' }] } }, { status: 202 }])
    expect(await deleteCalendarEventByKey('user-ava', BOOKING_ID, { accountId: 'acct-m' })).toBe('deleted')
    expect(calls[0].url).toBe(`https://graph.microsoft.com/v1.0/me/events?$filter=${encodeURIComponent(`transactionId eq '${BOOKING_ID}'`)}&$select=id&$top=1`)
    expect(calls[1]).toMatchObject({ url: 'https://graph.microsoft.com/v1.0/me/events/AAMk-9/cancel', method: 'POST' })
    stubFetch([{ status: 200, body: { value: [] } }])
    expect(await deleteCalendarEventByKey('user-ava', BOOKING_ID, { accountId: 'acct-m' })).toBe('none')
    stubFetch([{ status: 400 }])
    await expect(deleteCalendarEventByKey('user-ava', BOOKING_ID, { accountId: 'acct-m' })).rejects.toThrow('400')
  })
})
