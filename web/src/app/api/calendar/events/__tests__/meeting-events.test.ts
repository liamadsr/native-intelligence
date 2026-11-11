/**
 * The calendar's own routes and meeting links (src/app/api/calendar/events):
 * the view asks for the person's meeting links too; moving or renaming a
 * meeting the calendar shows from the meeting itself moves or renames the
 * meeting (never a provider call); deleting it revokes it; a meeting's own
 * provider event moved there takes the meeting with it, deleted there revokes
 * it; "Add a meeting link" remembers its event on the meeting.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  listed: [] as Array<Record<string, unknown>>,
  updated: [] as unknown[],
  deleted: [] as unknown[],
  changed: [] as unknown[],
  revoked: [] as string[],
  tied: null as string | null,
  saved: [] as Array<{ row: unknown; id: string }>,
  rpcs: [] as Array<[string, Record<string, unknown>]>,
  revokeAnswer: { data: [{ revoked: true, call_id: null, room: null }], error: null } as { data: unknown; error: unknown },
  drained: 0,
  via: 'session' as 'session' | 'device',
}))

vi.mock('server-only', () => ({}))
vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: () => {} }))
vi.mock('@/lib/ai/auth', () => ({ authenticateUser: async () => ({ user: { id: 'user-me' }, supabase: { person: h.via === 'session' }, via: h.via }) }))
vi.mock('@/lib/api-auth', () => ({ requireWorkspace: async () => ({ supabase: { person: true }, user: { id: 'user-me' }, workspaceId: 'ws-1' }) }))
vi.mock('@/lib/crm/calendar-contacts', () => ({ ensureContactsForCalendarEvents: async () => {} }))
vi.mock('@/lib/admin', () => ({
  getServiceClient: () => ({
    from: () => ({ update: (row: unknown) => ({ eq: async (_k: string, id: string) => (h.saved.push({ row, id }), { error: null }) }) }),
    rpc: async (name: string, args: Record<string, unknown>) => (h.rpcs.push([name, args]), h.revokeAnswer),
  }),
}))
vi.mock('@/lib/time-offers/host-calendar', () => ({ writableCalendarAccounts: async () => [{ id: 'acct-default', provider: 'google', label: 'me@example.com' }] }))
vi.mock('@/lib/team-calls/eject', () => ({ liveEjectDeps: () => ({}), drainTeamCallEjections: async () => ((h.drained += 1), { done: 1, failed: 0 }) }))
vi.mock('@/lib/team-calls/livekit', () => ({ teamCallsConfig: () => ({ url: 'ws://x', apiUrl: 'http://x', apiKey: 'k', apiSecret: 's' }) }))
vi.mock('@/lib/integrations/calendar', () => ({
  listCalendarEventsUnified: async (_u: string, options: Record<string, unknown>) => (h.listed.push(options), []),
  listCalendarEvents: async () => [],
  getCalendarProvider: async () => null,
  createCalendarEvent: async (_u: string, _e: unknown, accountId?: string) => ({ id: 'evt-new', accountId }),
  updateCalendarEvent: async (...args: unknown[]) => (h.updated.push(args), { id: args[1] }),
  deleteCalendarEvent: async (...args: unknown[]) => void h.deleted.push(args),
}))
vi.mock('@/lib/meeting-links/calendar', () => ({
  meetingLinkForNewEvent: async () => ({ ok: true, link: { meetingId: 'mtg-new', url: 'https://app.example/m/x' }, location: 'https://app.example/m/x', description: 'Join the meeting: https://app.example/m/x' }),
}))
vi.mock('@/lib/meeting-links/store', async (orig) => {
  const real = await orig<typeof import('@/lib/meeting-links/store')>()
  return {
    revokeMeetingAs: async (svc: never, id: string, userId: string) => {
      h.revoked.push(id)
      return real.revokeMeetingAs(svc, id, userId)
    },
  }
})
vi.mock('@/lib/meeting-links/calendar-events', async (orig) => ({
  ...(await orig<typeof import('@/lib/meeting-links/calendar-events')>()),
  changeMeeting: async (_s: unknown, args: { clamp?: boolean; endsAt?: string }) => {
    h.changed.push(args)
    if (args.clamp && args.endsAt === '2026-11-12T23:00:00.000Z') return { ok: true, title: 'T', startsAt: 'a', endsAt: 'b', clamped: 'longest' }
    return { ok: true, title: 'T', startsAt: 'a', endsAt: 'b' }
  },
  meetingOfProviderEvent: async () => h.tied,
}))

import { DELETE, GET, PATCH, POST } from '../route'

const MID = '11111111-1111-4111-8111-111111111111'
const req = (method: string, body?: unknown, query = '') => new Request(`https://app.example/api/calendar/events${query}`, { method, ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}) })

beforeEach(() => {
  Object.assign(h, { listed: [], updated: [], deleted: [], changed: [], revoked: [], tied: null, saved: [], rpcs: [], drained: 0, via: 'session', revokeAnswer: { data: [{ revoked: true, call_id: null, room: null }], error: null } })
})

describe('the app’s calendar and meeting links', () => {
  it('the view asks for the person’s meeting links too', async () => {
    await GET(req('GET', undefined, '?workspaceId=ws-1'))
    expect(h.listed[0]).toMatchObject({ includeMeetingLinks: true, workspaceId: 'ws-1' })
  })

  it('a meeting shown from the meeting itself: moving it moves the meeting (no provider call); deleting it revokes it', async () => {
    const moved = await PATCH(req('PATCH', { eventId: `meeting:${MID}`, start: '2026-11-12T15:00:00.000Z', end: '2026-11-12T15:30:00.000Z' }))
    expect(moved.status).toBe(200)
    expect(h.changed).toEqual([{ meetingId: MID, userId: 'user-me', title: undefined, startsAt: '2026-11-12T15:00:00.000Z', endsAt: '2026-11-12T15:30:00.000Z' }])
    expect(h.updated).toEqual([])
    await DELETE(req('DELETE', undefined, `?eventId=meeting:${MID}`))
    expect(h.revoked).toEqual([MID])
    expect(h.deleted).toEqual([])
  })

  it('a meeting’s own provider event moved there: the meeting follows; deleted there: revoked', async () => {
    h.tied = MID
    await PATCH(req('PATCH', { eventId: 'evt-1', start: '2026-11-12T15:00:00.000Z', end: '2026-11-12T15:30:00.000Z' }))
    expect(h.updated).toHaveLength(1)
    expect(h.changed).toEqual([{ meetingId: MID, userId: 'user-me', title: undefined, startsAt: '2026-11-12T15:00:00.000Z', endsAt: '2026-11-12T15:30:00.000Z', clamp: true }])
    await DELETE(req('DELETE', undefined, '?eventId=evt-1'))
    expect(h.deleted).toHaveLength(1)
    expect(h.revoked).toEqual([MID])
  })

  it('any other event: as before, the meeting untouched', async () => {
    await PATCH(req('PATCH', { eventId: 'evt-2', title: 'Lunch' }))
    await DELETE(req('DELETE', undefined, '?eventId=evt-2'))
    expect(h.changed).toEqual([])
    expect(h.revoked).toEqual([])
  })

  it('"Add a meeting link": the meeting remembers the event as the PERSON’s, on the account actually used (the default when none was sent)', async () => {
    await POST(req('POST', { title: 'Design review', start: '2026-11-12T15:00:00.000Z', end: '2026-11-12T15:30:00.000Z', meetingLink: true }))
    expect(h.saved).toEqual([{ row: { calendar_event_id: 'evt-new', calendar_account_id: 'acct-default', calendar_event_kind: 'person' }, id: 'mtg-new' }])
    h.saved = []
    await POST(req('POST', { title: 'Design review', start: '2026-11-12T15:00:00.000Z', end: '2026-11-12T15:30:00.000Z', meetingLink: true, accountId: 'acct-chosen' }))
    expect(h.saved[0].row).toMatchObject({ calendar_account_id: 'acct-chosen', calendar_event_kind: 'person' })
  })

  it('dragged to a length a meeting can’t have: the event is saved, and the person is told what the link did', async () => {
    h.tied = MID
    const res = await PATCH(req('PATCH', { eventId: 'evt-1', start: '2026-11-12T13:00:00.000Z', end: '2026-11-12T23:00:00.000Z' }))
    expect(res.status).toBe(200)
    expect((await res.json()).notice).toContain('first 8 hours')
  })

  it('a device’s token (no session the database can read): revoked as the host all the same, never a 500', async () => {
    h.via = 'device'
    const res = await DELETE(req('DELETE', undefined, `?eventId=meeting:${MID}`))
    expect(res.status).toBe(200)
    expect(h.rpcs).toEqual([['meeting_revoke_as', { target_meeting: MID, acting_user: 'user-me' }]])
  })

  it('not the host: 403, nothing removed', async () => {
    h.revokeAnswer = { data: null, error: { code: '42501', message: 'meetings: only the host can revoke the link' } }
    expect((await DELETE(req('DELETE', undefined, `?eventId=meeting:${MID}`))).status).toBe(403)
  })

  it('removed with a live call: the guests in it are taken out at once', async () => {
    h.revokeAnswer = { data: [{ revoked: true, call_id: 'call-1', room: 'tc-call-1' }], error: null }
    await DELETE(req('DELETE', undefined, `?eventId=meeting:${MID}`))
    expect(h.drained).toBe(1)
    h.tied = MID
    await DELETE(req('DELETE', undefined, '?eventId=evt-1'))
    expect(h.drained).toBe(2)
  })
})
