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
}))

vi.mock('server-only', () => ({}))
vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: () => {} }))
vi.mock('@/lib/ai/auth', () => ({ authenticateUser: async () => ({ user: { id: 'user-me' }, supabase: { person: true } }) }))
vi.mock('@/lib/api-auth', () => ({ requireWorkspace: async () => ({ supabase: { person: true }, user: { id: 'user-me' }, workspaceId: 'ws-1' }) }))
vi.mock('@/lib/crm/calendar-contacts', () => ({ ensureContactsForCalendarEvents: async () => {} }))
vi.mock('@/lib/admin', () => ({
  getServiceClient: () => ({
    from: () => ({ update: (row: unknown) => ({ eq: async (_k: string, id: string) => (h.saved.push({ row, id }), { error: null }) }) }),
  }),
}))
vi.mock('@/lib/integrations/calendar', () => ({
  listCalendarEventsUnified: async (_u: string, options: Record<string, unknown>) => (h.listed.push(options), []),
  listCalendarEvents: async () => [],
  getCalendarProvider: async () => null,
  createCalendarEvent: async () => ({ id: 'evt-new', accountId: 'acct-google' }),
  updateCalendarEvent: async (...args: unknown[]) => (h.updated.push(args), { id: args[1] }),
  deleteCalendarEvent: async (...args: unknown[]) => void h.deleted.push(args),
}))
vi.mock('@/lib/meeting-links/calendar', () => ({
  meetingLinkForNewEvent: async () => ({ ok: true, link: { meetingId: 'mtg-new', url: 'https://app.example/m/x' }, location: 'https://app.example/m/x', description: 'Join the meeting: https://app.example/m/x' }),
}))
vi.mock('@/lib/meeting-links/store', () => ({ revokeMeeting: async (_s: unknown, id: string) => (h.revoked.push(id), { revoked: true }) }))
vi.mock('@/lib/meeting-links/calendar-events', async (orig) => ({
  ...(await orig<typeof import('@/lib/meeting-links/calendar-events')>()),
  changeMeeting: async (_s: unknown, args: unknown) => (h.changed.push(args), { ok: true, title: 'T', startsAt: 'a', endsAt: 'b' }),
  meetingOfProviderEvent: async () => h.tied,
}))

import { DELETE, GET, PATCH, POST } from '../route'

const MID = '11111111-1111-4111-8111-111111111111'
const req = (method: string, body?: unknown, query = '') => new Request(`https://app.example/api/calendar/events${query}`, { method, ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}) })

beforeEach(() => {
  Object.assign(h, { listed: [], updated: [], deleted: [], changed: [], revoked: [], tied: null, saved: [] })
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
    expect(h.changed).toEqual([{ meetingId: MID, userId: 'user-me', title: undefined, startsAt: '2026-11-12T15:00:00.000Z', endsAt: '2026-11-12T15:30:00.000Z' }])
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

  it('"Add a meeting link": the meeting remembers the event it is on', async () => {
    await POST(req('POST', { title: 'Design review', start: '2026-11-12T15:00:00.000Z', end: '2026-11-12T15:30:00.000Z', meetingLink: true }))
    expect(h.saved).toEqual([{ row: { calendar_event_id: 'evt-new', calendar_account_id: 'acct-google' }, id: 'mtg-new' }])
  })
})
