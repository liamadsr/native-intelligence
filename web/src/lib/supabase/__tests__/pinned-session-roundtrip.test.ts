/**
 * The move itself, against the real cookie library.
 *
 * A session is written the way it is today: under the project's own name,
 * base64url-encoded and split across several cookies. Then the address
 * changes. With the pin, the real @supabase/ssr clients must find that same
 * session under the new address; without it they must not (which is the
 * sign-out the pin exists to prevent, shown here so the first claim is not
 * true by accident). Nothing is mocked but the network.
 */
import { createBrowserClient, createChunks, createServerClient } from '@supabase/ssr'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { authCookieOptions } from '@/lib/supabase/project'

const REF = 'fixturetestref'
const OLD_NAME = `sb-${REF}-auth-token`
const NEW_ADDRESS = 'https://db.example.test'

const b64url = (text: string) => Buffer.from(text, 'utf8').toString('base64url')
const jwt = (sub: string) =>
  `${b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64url(
    JSON.stringify({ sub, role: 'authenticated', aud: 'authenticated', exp: 4102444800 }),
  )}.signature`

// Big enough that it does not fit one cookie, like a real session with its identities.
const session = {
  access_token: jwt('user-A'),
  refresh_token: 'refresh-token',
  token_type: 'bearer',
  expires_in: 3600,
  expires_at: 4102444800,
  user: {
    id: 'user-A',
    aud: 'authenticated',
    role: 'authenticated',
    email: 'person@example.test',
    app_metadata: {},
    user_metadata: { padding: 'x'.repeat(5000) },
    created_at: '2026-01-01T00:00:00Z',
  },
}
const writtenBeforeTheMove = createChunks(OLD_NAME, 'base64-' + b64url(JSON.stringify(session)))

/** A cookie jar and the library's two callbacks over it. */
function jar(initial: { name: string; value: string }[]) {
  const held = new Map(initial.map((c) => [c.name, c.value]))
  return {
    names: () => [...held.keys()].sort(),
    cookies: {
      getAll: () => [...held.entries()].map(([name, value]) => ({ name, value })),
      setAll: (list: { name: string; value: string }[]) => {
        for (const c of list) {
          if (c.value) held.set(c.name, c.value)
          else held.delete(c.name)
        }
      },
    },
  }
}

const requests: string[] = []
const network = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input)
  requests.push(`${init?.method ?? 'GET'} ${url}`)
  if (url.includes('/token?grant_type=pkce')) {
    return new Response(JSON.stringify(session), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  if (url.includes('/logout')) return new Response(null, { status: 204 })
  return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
}

beforeEach(() => {
  requests.length = 0
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', NEW_ADDRESS)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('a session written before the address moved', () => {
  it('is stored in more than one cookie under the project\'s own name', () => {
    expect(writtenBeforeTheMove.length).toBeGreaterThan(1)
    expect(writtenBeforeTheMove.map((c) => c.name)).toEqual(writtenBeforeTheMove.map((_, i) => `${OLD_NAME}.${i}`))
  })

  it('pinned: the server client on the new address reads it, whole', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PROJECT_REF', REF)
    const j = jar(writtenBeforeTheMove)
    const client = createServerClient(NEW_ADDRESS, 'anon', { ...authCookieOptions(), cookies: j.cookies, global: { fetch: network } })
    const { data } = await client.auth.getSession()
    expect(data.session?.user?.id).toBe('user-A')
    expect(data.session?.access_token).toBe(session.access_token)
    expect(data.session?.user?.user_metadata?.padding).toHaveLength(5000)
  })

  it('unpinned: the same client does not find it (everyone would be signed out)', async () => {
    const j = jar(writtenBeforeTheMove)
    const client = createServerClient(NEW_ADDRESS, 'anon', { ...authCookieOptions(), cookies: j.cookies, global: { fetch: network } })
    const { data } = await client.auth.getSession()
    expect(data.session).toBeNull()
  })

  it('pinned: the browser client reads it too, and signing out removes every part of it', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PROJECT_REF', REF)
    const j = jar(writtenBeforeTheMove)
    const client = createBrowserClient(NEW_ADDRESS, 'anon', {
      ...authCookieOptions(),
      isSingleton: false,
      cookies: j.cookies,
      global: { fetch: network },
    })
    const { data } = await client.auth.getSession()
    expect(data.session?.user?.id).toBe('user-A')
    await client.auth.signOut({ scope: 'local' })
    expect(j.names().filter((n) => n.startsWith(OLD_NAME))).toEqual([])
  })
})

describe('a sign-in started after the address moved', () => {
  it('pinned: the code verifier and the new session are kept under the pinned name', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PROJECT_REF', REF)
    const j = jar([])
    const starting = createServerClient(NEW_ADDRESS, 'anon', { ...authCookieOptions(), cookies: j.cookies, global: { fetch: network } })
    const { data } = await starting.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: 'https://app.example.test/auth/callback', skipBrowserRedirect: true },
    })
    expect(new URL(data.url!).host).toBe(new URL(NEW_ADDRESS).host)
    expect(j.names()).toEqual([`${OLD_NAME}-code-verifier`])

    // The callback is another request, so another client over the same cookies.
    const finishing = createServerClient(NEW_ADDRESS, 'anon', { ...authCookieOptions(), cookies: j.cookies, global: { fetch: network } })
    const exchanged = await finishing.auth.exchangeCodeForSession('a-code')
    expect(exchanged.error).toBeNull()
    expect(requests.some((r) => r.includes('grant_type=pkce'))).toBe(true)
    const names = j.names()
    expect(names.length).toBeGreaterThan(0)
    expect(names.every((n) => n === OLD_NAME || n.startsWith(`${OLD_NAME}.`))).toBe(true)
  })
})
