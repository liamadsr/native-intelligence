import {
  createServerClient,
  combineChunks,
  stringFromBase64URL,
} from '@supabase/ssr'
import { cookies, headers } from 'next/headers'

// The SSR client stores the session behind a `base64-` prefix (its default
// cookieEncoding) — see @supabase/ssr's cookies.ts getItem.
const BASE64_PREFIX = 'base64-'

/**
 * base64url-decode a string into UTF-8 text. Used only for JWT payload
 * segments (the URL-safe alphabet with `-`/`_` and no `=` padding). Returns
 * null on any malformed input.
 *
 * Exported for unit tests (`__tests__/server.test.ts`); not used elsewhere.
 */
export function base64UrlDecode(input: string): string | null {
  try {
    let b64 = input.replace(/-/g, '+').replace(/_/g, '/')
    while (b64.length % 4 !== 0) b64 += '='
    return Buffer.from(b64, 'base64').toString('utf8')
  } catch {
    return null
  }
}

/**
 * Extract the `sub` (user id) claim from a Supabase access token WITHOUT
 * verifying its signature. This is a same-identity comparison only — we use it
 * to decide whether an incoming Bearer names the *same* user as the cookie
 * session, never to authorize anything. GoTrue (auth.getUser) and PostgREST
 * (RLS) still verify the signature downstream, so an attacker cannot forge a
 * matching `sub` to smuggle an unsigned token through.
 *
 * Returns null on any failure (not a JWT, unparseable payload, no `sub`).
 *
 * Exported for unit tests (`__tests__/server.test.ts`); the identity guard in
 * createClient() is its only production caller.
 */
export function decodeJwtSub(token: string): string | null {
  const parts = token.split('.')
  if (parts.length < 2) return null
  const json = base64UrlDecode(parts[1])
  if (!json) return null
  try {
    const payload = JSON.parse(json) as { sub?: unknown }
    return typeof payload.sub === 'string' ? payload.sub : null
  } catch {
    return null
  }
}

/**
 * Derive the Supabase auth-token storage key the SSR client uses for its
 * session cookie. supabase-js computes this as
 * `sb-${new URL(supabaseUrl).hostname.split('.')[0]}-auth-token` (unless
 * `cookieOptions.name` overrides it — we never set that). We mirror that
 * derivation so the cookie we read is exactly the one the SSR client wrote.
 * Returns null if the URL can't be parsed.
 */
function authTokenStorageKey(): string | null {
  try {
    const host = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).hostname
    const ref = host.split('.')[0]
    if (!ref) return null
    return `sb-${ref}-auth-token`
  } catch {
    return null
  }
}

/**
 * Resolve the `sub` of the Supabase session carried by the request cookies, or
 * null if there is no session we can extract.
 *
 * CRITICAL: this must match @supabase/ssr's own read path EXACTLY, because the
 * forwarding rule in createClient() is "forward the Bearer UNLESS the cookie
 * yields a parsed session whose sub differs". The safety of "can't extract →
 * forward" rests entirely on the fact that whenever WE fail to extract a
 * session, GoTrue (which uses the same ssr storage) also sees no session — so
 * there is no competing identity and forwarding cannot cause confusion.
 *
 * We therefore reuse the library's OWN functions rather than hand-rolling, so
 * divergence is impossible:
 *   - combineChunks() reassembles `<key>`, `<key>.0`, `<key>.1`, … and, per its
 *     FALSY semantics (`if (value) return value`, `if (!chunk) break` in
 *     @supabase/ssr@0.8.0 chunker.ts), treats an EMPTY-STRING cookie value as
 *     ABSENT. That empty-string state is common, not exotic: on a dead refresh
 *     token, middleware getUser() triggers session removal, which writes '' via
 *     setAll, and the proxy copies '' onto the request cookies. combineChunks
 *     maps that to null → no session → forward.
 *   - stringFromBase64URL() decodes the `base64-` payload identically to getItem.
 * A truncated multi-chunk reassembly (a browser evicting one chunk) yields a
 * non-JSON string → JSON.parse throws → null → forward, never suppression.
 *
 * Returns:
 *   string — a session cookie parsed cleanly to an access token with a `sub`
 *   null   — no extractable session (absent, empty '', truncated, unparseable,
 *            no access_token, or undecodable sub)
 */
async function readCookieSub(
  cookieStore: Awaited<ReturnType<typeof cookies>>
): Promise<string | null> {
  const key = authTokenStorageKey()
  if (!key) return null

  // Feed the cookie jar to the library's combineChunks. Return undefined for a
  // missing cookie (NOT '') so its `if (!chunk) break` / `if (value) return`
  // falsy checks behave exactly as they do at runtime; an empty-string cookie
  // value flows through and combineChunks maps it to null (absent).
  const raw = await combineChunks(key, (chunkName) => {
    const cookie = cookieStore.get(chunkName)
    return cookie ? cookie.value : undefined
  })
  if (!raw) return null // absent OR empty-string ('') → no session → forward

  let sessionJson = raw
  if (raw.startsWith(BASE64_PREFIX)) {
    try {
      sessionJson = stringFromBase64URL(raw.slice(BASE64_PREFIX.length))
    } catch {
      return null // undecodable base64 → treat as no session → forward
    }
  }

  try {
    const session = JSON.parse(sessionJson) as { access_token?: unknown }
    if (typeof session.access_token !== 'string') return null
    return decodeJwtSub(session.access_token)
  } catch {
    return null // truncated / non-JSON reassembly → no session → forward
  }
}

export async function createClient() {
  const cookieStore = await cookies()

  // Non-browser clients (desktop app, hardware devices, MCP) authenticate
  // with an `Authorization: Bearer <token>` header instead of a cookie
  // session. Forward that header to PostgREST so RLS evaluates against the
  // token's user. Browser requests have no such header and are unaffected.
  //
  // Only forward Supabase JWTs (`eyJ…`). A Dial8 device token (`d8d_…`) is an
  // opaque secret, NOT a JWT — forwarding it makes Supabase auth reject it as
  // malformed (and `auth.getUser()` throws). Device tokens are resolved
  // separately in resolveUser()/authenticateUser(); here we just leave the
  // header off so the client behaves like an anonymous cookie client.
  //
  // IDENTITY-CONFUSION GUARD (dual-credential): a request can carry BOTH a
  // valid cookie session (user A) AND a Bearer JWT for a DIFFERENT user (user
  // B) — e.g. the desktop app switched accounts but a stale in-memory token
  // lingers. supabase-js prefers an explicit Authorization header over the
  // cookie session's token for PostgREST, while `auth.getUser()` (and thus
  // resolveUser in api-auth.ts) resolves from the cookie session. Forwarding
  // unconditionally would make route logic act as A while every RLS query runs
  // as B: falsely-empty reads and writes attributed to A under B's policies.
  // RLS identity must NEVER contradict the resolved user.
  //
  // The rule: forward the Bearer UNLESS the cookie yields a successfully-parsed
  // session access token whose `sub` DIFFERS from the Bearer's `sub`. That one
  // case is the true confusion, and the cookie wins (matching resolveUser's
  // cookie-first order). EVERYTHING else forwards — identical to the header's
  // pre-guard behavior — because it is safe: whenever readCookieSub() can't
  // extract a session under @supabase/ssr's own read semantics (absent cookie,
  // empty-string '' from a removed session, a truncated/evicted chunk,
  // unparseable JSON, or an undecodable sub), GoTrue sees no session either, so
  // no competing identity exists and forwarding cannot confuse anything.
  //   - no session cookie (absent/'')          → forward
  //   - session cookie, SAME sub                → forward
  //   - session cookie, unparseable/truncated   → forward (no competing identity)
  //   - session cookie, DIFFERENT sub           → DO NOT forward (cookie wins)
  //   - d8d_ device token                       → never forward
  const headerStore = await headers()
  const authHeader = headerStore.get('authorization')
  const bearer =
    authHeader?.startsWith('Bearer ') && !authHeader.slice(7).startsWith('d8d_')
      ? authHeader.slice(7)
      : null

  let forwardAuthHeader = false
  if (bearer) {
    const cookieSub = await readCookieSub(cookieStore)
    if (cookieSub === null) {
      // No extractable session — no competing identity. Forward (as on main).
      forwardAuthHeader = true
    } else {
      // A parsed session exists — forward ONLY when it names the SAME user.
      const bearerSub = decodeJwtSub(bearer)
      forwardAuthHeader = bearerSub !== null && bearerSub === cookieSub
    }
  }

  const global = forwardAuthHeader
    ? { global: { headers: { Authorization: authHeader! } } }
    : {}

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      ...global,
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          } catch {
            // The `setAll` method was called from a Server Component.
            // This can be ignored if you have middleware refreshing
            // user sessions.
          }
        },
      },
    }
  )
}
