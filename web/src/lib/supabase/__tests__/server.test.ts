import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * Tests for src/lib/supabase/server.ts createClient().
 *
 * The security-relevant behavior is the dual-credential identity guard. The
 * rule: an incoming `Authorization: Bearer <JWT>` is forwarded into the
 * PostgREST client (`global.headers.Authorization`) UNLESS the cookie yields a
 * successfully-parsed session access token whose `sub` DIFFERS from the
 * Bearer's `sub`. supabase-js prefers an explicit Authorization header over the
 * cookie session for RLS queries, while `auth.getUser()` resolves from the
 * cookie — so forwarding a Bearer for a DIFFERENT user than a live cookie
 * session would run every query as the wrong user (cross-identity RLS).
 *
 * Everything OTHER than a parsed-different-sub cookie forwards — this matches
 * main's pre-guard behavior and is safe, because whenever we can't extract a
 * session under @supabase/ssr's own read semantics (absent cookie, empty-string
 * '' from a removed session, a truncated/evicted chunk, unparseable JSON),
 * GoTrue sees no session either, so there is no competing identity. These tests
 * double as the drift alarm for readCookieSub's reuse of the library's
 * combineChunks / stringFromBase64URL.
 *
 * We assert directly on the `options` handed to `@supabase/ssr`'s
 * createServerClient: whether `options.global?.headers?.Authorization` is set.
 *
 * HERMETIC ENV: readCookieSub() derives the auth-token storage key
 * `sb-<ref>-auth-token` from NEXT_PUBLIC_SUPABASE_URL *at call time*. This suite
 * must not depend on the ambient value — on a Vercel build (`vitest run` inside
 * `next build`) the real prod URL is injected, so a hardcoded fixture key would
 * no longer match the module's derived key, every cookie would classify as
 * absent, and the suppression assertions would flip. So we pin the var to a
 * fixed test URL via vi.stubEnv (beforeEach) / vi.unstubAllEnvs (afterEach) and
 * derive the fixture cookie key from that SAME pinned value with the SAME
 * derivation the module uses. Every test passes regardless of the ambient
 * NEXT_PUBLIC_SUPABASE_URL (proven by running the suite with the var overridden
 * to a different URL and with it unset).
 */

// Pinned test project URL — the whole suite runs against this, never the
// ambient value. Kept deliberately different from src/test/setup.ts's default
// so a regression to reading ambient env would surface immediately.
const TEST_SUPABASE_URL = 'https://fixturetestref.supabase.co'
// Derive the storage key EXACTLY as authTokenStorageKey() in server.ts does:
// `sb-${new URL(url).hostname.split('.')[0]}-auth-token`.
const AUTH_COOKIE_KEY = `sb-${new URL(TEST_SUPABASE_URL).hostname.split('.')[0]}-auth-token`

// Hoisted holders so the vi.mock callbacks can reach them.
const hoisted = vi.hoisted(() => ({
  // Records the last options object passed to createServerClient.
  lastOptions: null as unknown,
  // Cookie jar: name -> value. Modeled as a Map so getAll/get are trivial.
  cookies: new Map<string, string>(),
  // Authorization header value (null = no header).
  authHeader: null as string | null,
}))

// Override ONLY createServerClient (to capture its options); keep the REAL
// combineChunks / stringFromBase64URL so readCookieSub is exercised against the
// library's own read semantics — the whole point of reusing them. This spread
// also makes the tests the drift alarm: a library upgrade that changes those
// functions runs through here unmocked.
vi.mock('@supabase/ssr', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@supabase/ssr')>()
  return {
    ...actual,
    createServerClient: (_url: string, _key: string, options: unknown) => {
      hoisted.lastOptions = options
      // Return a dummy client; createClient() only returns it, never calls it.
      return { __mock: true }
    },
  }
})

vi.mock('next/headers', () => ({
  headers: async () => ({
    get: (name: string) =>
      name.toLowerCase() === 'authorization' ? hoisted.authHeader : null,
  }),
  cookies: async () => ({
    get: (name: string) =>
      hoisted.cookies.has(name)
        ? { name, value: hoisted.cookies.get(name)! }
        : undefined,
    getAll: () =>
      [...hoisted.cookies.entries()].map(([name, value]) => ({ name, value })),
    set: () => {},
  }),
}))

const { createClient, decodeJwtSub } = await import('@/lib/supabase/server')

// --- Helpers to construct SSR-format cookies + JWTs --------------------------

function b64urlEncode(str: string): string {
  return Buffer.from(str, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/** Build a (structurally valid, unsigned) Supabase access-token JWT for `sub`. */
function makeJwt(sub: string): string {
  const header = b64urlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = b64urlEncode(
    JSON.stringify({ sub, role: 'authenticated', aud: 'authenticated' })
  )
  // The payload uses `+`/`/`-free base64url; add a non-empty signature segment.
  return `${header}.${payload}.sig-sig`
}

/**
 * Build the SSR auth-token cookie value for a session whose access_token names
 * `sub` (default cookieEncoding = base64url behind the `base64-` prefix).
 */
function makeAuthCookieValue(sub: string): string {
  const session = JSON.stringify({
    access_token: makeJwt(sub),
    token_type: 'bearer',
    user: { id: sub },
  })
  return 'base64-' + b64urlEncode(session)
}

/** Split a full cookie value into chunk cookies (.0/.1/…) of `size` chars. */
function chunkCookie(value: string, size: number): [string, string][] {
  const chunks: [string, string][] = []
  for (let i = 0, part = 0; i < value.length; i += size, part++) {
    chunks.push([`${AUTH_COOKIE_KEY}.${part}`, value.slice(i, i + size)])
  }
  return chunks
}

/** Read the Authorization header the client would have been built with. */
function forwardedAuth(): string | undefined {
  const opts = hoisted.lastOptions as {
    global?: { headers?: { Authorization?: string } }
  } | null
  return opts?.global?.headers?.Authorization
}

beforeEach(() => {
  // Pin the URL the module reads at CALL time (authTokenStorageKey), so the
  // derived storage key always matches AUTH_COOKIE_KEY regardless of the
  // ambient NEXT_PUBLIC_SUPABASE_URL (prod URL on a Vercel build, placeholder
  // locally). No module reset needed — server.ts reads env inside createClient.
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', TEST_SUPABASE_URL)
  hoisted.lastOptions = null
  hoisted.cookies = new Map()
  hoisted.authHeader = null
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('createClient() — dual-credential identity guard', () => {
  it('cookie-only (no Authorization header) → does not forward', async () => {
    hoisted.cookies.set(AUTH_COOKIE_KEY, makeAuthCookieValue('user-A'))
    // No authHeader.
    await createClient()
    expect(forwardedAuth()).toBeUndefined()
  })

  it('Bearer-only, no auth cookie → forwards the Bearer', async () => {
    hoisted.authHeader = `Bearer ${makeJwt('user-B')}`
    // No auth cookie in the jar.
    await createClient()
    expect(forwardedAuth()).toBe(hoisted.authHeader)
  })

  it('Bearer + auth cookie, SAME sub → forwards the Bearer', async () => {
    hoisted.cookies.set(AUTH_COOKIE_KEY, makeAuthCookieValue('user-A'))
    hoisted.authHeader = `Bearer ${makeJwt('user-A')}`
    await createClient()
    expect(forwardedAuth()).toBe(hoisted.authHeader)
  })

  it('Bearer + auth cookie, DIFFERENT sub → does NOT forward', async () => {
    hoisted.cookies.set(AUTH_COOKIE_KEY, makeAuthCookieValue('user-A'))
    hoisted.authHeader = `Bearer ${makeJwt('user-B')}`
    await createClient()
    expect(forwardedAuth()).toBeUndefined()
  })

  it('Bearer + unparseable auth cookie → FORWARDS (no extractable session)', async () => {
    // A present cookie whose value decodes but is not valid JSON yields no
    // session under ssr's read path — GoTrue sees nothing either — so there is
    // no competing identity to protect. Forward, matching main's behavior.
    hoisted.cookies.set(AUTH_COOKIE_KEY, 'base64-' + b64urlEncode('{not json'))
    hoisted.authHeader = `Bearer ${makeJwt('user-B')}`
    await createClient()
    expect(forwardedAuth()).toBe(hoisted.authHeader)
  })

  it('Bearer + empty-string bare cookie → FORWARDS (removed session reads as absent)', async () => {
    // On a dead refresh token, middleware session removal writes '' via setAll
    // and the proxy copies '' onto the request cookies. combineChunks maps ''
    // to null (its falsy `if (value)` check) → no session → forward. Suppressing
    // here would break the exact stale-desktop-with-valid-Bearer case.
    hoisted.cookies.set(AUTH_COOKIE_KEY, '')
    hoisted.authHeader = `Bearer ${makeJwt('user-B')}`
    await createClient()
    expect(forwardedAuth()).toBe(hoisted.authHeader)
  })

  it('Bearer + empty-string chunk .0 → FORWARDS (chunked removed session reads as absent)', async () => {
    // The chunked form of a removed session: `<key>.0` set to ''. combineChunks
    // reads the bare key (absent), then `<key>.0` — '' is falsy so the chunk
    // loop breaks immediately with no values → null → forward.
    hoisted.cookies.set(`${AUTH_COOKIE_KEY}.0`, '')
    hoisted.authHeader = `Bearer ${makeJwt('user-B')}`
    await createClient()
    expect(forwardedAuth()).toBe(hoisted.authHeader)
  })

  it('Bearer + truncated multi-chunk cookie (.1 evicted), SAME sub → FORWARDS', async () => {
    // A browser evicting one chunk of a multi-chunk cookie leaves .0 present and
    // .1 missing. combineChunks joins only .0 → a truncated base64 payload →
    // JSON.parse throws → null → forward. This must NOT suppress even for the
    // SAME user, since the request worked on main.
    const chunks = chunkCookie(makeAuthCookieValue('user-A'), 80)
    expect(chunks.length).toBeGreaterThan(1)
    // Set only the FIRST chunk (.0); drop the rest to simulate eviction of .1+.
    hoisted.cookies.set(chunks[0][0], chunks[0][1])
    hoisted.authHeader = `Bearer ${makeJwt('user-A')}`
    await createClient()
    expect(forwardedAuth()).toBe(hoisted.authHeader)
  })

  it('Bearer + chunked auth cookie (.0/.1), SAME sub → forwards', async () => {
    const value = makeAuthCookieValue('user-A')
    // Force chunking by using a small chunk size (value is >150 chars).
    const chunks = chunkCookie(value, 80)
    expect(chunks.length).toBeGreaterThan(1) // sanity: actually chunked
    for (const [name, chunkValue] of chunks) hoisted.cookies.set(name, chunkValue)
    hoisted.authHeader = `Bearer ${makeJwt('user-A')}`
    await createClient()
    expect(forwardedAuth()).toBe(hoisted.authHeader)
  })

  it('Bearer + chunked auth cookie (.0/.1), DIFFERENT sub → does NOT forward', async () => {
    const chunks = chunkCookie(makeAuthCookieValue('user-A'), 80)
    expect(chunks.length).toBeGreaterThan(1)
    for (const [name, chunkValue] of chunks) hoisted.cookies.set(name, chunkValue)
    hoisted.authHeader = `Bearer ${makeJwt('user-B')}`
    await createClient()
    expect(forwardedAuth()).toBeUndefined()
  })

  it('nid_ device token → never forwarded (with or without cookie)', async () => {
    hoisted.authHeader = 'Bearer nid_opaque_secret'
    await createClient()
    expect(forwardedAuth()).toBeUndefined()

    // Also with a cookie session present.
    hoisted.cookies.set(AUTH_COOKIE_KEY, makeAuthCookieValue('user-A'))
    await createClient()
    expect(forwardedAuth()).toBeUndefined()
  })

  it('non-Bearer Authorization header → not forwarded', async () => {
    hoisted.authHeader = 'Basic dXNlcjpwYXNz'
    await createClient()
    expect(forwardedAuth()).toBeUndefined()
  })
})

// --- decodeJwtSub, tested directly ------------------------------------------
//
// decodeJwtSub is the primitive the SAME/DIFFERENT decision rests on, so we
// pin its contract directly: it must base64url-decode a JWT payload (URL-safe
// alphabet, no padding) and return null on anything malformed.

/** A base64url-encoded JWT payload that PROVABLY uses BOTH URL-safe chars. */
function makePayloadWithUrlSafeChars(): { token: string; sub: string } {
  // The multibyte codepoints U+083E/U+083F encode to bytes whose base64
  // sextets land on 62 and 63 — rendered `+`/`/` in standard base64 but `-`/`_`
  // in base64url. Embedding them in the sub forces the payload to contain both
  // URL-safe chars (asserted in the test), so a plain-base64 decode would
  // corrupt it while base64UrlDecode must recover it exactly.
  const sub = 'a\u{083E}\u{083F}z'
  const header = b64urlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = b64urlEncode(JSON.stringify({ sub }))
  return { token: `${header}.${payload}.sig`, sub }
}

describe('decodeJwtSub', () => {
  it('decodes the sub from a base64url payload (chars beyond plain base64)', () => {
    const { token, sub } = makePayloadWithUrlSafeChars()
    const payloadSegment = token.split('.')[1]
    // Guard: the payload genuinely uses BOTH URL-safe chars, so this test
    // actually distinguishes base64url decoding from plain base64.
    expect(payloadSegment.includes('-')).toBe(true)
    expect(payloadSegment.includes('_')).toBe(true)
    expect(decodeJwtSub(token)).toBe(sub)
  })

  it('decodes a plain-ASCII sub', () => {
    expect(decodeJwtSub(makeJwt('user-A'))).toBe('user-A')
  })

  it('returns null for a non-JWT string (no dot segments)', () => {
    expect(decodeJwtSub('not-a-real-jwt')).toBeNull()
  })

  it('returns null when the payload is not valid base64/JSON', () => {
    expect(decodeJwtSub('header.@@@not-base64@@@.sig')).toBeNull()
  })

  it('returns null when the payload has no sub claim', () => {
    const token = `${b64urlEncode('{}')}.${b64urlEncode(
      JSON.stringify({ role: 'authenticated' })
    )}.sig`
    expect(decodeJwtSub(token)).toBeNull()
  })

  it('returns null when sub is present but not a string', () => {
    const token = `${b64urlEncode('{}')}.${b64urlEncode(
      JSON.stringify({ sub: 12345 })
    )}.sig`
    expect(decodeJwtSub(token)).toBeNull()
  })
})

// --- malformed Bearer flowing through createClient() ------------------------

describe('createClient() — malformed Bearer JWT handling', () => {
  it('does NOT forward a malformed Bearer when a PARSED cookie session exists', async () => {
    // The cookie parses cleanly to user-A's sub; the Bearer is a broken JWT
    // whose sub can't be decoded (bearerSub null). Since a real competing
    // identity exists and the Bearer can't be shown to match it, the cookie
    // wins → not forwarded.
    hoisted.cookies.set(AUTH_COOKIE_KEY, makeAuthCookieValue('user-A'))
    hoisted.authHeader = 'Bearer not-a-real-jwt'
    await createClient()
    expect(forwardedAuth()).toBeUndefined()
  })

  it('still forwards a malformed Bearer with NO cookie (no identity to contradict)', async () => {
    // No cookie session at all → the no-session branch forwards regardless of
    // whether the Bearer decodes (matches the cookie-less desktop/MCP path).
    hoisted.authHeader = 'Bearer not-a-real-jwt'
    await createClient()
    expect(forwardedAuth()).toBe(hoisted.authHeader)
  })
})
