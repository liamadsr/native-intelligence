import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { UnauthenticatedError } from 'eve/channels/auth'

/**
 * The stale-bearer trap (production, 2026-09-25) — onboarding-researcher twin.
 *
 * An idle chat tab's Supabase JWT expired; the next send carried it as
 * `Authorization: Bearer` next to a still-refreshable cookie session. The user
 * resolved (cookie) but every PostgREST call was pinned to the dead Bearer, so
 * the `member` query failed PGRST303, the error was ignored, and the workspace
 * fell through to the user's FIRST membership — the ownership ACL then 403'd
 * "This chat session belongs to another user or workspace."
 *
 * Pinned here: an expired-JWT member query is a 401 `session_expired` and the
 * first-membership fallback never runs; any other query error fails closed; a
 * successful empty lookup still falls through; a rejected Bearer is never
 * forwarded to PostgREST (the cookie session carries the DB reads instead).
 * Twins: agents/{chat-agent,onboarding-researcher}/lib/__tests__/
 * auth-session-expiry.test.ts.
 */

type User = { id: string }
type QueryResult = { data: unknown; error: unknown }
type RecordedQuery = { authorization: string | undefined; filters: Array<[string, unknown]>; ordered: boolean }

// ── Controllable fake Supabase server client ────────────────────────────────
const state: {
  /** token → the user auth.getUser(token) verifies it as (absent → rejected). */
  bearerUsers: Map<string, User>
  /** The error auth.getUser(token) returns for a rejected token. */
  bearerError: Record<string, unknown>
  /** The cookie session's user (auth.getUser() with no token). */
  cookieUser: User | null
  /** Scripted results for successive `member` queries, in order. */
  memberResults: QueryResult[]
} = {
  bearerUsers: new Map(),
  bearerError: { name: 'AuthApiError', status: 403, code: 'bad_jwt' },
  cookieUser: null,
  memberResults: [],
}
const queries: RecordedQuery[] = []
const getUserCalls: Array<string | undefined> = []

function fakeServerClient(opts: { global?: { headers?: Record<string, string> } }) {
  const authorization = opts?.global?.headers?.Authorization
  return {
    auth: {
      getUser: vi.fn(async (token?: string) => {
        getUserCalls.push(token)
        if (token === undefined) return { data: { user: state.cookieUser }, error: null }
        const user = state.bearerUsers.get(token)
        return user
          ? { data: { user }, error: null }
          : { data: { user: null }, error: state.bearerError }
      }),
    },
    from: vi.fn((table: string) => {
      if (table !== 'member') throw new Error(`unexpected table ${table}`)
      const q: RecordedQuery = { authorization, filters: [], ordered: false }
      const b = {
        select: () => b,
        eq: (k: string, v: unknown) => {
          q.filters.push([k, v])
          return b
        },
        order: () => {
          q.ordered = true
          return b
        },
        limit: () => b,
        maybeSingle: async () => {
          queries.push(q)
          return state.memberResults.shift() ?? { data: null, error: null }
        },
      }
      return b
    }),
  }
}

const createServerClient = vi.fn((_url: string, _key: string, opts: never) => fakeServerClient(opts))
vi.mock('@supabase/ssr', () => ({
  createServerClient: (...args: unknown[]) => (createServerClient as unknown as (...a: unknown[]) => unknown)(...args),
}))
// The service-role client (ownership ACL) is not exercised here.
vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn() }))

import { resolveSupabaseSession, isJwtExpiredError, SESSION_EXPIRED_CODE } from '../auth'

const URL_ = 'https://app/eve/onboarding-researcher/v1/session/wrun_ABC'
const USER: User = { id: 'user-1' }
const EXPIRED = { data: null, error: { code: 'PGRST303', message: 'JWT expired' } }

function req(headers: Record<string, string>): Request {
  return new Request(URL_, { method: 'POST', headers })
}

/** Await a rejection and return it (fails the test if it resolves). */
async function rejectionOf(p: Promise<unknown>): Promise<unknown> {
  try {
    await p
  } catch (err) {
    return err
  }
  throw new Error('expected the promise to reject')
}

let warn: ReturnType<typeof vi.spyOn>
let errorLog: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key'
  state.bearerUsers = new Map()
  state.bearerError = { name: 'AuthApiError', status: 403, code: 'bad_jwt' }
  state.cookieUser = null
  state.memberResults = []
  queries.length = 0
  getUserCalls.length = 0
  createServerClient.mockClear()
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  warn.mockRestore()
  errorLog.mockRestore()
})

describe('isJwtExpiredError (twin of src/lib/api-auth.ts)', () => {
  it('matches PGRST303 and a "JWT expired" message; nothing else', () => {
    expect(isJwtExpiredError({ code: 'PGRST303' })).toBe(true)
    expect(isJwtExpiredError({ message: 'JWT expired' })).toBe(true)
    expect(isJwtExpiredError({ code: '42501', message: 'permission denied' })).toBe(false)
    expect(isJwtExpiredError(null)).toBe(false)
  })
})

describe('resolveSupabaseSession — member query errors never fall through to another workspace', () => {
  it('an EXPIRED-JWT candidate lookup (PGRST303) → 401 session_expired; the first-membership query never runs', async () => {
    state.bearerUsers.set('live.jwt', USER)
    state.memberResults = [EXPIRED, { data: { workspace_id: 'ws-first' }, error: null }]

    const err = await rejectionOf(
      resolveSupabaseSession(req({ authorization: 'Bearer live.jwt', 'x-workspace-id': 'ws-chat' })),
    )

    expect(err).toBeInstanceOf(UnauthenticatedError)
    const res = (err as UnauthenticatedError).response
    expect(res.status).toBe(401)
    const body = (await res.json()) as { code: string; error: string }
    expect(body.code).toBe(SESSION_EXPIRED_CODE)
    expect(body.code).toBe('session_expired')
    expect(body.error).toBe('Your session expired — refresh and try again.')
    // ONE member query: the candidate check. The fallback that picked "My Workspace" is never consulted.
    expect(queries).toHaveLength(1)
    expect(queries[0].ordered).toBe(false)
    // One warn line naming the code, never the token.
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('PGRST303')
    expect(String(warn.mock.calls[0][0])).not.toContain('live.jwt')
  })

  it('an EXPIRED-JWT first-membership lookup (no candidate) → 401 session_expired', async () => {
    state.bearerUsers.set('live.jwt', USER)
    state.memberResults = [{ data: null, error: { message: 'JWT expired' } }]
    const err = await rejectionOf(resolveSupabaseSession(req({ authorization: 'Bearer live.jwt' })))
    expect(err).toBeInstanceOf(UnauthenticatedError)
    expect((err as UnauthenticatedError).response.status).toBe(401)
    expect(queries).toHaveLength(1)
  })

  it('any OTHER candidate query error fails CLOSED (throws, not a 401) and never falls through', async () => {
    state.bearerUsers.set('live.jwt', USER)
    state.memberResults = [
      { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } },
      { data: { workspace_id: 'ws-first' }, error: null },
    ]
    const err = await rejectionOf(
      resolveSupabaseSession(req({ authorization: 'Bearer live.jwt', 'x-workspace-id': 'ws-chat' })),
    )
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(UnauthenticatedError)
    expect(queries).toHaveLength(1)
  })

  it('any OTHER first-membership query error fails CLOSED too', async () => {
    state.bearerUsers.set('live.jwt', USER)
    state.memberResults = [{ data: null, error: { code: '57014', message: 'timeout' } }]
    const err = await rejectionOf(resolveSupabaseSession(req({ authorization: 'Bearer live.jwt' })))
    expect(err).not.toBeInstanceOf(UnauthenticatedError)
    expect(err).toBeInstanceOf(Error)
  })

  it('a SUCCESSFUL candidate lookup with no row still falls through to the first membership', async () => {
    state.bearerUsers.set('live.jwt', USER)
    state.memberResults = [{ data: null, error: null }, { data: { workspace_id: 'ws-first' }, error: null }]
    const session = await resolveSupabaseSession(
      req({ authorization: 'Bearer live.jwt', 'x-workspace-id': 'ws-not-mine' }),
    )
    expect(session).toEqual({ userId: 'user-1', workspaceId: 'ws-first' })
    expect(queries).toHaveLength(2)
    expect(queries[1].ordered).toBe(true)
  })

  it('a member of the claimed workspace resolves to it (one query)', async () => {
    state.bearerUsers.set('live.jwt', USER)
    state.memberResults = [{ data: { workspace_id: 'ws-chat' }, error: null }]
    const session = await resolveSupabaseSession(
      req({ authorization: 'Bearer live.jwt', 'x-workspace-id': 'ws-chat' }),
    )
    expect(session).toEqual({ userId: 'user-1', workspaceId: 'ws-chat' })
    expect(queries).toHaveLength(1)
  })
})

describe('resolveSupabaseSession — a rejected Bearer is never forwarded to PostgREST', () => {
  it('a VALID bearer pins the DB reads to it', async () => {
    state.bearerUsers.set('live.jwt', USER)
    state.memberResults = [{ data: { workspace_id: 'ws-chat' }, error: null }]
    await resolveSupabaseSession(req({ authorization: 'Bearer live.jwt', 'x-workspace-id': 'ws-chat' }))
    expect(getUserCalls).toEqual(['live.jwt'])
    expect(queries[0].authorization).toBe('Bearer live.jwt')
  })

  it('an EXPIRED bearer + a valid cookie session → the cookie user, DB reads WITHOUT the stale Authorization header', async () => {
    state.cookieUser = USER // bearer 'stale.jwt' is NOT in bearerUsers → rejected
    state.memberResults = [{ data: { workspace_id: 'ws-chat' }, error: null }]
    const session = await resolveSupabaseSession(
      req({ authorization: 'Bearer stale.jwt', cookie: 'workspace_id=ws-chat' }),
    )
    expect(session).toEqual({ userId: 'user-1', workspaceId: 'ws-chat' })
    // Verified the bearer, then fell back to the cookie session.
    expect(getUserCalls).toEqual(['stale.jwt', undefined])
    // No DB call carried the stale bearer — and no client was built with it.
    expect(queries).toHaveLength(1)
    expect(queries[0].authorization).toBeUndefined()
    for (const call of createServerClient.mock.calls) {
      expect(JSON.stringify(call[2] ?? {})).not.toContain('stale.jwt')
    }
  })

  it('an EXPIRED bearer and NO cookie session → 401 session_expired (no member query)', async () => {
    const err = await rejectionOf(resolveSupabaseSession(req({ authorization: 'Bearer stale.jwt' })))
    expect(err).toBeInstanceOf(UnauthenticatedError)
    const body = (await (err as UnauthenticatedError).response.json()) as { code: string }
    expect(body.code).toBe('session_expired')
    expect(queries).toHaveLength(0)
    expect(String(warn.mock.calls[0]?.[0])).not.toContain('stale.jwt')
  })

  it('an auth-service outage while verifying the bearer fails closed as a server error, not a 401', async () => {
    state.cookieUser = USER
    state.bearerError = { name: 'AuthRetryableFetchError', status: 0 }
    const err = await rejectionOf(resolveSupabaseSession(req({ authorization: 'Bearer live.jwt' })))
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(UnauthenticatedError)
    expect(queries).toHaveLength(0)
  })

  it('no bearer and no cookie session → null (skip to the next AuthFn), as before', async () => {
    expect(await resolveSupabaseSession(req({}))).toBeNull()
  })

  it('a d8d_ device token is not treated as a Supabase JWT (never verified, never forwarded)', async () => {
    state.cookieUser = null
    expect(await resolveSupabaseSession(req({ authorization: 'Bearer d8d_abc' }))).toBeNull()
    expect(getUserCalls).toEqual([undefined])
  })
})
