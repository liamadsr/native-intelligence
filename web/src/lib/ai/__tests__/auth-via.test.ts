import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * `via` from the REAL authenticateUser — which credential actually
 * authenticated the request. /api/device/ask relays exactly that credential to
 * the chat-agent (deviceAskCredential), so a wrong `via` would relay a dead
 * bearer (401 at the channel) or the wrong principal. The route tests mock
 * authenticateUser; this file pins the value at its source:
 *   valid Bearer JWT → 'jwt'; no header / non-Bearer / bad Bearer + cookie →
 *   'cookie'; a live nid_ device token → 'device'; an expired / unknown nid_
 *   token next to a valid cookie → 'cookie' (the stale-bearer case the relay
 *   fix depends on), and the device token is then never treated as a JWT win.
 */

const hoisted = vi.hoisted(() => ({
  jwtGetUser: vi.fn(),
  cookieGetUser: vi.fn(),
  getUserById: vi.fn(),
  resolveDeviceToken: vi.fn(),
}))

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }))
vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({ auth: { getUser: hoisted.jwtGetUser } })),
}))
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: hoisted.cookieGetUser } }),
}))
vi.mock('@/lib/supabase/service', () => ({
  getServiceClient: () => ({ auth: { admin: { getUserById: hoisted.getUserById } } }),
}))
vi.mock('@/lib/device-tokens', () => ({
  isDeviceToken: (t: string) => t.startsWith('nid_'),
  resolveDeviceToken: hoisted.resolveDeviceToken,
}))

const { authenticateUser } = await import('@/lib/ai/auth')

function request(authHeader?: string): Request {
  const headers = new Headers()
  if (authHeader) headers.set('authorization', authHeader)
  return new Request('https://nativeintelligence.dev/api/device/ask', { method: 'POST', headers })
}

const DEVICE_OWNER = { id: 'u-device' }
const COOKIE_USER = { id: 'u-cookie' }
const JWT_USER = { id: 'u-jwt' }

beforeEach(() => {
  hoisted.jwtGetUser.mockReset()
  hoisted.cookieGetUser.mockReset()
  hoisted.getUserById.mockReset()
  hoisted.resolveDeviceToken.mockReset()
  // Defaults: the cookie is valid; a JWT is not; device tokens resolve only when told to.
  hoisted.cookieGetUser.mockResolvedValue({ data: { user: COOKIE_USER }, error: null })
  hoisted.jwtGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'invalid JWT' } })
  hoisted.resolveDeviceToken.mockResolvedValue(null)
})

describe("authenticateUser — `via` names the credential that authenticated", () => {
  it("a valid Bearer JWT → 'jwt'", async () => {
    hoisted.jwtGetUser.mockResolvedValueOnce({ data: { user: JWT_USER }, error: null })
    const r = await authenticateUser(request('Bearer eyJ.valid.jwt'))
    expect(r.user).toEqual(JWT_USER)
    expect(r.via).toBe('jwt')
  })

  it("no Authorization header → 'cookie'", async () => {
    const r = await authenticateUser(request())
    expect(r.user).toEqual(COOKIE_USER)
    expect(r.via).toBe('cookie')
  })

  it("a non-Bearer Authorization value → 'cookie'", async () => {
    const r = await authenticateUser(request('Basic x'))
    expect(r.via).toBe('cookie')
    expect(hoisted.jwtGetUser).not.toHaveBeenCalled()
  })

  it("an invalid Bearer JWT next to a valid cookie → 'cookie'", async () => {
    const r = await authenticateUser(request('Bearer bad'))
    expect(r.user).toEqual(COOKIE_USER)
    expect(r.via).toBe('cookie')
  })

  it("a live nid_ device token → 'device' (the cookie is never consulted)", async () => {
    hoisted.resolveDeviceToken.mockResolvedValueOnce({ userId: 'u-device', workspaceId: 'ws-1' })
    hoisted.getUserById.mockResolvedValueOnce({ data: { user: DEVICE_OWNER } })
    const r = await authenticateUser(request('Bearer nid_live'))
    expect(hoisted.resolveDeviceToken).toHaveBeenCalledWith('nid_live')
    expect(hoisted.getUserById).toHaveBeenCalledWith('u-device')
    expect(r.user).toEqual(DEVICE_OWNER)
    expect(r.via).toBe('device')
    expect(hoisted.cookieGetUser).not.toHaveBeenCalled()
  })

  it("an expired / unknown nid_ token next to a valid cookie → 'cookie' (the stale bearer is NOT the credential to relay)", async () => {
    // resolveDeviceToken → null (expired). The nid_ string then also fails as a JWT.
    const r = await authenticateUser(request('Bearer nid_expired'))
    expect(r.user).toEqual(COOKIE_USER)
    expect(r.via).toBe('cookie')
  })

  it("a live nid_ token whose owner no longer exists falls through → 'cookie'", async () => {
    hoisted.resolveDeviceToken.mockResolvedValueOnce({ userId: 'u-gone', workspaceId: 'ws-1' })
    hoisted.getUserById.mockResolvedValueOnce({ data: { user: null } })
    const r = await authenticateUser(request('Bearer nid_orphan'))
    expect(r.via).toBe('cookie')
  })

  it('throws a 401 Response when nothing authenticates', async () => {
    hoisted.cookieGetUser.mockResolvedValueOnce({ data: { user: null }, error: { message: 'no session' } })
    const err = await authenticateUser(request('Bearer nid_expired')).catch((e) => e)
    expect(err).toBeInstanceOf(Response)
    expect((err as Response).status).toBe(401)
  })
})
