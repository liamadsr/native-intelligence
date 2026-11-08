/**
 * Standalone Supabase session resolver + session-ownership ACL for the
 * user-facing `chat-agent` eve HTTP channel (Phase 4 — main chat → eve).
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ TWIN FILE. The Supabase resolver half of this module is a DUPLICATE of   │
 * │ `agents/onboarding-researcher/lib/auth.ts`. Keep the two in sync. The    │
 * │ ownership-ACL half is this agent's own, keyed on                         │
 * │ `chat_conversations.eve_session_id` (migration 190).                     │
 * │                                                                          │
 * │ Why duplicated, not shared: eve compiles each agent root INDEPENDENTLY    │
 * │ (per-root isolation — a declared root discovers its own slots). A         │
 * │ cross-root relative import reaches out of THIS agent root into a          │
 * │ sibling's, coupling two independently-built bundles — the fragility the   │
 * │ migration plan warns against. So each root keeps its own copy; this       │
 * │ header names the twins.                                                    │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * WHY SUPABASE-SESSION AUTH (not the skill-runner's internal shared secret):
 * the chat-agent is USER-FACING — the browser (EveChatTransport) drives its
 * sessions directly with the app's Supabase cookies / `Bearer <jwt>`, same
 * origin. So the channel authenticates the app's Supabase session and enforces
 * the session-ownership ACL. (Contrast the headless skill-runner/coding-agent,
 * which are server-to-server only and use a shared secret with NO ownership
 * ACL.)
 *
 * WHY A STANDALONE RESOLVER (not the app's helpers): the eve route-auth `AuthFn`
 * runs at the channel layer inside eve's Nitro runtime — a SEPARATE service from
 * the Next.js app. That context has no Next.js request scope (`next/headers`
 * throws) and no `@/*` path alias, so the app's `src/lib/api-auth.ts` /
 * `src/lib/supabase/server.ts` / `src/lib/workspace.ts` cannot be imported here.
 * We reuse the SAME underlying primitive the app uses — `createServerClient`
 * from `@supabase/ssr` — fed a cookie adapter built from the raw `Request`
 * headers. Same decode path, same `auth.getUser()` verification, correct outside
 * Next.
 *
 * We mirror the app's resolution semantics exactly:
 *   - user: a VERIFIED `Authorization: Bearer <jwt>` (DB reads then run as it),
 *     else the cookie session (DB reads then run on the cookie session, never
 *     on a stale Bearer) — see resolveUserAndClient; an expired JWT → 401
 *     `session_expired`, never a silent fall-through to another workspace;
 *   - workspace: `x-workspace-id` header -> `workspace_id` cookie -> first
 *     membership, header/cookie candidate TRUSTED ONLY after a `member` check.
 *
 * ── The chat-run token + per-turn ctx (chat-agent-specific) ──────────────────
 * The channel ALSO forwards two request headers onto the principal's attributes
 * so the dynamic resolvers can reach the internal spec/tool routes:
 *   - `x-chat-run-token`  → `attributes.chatRunToken` (HMAC-signed durable facts;
 *      re-verified server-side on the internal routes. On a request that STARTS
 *      model work it is also verified HERE — same user + workspace, not
 *      expired — or the request is refused 403, see assertTurnRunToken: the
 *      usage-limit gate and the usage meter depend on it), and
 *   - `x-chat-run-ctx`    → `attributes.chatRunCtx` (the transport's pre-encoded
 *      base64url per-turn context; forwarded verbatim as the spec route's ?ctx=).
 * These are read AFTER Supabase auth + the ownership ACL succeed, so a caller who
 * fails either never gets a principal at all.
 *
 * ── Device-token principals (/api/device/ask) ────────────────────────────────
 * The chat-agent is also driven by /api/device/ask (the ESP32 one-shot), which
 * runs one one-shot session here per question. It relays the DEVICE's own
 * credential — a `d8d_` device token, which is not a Supabase JWT — so a second
 * resolver ({@link resolveDeviceTokenSession}) maps that token to its owning
 * user + active workspace, exactly like src/lib/device-tokens.ts. The device
 * principal then goes through the SAME ownership ACL as a browser principal
 * ({@link deviceTokenAuthWithAcl}): the route registers each device session on
 * a chat_conversations row owned by that user + workspace before it streams, so
 * a device session is continuable/streamable/cancellable only by its owner, and
 * an unregistered id is refused. A device principal is further bound to its own
 * ask: every request must carry a verified 'device_ask' chat-run token for the
 * same user + workspace, and a targeted session must be registered on the very
 * row that token was minted for — so a d8d_ token can never create a token-less
 * session or reach the user's in-app chats.
 *
 * ── The server principal (idle-time compaction, home turns) ──────────────────
 * One narrow server entry ({@link serverCompactionAuth}): the app's idle
 * compaction (src/lib/chat/idle-compaction.ts) and its server-written home
 * turns (src/lib/chat/home-turn-server.ts, A4 slice 5) present the chat
 * family's internal secret (`x-chat-run-secret`) plus a chat-run token minted
 * for the conversation. It is admitted ONLY for `POST /session/:id/compact`,
 * `GET /session/:id/stream` and, with a `server: 'home_turn'` or
 * `'channel_turn'` token (the person messaging from an outside channel), a
 * `POST /session/:id` send into a home thread whose body is exactly
 * `{ message, turnPolicy: 'queue' }`; and only when `:id` is the eve session
 * registered on the token's own conversation row (same user + workspace).
 * One create: a home- or channel-turn token whose own conversation is the person's home
 * thread may `POST /session` with NO body (a message-free session eve parks:
 * no hooks, no model, nothing billed), for a home thread with no live
 * session; the app registers it on the row before anything targets it. The
 * Now file's check-in creates one the same way for a session of its own,
 * which the app registers on the check-in's home_turn row instead, the only
 * place its token is ever admitted to send or read (lookupCheckInSession).
 * Every other route is 403, so holding the secret never creates a session
 * with a message (or for anything but a home thread), steers, answers an
 * approval or question, cancels, clears or resets anything, and never skips
 * the ACL.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { ForbiddenError, UnauthenticatedError, localDev, type AuthFn } from 'eve/channels/auth'
import { createClient } from '@supabase/supabase-js'
import { createServerClient, type CookieMethodsServer } from '@supabase/ssr'
import { parse as parseCookie } from 'cookie'
import type { SupabaseClient, User } from '@supabase/supabase-js'

/** Kept in sync with `WORKSPACE_HEADER` / `WORKSPACE_COOKIE` in src/lib/workspace.ts. */
const WORKSPACE_HEADER = 'x-workspace-id'
const WORKSPACE_COOKIE = 'workspace_id'

/** Kept in sync with CHAT_RUN_*_HEADER in src/lib/chat/chat-run-token.ts. */
const CHAT_RUN_TOKEN_HEADER = 'x-chat-run-token'
/** The chat family's internal secret, presented only by the server principal. */
const CHAT_RUN_SECRET_HEADER = 'x-chat-run-secret'
/** The transport's pre-encoded per-turn context (base64url JSON). */
const CHAT_RUN_CTX_HEADER = 'x-chat-run-ctx'
/** The id of the reply a send starts or continues (the reply backup writes under it). */
export const CHAT_REPLY_ID_HEADER = 'x-chat-reply-id'

function env(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`[chat-agent/lib/auth] missing required env var ${name}`)
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
  console.warn(`[chat-agent/lib/auth] ${reason} → 401 ${SESSION_EXPIRED_CODE}`)
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
 * so it keeps its own copy. Same copy in
 * `agents/onboarding-researcher/lib/auth.ts`.
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
    throw new Error('[chat-agent/lib/auth] Supabase auth unavailable while verifying the bearer')
  }

  const user = await cookieUser(cookieClient)
  if (user) {
    console.warn(
      `[chat-agent/lib/auth] bearer rejected (${String(bearerError?.code ?? 'invalid')}); using the cookie session for DB reads`
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
  console.error('[chat-agent/lib/auth] member query failed', { code: error.code })
  return new Error('[chat-agent/lib/auth] workspace membership lookup failed')
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
  /** Empty string when the user has no membership yet — never null so it fits
   *  eve's `attributes: Record<string, string | string[]>` shape. */
  workspaceId: string
}

/**
 * Full resolution used by the `supabaseSessionWithAcl()` AuthFn. Returns null
 * (skip) when there is no authenticated user.
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

/**
 * Read the chat-run token + pre-encoded per-turn ctx off the request headers.
 * Stamped onto the principal's attributes ONLY after Supabase auth + the
 * ownership ACL succeed. Both default to '' (fits eve's string-attribute shape).
 * On a request that starts model work the Supabase entry REQUIRES a verified
 * chat-run token for the same user + workspace ({@link assertTurnRunToken}); on
 * the other routes (stream, cancel, …) the token is only forwarded. The
 * internal routes re-verify it either way.
 */
export function chatRunHeaders(request: Request): { chatRunToken: string; chatRunCtx: string } {
  return {
    chatRunToken: request.headers.get(CHAT_RUN_TOKEN_HEADER) ?? '',
    chatRunCtx: request.headers.get(CHAT_RUN_CTX_HEADER) ?? '',
  }
}

/** A reply id as the transport mints it: visible ASCII, bounded. */
const REPLY_ID_PATTERN = /^[\x21-\x7e]{1,200}$/

/**
 * The id of the reply this send starts or continues (`x-chat-reply-id`), or ''
 * when absent or malformed. The transport sends the id it renders the reply
 * under; the reply-backup hook (../hooks/reply-backup.ts) writes the server's
 * copy of the reply under the same id, so the browser's own persist converges
 * on that row. Like the token, stamped only after auth + the ACL succeed. It
 * names a row in the caller's own conversation and nothing else: the internal
 * route scopes the write to the run token's conversation.
 */
export function chatReplyIdHeader(request: Request): string {
  const raw = request.headers.get(CHAT_REPLY_ID_HEADER) ?? ''
  return REPLY_ID_PATTERN.test(raw) ? raw : ''
}

// ---------------------------------------------------------------------------
// Session-ownership ACL
// ---------------------------------------------------------------------------
//
// Route auth (above) identifies the caller but does NOT verify the caller OWNS
// the eve `sessionId` on session-scoped routes (continue, stream, and the
// cancel/compact/clear/reset controls + subagent streams). Phase 4 (main chat -> eve) is
// the first production UI to drive these sessions, so this gate is a hard
// prerequisite: without it, any authenticated user who learns another user's
// session id could continue or stream that session.
//
// Ownership record: a chat-agent session is created for one `chat_conversations`
// row; the EveChatTransport writes `eve_session_id` onto that conversation the
// instant eve mints the id (see migration 190), BEFORE any continue/stream
// request can target it. So an id that resolves to no owning conversation is
// either not ours or a guess — fail CLOSED. Both the conversation's user_id AND
// workspace_id must match the authenticated principal.

/**
 * Extract the `:sessionId` from a session-targeting eve route, if any.
 *
 * The chat-agent mounts under `/eve/chat-agent/v1/session/...`, but this
 * matcher is deliberately mount-agnostic: it keys off the `.../session/<id>`
 * segment so it survives prefix changes, and it matches EVERY route under that
 * id (send, stream, cancel/compact/clear/reset, subagent streams). The bare
 * create route (`.../session` with no id) has no id to check and returns null,
 * so session CREATION is never gated — every route on an EXISTING id is.
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
 * ONLY for the ownership lookup — a read against `chat_conversations` that must
 * see the row regardless of whose cookie is on the request. It never writes and
 * never returns data to the model.
 */
export function serviceClient(): SupabaseClient {
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
 * that is not provably owned by BOTH `callerUserId` and `callerWorkspaceId`.
 *
 * Returns FALSE ("allow") only when:
 *   - the request targets no specific session (create route / health), OR
 *   - the session id is REGISTERED (present on some `chat_conversations` row's
 *     `eve_session_id`) to THIS caller's user AND workspace.
 *
 * FAIL-CLOSED on unregistered ids and on query errors. The EveChatTransport
 * writes `eve_session_id` onto the owning conversation the instant eve mints it
 * (before it drives any turn), so any session a legitimate caller could target
 * is already registered by the time its id is knowable. An id that resolves to
 * NO owner is therefore either not ours or a guess — deny it. A query error
 * likewise can't prove ownership, so it too denies. Workspace is checked too so
 * a user who belongs to the conversation but is acting under a DIFFERENT
 * workspace cannot drive it.
 */
export async function isSessionOwnedByOther(
  request: Request,
  callerUserId: string,
  callerWorkspaceId: string
): Promise<boolean> {
  const sessionId = extractTargetedSessionId(request)
  if (!sessionId) return false // no targeted session — nothing to gate

  let owner: { userId: string; workspaceId: string } | null | undefined
  try {
    owner = await lookupSessionOwner(sessionId)
  } catch {
    // Query failed: can't prove ownership. Fail closed — reject rather than risk
    // cross-user access.
    return true
  }

  if (!owner) return true // unregistered id — deny (not provably ours)
  return owner.userId !== callerUserId || owner.workspaceId !== callerWorkspaceId
}

/**
 * Find which (user, workspace) a chat eve sessionId is registered to, by
 * matching `chat_conversations.eve_session_id`. Returns null when no
 * conversation registers it. Throws on a genuine query error (caller fails
 * CLOSED). The eve_session_id column carries a UNIQUE index (migration 190), so
 * this is a single indexed probe; `.maybeSingle()` is safe.
 */
export async function lookupSessionOwner(
  sessionId: string
): Promise<{ userId: string; workspaceId: string; conversationId: string; isHome: boolean; outsideChannel: string | null; agentGuestId: string | null } | null> {
  const supabase = serviceClient()
  const read = (columns: string) =>
    supabase
      .from('chat_conversations')
      .select(columns)
      .eq('eve_session_id', sessionId)
      .limit(1)
      .maybeSingle<{ id: string; user_id: string; workspace_id: string; is_home?: boolean | null; outside_channel?: string | null; agent_guest_id?: string | null }>()
  let { data, error } = await read('id, user_id, workspace_id, is_home, outside_channel, agent_guest_id')
  // A database without migration 427 (no conversation is a guest's yet), or 414 (nor a channel's).
  if (error?.code === UNDEFINED_COLUMN) ({ data, error } = await read('id, user_id, workspace_id, is_home, outside_channel'))
  if (error?.code === UNDEFINED_COLUMN) ({ data, error } = await read('id, user_id, workspace_id, is_home'))

  if (error) throw new Error(error.message)
  if (!data) return null
  // is_home (migration 330) is true on the person's one home thread, NULL
  // elsewhere; outside_channel (414) names a person's Slack-thread conversation.
  return {
    userId: data.user_id,
    workspaceId: data.workspace_id,
    conversationId: data.id,
    isHome: data.is_home === true,
    outsideChannel: typeof data.outside_channel === 'string' ? data.outside_channel : null,
    agentGuestId: typeof data.agent_guest_id === 'string' ? data.agent_guest_id : null,
  }
}

/** Postgres's undefined_column: a database a migration hasn't reached yet. */
const UNDEFINED_COLUMN = '42703'

/**
 * Where a server turn may send (and create a session): a home thread, and,
 * for a channel turn only, the person's conversation marked with that turn's
 * own channel (a Slack channel thread, migration 414). A guest's channel turn
 * sends only into that guest's own thread, whichever channel it came by (one
 * thread per guest, texting or on Slack: migration 434). Every other server
 * principal stays home-only.
 */
function serverSendTargetOk(owner: { isHome: boolean; outsideChannel: string | null; agentGuestId?: string | null }, claims: VerifiedChatRunClaims): boolean {
  if (claims.guestId !== undefined || owner.agentGuestId) {
    return claims.server === 'channel_turn' && !owner.isHome && !!owner.agentGuestId && owner.agentGuestId === claims.guestId && claims.surface !== undefined && CHANNEL_SURFACES.has(claims.surface)
  }
  if (owner.isHome) return true
  return claims.server === 'channel_turn' && claims.surface !== undefined && owner.outsideChannel === claims.surface
}

// ---------------------------------------------------------------------------
// Device-token principals (/api/device/ask)
// ---------------------------------------------------------------------------

/** Kept in sync with DEVICE_TOKEN_PREFIX in src/lib/device-tokens.ts. */
const DEVICE_TOKEN_PREFIX = 'd8d_'

/**
 * Resolve a `Bearer d8d_…` device token to its owning user + active workspace,
 * mirroring resolveDeviceToken() in src/lib/device-tokens.ts (which this eve root
 * cannot import): look the SHA-256 hash up in `device_token`, refuse an unknown
 * or expired token, and scope to the token's `active_workspace_id`, else the
 * owner's OLDEST membership (same order as the Next side, so both resolve the
 * same workspace and the ACL never 403s a device out of its own session).
 *
 * Returns null (skip) for anything that is not a live device token — a Supabase
 * JWT, no bearer, an unknown/expired token, a lookup error. It never touches
 * `last_used_at`: the Next route already did when it authenticated the device.
 */
export async function resolveDeviceTokenSession(
  request: Request
): Promise<ResolvedSession | null> {
  const authHeader = request.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) return null
  const token = authHeader.slice(7)
  if (!token.startsWith(DEVICE_TOKEN_PREFIX)) return null

  const supabase = serviceClient()
  const tokenHash = createHash('sha256').update(token).digest('hex')
  const { data: row, error } = await supabase
    .from('device_token')
    .select('user_id, active_workspace_id, expires_at')
    .eq('token_hash', tokenHash)
    .maybeSingle<{
      user_id: string
      active_workspace_id: string | null
      expires_at: string | null
    }>()
  if (error || !row) return null
  if (row.expires_at && new Date(row.expires_at) < new Date()) return null

  let workspaceId = row.active_workspace_id
  if (!workspaceId) {
    const { data: membership } = await supabase
      .from('member')
      .select('workspace_id')
      .eq('user_id', row.user_id)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle<{ workspace_id: string }>()
    workspaceId = membership?.workspace_id ?? null
  }
  return { userId: row.user_id, workspaceId: workspaceId ?? '' }
}

/**
 * The internal shared secret — the SAME resolution as spec-client.ts
 * internalSecret() and src/lib/chat/chat-run-token.ts internalSecret():
 * CHAT_INTERNAL_SECRET, else RUN_SKILL_INTERNAL_SECRET. Null when unset (the
 * device and server entries then admit nothing: fail closed).
 */
export function chatRunSecret(): string | null {
  const s = process.env.CHAT_INTERNAL_SECRET
  if (s && s.length > 0) return s
  const fallback = process.env.RUN_SKILL_INTERNAL_SECRET
  return fallback && fallback.length > 0 ? fallback : null
}

/** The claims a verified chat-run token carries (a subset of ChatRunTokenClaims). */
export interface VerifiedChatRunClaims {
  conversationId: string
  workspaceId: string
  userId: string
  /**
   * Absent → the in-app (browser) chat; 'device_ask' → the device one-shot;
   * 'slack' | 'sms' | 'call' → a message the person sent from an outside channel (a
   * Slack message, a text to the Native Intelligence number, what they said on a call to it), only ever
   * together with `server: 'channel_turn'` (twin of ChatRunTokenClaims.surface).
   */
  surface?: 'device_ask' | 'slack' | 'sms' | 'call'
  /**
   * The AI teammate a bots v2 teammate chat is with (twin of
   * ChatRunTokenClaims.teammateId). An ordinary in-app chat for this channel:
   * the same user + workspace binding, no surface semantics.
   */
  teammateId?: string
  /**
   * Where a teammate token talks to its bot (twin of
   * ChatRunTokenClaims.teammateIn): absent, its own thread; 'chat', a main-chat
   * conversation with the bot as its agent (bots v4 Phase C). Only with
   * `teammateId`. An ordinary in-app chat for this channel either way: the
   * same user + workspace binding, metered, no surface semantics.
   */
  teammateIn?: 'chat'
  /**
   * A relayed turn in a bot's own thread (twin of ChatRunTokenClaims.relay,
   * bots v4 Phase A4): the relay row's id. Only with `teammateId`, never with
   * `teammateIn` or a surface. An ordinary in-app chat for this channel: the
   * same user + workspace binding (the relay sends the person's own
   * credential), metered, no surface semantics.
   */
  relay?: string
  /**
   * A token the server minted for itself (twin of ChatRunTokenClaims.server):
   * 'idle_compaction', 'home_turn' or 'channel_turn'. Only 'home_turn' and
   * 'channel_turn' may send, and only into the token's own home thread
   * ({@link serverCompactionAuth}), and the person's own entry refuses every
   * server token ({@link assertTurnRunToken}). 'channel_turn' always carries
   * a channel surface ('slack', 'sms') and a channel surface always means
   * 'channel_turn'; no other server token carries a surface.
   */
  server?: 'idle_compaction' | 'home_turn' | 'channel_turn'
  /**
   * Why a home turn's token was minted (twin of ChatRunTokenClaims.homeTurnReason):
   * only with `server: 'home_turn'`. 'check_in' (the Now file's check-in,
   * docs/plans/now-file.md) runs in a fresh session of its own, registered on
   * its home_turn row, never the thread's ({@link serverCompactionAuth}).
   */
  homeTurnReason?: string
  /**
   * A guest's channel turn (twin of ChatRunTokenClaims.guestId, migrations 428
   * and 434): the person the owner added, in their own thread. Only with
   * `server: 'channel_turn'` and a channel surface ('dial8' always carries one). The profile memory slot resolves no
   * scope for it (./profile-memory.ts): the owner's memory is never read or
   * written from a guest's conversation.
   */
  guestId?: string
  exp: number
}

/** Twin of CHAT_RUN_SERVER_PRINCIPALS in src/lib/chat/chat-run-token.ts. */
const SERVER_PRINCIPALS: ReadonlySet<string> = new Set(['idle_compaction', 'home_turn', 'channel_turn'])

/** Twin of CHANNEL_SURFACES in src/lib/chat/chat-run-token.ts. */
const CHANNEL_SURFACES: ReadonlySet<string> = new Set(['slack', 'sms', 'dial8', 'call'])

/** Twin of GUEST_ONLY_SURFACES in src/lib/chat/chat-run-token.ts. */
const GUEST_ONLY_SURFACES: ReadonlySet<string> = new Set(['dial8'])

/** Twin of CHAT_RUN_SURFACES in src/lib/chat/chat-run-token.ts. */
const SURFACES: ReadonlySet<string> = new Set(['device_ask', ...CHANNEL_SURFACES])

/** The server principals that may send a queued turn into a home thread. */
const SENDING_SERVER_PRINCIPALS: ReadonlySet<string> = new Set(['home_turn', 'channel_turn'])

/**
 * Twin of serverSurfacePairValid in src/lib/chat/chat-run-token.ts: a server
 * token carries no surface, except channel_turn ⇔ a channel surface (each
 * requires the other).
 */
export function serverSurfacePairValid(server: unknown, surface: unknown): boolean {
  const channelSurface = typeof surface === 'string' && CHANNEL_SURFACES.has(surface)
  if (server === 'channel_turn' || channelSurface) return server === 'channel_turn' && channelSurface
  return server === undefined || surface === undefined
}

/**
 * True when a verified token may ride the server entry
 * ({@link serverCompactionAuth}): no relay, and either no surface or a
 * channel turn's own. A device ask never does.
 */
function serverEntryClaimsOk(claims: VerifiedChatRunClaims): boolean {
  if (claims.relay !== undefined) return false
  if (claims.surface === undefined) return true
  return claims.server === 'channel_turn' && CHANNEL_SURFACES.has(claims.surface)
}

/** The claims a device principal must present (a subset of ChatRunTokenClaims). */
export interface DeviceAskRunClaims extends VerifiedChatRunClaims {
  surface: 'device_ask'
}

/**
 * Verify a chat-run token — twin of verifyChatRunToken in
 * src/lib/chat/chat-run-token.ts (this eve root cannot import it; the drift
 * tests verify Next-minted tokens with this copy): HMAC-SHA256 over the
 * base64url payload, constant-time compared, unexpired, well-shaped. A
 * tampered or expired token, a malformed one, or no secret → null.
 *
 * `opts.allowExpired` skips ONLY the expiry check (HMAC + shape still
 * required) — for ATTRIBUTING work that already ran (the usage meter's "was
 * this finished turn a device-ask surface run?"), never for admitting work.
 */
export function verifyChatRunClaims(
  token: string,
  opts?: { allowExpired?: boolean },
): VerifiedChatRunClaims | null {
  const secret = chatRunSecret()
  if (!secret || !token) return null
  const dot = token.indexOf('.')
  if (dot <= 0 || dot === token.length - 1) return null
  const payloadB64 = token.slice(0, dot)
  const presented = new Uint8Array(Buffer.from(token.slice(dot + 1), 'utf8'))
  const expected = new Uint8Array(Buffer.from(createHmac('sha256', secret).update(payloadB64).digest('base64url'), 'utf8'))
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return null
  let claims: Record<string, unknown>
  try {
    claims = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as Record<string, unknown>
  } catch {
    return null
  }
  if (
    !claims ||
    typeof claims.exp !== 'number' ||
    (!opts?.allowExpired && claims.exp <= Date.now()) ||
    typeof claims.conversationId !== 'string' ||
    typeof claims.workspaceId !== 'string' ||
    typeof claims.userId !== 'string' ||
    (claims.agentId !== undefined && typeof claims.agentId !== 'string') ||
    (claims.skillId !== undefined && typeof claims.skillId !== 'string') ||
    (claims.surface !== undefined && (typeof claims.surface !== 'string' || !SURFACES.has(claims.surface))) ||
    (claims.teammateId !== undefined && (typeof claims.teammateId !== 'string' || !claims.teammateId)) ||
    // A bot conversation (bots v4 Phase C): only 'chat', only with a teammate, never about an item.
    (claims.teammateIn !== undefined &&
      (claims.teammateIn !== 'chat' ||
        typeof claims.teammateId !== 'string' ||
        !claims.teammateId ||
        claims.aboutWorkItemId !== undefined ||
        claims.aboutCardId !== undefined)) ||
    // A relayed turn (bots v4 Phase A4): only in a bot's own thread.
    (claims.relay !== undefined &&
      (typeof claims.relay !== 'string' ||
        !claims.relay ||
        typeof claims.teammateId !== 'string' ||
        !claims.teammateId ||
        claims.teammateIn !== undefined ||
        claims.surface !== undefined)) ||
    // A server-minted token (A4): a known principal, never with a relay or a
    // sealed user credential; a channel turn never a teammate's; no surface,
    // except channel_turn ⇔ a channel surface.
    (claims.server !== undefined &&
      (typeof claims.server !== 'string' ||
        !SERVER_PRINCIPALS.has(claims.server) ||
        claims.relay !== undefined ||
        claims.cred !== undefined ||
        (claims.server === 'channel_turn' && (claims.teammateId !== undefined || claims.focusArea !== undefined)))) ||
    !serverSurfacePairValid(claims.server, claims.surface) ||
    // A home turn's reason (twin of the app's check): only on a home turn's token, and a string.
    (claims.homeTurnReason !== undefined && (claims.server !== 'home_turn' || typeof claims.homeTurnReason !== 'string' || !claims.homeTurnReason)) ||
    // A guest's turn (twin of ChatRunTokenClaims.guestId): only a channel turn, by text, Slack or a linked agent.
    (claims.guestId !== undefined &&
      (typeof claims.guestId !== 'string' || !claims.guestId || claims.server !== 'channel_turn' || typeof claims.surface !== 'string' || !CHANNEL_SURFACES.has(claims.surface))) ||
    // A linked agent's turn is always a guest's, never the owner's own.
    (typeof claims.surface === 'string' && GUEST_ONLY_SURFACES.has(claims.surface) && claims.guestId === undefined)
  ) {
    return null
  }
  return claims as unknown as VerifiedChatRunClaims
}

/**
 * A verified chat-run token minted for a DEVICE ASK (`surface === 'device_ask'`).
 * A browser token (no surface), a tampered or expired token, or no secret → null.
 */
export function verifyDeviceAskRunToken(token: string): DeviceAskRunClaims | null {
  const claims = verifyChatRunClaims(token)
  return claims && claims.surface === 'device_ask' ? (claims as DeviceAskRunClaims) : null
}

/**
 * True for a request that STARTS model work on this channel — the only requests
 * whose principal becomes `ctx.session.auth.current` (eve 0.66.3
 * docs/guides/auth-and-route-protection.md: "auth.current: the caller on the
 * active inbound turn"; a follow-up message updates it). On eve 0.66.3's
 * channel (dist/src/eve-channel/index.js) those are POST `/session` (create +
 * first turn), POST `/session/:id` (send, steer, HITL respond) and POST
 * `/session/:id/compact` (a summarization model call). Stream reads, cancel,
 * clear and reset start no model work and are not matched. Mount-agnostic, like
 * {@link extractTargetedSessionId}.
 */
export function isTurnStartingRequest(request: Request): boolean {
  if (request.method.toUpperCase() !== 'POST') return false
  let pathname: string
  try {
    pathname = new URL(request.url).pathname
  } catch {
    return false
  }
  return /\/session(?:\/[^/]+(?:\/compact)?)?\/?$/.test(pathname)
}

/**
 * The Supabase entry's run-token gate: a request that starts model work must
 * carry a VERIFIED chat-run token (HMAC-valid, unexpired) minted for the SAME
 * user + workspace the Supabase session resolved. Throws ForbiddenError
 * otherwise.
 *
 * Which tokens: the in-app token the browser transport mints per send
 * (/api/account/chat/eve-session), and a 'device_ask' token — /api/device/ask
 * relays a JWT- or cookie-authenticated device's Supabase credential through
 * this same entry, with the device-ask token it minted for that ask (its
 * spec/tool access still ends with the ask's ownership row, and it bills as
 * 'device_ask').
 *
 * Why: the token is what the turn's usage-limit gate and the model / persona /
 * tool resolvers read, and what the usage meter bills under. Before this gate
 * the channel stamped whatever header the browser sent (or ''), and every
 * consumer failed SOFT on a missing or bad token — so a client that stripped or
 * corrupted the header ran turns with no usage-limit gate. The mint route runs
 * checkUsageLimits before minting, so this makes "no mint, no turn" structural.
 * It adds a requirement; it never replaces the ownership ACL, and no secret
 * skips it.
 *
 * A 'device_ask' token is bound to ITS ask, as on the device entry
 * (isDeviceSessionForeign): on a request that targets a session, that session
 * must be registered on the conversation row the token was minted for. So a
 * device-ask token cannot drive the user's in-app sessions — turns the usage
 * meter would skip as a surface run while /api/device/ask bills only its own
 * session. Fail closed on an unregistered id or a lookup error. Creating the
 * ask's session (POST /session, no target) stays allowed.
 */
export async function assertTurnRunToken(
  request: Request,
  session: ResolvedSession,
  chatRunToken: string,
): Promise<void> {
  if (!isTurnStartingRequest(request)) return
  const claims = verifyChatRunClaims(chatRunToken)
  // A server-minted token (idle compaction, a home turn) is the server's own:
  // it rides only the server entry with the chat secret, never a person's
  // session, so a leaked one can't start a turn through the browser path.
  if (!claims || claims.server !== undefined || claims.userId !== session.userId || claims.workspaceId !== session.workspaceId) {
    throw new ForbiddenError({
      code: 'chat_run_token_required',
      message: 'A chat turn needs a current chat-run token for this user and workspace.',
    })
  }
  if (claims.surface === 'device_ask' && (await isDeviceSessionForeign(request, session, claims.conversationId))) {
    throw new ForbiddenError({
      code: 'device_run_token_foreign_session',
      message: 'A device-ask run token may only drive the session of its own ask.',
    })
  }
}

/**
 * AuthFn for a device-token principal. A `d8d_` token is a long-lived hardware
 * credential whose ONLY use on this channel is /api/device/ask's one-shot task
 * session, so the device principal is bound to exactly that:
 *   1. resolve the device (owner + active workspace);
 *   2. REQUIRE a verified device-ask chat-run token (x-chat-run-token — the ask's
 *      eve Client sends it on every request: create, stream, cancel) for the SAME
 *      user + workspace. No token, a browser token, another user's / workspace's
 *      token, or an expired one → 403. So a device token alone can neither create
 *      a token-less (ungated, unmetered) session nor drive anything else;
 *   3. on a session-targeting route, the session must be registered to this user
 *      + workspace (the same ownership ACL the Supabase entry runs, fail closed)
 *      AND to the conversation row the token was minted for — so a device can
 *      reach only the session of its own ask, never the user's in-app chats;
 *   4. stamp the chat-run token + per-turn ctx like the Supabase entry.
 * Skips (null) for anything that is not a live device token, so browser traffic
 * never reaches it.
 */
export function deviceTokenAuthWithAcl(): AuthFn<Request> {
  return async (request) => {
    const session = await resolveDeviceTokenSession(request)
    if (!session) return null

    const { chatRunToken, chatRunCtx } = chatRunHeaders(request)
    const claims = verifyDeviceAskRunToken(chatRunToken)
    if (!claims || claims.userId !== session.userId || claims.workspaceId !== session.workspaceId) {
      throw new ForbiddenError({
        code: 'device_run_token_required',
        message: 'A device may only drive the session of its own device ask.',
      })
    }

    if (await isDeviceSessionForeign(request, session, claims.conversationId)) {
      throw new ForbiddenError({
        code: 'session_forbidden',
        message: 'This chat session belongs to another user or workspace.',
      })
    }

    return {
      authenticator: 'device',
      principalId: session.userId,
      principalType: 'user',
      attributes: {
        workspaceId: session.workspaceId,
        chatRunToken,
        chatRunCtx,
      },
    }
  }
}

/**
 * The device twin of {@link isSessionOwnedByOther}: TRUE ("reject") when the
 * request targets a session that is not registered to this user + workspace on
 * the SAME conversation row the device's run token was minted for. Fail closed
 * on an unregistered id and on a lookup error; no targeted session → false.
 */
async function isDeviceSessionForeign(
  request: Request,
  session: ResolvedSession,
  conversationId: string
): Promise<boolean> {
  const sessionId = extractTargetedSessionId(request)
  if (!sessionId) return false
  let owner: Awaited<ReturnType<typeof lookupSessionOwner>>
  try {
    owner = await lookupSessionOwner(sessionId)
  } catch {
    return true
  }
  if (!owner) return true
  return (
    owner.userId !== session.userId ||
    owner.workspaceId !== session.workspaceId ||
    owner.conversationId !== conversationId
  )
}

// ---------------------------------------------------------------------------
// The server principal (idle-time compaction)
// ---------------------------------------------------------------------------

/** What a server caller may do: the method → the one action after `/session/:id`. */
const SERVER_ROUTES: Readonly<Record<string, string>> = { POST: 'compact', GET: 'stream' }

/**
 * The session id of a request the server principal may make, else null:
 * exactly `POST …/session/:id/compact` or `GET …/session/:id/stream` (eve
 * 0.66.3's EVE_SESSION_COMPACT_ROUTE_PATTERN / EVE_SESSION_STREAM_ROUTE_PATTERN).
 * The id is the segment after the FIRST `session` segment, the one
 * {@link extractTargetedSessionId} gates on, and nothing may follow the
 * action. So create, send / steer / respond, cancel, clear, reset, a subagent
 * stream, and any route eve adds later all answer null.
 */
export function serverRouteSessionId(request: Request): string | null {
  const action = SERVER_ROUTES[request.method.toUpperCase()]
  if (!action) return null
  let pathname: string
  try {
    pathname = new URL(request.url).pathname
  } catch {
    return null
  }
  const segments = pathname.split('/')
  const at = segments.indexOf('session')
  if (at < 0) return null
  const rest = segments.slice(at + 1)
  if (rest.length !== 2 || !rest[0] || rest[1] !== action) return null
  let id: string
  try {
    id = decodeURIComponent(rest[0])
  } catch {
    id = rest[0] // matches no registered id: the ownership check refuses it
  }
  return id && id !== 'session' ? id : null
}

/**
 * The session id of a SEND the server principal may make, else null: exactly
 * `POST …/session/:id` (eve 0.66.3's EVE_SESSION_ROUTE_PATTERN), nothing
 * after the id, the id after the FIRST `session` segment (the one
 * {@link extractTargetedSessionId} gates on). Only a home-turn token may use
 * it ({@link serverCompactionAuth}).
 */
export function serverSendSessionId(request: Request): string | null {
  if (request.method.toUpperCase() !== 'POST') return null
  let pathname: string
  try {
    pathname = new URL(request.url).pathname
  } catch {
    return null
  }
  const segments = pathname.split('/')
  const at = segments.indexOf('session')
  if (at < 0) return null
  const rest = segments.slice(at + 1)
  if (rest.length !== 1 || !rest[0]) return null
  let id: string
  try {
    id = decodeURIComponent(rest[0])
  } catch {
    id = rest[0] // matches no registered id: the ownership check refuses it
  }
  return id && id !== 'session' ? id : null
}

/**
 * True for exactly `POST …/session`: eve's create route (EVE_SESSION_ROUTE_PATH),
 * nothing after the first `session` segment. Only a home-turn token may use
 * it, with no body ({@link serverCompactionAuth}).
 */
export function isServerCreateRoute(request: Request): boolean {
  if (request.method.toUpperCase() !== 'POST') return false
  let pathname: string
  try {
    pathname = new URL(request.url).pathname
  } catch {
    return false
  }
  const segments = pathname.split('/')
  const at = segments.indexOf('session')
  return at >= 0 && segments.slice(at + 1).every((segment) => segment === '')
}

/**
 * True when a create request carries no body: a message-free session (eve's
 * client sends none for `sessions.create()` without a message), never a first
 * turn, and no tool stubs. Read from a clone, so eve still reads the body.
 */
export async function isEmptyCreateBody(request: Request): Promise<boolean> {
  try {
    return (await request.clone().text()).trim() === ''
  } catch {
    return false
  }
}

/**
 * The (user, workspace, home) of the conversation a home-turn token names, or
 * null when there is no such row. Throws on a query error (the caller fails
 * CLOSED).
 */
async function lookupConversationOwner(
  conversationId: string,
): Promise<{ userId: string; workspaceId: string; isHome: boolean; outsideChannel: string | null; agentGuestId: string | null } | null> {
  const supabase = serviceClient()
  const read = (columns: string) =>
    supabase
      .from('chat_conversations')
      .select(columns)
      .eq('id', conversationId)
      .limit(1)
      .maybeSingle<{ user_id: string; workspace_id: string; is_home?: boolean | null; outside_channel?: string | null; agent_guest_id?: string | null }>()
  let { data, error } = await read('user_id, workspace_id, is_home, outside_channel, agent_guest_id')
  // A database without migration 427 (no conversation is a guest's yet), or 414 (nor a channel's).
  if (error?.code === UNDEFINED_COLUMN) ({ data, error } = await read('user_id, workspace_id, is_home, outside_channel'))
  if (error?.code === UNDEFINED_COLUMN) ({ data, error } = await read('user_id, workspace_id, is_home'))
  if (error) throw new Error(error.message)
  if (!data) return null
  return {
    userId: data.user_id,
    workspaceId: data.workspace_id,
    isHome: data.is_home === true,
    outsideChannel: typeof data.outside_channel === 'string' ? data.outside_channel : null,
    agentGuestId: typeof data.agent_guest_id === 'string' ? data.agent_guest_id : null,
  }
}

/**
 * True for the Now file's check-in (docs/plans/now-file.md "The check-in"):
 * a verified home turn's token minted for reason 'check_in' (twin of
 * isCheckInClaims in src/lib/chat/chat-run-token.ts).
 */
export function isCheckInClaims(claims: Pick<VerifiedChatRunClaims, 'server' | 'homeTurnReason'>): boolean {
  return claims.server === 'home_turn' && claims.homeTurnReason === 'check_in'
}

/** The home_turn statuses whose check-in may still be sent into and read. */
const CHECK_IN_LIVE_STATUSES = ['claimed', 'sent']

/**
 * The owner of a check-in's own session: the check-in's home_turn row that
 * registers it (eve_session_id, reason 'check_in', on the token's
 * conversation, still claimed or sent: a finished check-in's session is
 * reachable no more), whose conversation is that person's home thread (where
 * its reply lands). Null when there is no such row. Throws on a query error
 * (the caller fails CLOSED).
 */
export async function lookupCheckInSession(
  sessionId: string,
  conversationId: string,
): Promise<{ userId: string; workspaceId: string; conversationId: string; isHome: boolean; outsideChannel: string | null; agentGuestId: string | null } | null> {
  const { data, error } = await serviceClient()
    .from('home_turn')
    .select('conversation_id, user_id, workspace_id')
    .eq('eve_session_id', sessionId)
    .eq('conversation_id', conversationId)
    .eq('reason', 'check_in')
    .in('status', CHECK_IN_LIVE_STATUSES)
    .limit(1)
    .maybeSingle<{ conversation_id: string; user_id: string; workspace_id: string }>()
  if (error) throw new Error(error.message)
  if (!data) return null
  const conversation = await lookupConversationOwner(data.conversation_id)
  if (!conversation || !conversation.isHome || conversation.agentGuestId) return null
  if (conversation.userId !== data.user_id || conversation.workspaceId !== data.workspace_id) return null
  return { userId: data.user_id, workspaceId: data.workspace_id, conversationId: data.conversation_id, isHome: true, outsideChannel: null, agentGuestId: null }
}

/** The longest background update a home turn may send (the app builds a few KB). */
export const SERVER_SEND_MAX_CHARS = 32_000

/** The only keys a home turn's send body may hold. */
const SERVER_SEND_KEYS: ReadonlySet<string> = new Set(['message', 'turnPolicy'])

/**
 * True when a home turn's send body is exactly `{ message, turnPolicy: 'queue' }`:
 * a non-empty string message (at most
 * {@link SERVER_SEND_MAX_CHARS}), queued behind anything running (never a
 * steer into the person's turn), and nothing else: no `clientContext` (one-turn
 * text the model reads, which the server never needs) and no
 * `inputResponses`: the secret can never answer an approval or a question.
 * Read from a clone, so eve still reads the body. A body that isn't JSON → false.
 */
export async function isQueuedServerSendBody(request: Request): Promise<boolean> {
  let body: unknown
  try {
    body = await request.clone().json()
  } catch {
    return false
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false
  const b = body as Record<string, unknown>
  for (const key of Object.keys(b)) if (!SERVER_SEND_KEYS.has(key)) return false
  if (typeof b.message !== 'string' || b.message.trim().length === 0 || b.message.length > SERVER_SEND_MAX_CHARS) return false
  return b.turnPolicy === 'queue'
}

/**
 * eve's request id for a session-limit prompt on the lifetime INPUT budget
 * (eve 0.79.1 harness/hitl/budget-request.js: `<session>:<turn>:limit:input:<used>`).
 */
const SESSION_LIMIT_INPUT_REQUEST_RE = /:limit:input:\d+$/

/**
 * True when a server turn's body is exactly one Continue on eve's lifetime
 * input-budget prompt:
 * `{ inputResponses: [{ requestId: '…:limit:input:N', optionId: 'continue' }] }`.
 * The main chat has no input budget (../agent.ts); a session created before
 * that keeps eve's 40M default, and its prompt has one right answer, which a
 * home or channel turn (a text, Slack) gives so the person never has to. The
 * one answer the secret can ever give: never an approval, a question, a Stop,
 * or any other limit. Read from a clone, so eve still reads the body.
 */
export async function isSessionLimitContinueBody(request: Request): Promise<boolean> {
  let body: unknown
  try {
    body = await request.clone().json()
  } catch {
    return false
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false
  const keys = Object.keys(body)
  if (keys.length !== 1 || keys[0] !== 'inputResponses') return false
  const responses = (body as { inputResponses?: unknown }).inputResponses
  if (!Array.isArray(responses) || responses.length !== 1) return false
  const r = responses[0]
  if (!r || typeof r !== 'object' || Array.isArray(r)) return false
  const rk = Object.keys(r).sort()
  if (rk.length !== 2 || rk[0] !== 'optionId' || rk[1] !== 'requestId') return false
  const { requestId, optionId } = r as { requestId?: unknown; optionId?: unknown }
  return (
    optionId === 'continue' &&
    typeof requestId === 'string' &&
    requestId.length <= 300 &&
    SESSION_LIMIT_INPUT_REQUEST_RE.test(requestId)
  )
}

/** Constant-time equality; false when either side is empty or the lengths differ. */
function secretMatches(presented: string, expected: string | null): boolean {
  if (!expected || !presented) return false
  const a = new Uint8Array(Buffer.from(presented, 'utf8'))
  const b = new Uint8Array(Buffer.from(expected, 'utf8'))
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * AuthFn for the app's two server callers: idle-time compaction
 * (src/lib/chat/idle-compaction.ts) and server-written home turns
 * (src/lib/chat/home-turn-server.ts, A4 slice 5):
 *   1. no `x-chat-run-secret` header → skip (null): the person and device
 *      entries decide, unchanged;
 *   2. the header must equal the chat family's internal secret
 *      (CHAT_INTERNAL_SECRET, else RUN_SKILL_INTERNAL_SECRET), compared in
 *      constant time → else 401;
 *   3. the route must be `POST …/session/:id/compact`, `GET …/session/:id/stream`
 *      ({@link serverRouteSessionId}), `POST …/session/:id`, a send
 *      ({@link serverSendSessionId}), or `POST …/session`, a create
 *      ({@link isServerCreateRoute}) → else 403;
 *   4. `x-chat-run-token` must be a VERIFIED, unexpired chat-run token for an
 *      in-app conversation (no device-ask surface, no relay; the one surface
 *      admitted is a channel turn's own) → else 403;
 *   5. a send needs the token's `server: 'home_turn'` or `'channel_turn'`
 *      claim (the person messaging from an outside channel,
 *      docs/plans/slack-connect.md), and such a token may send and read the
 *      stream but never compact → else 403;
 *   6. the targeted session must be the one registered on THAT token's
 *      conversation row, for the token's user + workspace (fail closed on an
 *      unregistered id or a lookup error) → else 403. A check-in's token
 *      (reason 'check_in', docs/plans/now-file.md) instead reaches only the
 *      fresh session its own home_turn row registers while that row is
 *      claimed or sent ({@link lookupCheckInSession}), never one a
 *      conversation registers: the home thread's history never reaches it;
 *   7. a send must target a home thread (`is_home`, migration 330), or, for a
 *      channel turn only, the person's conversation marked with its own
 *      channel (`outside_channel`, migration 414: a Slack channel thread), and its
 *      body must be exactly `{ message, turnPolicy: 'queue' }`
 *      ({@link isQueuedServerSendBody}): never a steer into the person's turn,
 *      and no `inputResponses` (the secret can't answer an approval or a
 *      question), with ONE exception: a single Continue on eve's lifetime
 *      input-budget prompt ({@link isSessionLimitContinueBody}), which the
 *      main chat no longer has and a session from before keeps → else 403;
 *   8. a create needs a home- or channel-turn token whose own conversation row is the
 *      person's home thread (same user + workspace, `is_home`; fail closed on
 *      a lookup error), and NO body ({@link isEmptyCreateBody}): a parked
 *      session, never a first turn → else 403. It targets no session, so
 *      step 6 has nothing to check; the app registers the new id on the row
 *      (conditionally: never over a live one) before anything can target it.
 * The principal acts for the conversation's person. A send makes it eve's
 * `auth.current` for that turn: its run token (no sealed credential) is what
 * the spec, tool and usage routes read, so a home turn is held to reads
 * (isServerTurnTool) while a channel turn acts with the person's tools minus
 * its surface's exclusions; its ask_user answers instead of parking, and it is
 * billed as `ai_chat` to the token's user. The compact command carries no
 * auth of its own (re-checked in eve 0.79.1: channel/session.js `compact()`
 * sends no principal, and maybeCompact reads the session's stored auth, the
 * last turn's), so a manual compaction bills under the session's last
 * turn's token, else its owner: the same person and workspace step 6 checked.
 */
export function serverCompactionAuth(): AuthFn<Request> {
  return async (request) => {
    const presented = request.headers.get(CHAT_RUN_SECRET_HEADER)
    if (!presented) return null

    if (!secretMatches(presented, chatRunSecret())) {
      console.warn('[chat-agent/lib/auth] server caller: internal secret rejected → 401')
      throw new UnauthenticatedError({
        code: 'server_secret_invalid',
        message: 'The internal secret does not match.',
      })
    }

    const routeSessionId = serverRouteSessionId(request)
    const sendSessionId = routeSessionId ? null : serverSendSessionId(request)
    const sessionId = routeSessionId ?? sendSessionId
    if (!sessionId && isServerCreateRoute(request)) return serverCreatePrincipal(request)
    if (!sessionId) {
      throw new ForbiddenError({
        code: 'server_route_forbidden',
        message: 'A server caller may only compact a chat session, read its stream, or queue a home turn.',
      })
    }

    const { chatRunToken } = chatRunHeaders(request)
    const claims = verifyChatRunClaims(chatRunToken)
    if (!claims || !serverEntryClaimsOk(claims)) {
      throw new ForbiddenError({
        code: 'server_run_token_required',
        message: 'A server caller needs a current chat-run token for the conversation.',
      })
    }

    const isSend = sendSessionId !== null
    const isCompact = request.method.toUpperCase() === 'POST' && !isSend
    const sends = claims.server !== undefined && SENDING_SERVER_PRINCIPALS.has(claims.server)
    if ((isSend && !sends) || (isCompact && sends)) {
      throw new ForbiddenError({
        code: 'server_route_forbidden',
        message: isSend
          ? 'Only a home-turn or channel-turn token may send into a chat session.'
          : 'A home-turn or channel-turn token may not compact a chat session.',
      })
    }

    // A check-in's token reaches only its own fresh session, registered on its
    // home_turn row while that turn is claimed or sent; never a session a
    // conversation registers (the home thread's included). Every other token
    // reaches only its conversation's.
    let owner: Awaited<ReturnType<typeof lookupSessionOwner>> = null
    try {
      owner = isCheckInClaims(claims) ? await lookupCheckInSession(sessionId, claims.conversationId) : await lookupSessionOwner(sessionId)
    } catch {
      owner = null
    }
    if (
      !owner ||
      owner.conversationId !== claims.conversationId ||
      owner.userId !== claims.userId ||
      owner.workspaceId !== claims.workspaceId
    ) {
      throw new ForbiddenError({
        code: 'session_forbidden',
        message: "This chat session is not the run token's conversation.",
      })
    }

    if (isSend) {
      if (!serverSendTargetOk(owner, claims)) {
        throw new ForbiddenError({
          code: 'server_send_not_home',
          message: "A server turn may only be sent into a home thread (or a channel turn into its own channel's conversation).",
        })
      }
      if (!(await isQueuedServerSendBody(request)) && !(await isSessionLimitContinueBody(request))) {
        throw new ForbiddenError({
          code: 'server_send_body_forbidden',
          message: "A server turn's body must be exactly { message, turnPolicy: 'queue' }, or one Continue on the input-budget prompt.",
        })
      }
    }

    return {
      authenticator: 'server',
      principalId: claims.userId,
      principalType: 'service',
      attributes: {
        workspaceId: claims.workspaceId,
        chatRunToken,
        chatRunCtx: '',
      },
    }
  }
}

/**
 * Step 8 of {@link serverCompactionAuth}: a home or channel turn creating a parked
 * session for a home thread that has no live one (the secret already
 * matched). A home-turn token, for a conversation that is the token's
 * person's home thread in the token's workspace, and no body; else 403.
 */
async function serverCreatePrincipal(request: Request) {
  const { chatRunToken } = chatRunHeaders(request)
  const claims = verifyChatRunClaims(chatRunToken)
  if (!claims || !serverEntryClaimsOk(claims) || claims.server === undefined || !SENDING_SERVER_PRINCIPALS.has(claims.server)) {
    throw new ForbiddenError({
      code: 'server_route_forbidden',
      message: 'Only a home-turn or channel-turn token may create a chat session.',
    })
  }
  let owner: Awaited<ReturnType<typeof lookupConversationOwner>> = null
  try {
    owner = await lookupConversationOwner(claims.conversationId)
  } catch {
    owner = null
  }
  if (!owner || !serverSendTargetOk(owner, claims) || owner.userId !== claims.userId || owner.workspaceId !== claims.workspaceId) {
    throw new ForbiddenError({
      code: 'server_create_not_home',
      message: "A server caller may only create a session for a home thread (or a channel turn for its own channel's conversation).",
    })
  }
  if (!(await isEmptyCreateBody(request))) {
    throw new ForbiddenError({
      code: 'server_create_body_forbidden',
      message: 'A server-created session starts without a message.',
    })
  }
  return {
    authenticator: 'server',
    principalId: claims.userId,
    principalType: 'service' as const,
    attributes: {
      workspaceId: claims.workspaceId,
      chatRunToken,
      chatRunCtx: '',
    },
  }
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
