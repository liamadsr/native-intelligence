/**
 * /api/calendar/rsvp: signed in and in a workspace, the UID and the answer
 * checked, and each failed reply answered with its own status and code.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({ auth: vi.fn(), status: vi.fn(), respond: vi.fn() }))
vi.mock('@/lib/api-auth', () => ({ requireWorkspace: mocks.auth }))
vi.mock('@/lib/integrations/calendar-rsvp', async (original) => ({
  ...(await original<typeof import('@/lib/integrations/calendar-rsvp')>()),
  invitationStatus: mocks.status,
  respondToInvitation: mocks.respond,
}))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({}) }))
vi.mock('@/lib/oauth/token-manager', () => ({ getValidTokenForAccount: vi.fn() }))
vi.mock('@/lib/demo/demo-mode', () => ({ isDemoWorkspace: vi.fn(async () => false) }))

import { GET, POST } from '../route'
import { RsvpError } from '@/lib/integrations/calendar-rsvp'

const get = (query: string) => new NextRequest(`http://localhost/api/calendar/rsvp${query}`)
const post = (body: unknown) =>
  new NextRequest('http://localhost/api/calendar/rsvp', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })
const FOUND = { found: true, provider: 'google', accountId: 'acc-g', accountEmail: 'sam@example.com', response: 'accepted', link: null, canAnswer: true }

beforeEach(() => {
  mocks.auth.mockReset().mockResolvedValue({ user: { id: 'u1' }, workspaceId: 'w1' })
  mocks.status.mockReset().mockResolvedValue({ found: false, reason: 'not_found' })
  mocks.respond.mockReset().mockResolvedValue(FOUND)
})

describe('GET /api/calendar/rsvp', () => {
  it('answers what the auth helper answers when nobody is signed in', async () => {
    mocks.auth.mockResolvedValue(new Response(null, { status: 401 }))
    expect((await GET(get('?uid=a@example.com'))).status).toBe(401)
    expect(mocks.status).not.toHaveBeenCalled()
  })

  it('needs a UID of a sane length', async () => {
    expect((await GET(get(''))).status).toBe(400)
    expect((await GET(get(`?uid=${'x'.repeat(1025)}`))).status).toBe(400)
    expect(mocks.status).not.toHaveBeenCalled()
  })

  it('looks the event up for the signed-in person in the current workspace, and is never cached', async () => {
    const res = await GET(get('?uid=evt-7781%40example.com'))
    expect(mocks.status).toHaveBeenCalledWith({ userId: 'u1', workspaceId: 'w1' }, 'evt-7781@example.com')
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store, private')
    expect(await res.json()).toEqual({ found: false, reason: 'not_found' })
  })

  it('is a 500 with the shared error shape when the lookup throws', async () => {
    mocks.status.mockRejectedValue(new Error('could not read calendar accounts: boom'))
    const res = await GET(get('?uid=a@example.com'))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("Couldn't check your calendar")
  })
})

describe('POST /api/calendar/rsvp', () => {
  it('answers what the auth helper answers when nobody is signed in', async () => {
    mocks.auth.mockResolvedValue(new Response(null, { status: 401 }))
    expect((await POST(post({ uid: 'a@example.com', response: 'accepted' }))).status).toBe(401)
    expect(mocks.respond).not.toHaveBeenCalled()
  })

  it('refuses a missing UID, an answer that is not one of the three, and a body that is not JSON', async () => {
    expect((await POST(post({ response: 'accepted' }))).status).toBe(400)
    expect((await POST(post({ uid: 'a@example.com', response: 'pending' }))).status).toBe(400)
    expect((await POST(post({ uid: 'a@example.com', response: 'needsAction' }))).status).toBe(400)
    expect((await POST(post('not json'))).status).toBe(400)
    expect(mocks.respond).not.toHaveBeenCalled()
  })

  it('answers as the signed-in person in the current workspace and returns the calendar’s state', async () => {
    const res = await POST(post({ uid: 'evt-7781@example.com', response: 'tentative' }))
    expect(mocks.respond).toHaveBeenCalledWith({ userId: 'u1', workspaceId: 'w1' }, 'evt-7781@example.com', 'tentative', 'series')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(FOUND)
  })

  it('answers one occurrence of a repeating event when asked to, and refuses any other word for it', async () => {
    await POST(post({ uid: 'evt-7781@example.com', response: 'declined', which: 'occurrence' }))
    expect(mocks.respond).toHaveBeenLastCalledWith({ userId: 'u1', workspaceId: 'w1' }, 'evt-7781@example.com', 'declined', 'occurrence')
    mocks.respond.mockClear()
    expect((await POST(post({ uid: 'evt-7781@example.com', response: 'declined', which: 'following' }))).status).toBe(400)
    expect(mocks.respond).not.toHaveBeenCalled()
  })

  it.each([
    ['no_occurrence', 409],
    ['not_on_calendar', 404],
    ['no_calendar', 404],
    ['gone', 404],
    ['reconnect', 409],
    ['organizer', 409],
    ['not_invited', 409],
    ['cancelled', 409],
    ['unreadable', 502],
    ['provider', 502],
  ] as const)('a reply refused as %s is a %i with its code and words', async (code, status) => {
    mocks.respond.mockRejectedValue(new RsvpError(code, 'Why it was not sent.', 'sam@example.com'))
    const res = await POST(post({ uid: 'a@example.com', response: 'accepted' }))
    expect(res.status).toBe(status)
    expect(await res.json()).toEqual({ error: 'Why it was not sent.', code: `RSVP_${code.toUpperCase()}`, details: { accountEmail: 'sam@example.com' } })
  })

  it('is a 500 for anything else', async () => {
    mocks.respond.mockRejectedValue(new Error('boom'))
    const res = await POST(post({ uid: 'a@example.com', response: 'accepted' }))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("Couldn't answer the invitation")
  })
})
