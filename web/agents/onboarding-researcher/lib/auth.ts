/**
 * Standalone Supabase session resolver + session-ownership ACL for the
 * onboarding research agent's eve HTTP channel.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ TWIN FILE. The `resolveSupabaseSession` half of this module is a         │
 * │ DUPLICATE of `agents/chat-agent/lib/auth.ts`'s resolver. Keep the two in │
 * │ sync.                                                                    │
 * │                                                                          │
 * │ Why duplicated, not shared: eve compiles each agent root INDEPENDENTLY   │
 * │ (the framework's model is per-root isolation — "a declared subagent      │
 * │ inherits nothing from the root; it discovers its own slots"). A          │
 * │ cross-root relative import (`../../../agent/lib/auth.js`) reaches out of  │
 * │ THIS agent root into a sibling's, coupling two independently-built        │
 * │ bundles — exactly the fragility the migration plan warns about. `eve     │
 * │ info` resolves such an import at discovery, but nothing guarantees the    │
 * │ sibling's `lib/` traces cleanly into THIS root's hosted output. So each   │
 * │ root keeps its own copy; this header names the twin.                      │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * WHY A STANDALONE RESOLVER (not the app's helpers):
 * The eve route-auth `AuthFn` runs at the channel layer inside eve's Nitro
 * runtime — a SEPARATE service from the Next.js app. That context has no
 * Next.js request scope (`next/headers` throws) and no `@/*` path alias, so the
 * app's `src/lib/api-auth.ts` / `src/lib/supabase/server.ts` / `src/lib/workspace.ts`
 * (all built on `next/headers`) cannot be imported here. We reuse the SAME
 * underlying primitive the app uses — `createServerClient` from `@supabase/ssr`
 * — fed a cookie adapter built from the raw `Request` headers. Same decode
 * path, same `auth.getUser()` verification, correct outside Next.
 *
 * We mirror the app's resolution semantics exactly:
 *   - user: a VERIFIED `Authorization: Bearer <jwt>` (DB reads then run as it),
 *     else the cookie session (DB reads then run on the cookie session, never
 *     on a stale Bearer) — see resolveUserAndClient; an expired JWT → 401
 *     `session_expired`, never a silent fall-through to another workspace;
 *   - workspace: `x-workspace-id` header -> `workspace_id` cookie -> first
 *     membership, header/cookie candidate TRUSTED ONLY after a `member` check.
 */
import { timingSafeEqual } from 'node:crypto'
import { UnauthenticatedError, localDev, type AuthFn } from 'eve/channels/auth'
import { createClient } from '@supabase/supabase-js'
import { createServerClient, type CookieMethodsServer } from '@supabase/ssr'
import { parse as parseCookie } from 'cookie'
import type { SupabaseClient, User } from '@supabase/supabase-js'

/** Kept in sync with `WORKSPACE_HEADER` / `WORKSPACE_COOKIE` in src/lib/workspace.ts. */
const WORKSPACE_HEADER = 'x-workspace-id'
const WORKSPACE_COOKIE = 'workspace_id'

function env(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`[onboarding-researcher/lib/auth] missing required env var ${name}`)
  }
  return value
}

/** A `d8d_` device token is not a Supabase JWT (see src/lib/device-tokens.ts). */
const DEVICE_BEARER_PREFIX = 'd8d_'

/**
 * The 401 this channel answers when the caller's Supabase session has EXPIRED.
 * The browser transport (src/lib/chat/eve/eve-chat-transport.ts) treats
 * it as "refresh the JWT, re-mint, retry once" — never as a tenancy failure.
 */
export const SESSION_EXPIRED_CODE = 'session_expired'
export const SESSION_EXPIRED_MESSAGE = 'Your session expired — refresh and try again.'

/**
 * Build the session-expired rejection and log ONE line saying why (the reason
 * names an error code, never a token). eve's routeAuth turns a thrown
 * UnauthenticatedError into its structured 401 `{ ok: false, code, error }`.
 */
function sessionExpiredError(reason: string): UnauthenticatedError {
  console.warn(`[onboarding-researcher/lib/auth] ${reason} → 401 ${SESSION_EXPIRED_CODE}`)
  return new UnauthenticatedError({
    code: SESSION_EXPIRED_CODE,
    message: SESSION_EXPIRED_MESSAGE,
  })
}

/**
 * True when a Supabase/PostgREST error is an EXPIRED-JWT rejection: PGRST303 is
 * PostgREST's dedicated expired-token code; the message check covers older or
 * proxied errors that carry the text but not the code.
 *
 * TWIN of `isJwtExpiredError` in src/lib/api-auth.ts (and src/lib/workspace.ts).
 * This eve root cannot import app modules (no `@/*` alias, per-root isolation),
 * so it keeps its own copy. Same copy in `agents/chat-agent/lib/auth.ts`.
 */
export function isJwtExpiredError(
  error: { code?: unknown; message?: unknown } | null | undefined
): boolean {
  if (!error) return false
  return (
    error.code === 'PGRST303' ||
    /jwt expired/i.test(typeof error.message === 'string' ? error.message : '')
  )
}

/** The Supabase JWT a `Bearer` header carries, or null (no bearer / a device token). */
function jwtBearer(request: Request): string | null {
  const authHeader = request.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) return null
  const token = authHeader.slice(7).trim()
  if (!token || token.startsWith(DEVICE_BEARER_PREFIX)) return null
  return token
}

/**
 * Build a Supabase server client whose cookie store is the incoming Request's
 * `Cookie:` header (read-only — eve never writes response cookies). When
 * `bearer` is given, every PostgREST call carries it (`Authorization`), so RLS
 * evaluates against that token's user. Pass a bearer ONLY once it has been
 * verified live — see {@link resolveUserAndClient} for why.
 */
function supabaseFromRequest(request: Request, bearer: string | null): SupabaseClient {
  const cookieHeader = request.headers.get('cookie') ?? ''
  const parsed = parseCookie(cookieHeader)
  const allCookies = Object.entries(parsed).map(([name, value]) => ({
    name,
    value: value ?? '',
  }))

  const cookies: CookieMethodsServer = {
    getAll() {
      return allCookies
    },
    // Route auth is read-only; refreshed sessions are the app's concern.
    setAll() {},
  }

  return createServerClient(
    env('NEXT_PUBLIC_SUPABASE_URL'),
    env('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
    {
      cookies,
      ...(bearer ? { global: { headers: { Authorization: `Bearer ${bearer}` } } } : {}),
    }
  )
}

/** The cookie session's user (the client refreshes an expired access token). */
async function cookieUser(supabase: SupabaseClient): Promise<User | null> {
  try {
    const {
      data: { user },
    } = await supabase.auth.getUser()
    return user ?? null
  } catch {
    return null
  }
}

/**
 * Resolve the authenticated user AND the Supabase client its DB reads run on,
 * so both always carry the SAME, LIVE identity.
 *
 * THE STALE-BEARER TRAP (production, 2026-09-25): the browser sends its cached
 * Supabase JWT as `Authorization: Bearer` alongside its cookies. This resolver
 * used to pin every PostgREST call to that Bearer while resolving the USER
 * through the cookie session (which the client refreshes). After ~1h idle the
 * Bearer had expired: the user still resolved, but the `member` query failed
 * with PGRST303 'JWT expired', the error was ignored, and the workspace fell
 * through to the user's FIRST membership — not the chat's workspace — so the
 * ownership ACL answered 403 "This chat session belongs to another user or
 * workspace." for the user's own chat.
 *
 * So the Bearer is verified FIRST (`auth.getUser(token)`):
 *   - valid   → that user, and a client pinned to that Bearer (RLS as them);
 *   - invalid or expired → it is IGNORED: the cookie session (refreshed by
 *     @supabase/ssr) resolves the user and the client carries NO Authorization
 *     override, so the DB calls run on the refreshed cookie session; with no
 *     cookie session either → 401 `session_expired` (the transport refreshes
 *     its JWT and retries once);
 *   - an auth-service outage (retryable fetch error) → throw (fail closed as a
 *     server error, never a misleading "session expired").
 * No JWT Bearer (or a `d8d_` device token, handled elsewhere) → the cookie
 * session alone, returning null (skip) when there is none, as before.
 */
async function resolveUserAndClient(
  request: Request
): Promise<{ user: User; supabase: SupabaseClient } | null> {
  const bearer = jwtBearer(request)
  const cookieClient = supabaseFromRequest(request, null)
  if (!bearer) {
    const user = await cookieUser(cookieClient)
    return user ? { user, supabase: cookieClient } : null
  }

  let bearerUser: User | null = null
  let bearerError: { name?: unknown; status?: unknown; code?: unknown } | null = null
  try {
    const { data, error } = await cookieClient.auth.getUser(bearer)
    bearerUser = data?.user ?? null
    bearerError = error ?? null
  } catch (err) {
    bearerError = (err ?? null) as typeof bearerError
  }
  if (bearerUser) return { user: bearerUser, supabase: supabaseFromRequest(request, bearer) }
  if (
    bearerError &&
    (bearerError.name === 'AuthRetryableFetchError' ||
      (typeof bearerError.status === 'number' && bearerError.status >= 500))
  ) {
    throw new Error('[onboarding-researcher/lib/auth] Supabase auth unavailable while verifying the bearer')
  }

  const user = await cookieUser(cookieClient)
  if (user) {
    console.warn(
      `[onboarding-researcher/lib/auth] bearer rejected (${String(bearerError?.code ?? 'invalid')}); using the cookie session for DB reads`
    )
    return { user, supabase: cookieClient }
  }
  throw sessionExpiredError(
    `bearer rejected (${String(bearerError?.code ?? 'invalid')}) and no cookie session`
  )
}

/**
 * The error a failed `member` query becomes. A JWT expiry is the half-expired
 * session case → 401 `session_expired`; anything else fails CLOSED (a thrown
 * server error). Either way the caller must NOT read the failure as "not a
 * member" and fall through to another workspace.
 */
function membershipQueryError(error: { code?: unknown; message?: unknown }): Error {
  if (isJwtExpiredError(error)) {
    return sessionExpiredError(
      `member query rejected the JWT (${String(error.code ?? 'jwt expired')})`
    )
  }
  console.error('[onboarding-researcher/lib/auth] member query failed', { code: error.code })
  return new Error('[onboarding-researcher/lib/auth] workspace membership lookup failed')
}

/**
 * Resolve the active workspace for `user`, mirroring resolveWorkspaceMembership()
 * in src/lib/api-auth.ts: header -> cookie -> first membership, with
 * header/cookie candidates verified against a real `member` row before they're
 * trusted. Only a SUCCESSFUL query with no row falls through to the first
 * membership; a query error throws (see {@link membershipQueryError}).
 */
async function resolveWorkspaceId(
  supabase: SupabaseClient,
  request: Request,
  user: User
): Promise<string | null> {
  const cookieHeader = request.headers.get('cookie') ?? ''
  const parsed = parseCookie(cookieHeader)
  const candidate =
    request.headers.get(WORKSPACE_HEADER) || parsed[WORKSPACE_COOKIE] || null

  if (candidate) {
    const { data: membership, error } = await supabase
      .from('member')
      .select('workspace_id')
      .eq('user_id', user.id)
      .eq('workspace_id', candidate)
      .maybeSingle<{ workspace_id: string }>()
    if (error) throw membershipQueryError(error)
    if (membership) return membership.workspace_id
    // Not a member of the claimed workspace — fall through to first membership.
  }

  // ORDER BY must stay in lockstep with getCurrentWorkspaceId() in
  // src/lib/workspace.ts — without it Postgres may return a different row per
  // query plan, so the Next side and this channel can resolve DIFFERENT
  // workspaces for the same multi-membership user and the ownership ACL below
  // then 403s the user out of their own session.
  const { data, error } = await supabase
    .from('member')
    .select('workspace_id')
    .eq('user_id', user.id)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle<{ workspace_id: string }>()
  if (error) throw membershipQueryError(error)

  return data?.workspace_id ?? null
}

export interface ResolvedSession {
  userId: string
  /** '' when the user has no membership yet — never null (fits eve's
   *  `attributes: Record<string, string | string[]>` shape). */
  workspaceId: string
}

/**
 * Full resolution used by the `supabaseSession()` AuthFn. Returns null (skip)
 * when there is no authenticated user.
 */
export async function resolveSupabaseSession(
  request: Request
): Promise<ResolvedSession | null> {
  const resolved = await resolveUserAndClient(request)
  if (!resolved) return null
  const { user, supabase } = resolved

  const workspaceId = await resolveWorkspaceId(supabase, request, user)
  return { userId: user.id, workspaceId: workspaceId ?? '' }
}

// ---------------------------------------------------------------------------
// Session-ownership ACL
// ---------------------------------------------------------------------------

/**
 * Extract the `:sessionId` from a session-targeting eve route, if any.
 *
 * Named-agent routes are mounted under `/eve/onboarding-researcher/v1/session/...`
 * (send, stream, cancel/compact/clear/reset, subagent streams), but this matcher
 * is deliberately mount-agnostic: it keys off the `.../session/<id>` segment so
 * it survives prefix changes, and matches EVERY route under that id. The bare
 * create route (`.../session` with no id) has no id to check and returns null.
 */
export function extractTargetedSessionId(request: Request): string | null {
  let pathname: string
  try {
    pathname = new URL(request.url).pathname
  } catch {
    return null
  }
  // FAIL CLOSED on ANY path under a session id: capture the first segment after
  // `/session/`, whatever follows it. eve 0.66.3's session-scoped routes
  // (protocol/routes.d.ts) are `/session/:id` (send), `/session/:id/{stream,
  // cancel,compact,clear,reset}`, and the subagent-stream read
  // `/session/:parentSessionId/subagents/:callId/:childSessionId/stream` —
  // eve's own handlers check NO ownership for any of them. Capturing the first
  // segment gates every one of those on the (parent) session's owner, and any
  // route a future eve adds under a session id is gated by default instead of
  // silently skipped. Only the bare create route (`/session`, no id) is exempt.
  const m = pathname.match(/\/session\/([^/]+)(?:\/.*)?$/)
  if (!m) return null
  let id: string
  try {
    id = decodeURIComponent(m[1])
  } catch {
    // Malformed escape: keep the raw segment — it matches no registered id, so
    // the ownership lookup rejects it (fail closed, never "no session").
    id = m[1]
  }
  // `/session` (create) yields no capture; guard against a literal "session".
  return id && id !== 'session' ? id : null
}

/**
 * A service-role client, built from the raw env (no Next request scope). Used
 * ONLY for the ownership lookup — a read against `member.onboarding_progress`
 * that must see rows regardless of RLS/whose cookie is on the request. It never
 * writes and never returns data to the model.
 */
function serviceClient(): SupabaseClient {
  return createClient(
    env('NEXT_PUBLIC_SUPABASE_URL'),
    env('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { persistSession: false } }
  )
}

/**
 * Ownership gate for session-targeting routes.
 *
 * Returns TRUE ("reject") whenever the request targets a specific session id
 * that is not provably owned by `callerUserId`.
 *
 * Returns FALSE ("allow") only when:
 *   - the request targets no specific session (create route / health), OR
 *   - the session id is REGISTERED (present in some member row's
 *     `onboarding_progress.research.sessionId`) to THIS caller.
 *
 * FAIL-CLOSED on unregistered ids. The kickoff route CLAIMS ownership in the DB
 * BEFORE eve mints the session id and registers the real id the instant it
 * exists (see src/app/api/account/onboarding/research/route.ts), so any session
 * a legitimate caller could target is already registered by the time its id is
 * knowable. An id that resolves to NO owner is therefore either not ours or a
 * guess — deny it rather than leak an unowned/orphaned session. (A query error
 * likewise can't prove ownership, so it too denies.)
 */
export async function isSessionOwnedByOther(
  request: Request,
  callerUserId: string
): Promise<boolean> {
  const sessionId = extractTargetedSessionId(request)
  if (!sessionId) return false // no targeted session — nothing to gate

  let owner: { userId: string } | null | undefined
  try {
    owner = await lookupSessionOwner(sessionId)
  } catch {
    // Query failed: can't prove ownership. Fail closed — reject rather than risk
    // cross-user access.
    return true
  }

  if (!owner) return true // unregistered id — deny (not provably ours)
  return owner.userId !== callerUserId
}

/** The header the app's kickoff route vouches for a session create with (src/lib/agent-run/agent-run-token.ts). */
const AGENT_RUN_SECRET_HEADER = 'x-agent-run-secret'

/**
 * Whether `request` creates a session (the bare `POST .../session` route)
 * without the app's internal secret: only the kickoff route
 * (src/app/api/account/onboarding/research/route.ts) starts research, after
 * its owner, once-per-workspace and ChatGPT free-tier checks. A signed-in
 * browser could otherwise create sessions directly, each one a run on Native Intelligence's
 * models and paid web search. Every other route answers false (an existing
 * session is gated by isSessionOwnedByOther). Fails closed: no secret
 * configured means no create is vouched for.
 */
export function isUnvouchedSessionCreate(request: Request): boolean {
  const create = isSessionCreate(request)
  if (create !== true) return create === null
  const expected = process.env.AGENT_RUN_INTERNAL_SECRET || process.env.RUN_SKILL_INTERNAL_SECRET
  const presented = request.headers.get(AGENT_RUN_SECRET_HEADER)
  if (!expected || !presented) return true
  const a = new Uint8Array(Buffer.from(presented, 'utf8'))
  const b = new Uint8Array(Buffer.from(expected, 'utf8'))
  return a.length !== b.length || !timingSafeEqual(a, b)
}

/** Whether `request` is a session create: true, false, or null for a URL that can't be read. */
function isSessionCreate(request: Request): boolean | null {
  if (request.method !== 'POST') return false
  try {
    return /\/session\/?$/.test(new URL(request.url).pathname)
  } catch {
    return null
  }
}

/** Kept in sync with AGENT_RUN_TOKEN_HEADER in src/lib/agent-run/agent-run-token.ts (and ./model.ts). */
const AGENT_RUN_TOKEN_HEADER = 'x-agent-run-token'

/**
 * The plan token a session create carries when the app vouched for it (a
 * free user's research on their own ChatGPT plan, ./model.ts), or null. Only
 * the kickoff route, holding the internal secret, can put a session on a
 * plan; the plan proxy verifies the token itself before any call.
 */
export function vouchedPlanToken(request: Request): string | null {
  if (isSessionCreate(request) !== true || isUnvouchedSessionCreate(request)) return null
  const token = request.headers.get(AGENT_RUN_TOKEN_HEADER)
  return token && token.length <= 4_096 ? token : null
}

/**
 * Find which user (if any) a research sessionId is registered to, by matching
 * `member.onboarding_progress -> 'research' ->> 'sessionId'`. Returns null when
 * no member row registers it. Throws on a genuine query error (caller decides
 * fail-open vs fail-closed).
 *
 * NOTE (later phase): today only THIS agent's sessions register (in
 * research.sessionId). When more agents register sessions, widen this into a
 * generic per-tenant session registry. Until then, an id with no owner is
 * denied by the caller (fail-closed) rather than trusted for unguessability.
 */
async function lookupSessionOwner(
  sessionId: string
): Promise<{ userId: string } | null> {
  const supabase = serviceClient()
  const { data, error } = await supabase
    .from('member')
    .select('user_id')
    .eq('onboarding_progress->research->>sessionId', sessionId)
    .limit(1)
    .maybeSingle<{ user_id: string }>()

  if (error) throw new Error(error.message)
  if (!data) return null
  return { userId: data.user_id }
}

/**
 * eve's localDev(), never on Vercel. eve admits its synthetic `local-dev`
 * principal on an environment flag alone (EVE_DEV=1, which `eve dev` sets, or
 * VERCEL=1 with VERCEL_ENV=development), not on anything about the caller, so
 * one stray variable on a deployment would open every route here to anyone.
 * Local dev sets neither Vercel variable (`next dev` boots `eve dev`), so
 * either one, with any value and whatever NODE_ENV says, means a deployment:
 * skip. Copied in every cloud agent's lib/auth.ts.
 */
export function localDevOffVercel(): AuthFn<Request> {
  const local = localDev()
  return (request) => (process.env.VERCEL !== undefined || process.env.VERCEL_ENV !== undefined ? null : local(request))
}
