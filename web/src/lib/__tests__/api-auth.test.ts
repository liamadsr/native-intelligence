import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Tests for src/lib/api-auth.ts.
 *
 * These tests lock in the three-layer guard pattern: user -> workspace ->
 * membership. Any future refactor must preserve:
 *   - 401 shape when there is no user
 *   - 400 NO_WORKSPACE shape when there is a user but no workspace
 *   - 403 NOT_MEMBER shape when the user isn't a member of the workspace
 * so that the ~230 API routes that depend on these helpers stay consistent.
 *
 * Workspace + membership now resolve in a single member query (header >
 * cookie > first membership), so the mocks model the two query shapes:
 *   - .select().eq().eq().maybeSingle()    — claimed-workspace verification
 *   - .select().eq().limit().maybeSingle() — first-membership fallback
 */

// Hoisted mock holders so vi.mock callbacks can see them.
const hoisted = vi.hoisted(() => {
  return {
    getUser: vi.fn(),
    // workspace_merge lookup on a membership miss (.eq source .maybeSingle)
    mergeLookup: vi.fn(async () => ({ data: null as unknown, error: null as unknown })),
    // Claimed-workspace membership lookup (.eq user .eq workspace .maybeSingle)
    candidateLookup: vi.fn(
      async () => ({ data: null as unknown, error: null as unknown })
    ),
    // First-membership fallback (.eq user .limit(1) .maybeSingle)
    firstMembership: vi.fn(
      async () => ({ data: null as unknown, error: null as unknown })
    ),
    // Cookie jar returned by the mocked next/headers cookies().
    cookies: {} as Record<string, string>,
    // Authorization header returned by the mocked next/headers store.
    // null = browser request (no header); set a string to simulate a device.
    authHeader: null as string | null,
    // Bearer-token user resolution (token-bound client). Defaults to no user.
    tokenGetUser: vi.fn(
      async () =>
        ({ data: { user: null as unknown }, error: null }) as {
          data: { user: unknown }
          error: unknown
        }
    ),
    // Captures the options passed to the token-bound createClient so tests can
    // structurally assert the Authorization header (unit tests can't run RLS).
    tokenClientOptions: null as unknown,
    // Which client ran the membership query: 'cookie' | 'token'. Lets us assert
    // that a Bearer-resolved user's queries run on the token-bound client.
    memberQueryClient: null as null | string,
    // Device-token resolution — null = not a device token / invalid.
    resolveDeviceToken: vi.fn(
      async () => null as null | { userId: string; workspaceId: string }
    ),
  }
})

// Shared `.from('member')` query builder used by BOTH the cookie client and
// the token-bound client, tagged with which client it belongs to so tests can
// assert the query ran on the right one.
function memberFrom(clientTag: string) {
  return (_table: string) => ({
    select: () => ({
      eq: () => ({
        // workspace_merge on a miss: .eq(source).maybeSingle()
        maybeSingle: async () => hoisted.mergeLookup(),
        eq: () => ({
          maybeSingle: async () => {
            hoisted.memberQueryClient = clientTag
            return hoisted.candidateLookup()
          },
        }),
        // Deterministic first-membership fallback: .order().limit().maybeSingle()
        order: () => ({
          limit: () => ({
            maybeSingle: async () => {
              hoisted.memberQueryClient = clientTag
              return hoisted.firstMembership()
            },
          }),
        }),
      }),
    }),
  })
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      getUser: hoisted.getUser,
    },
    from: memberFrom('cookie'),
  }),
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: (_url: string, _key: string, options: unknown) => {
    hoisted.tokenClientOptions = options
    return {
      auth: { getUser: hoisted.tokenGetUser },
      from: memberFrom('token'),
    }
  },
}))

vi.mock('next/headers', () => ({
  headers: async () => ({
    get: (name: string) =>
      name.toLowerCase() === 'authorization' ? hoisted.authHeader : null,
  }),
  cookies: async () => ({
    get: (name: string) =>
      name in hoisted.cookies
        ? { name, value: hoisted.cookies[name] }
        : undefined,
  }),
}))

// The real module (followWorkspaceMerges runs against the mocked query builders above); only the names are pinned.
vi.mock('@/lib/workspace', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspace')>()),
  WORKSPACE_COOKIE: 'workspace_id',
  WORKSPACE_HEADER: 'x-workspace-id',
}))

vi.mock('@/lib/device-tokens', () => ({
  isDeviceToken: (token: string) => token.startsWith('nid_'),
  resolveDeviceToken: hoisted.resolveDeviceToken,
}))

const { requireUser, requireWorkspace, requireWorkspaceMember } = await import(
  '@/lib/api-auth'
)

beforeEach(() => {
  hoisted.mergeLookup.mockReset().mockResolvedValue({ data: null, error: null })
  hoisted.getUser.mockReset()
  hoisted.candidateLookup.mockReset()
  hoisted.candidateLookup.mockResolvedValue({ data: null, error: null })
  hoisted.firstMembership.mockReset()
  hoisted.firstMembership.mockResolvedValue({ data: null, error: null })
  hoisted.cookies = {}
  hoisted.authHeader = null
  hoisted.tokenGetUser.mockReset()
  hoisted.tokenGetUser.mockResolvedValue({ data: { user: null }, error: null })
  hoisted.tokenClientOptions = null
  hoisted.memberQueryClient = null
  hoisted.resolveDeviceToken.mockReset()
  hoisted.resolveDeviceToken.mockResolvedValue(null)
})

describe('requireUser', () => {
  it('returns 401 when there is no authenticated user', async () => {
    hoisted.getUser.mockResolvedValueOnce({ data: { user: null }, error: null })
    const result = await requireUser()
    expect(result).toBeInstanceOf(Response)
    const res = result as Response
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.code).toBe('UNAUTHORIZED')
  })

  it('returns { supabase, user } when authenticated', async () => {
    const user = { id: 'u1', email: 'a@b.com' }
    hoisted.getUser.mockResolvedValueOnce({ data: { user }, error: null })
    const result = await requireUser()
    expect(result).not.toBeInstanceOf(Response)
    expect((result as { user: typeof user }).user).toEqual(user)
  })

  it('falls back to a Bearer token when there is no cookie session', async () => {
    // No cookie user...
    hoisted.getUser.mockResolvedValueOnce({ data: { user: null }, error: null })
    // ...but a valid Authorization header that resolves to a user.
    const user = { id: 'device-user', email: 'device@b.com' }
    hoisted.authHeader = 'Bearer abc.def.ghi'
    hoisted.tokenGetUser.mockResolvedValueOnce({ data: { user }, error: null })

    const result = await requireUser()
    expect(result).not.toBeInstanceOf(Response)
    expect((result as { user: typeof user }).user).toEqual(user)
    expect(hoisted.tokenGetUser).toHaveBeenCalledWith('abc.def.ghi')
  })

  it('binds the returned client to the Bearer token (RLS runs as the user)', async () => {
    // The crux of the fix: a Bearer-resolved user must get a token-bound
    // client, NOT the anonymous cookie client, so downstream RLS queries run
    // as them. Structurally assert the constructed client carries the header.
    hoisted.getUser.mockResolvedValueOnce({ data: { user: null }, error: null })
    hoisted.authHeader = 'Bearer eyJ.header.sig'
    hoisted.tokenGetUser.mockResolvedValueOnce({
      data: { user: { id: 'u-bearer' } },
      error: null,
    })

    const result = await requireUser()
    expect(result).not.toBeInstanceOf(Response)
    expect(hoisted.tokenClientOptions).toMatchObject({
      global: { headers: { Authorization: 'Bearer eyJ.header.sig' } },
    })
  })

  it('disables session persistence / auto-refresh on the token-bound client', async () => {
    // The per-request token client is discarded immediately; leaving the
    // default auto-refresh on would leak a permanent 30s interval timer per
    // Bearer request. Structurally assert the timer-killing auth options.
    hoisted.getUser.mockResolvedValueOnce({ data: { user: null }, error: null })
    hoisted.authHeader = 'Bearer eyJ.header.sig'
    hoisted.tokenGetUser.mockResolvedValueOnce({
      data: { user: { id: 'u-bearer' } },
      error: null,
    })

    await requireUser()
    expect(hoisted.tokenClientOptions).toMatchObject({
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    })
  })

  it('returns 401 when the Bearer token is invalid', async () => {
    hoisted.getUser.mockResolvedValueOnce({ data: { user: null }, error: null })
    hoisted.authHeader = 'Bearer not-a-real-token'
    hoisted.tokenGetUser.mockResolvedValueOnce({ data: { user: null }, error: null })

    const result = await requireUser()
    expect(result).toBeInstanceOf(Response)
    expect((result as Response).status).toBe(401)
  })
})

describe('requireWorkspace', () => {
  it('propagates the 401 from requireUser when unauthenticated', async () => {
    hoisted.getUser.mockResolvedValueOnce({ data: { user: null }, error: null })
    const result = await requireWorkspace()
    expect(result).toBeInstanceOf(Response)
    expect((result as Response).status).toBe(401)
  })

  it('returns 400 NO_WORKSPACE when user exists but has no memberships', async () => {
    hoisted.getUser.mockResolvedValueOnce({
      data: { user: { id: 'u1' } },
      error: null,
    })
    // No cookie/header claim, and no membership rows at all.
    hoisted.firstMembership.mockResolvedValueOnce({ data: null, error: null })

    const result = await requireWorkspace()
    expect(result).toBeInstanceOf(Response)
    const res = result as Response
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe('NO_WORKSPACE')
  })

  it('returns the workspaceId from a verified cookie claim', async () => {
    hoisted.getUser.mockResolvedValueOnce({
      data: { user: { id: 'u1' } },
      error: null,
    })
    hoisted.cookies['workspace_id'] = 'w1'
    hoisted.candidateLookup.mockResolvedValueOnce({
      data: { workspace_id: 'w1', id: 'm1' },
      error: null,
    })

    const result = await requireWorkspace()
    expect(result).not.toBeInstanceOf(Response)
    const ctx = result as { workspaceId: string; user: { id: string } }
    expect(ctx.workspaceId).toBe('w1')
    expect(ctx.user.id).toBe('u1')
  })

  it('falls back to first membership when the claimed workspace is not joined', async () => {
    hoisted.getUser.mockResolvedValueOnce({
      data: { user: { id: 'u1' } },
      error: null,
    })
    hoisted.cookies['workspace_id'] = 'w-spoofed'
    hoisted.candidateLookup.mockResolvedValueOnce({ data: null, error: null })
    hoisted.firstMembership.mockResolvedValueOnce({
      data: { workspace_id: 'w-mine', id: 'm1' },
      error: null,
    })

    const result = await requireWorkspace()
    expect(result).not.toBeInstanceOf(Response)
    expect((result as { workspaceId: string }).workspaceId).toBe('w-mine')
  })

  it('a cookie naming a workspace that was merged away lands in the destination, not the oldest workspace', async () => {
    hoisted.getUser.mockResolvedValueOnce({ data: { user: { id: 'u1' } }, error: null })
    hoisted.cookies['workspace_id'] = 'w-merged-away'
    hoisted.candidateLookup
      .mockResolvedValueOnce({ data: null, error: null }) // not a member of the gone workspace
      .mockResolvedValueOnce({ data: { workspace_id: 'w-dest', id: 'm-dest' }, error: null }) // a member of where it went
    hoisted.mergeLookup.mockResolvedValueOnce({ data: { destination_workspace_id: 'w-dest' }, error: null })
    hoisted.firstMembership.mockResolvedValueOnce({ data: { workspace_id: 'w-oldest', id: 'm0' }, error: null })

    const result = await requireWorkspace()
    expect(result).not.toBeInstanceOf(Response)
    expect((result as { workspaceId: string }).workspaceId).toBe('w-dest')
    expect(hoisted.firstMembership).not.toHaveBeenCalled()
  })

  it('a merged-away workspace whose destination the person is not in still falls back to the first membership', async () => {
    hoisted.getUser.mockResolvedValueOnce({ data: { user: { id: 'u1' } }, error: null })
    hoisted.cookies['workspace_id'] = 'w-merged-away'
    hoisted.candidateLookup.mockResolvedValueOnce({ data: null, error: null })
    hoisted.mergeLookup.mockResolvedValueOnce({ data: null, error: null }) // RLS: not a destination member → no record
    hoisted.firstMembership.mockResolvedValueOnce({ data: { workspace_id: 'w-mine', id: 'm1' }, error: null })

    const result = await requireWorkspace()
    expect((result as { workspaceId: string }).workspaceId).toBe('w-mine')
  })

  it('resolves the workspace for a Bearer-only session on the token-bound client', async () => {
    // The reported bug: half-expired cookie (getUser null) + live Bearer JWT.
    // Before the fix, the member query ran as anon and returned NO_WORKSPACE.
    hoisted.getUser.mockResolvedValueOnce({ data: { user: null }, error: null })
    hoisted.authHeader = 'Bearer eyJ.access.token'
    hoisted.tokenGetUser.mockResolvedValueOnce({
      data: { user: { id: 'u-member' } },
      error: null,
    })
    hoisted.firstMembership.mockResolvedValueOnce({
      data: { workspace_id: 'w-real', id: 'm9' },
      error: null,
    })

    const result = await requireWorkspace()
    expect(result).not.toBeInstanceOf(Response)
    expect((result as { workspaceId: string }).workspaceId).toBe('w-real')
    // The member query MUST have run on the token-bound client (RLS as user).
    expect(hoisted.memberQueryClient).toBe('token')
    expect(hoisted.tokenClientOptions).toMatchObject({
      global: { headers: { Authorization: 'Bearer eyJ.access.token' } },
    })
  })

  it('returns 500 (not NO_WORKSPACE) when the membership query errors', async () => {
    // Error honesty: a transient DB error on the member query must surface as
    // a 500, never as a false "No workspace" for a real member.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    hoisted.getUser.mockResolvedValueOnce({
      data: { user: { id: 'u1' } },
      error: null,
    })
    hoisted.firstMembership.mockResolvedValueOnce({
      data: null,
      error: { message: 'permission denied for table member' },
    })

    const result = await requireWorkspace()
    expect(result).toBeInstanceOf(Response)
    const res = result as Response
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.code).toBe('INTERNAL')
    // Info-disclosure guard: the raw DB message must NOT reach the client...
    expect(JSON.stringify(body)).not.toContain('permission denied')
    // ...but IS logged server-side for observability.
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it('returns 401 SESSION_EXPIRED (not 500) when the membership query hits an expired JWT', async () => {
    // The reported prod bug: a half-expired session hands the token-bound
    // membership query a stale Bearer, PostgREST rejects it with PGRST303. That
    // must be a 401 the client can refresh + retry, NOT a 500.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    hoisted.getUser.mockResolvedValueOnce({
      data: { user: { id: 'u1' } },
      error: null,
    })
    hoisted.firstMembership.mockResolvedValueOnce({
      data: null,
      error: { code: 'PGRST303', message: 'JWT expired' },
    })

    const result = await requireWorkspace()
    expect(result).toBeInstanceOf(Response)
    const res = result as Response
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.code).toBe('SESSION_EXPIRED')
    expect(body.error).toBe('Session expired')
    errSpy.mockRestore()
  })
})

describe('requireWorkspace (device token)', () => {
  it('returns 403 NOT_MEMBER when the device-pinned workspace has no member row', async () => {
    // Removed from w1 after pinning the device to it: the pin alone must not
    // keep the workspace reachable.
    hoisted.getUser.mockResolvedValue({ data: { user: null }, error: null })
    hoisted.authHeader = 'Bearer nid_secret'
    hoisted.resolveDeviceToken.mockResolvedValue({ userId: 'u1', workspaceId: 'w1' })
    hoisted.candidateLookup.mockResolvedValueOnce({ data: null, error: null })

    const result = await requireWorkspace()
    expect(result).toBeInstanceOf(Response)
    const res = result as Response
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe('NOT_MEMBER')
  })

  it('returns the pinned workspace for a member', async () => {
    hoisted.getUser.mockResolvedValue({ data: { user: null }, error: null })
    hoisted.authHeader = 'Bearer nid_secret'
    hoisted.resolveDeviceToken.mockResolvedValue({ userId: 'u1', workspaceId: 'w1' })
    hoisted.candidateLookup.mockResolvedValueOnce({ data: { id: 'm1' }, error: null })

    const result = await requireWorkspace()
    expect(result).not.toBeInstanceOf(Response)
    expect((result as { workspaceId: string }).workspaceId).toBe('w1')
    // Not the cookie client: a device-token request has no Supabase session, so
    // member RLS would hide the row and refuse every member. The check runs on
    // a supabase-js client (service-role in production; mocked here).
    expect(hoisted.memberQueryClient).toBe('token')
  })
})

describe('requireWorkspaceMember', () => {
  it('returns 403 NOT_MEMBER when a device-pinned workspace has no member row', async () => {
    // Device-token auth: no cookie session, Bearer nid_… resolves to a user
    // pinned to workspace w1 — but the member row no longer exists.
    hoisted.getUser.mockResolvedValue({ data: { user: null }, error: null })
    hoisted.authHeader = 'Bearer nid_secret'
    hoisted.resolveDeviceToken.mockResolvedValue({
      userId: 'u1',
      workspaceId: 'w1',
    })
    hoisted.candidateLookup.mockResolvedValueOnce({ data: null, error: null })

    const result = await requireWorkspaceMember()
    expect(result).toBeInstanceOf(Response)
    const res = result as Response
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.code).toBe('NOT_MEMBER')
  })

  it('checks a device-pinned workspace off the cookie client and returns the member row', async () => {
    hoisted.getUser.mockResolvedValue({ data: { user: null }, error: null })
    hoisted.authHeader = 'Bearer nid_secret'
    hoisted.resolveDeviceToken.mockResolvedValue({ userId: 'u1', workspaceId: 'w1' })
    hoisted.candidateLookup.mockResolvedValueOnce({ data: { id: 'm1', role: 'member' }, error: null })

    const result = await requireWorkspaceMember({ select: 'id, role' })
    expect(result).not.toBeInstanceOf(Response)
    const ctx = result as { workspaceId: string; member: { id: string; role: string } }
    expect(ctx.workspaceId).toBe('w1')
    expect(ctx.member).toMatchObject({ id: 'm1', role: 'member' })
    // A device-token request has no Supabase session: the anon cookie client's
    // member RLS would hide the row and 403 every real member. The read runs on
    // a supabase-js client (service-role in production; mocked here).
    expect(hoisted.memberQueryClient).toBe('token')
  })

  it('returns 500 (not NOT_MEMBER) when the device-pinned membership query errors', async () => {
    hoisted.getUser.mockResolvedValue({ data: { user: null }, error: null })
    hoisted.authHeader = 'Bearer nid_secret'
    hoisted.resolveDeviceToken.mockResolvedValue({ userId: 'u1', workspaceId: 'w1' })
    hoisted.candidateLookup.mockResolvedValueOnce({ data: null, error: { message: 'db down' } })

    const result = await requireWorkspaceMember()
    expect(result).toBeInstanceOf(Response)
    expect((result as Response).status).toBe(500)
  })

  it('returns the member row on success', async () => {
    hoisted.getUser.mockResolvedValueOnce({
      data: { user: { id: 'u1' } },
      error: null,
    })
    hoisted.cookies['workspace_id'] = 'w1'
    hoisted.candidateLookup.mockResolvedValueOnce({
      data: { workspace_id: 'w1', id: 'm1', role: 'admin' },
      error: null,
    })

    const result = await requireWorkspaceMember()
    expect(result).not.toBeInstanceOf(Response)
    const ctx = result as {
      workspaceId: string
      member: { id: string; role: string }
    }
    expect(ctx.workspaceId).toBe('w1')
    expect(ctx.member).toMatchObject({ id: 'm1', role: 'admin' })
  })

  it('propagates 401 when unauthenticated', async () => {
    hoisted.getUser.mockResolvedValueOnce({ data: { user: null }, error: null })

    const result = await requireWorkspaceMember()
    expect(result).toBeInstanceOf(Response)
    expect((result as Response).status).toBe(401)
  })

  it('propagates 400 when no workspace', async () => {
    hoisted.getUser.mockResolvedValueOnce({
      data: { user: { id: 'u1' } },
      error: null,
    })
    hoisted.firstMembership.mockResolvedValueOnce({ data: null, error: null })

    const result = await requireWorkspaceMember()
    expect(result).toBeInstanceOf(Response)
    expect((result as Response).status).toBe(400)
  })

  it('returns 500 (not NO_WORKSPACE) when the membership query errors', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    hoisted.getUser.mockResolvedValueOnce({
      data: { user: { id: 'u1' } },
      error: null,
    })
    hoisted.firstMembership.mockResolvedValueOnce({
      data: null,
      error: { message: 'statement timeout' },
    })

    const result = await requireWorkspaceMember()
    expect(result).toBeInstanceOf(Response)
    const res = result as Response
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.code).toBe('INTERNAL')
    // Raw DB text must not leak; it is logged server-side instead.
    expect(JSON.stringify(body)).not.toContain('statement timeout')
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it('returns 401 SESSION_EXPIRED (not 500) when the membership query hits an expired JWT', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    hoisted.getUser.mockResolvedValueOnce({
      data: { user: { id: 'u1' } },
      error: null,
    })
    hoisted.firstMembership.mockResolvedValueOnce({
      data: null,
      error: { code: 'PGRST303', message: 'JWT expired' },
    })

    const result = await requireWorkspaceMember()
    expect(result).toBeInstanceOf(Response)
    const res = result as Response
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.code).toBe('SESSION_EXPIRED')
    expect(body.error).toBe('Session expired')
    errSpy.mockRestore()
  })

  it('detects an expired JWT by message text even without the PGRST303 code', async () => {
    // Belt-and-suspenders: a proxied/older error may carry "JWT expired" text
    // but no code. It must still map to SESSION_EXPIRED, not INTERNAL.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    hoisted.getUser.mockResolvedValueOnce({
      data: { user: { id: 'u1' } },
      error: null,
    })
    hoisted.firstMembership.mockResolvedValueOnce({
      data: null,
      error: { message: 'JWT expired' },
    })

    const result = await requireWorkspaceMember()
    expect((result as Response).status).toBe(401)
    const body = await (result as Response).json()
    expect(body.code).toBe('SESSION_EXPIRED')
    errSpy.mockRestore()
  })
})
