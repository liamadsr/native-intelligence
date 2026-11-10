import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Tests for src/lib/workspace.ts.
 *
 * The key behavior to lock in: resolution order is
 *   header (WORKSPACE_HEADER) > cookie (WORKSPACE_COOKIE) > first membership
 *
 * When a header or cookie claims a workspace, we MUST verify membership
 * before trusting it — otherwise a malicious client could read another
 * workspace's data by spoofing the header. This test file guards that.
 */

const hoisted = vi.hoisted(() => ({
  // workspace_merge lookup on a membership miss (.eq source .maybeSingle)
  mergeLookup: vi.fn(async (_args?: unknown) => ({ data: null as unknown, error: null as unknown })),
  cookies: {} as Record<string, string>,
  headers: {} as Record<string, string>,
  // Cookie-client auth.getUser() (browser session).
  getUser: vi.fn(),
  memberLookup: vi.fn(),
  firstMembership: vi.fn(),
  // Authorization header (null = browser request; string to simulate desktop).
  authHeader: null as string | null,
  // Token-bound client's auth.getUser(token) — the Bearer-JWT resolver.
  tokenGetUser: vi.fn(
    async () => ({ data: { user: null as unknown }, error: null })
  ),
  // Captures the options passed to the token-bound createClient so tests can
  // structurally assert the Authorization header (unit tests can't run RLS).
  tokenClientOptions: null as unknown,
  // Which client ran the membership query: 'cookie' | 'token'. Lets us assert
  // that a Bearer-resolved user's queries run on the token-bound client.
  memberQueryClient: null as null | string,
  // Opaque device-token resolution: the token hash, its expiry, and the
  // pinned workspace's ownership are all verified inside device-tokens.ts.
  resolveDeviceToken: vi.fn(async (_token: string) => null as unknown),
  // Service-role re-check that the token's owner is still in the pinned
  // workspace (device-tokens.ts isDeviceWorkspaceMember). Defaults to a member.
  isDeviceWorkspaceMember: vi.fn(async (_userId: string, _workspaceId: string) => true),
}))

// Shared `.from('member')` query builder used by BOTH the cookie client and
// the token-bound client, tagged with which client it belongs to so tests can
// assert the query ran on the right one.
function memberFrom(clientTag: string) {
  return (_table: string) => ({
    select: () => ({
      eq: (col1: string, val1: string) => ({
        // workspace_merge on a miss: .eq(source).maybeSingle()
        maybeSingle: () => hoisted.mergeLookup({ col1, val1 }),
        // Path 1: .eq(...).eq(...).maybeSingle() — membership verification
        eq: (col2: string, val2: string) => {
          hoisted.memberQueryClient = clientTag
          return {
            maybeSingle: () => hoisted.memberLookup({ col1, val1, col2, val2 }),
          }
        },
        // Path 2: .eq(...).order(...).limit(1).maybeSingle() — deterministic
        // first-membership fallback (ordered by created_at so resolution can't
        // flap between rows across requests)
        order: () => ({
          limit: () => ({
            maybeSingle: () => {
              hoisted.memberQueryClient = clientTag
              return hoisted.firstMembership({ col1, val1 })
            },
          }),
        }),
      }),
    }),
  })
}

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      name in hoisted.cookies ? { name, value: hoisted.cookies[name] } : undefined,
  }),
  headers: async () => ({
    get: (name: string) =>
      name.toLowerCase() === 'authorization'
        ? hoisted.authHeader
        : (hoisted.headers[name.toLowerCase()] ?? null),
  }),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      getUser: hoisted.getUser,
    },
    from: memberFrom('cookie'),
  }),
}))

// Token-bound anon client built by resolveUser for the Bearer-JWT path.
vi.mock('@supabase/supabase-js', () => ({
  createClient: (_url: string, _key: string, options: unknown) => {
    hoisted.tokenClientOptions = options
    return {
      auth: { getUser: hoisted.tokenGetUser },
      from: memberFrom('token'),
    }
  },
}))

vi.mock('@/lib/device-tokens', () => ({
  isDeviceToken: (token: string) => token.startsWith('nid_'),
  resolveDeviceToken: (token: string) => hoisted.resolveDeviceToken(token),
  isDeviceWorkspaceMember: (userId: string, workspaceId: string) =>
    hoisted.isDeviceWorkspaceMember(userId, workspaceId),
}))

const {
  getCurrentWorkspaceId,
  getCurrentWorkspaceIdSafe,
  getCurrentWorkspaceIdOrResponse,
  requireWorkspaceId,
  WORKSPACE_COOKIE,
  WORKSPACE_HEADER,
} = await import('@/lib/workspace')

beforeEach(() => {
  hoisted.mergeLookup.mockReset().mockResolvedValue({ data: null, error: null })
  hoisted.cookies = {}
  hoisted.headers = {}
  hoisted.authHeader = null
  hoisted.getUser.mockReset()
  hoisted.memberLookup.mockReset()
  hoisted.firstMembership.mockReset()
  hoisted.tokenGetUser.mockReset()
  hoisted.tokenGetUser.mockResolvedValue({ data: { user: null }, error: null })
  hoisted.tokenClientOptions = null
  hoisted.memberQueryClient = null
  hoisted.isDeviceWorkspaceMember.mockReset().mockResolvedValue(true)
  hoisted.resolveDeviceToken.mockReset()
  hoisted.resolveDeviceToken.mockResolvedValue(null)
})

describe('getCurrentWorkspaceId', () => {
  it('returns null when the user is not authenticated', async () => {
    hoisted.getUser.mockResolvedValueOnce({ data: { user: null } })
    const result = await getCurrentWorkspaceId()
    expect(result).toBeNull()
  })

  it('uses cookie value when no header is present and verifies membership', async () => {
    hoisted.cookies[WORKSPACE_COOKIE] = 'w-cookie'
    hoisted.getUser.mockResolvedValueOnce({ data: { user: { id: 'u1' } } })
    hoisted.memberLookup.mockResolvedValueOnce({
      data: { workspace_id: 'w-cookie' },
      error: null,
    })

    const result = await getCurrentWorkspaceId()
    expect(result).toBe('w-cookie')
    expect(hoisted.memberLookup).toHaveBeenCalledOnce()
  })

  it('prefers header over cookie when both are present', async () => {
    hoisted.cookies[WORKSPACE_COOKIE] = 'w-cookie'
    hoisted.headers[WORKSPACE_HEADER.toLowerCase()] = 'w-header'
    hoisted.getUser.mockResolvedValueOnce({ data: { user: { id: 'u1' } } })
    hoisted.memberLookup.mockResolvedValueOnce({
      data: { workspace_id: 'w-header' },
      error: null,
    })

    const result = await getCurrentWorkspaceId()
    expect(result).toBe('w-header')

    // Verify the membership lookup used the header value, not the cookie
    const call = hoisted.memberLookup.mock.calls[0][0]
    expect(call.val2).toBe('w-header')
  })

  it('falls back to first membership when claimed workspace is not owned by user', async () => {
    // Security-critical: spoofed header must NOT leak data.
    hoisted.headers[WORKSPACE_HEADER.toLowerCase()] = 'w-spoofed'
    hoisted.getUser.mockResolvedValueOnce({ data: { user: { id: 'u1' } } })
    // User is NOT a member of the spoofed workspace
    hoisted.memberLookup.mockResolvedValueOnce({ data: null, error: null })
    // But they are a member of some workspace
    hoisted.firstMembership.mockResolvedValueOnce({
      data: { workspace_id: 'w-real' },
      error: null,
    })

    const result = await getCurrentWorkspaceId()
    expect(result).toBe('w-real')
  })

  it('a header naming a workspace that was merged away resolves to the destination, not the oldest workspace', async () => {
    hoisted.headers[WORKSPACE_HEADER.toLowerCase()] = 'w-merged-away'
    hoisted.getUser.mockResolvedValueOnce({ data: { user: { id: 'u1' } } })
    hoisted.memberLookup
      .mockResolvedValueOnce({ data: null, error: null }) // not a member of the gone workspace
      .mockResolvedValueOnce({ data: { workspace_id: 'w-dest' }, error: null }) // a member of where it went
    hoisted.mergeLookup.mockResolvedValueOnce({ data: { destination_workspace_id: 'w-dest' }, error: null })
    hoisted.firstMembership.mockResolvedValueOnce({ data: { workspace_id: 'w-oldest' }, error: null })

    expect(await getCurrentWorkspaceId()).toBe('w-dest')
    expect(hoisted.mergeLookup).toHaveBeenCalledWith({ col1: 'source_workspace_id', val1: 'w-merged-away' })
    expect(hoisted.firstMembership).not.toHaveBeenCalled()
  })

  it('a merged-away workspace whose destination the person is not in still falls back to the first membership', async () => {
    hoisted.headers[WORKSPACE_HEADER.toLowerCase()] = 'w-merged-away'
    hoisted.getUser.mockResolvedValueOnce({ data: { user: { id: 'u1' } } })
    hoisted.memberLookup.mockResolvedValueOnce({ data: null, error: null })
    hoisted.mergeLookup.mockResolvedValueOnce({ data: null, error: null }) // RLS: not a destination member → no record
    hoisted.firstMembership.mockResolvedValueOnce({ data: { workspace_id: 'w-real' }, error: null })

    expect(await getCurrentWorkspaceId()).toBe('w-real')
  })

  it('falls back to first membership when no header/cookie is set', async () => {
    hoisted.getUser.mockResolvedValueOnce({ data: { user: { id: 'u1' } } })
    hoisted.firstMembership.mockResolvedValueOnce({
      data: { workspace_id: 'w-first' },
      error: null,
    })

    const result = await getCurrentWorkspaceId()
    expect(result).toBe('w-first')
    expect(hoisted.memberLookup).not.toHaveBeenCalled()
  })

  it('returns null when user has no memberships at all', async () => {
    hoisted.getUser.mockResolvedValueOnce({ data: { user: { id: 'u1' } } })
    hoisted.firstMembership.mockResolvedValueOnce({ data: null, error: null })

    const result = await getCurrentWorkspaceId()
    expect(result).toBeNull()
  })

  it('resolves via a Bearer JWT and runs the member query on the token-bound client', async () => {
    // Half-expired session: no cookie user, but a live Supabase access token.
    hoisted.getUser.mockResolvedValueOnce({ data: { user: null } })
    hoisted.authHeader = 'Bearer header.jwt.token'
    hoisted.tokenGetUser.mockResolvedValueOnce({
      data: { user: { id: 'u-bearer' } },
      error: null,
    })
    hoisted.firstMembership.mockResolvedValueOnce({
      data: { workspace_id: 'w-bearer' },
      error: null,
    })

    const result = await getCurrentWorkspaceId()
    expect(result).toBe('w-bearer')
    // The token was validated by the token-bound client...
    expect(hoisted.tokenGetUser).toHaveBeenCalledWith('header.jwt.token')
    // ...and the membership query ran on THAT client (RLS as the user), not
    // the anonymous cookie client — the crux of the "No workspace" fix.
    expect(hoisted.memberQueryClient).toBe('token')
    // Structurally assert the client carries the Authorization header AND the
    // timer-killing auth options (per-request client must not leak a permanent
    // auto-refresh interval).
    expect(hoisted.tokenClientOptions).toMatchObject({
      global: { headers: { Authorization: 'Bearer header.jwt.token' } },
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    })
  })

  it('does not attempt a Bearer client for an opaque device token', async () => {
    // Device tokens are not JWTs — resolveUser bails to null here (device
    // callers pin the workspace via api-auth, not via this cookie/RLS path).
    hoisted.getUser.mockResolvedValueOnce({ data: { user: null } })
    hoisted.authHeader = 'Bearer nid_opaque_secret'

    const result = await getCurrentWorkspaceId()
    expect(result).toBeNull()
    expect(hoisted.tokenGetUser).not.toHaveBeenCalled()
    expect(hoisted.tokenClientOptions).toBeNull()
  })

  it('throws a generic error (no upstream text) when a membership query errors', async () => {
    // Error honesty: a transient DB error must not be misread as "no workspace".
    // Info disclosure: the thrown message must NOT embed the raw DB text.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    hoisted.getUser.mockResolvedValueOnce({ data: { user: { id: 'u1' } } })
    hoisted.firstMembership.mockResolvedValueOnce({
      data: null,
      error: { message: 'permission denied for table member' },
    })

    const thrown = await getCurrentWorkspaceId().then(
      () => null,
      (e: Error) => e
    )
    expect(thrown).toBeInstanceOf(Error)
    // Exact message carries no upstream DB text — just the generic string.
    expect((thrown as Error).message).toBe('Membership query failed')
    expect((thrown as Error).message).not.toContain('permission denied')
    // ...but the raw error IS logged server-side.
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it('throws a generic error when the claimed-workspace verify query errors', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    hoisted.cookies[WORKSPACE_COOKIE] = 'w-cookie'
    hoisted.getUser.mockResolvedValueOnce({ data: { user: { id: 'u1' } } })
    hoisted.memberLookup.mockResolvedValueOnce({
      data: null,
      error: { message: 'deadlock detected' },
    })

    await expect(getCurrentWorkspaceId()).rejects.toThrow('Membership query failed')
    errSpy.mockRestore()
  })

  it("throws 'Session expired' (not the generic message) on an expired-JWT (PGRST303) first-membership error", async () => {
    // Half-expired session: the token-bound query is rejected with PGRST303.
    // 'Session expired' is safe to leak (no DB internals), so the ~20 legacy
    // callers that echo error.message into their 500 body return an honest
    // string rather than "Membership query failed".
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    hoisted.getUser.mockResolvedValueOnce({ data: { user: { id: 'u1' } } })
    hoisted.firstMembership.mockResolvedValueOnce({
      data: null,
      error: { code: 'PGRST303', message: 'JWT expired' },
    })

    await expect(getCurrentWorkspaceId()).rejects.toThrow('Session expired')
    errSpy.mockRestore()
  })

  it("throws 'Session expired' on an expired-JWT claimed-workspace verify error", async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    hoisted.cookies[WORKSPACE_COOKIE] = 'w-cookie'
    hoisted.getUser.mockResolvedValueOnce({ data: { user: { id: 'u1' } } })
    hoisted.memberLookup.mockResolvedValueOnce({
      data: null,
      error: { code: 'PGRST303', message: 'JWT expired' },
    })

    await expect(getCurrentWorkspaceId()).rejects.toThrow('Session expired')
    errSpy.mockRestore()
  })
})

describe('getCurrentWorkspaceId — device tokens', () => {
  /**
   * A device token (`nid_…`) is opaque, not a JWT, so `resolveUser` can bind
   * no client to it and returns null — and a server-to-server caller (the eval
   * run driver, the desktop app's headless calls) carries no cookie session
   * either. Without the device branch every such request resolves to null and
   * the route 400s "No workspace" before reading anything.
   */
  it('resolves the workspace a device token is pinned to, with no session at all', async () => {
    hoisted.authHeader = 'Bearer nid_devicetoken'
    hoisted.resolveDeviceToken.mockResolvedValueOnce({
      userId: 'u-device',
      workspaceId: 'w-pinned',
    })
    // No cookie user and no Bearer JWT: this is the server-to-server shape.
    hoisted.getUser.mockResolvedValue({ data: { user: null } })

    expect(await getCurrentWorkspaceId()).toBe('w-pinned')
    // The pin is the answer once its member row is re-checked (service-role,
    // fenced on the token's user); no cookie-client membership query is made.
    expect(hoisted.isDeviceWorkspaceMember).toHaveBeenCalledWith('u-device', 'w-pinned')
    expect(hoisted.memberLookup).not.toHaveBeenCalled()
    expect(hoisted.firstMembership).not.toHaveBeenCalled()
  })

  it('resolves no workspace for a stale pin (owner removed from the workspace since)', async () => {
    hoisted.authHeader = 'Bearer nid_devicetoken'
    hoisted.resolveDeviceToken.mockResolvedValueOnce({
      userId: 'u-device',
      workspaceId: 'w-left',
    })
    hoisted.isDeviceWorkspaceMember.mockResolvedValueOnce(false)
    hoisted.getUser.mockResolvedValue({ data: { user: null } })

    expect(await getCurrentWorkspaceId()).toBeNull()
  })

  it('throws (a 500, not a false answer) when the pinned-membership check errors', async () => {
    hoisted.authHeader = 'Bearer nid_devicetoken'
    hoisted.resolveDeviceToken.mockResolvedValueOnce({
      userId: 'u-device',
      workspaceId: 'w-pinned',
    })
    hoisted.isDeviceWorkspaceMember.mockRejectedValueOnce(new Error('db down'))
    hoisted.getUser.mockResolvedValue({ data: { user: null } })

    await expect(getCurrentWorkspaceId()).rejects.toMatchObject({
      name: 'WorkspaceLookupError',
      kind: 'query_failed',
    })
  })

  /**
   * THE SECURITY RULE. The pin is the only membership check a device call
   * gets, so honouring `x-workspace-id` here would let anyone holding a device
   * token read a workspace it was never issued for.
   */
  it('ignores a spoofed workspace header and returns the pin instead', async () => {
    hoisted.authHeader = 'Bearer nid_devicetoken'
    hoisted.headers[WORKSPACE_HEADER.toLowerCase()] = 'w-someone-elses'
    hoisted.cookies[WORKSPACE_COOKIE] = 'w-also-not-this'
    hoisted.resolveDeviceToken.mockResolvedValueOnce({
      userId: 'u-device',
      workspaceId: 'w-pinned',
    })
    hoisted.getUser.mockResolvedValue({ data: { user: null } })

    expect(await getCurrentWorkspaceId()).toBe('w-pinned')
    expect(hoisted.memberLookup).not.toHaveBeenCalled()
  })

  it('falls through to the normal path for an expired or unknown device token', async () => {
    hoisted.authHeader = 'Bearer nid_revoked'
    hoisted.resolveDeviceToken.mockResolvedValueOnce(null)
    hoisted.getUser.mockResolvedValueOnce({ data: { user: null } })

    // No pin and no session — null, not a crash and not someone's workspace.
    expect(await getCurrentWorkspaceId()).toBeNull()
  })

  it('leaves a browser session untouched — no device lookup is attempted', async () => {
    hoisted.cookies[WORKSPACE_COOKIE] = 'w-cookie'
    hoisted.getUser.mockResolvedValueOnce({ data: { user: { id: 'u1' } } })
    hoisted.memberLookup.mockResolvedValueOnce({
      data: { workspace_id: 'w-cookie' },
      error: null,
    })

    expect(await getCurrentWorkspaceId()).toBe('w-cookie')
    expect(hoisted.resolveDeviceToken).not.toHaveBeenCalled()
  })

  it('does not treat a Supabase Bearer JWT as a device token', async () => {
    hoisted.authHeader = 'Bearer eyJhbGciOiJIUzI1NiJ9.fake.jwt'
    hoisted.cookies[WORKSPACE_COOKIE] = 'w-cookie'
    hoisted.getUser.mockResolvedValueOnce({ data: { user: null } })
    hoisted.tokenGetUser.mockResolvedValueOnce({
      data: { user: { id: 'u-jwt' } },
      error: null,
    })
    hoisted.memberLookup.mockResolvedValueOnce({
      data: { workspace_id: 'w-cookie' },
      error: null,
    })

    expect(await getCurrentWorkspaceId()).toBe('w-cookie')
    expect(hoisted.resolveDeviceToken).not.toHaveBeenCalled()
    // And it still runs its membership query on the token-bound client.
    expect(hoisted.memberQueryClient).toBe('token')
  })
})


describe('getCurrentWorkspaceIdSafe', () => {
  it('returns the id when getCurrentWorkspaceId resolves', async () => {
    hoisted.getUser.mockResolvedValueOnce({ data: { user: { id: 'u1' } } })
    hoisted.firstMembership.mockResolvedValueOnce({
      data: { workspace_id: 'w-ok' },
      error: null,
    })

    await expect(getCurrentWorkspaceIdSafe()).resolves.toBe('w-ok')
  })

  it('degrades to null (does NOT throw) on a membership query error', async () => {
    // The whole point: a transient DB error in a server-component render path
    // must not escalate to global-error.tsx and blank the dashboard. The Safe
    // variant swallows the throw, logs, and returns null (call sites handle it).
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    hoisted.getUser.mockResolvedValueOnce({ data: { user: { id: 'u1' } } })
    hoisted.firstMembership.mockResolvedValueOnce({
      data: null,
      error: { message: 'connection pool exhausted' },
    })

    await expect(getCurrentWorkspaceIdSafe()).resolves.toBeNull()
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it('returns null (not a throw) when the user is unauthenticated', async () => {
    hoisted.getUser.mockResolvedValueOnce({ data: { user: null } })
    await expect(getCurrentWorkspaceIdSafe()).resolves.toBeNull()
  })
})

describe('getCurrentWorkspaceIdOrResponse', () => {
  it('passes through the id (and null) like getCurrentWorkspaceId', async () => {
    hoisted.getUser.mockResolvedValueOnce({ data: { user: { id: 'u1' } } })
    hoisted.firstMembership.mockResolvedValueOnce({
      data: { workspace_id: 'w-ok' },
      error: null,
    })
    await expect(getCurrentWorkspaceIdOrResponse()).resolves.toBe('w-ok')

    hoisted.getUser.mockResolvedValueOnce({ data: { user: null } })
    await expect(getCurrentWorkspaceIdOrResponse()).resolves.toBeNull()
  })

  it('maps an expired-JWT lookup failure to a 401 SESSION_EXPIRED Response', async () => {
    // The half-expired-session case previously escaped legacy routes as an
    // unhandled 500 (Sentry noise, and no signal for the client to refresh).
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    hoisted.getUser.mockResolvedValueOnce({ data: { user: { id: 'u1' } } })
    hoisted.firstMembership.mockResolvedValueOnce({
      data: null,
      error: { code: 'PGRST303', message: 'JWT expired' },
    })

    const result = await getCurrentWorkspaceIdOrResponse()
    expect(result).toBeInstanceOf(Response)
    expect((result as Response).status).toBe(401)
    await expect((result as Response).json()).resolves.toMatchObject({
      code: 'SESSION_EXPIRED',
    })
    errSpy.mockRestore()
  })

  it('maps a transient membership query failure to a clean 500 Response', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    hoisted.getUser.mockResolvedValueOnce({ data: { user: { id: 'u1' } } })
    hoisted.firstMembership.mockResolvedValueOnce({
      data: null,
      error: { message: 'permission denied for table member' },
    })

    const result = await getCurrentWorkspaceIdOrResponse()
    expect(result).toBeInstanceOf(Response)
    expect((result as Response).status).toBe(500)
    // Generic body — no upstream DB text.
    const body = await (result as Response).json()
    expect(body.error).toBe('Membership query failed')
    expect(JSON.stringify(body)).not.toContain('permission denied')
    errSpy.mockRestore()
  })
})

describe('requireWorkspaceId', () => {
  it('throws when no workspace can be resolved', async () => {
    hoisted.getUser.mockResolvedValueOnce({ data: { user: null } })
    await expect(requireWorkspaceId()).rejects.toThrow('No workspace found')
  })

  it('returns the id when resolved', async () => {
    hoisted.getUser.mockResolvedValueOnce({ data: { user: { id: 'u1' } } })
    hoisted.firstMembership.mockResolvedValueOnce({
      data: { workspace_id: 'w-ok' },
      error: null,
    })

    await expect(requireWorkspaceId()).resolves.toBe('w-ok')
  })
})
