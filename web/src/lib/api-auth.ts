/**
 * Centralized auth + workspace resolution for API routes.
 *
 * Before this helper existed, every account API route repeated this dance:
 *
 *   const supabase = await createClient()
 *   const { data: { user } } = await supabase.auth.getUser()
 *   if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
 *   const workspaceId = await getCurrentWorkspaceId()
 *   if (!workspaceId) return NextResponse.json({ error: 'No workspace' }, { status: 400 })
 *
 * Centralizing means we can:
 *   1. Change auth/workspace resolution in one place
 *   2. Standardize error shapes (see api-errors.ts)
 *   3. Make tests shorter — mock one helper, not four
 *
 * Usage:
 *   // Simple case
 *   const auth = await requireWorkspace()
 *   if (auth instanceof Response) return auth
 *   const { supabase, user, workspaceId } = auth
 *
 *   // Need the workspace-scoped member record too
 *   const auth = await requireWorkspaceMember()
 *   if (auth instanceof Response) return auth
 *   const { supabase, user, workspaceId, member } = auth
 */
import { timingSafeEqual } from 'crypto'
import type { SupabaseClient, User } from '@supabase/supabase-js'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { cookies, headers } from 'next/headers'
import { createClient } from '@/lib/supabase/server'
import { getServiceClient } from '@/lib/supabase/service'
import { WORKSPACE_COOKIE, WORKSPACE_HEADER, followWorkspaceMerges } from '@/lib/workspace'
import { apiError, unauthorized, noWorkspace, notMember, serverError, sessionExpired, featureDisabled } from '@/lib/api-errors'
import { isDeviceToken, resolveDeviceToken } from '@/lib/device-tokens'
import {
  FEATURES,
  isFeatureEnabled,
  resolveWorkspaceEdition,
  type FeatureKey,
} from '@/lib/editions'

/**
 * Authorize a Vercel cron request against CRON_SECRET.
 *
 * Fails CLOSED: if CRON_SECRET is unset/empty the route is refused (503),
 * because otherwise the comparison would be against `Bearer undefined`, which
 * an anonymous caller could reproduce to pass the gate. The Bearer token is
 * compared to the secret with a constant-time comparison (guarding the length
 * mismatch that would otherwise make timingSafeEqual throw).
 *
 * Returns null when the request is authorized, otherwise the Response to
 * return. Vercel cron issues requests with `Authorization: Bearer ${CRON_SECRET}`.
 */
export function requireCronSecret(request: Request): Response | null {
  const secret = process.env.CRON_SECRET
  if (!secret) {
    return apiError('Cron not configured', { status: 503, code: 'CRON_NOT_CONFIGURED' })
  }

  const authHeader = request.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) return unauthorized()

  const provided = authHeader.slice('Bearer '.length)
  const providedBuf = new Uint8Array(Buffer.from(provided))
  const expectedBuf = new Uint8Array(Buffer.from(secret))
  // timingSafeEqual throws on unequal-length buffers — guard first so a
  // length mismatch is a clean 401 rather than a 500.
  if (providedBuf.length !== expectedBuf.length) return unauthorized()
  if (!timingSafeEqual(providedBuf, expectedBuf)) return unauthorized()

  return null
}

/**
 * Build an anon-key Supabase client bound to a Supabase access token via the
 * standard `global.headers.Authorization` pattern. Every PostgREST query on
 * this client runs AS that token's user with RLS intact.
 *
 * This is the crux of the "half-expired session" fix: when the cookie session
 * is dead but a valid Bearer JWT is present, the cookie-based client would run
 * downstream queries as ANON (its per-request access token falls back to the
 * anon key), so every RLS-filtered read returns empty — surfacing as a bogus
 * "No workspace" for a real member. Binding the token here keeps the identity.
 *
 * Session persistence / auto-refresh are disabled: this client is created
 * per-request and discarded, and the default auto-refresh starts a permanent
 * 30s interval timer that is never cleared (a leaked timer + pinned closure
 * per Bearer request in a long-lived process).
 */
function createTokenBoundClient(token: string): SupabaseClient {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    }
  )
}

/**
 * Result of resolving the authenticated user. `client` is the Supabase client
 * downstream queries MUST use so they run under the resolved identity:
 *   - cookie/device auth  → `null` (caller keeps the cookie-based client)
 *   - Supabase Bearer JWT → a token-bound anon client (see above)
 */
interface ResolvedUser {
  user: User
  client: SupabaseClient | null
}

/**
 * Resolve the authenticated user from the request.
 *
 * Tries the cookie-based Supabase session first (browser clients), then
 * falls back to an `Authorization: Bearer <token>` header for non-browser
 * clients (desktop app, hardware devices, MCP). The bearer token is either a
 * Dial8 device token (`d8d_…`, validated against device_token) or a Supabase
 * access token (`eyJ…`, validated by a client bound to that token).
 *
 * When the user is resolved from a Supabase Bearer JWT, we return a
 * token-bound client so downstream RLS queries run AS the user. Cookie and
 * device-token auth return `client: null` and keep the caller's cookie client
 * (device routes pin the workspace explicitly and don't lean on cookie RLS).
 *
 * This mirrors the inline fallback in /api/deepgram-token, centralized so
 * every route built on requireUser/requireWorkspace accepts all auth modes.
 */
async function resolveUser(
  supabase: SupabaseClient
): Promise<ResolvedUser | null> {
  // Tolerate getUser() throwing: a non-JWT Bearer (e.g. a device token) can
  // make the cookie/JWT client reject the request rather than return null. We
  // still want to fall through to the device-token branch below.
  try {
    const { data: { user } } = await supabase.auth.getUser()
    if (user) return { user, client: null }
  } catch {
    // fall through to Bearer handling
  }

  // Bearer fallback is purely additive: if anything here fails (including
  // headers() being called outside a request scope), fall through to null
  // and let the cookie result stand.
  try {
    const headerStore = await headers()
    const authHeader = headerStore.get('authorization')
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7)

      // Device token: opaque secret resolving to a user + pinned workspace.
      if (isDeviceToken(token)) {
        const resolved = await resolveDeviceToken(token)
        if (!resolved) return null
        // device_token has no FK into auth.users data we return, so synthesize
        // the minimal User the callers use (they only read `.id`). Device
        // routes pin the workspace themselves, so keep the cookie client.
        return { user: { id: resolved.userId } as User, client: null }
      }

      // Otherwise treat it as a Supabase access token. Validate it AND bind a
      // client to it so downstream RLS queries run as this user — the cookie
      // client would run them as anon once the cookie session has expired.
      const tokenClient = createTokenBoundClient(token)
      const { data } = await tokenClient.auth.getUser(token)
      if (!data.user) return null
      return { user: data.user, client: tokenClient }
    }
  } catch {
    // no-op: no request scope / no header — cookie auth already decided
  }

  return null
}

export interface AuthContext {
  supabase: SupabaseClient
  user: User
}

export interface WorkspaceAuthContext extends AuthContext {
  workspaceId: string
}

export interface WorkspaceMember {
  id: string
  role?: string | null
}

export interface MemberAuthContext extends WorkspaceAuthContext {
  member: WorkspaceMember
}

/**
 * Resolve the authenticated user. Returns a 401 Response if no session.
 *
 * When the user was resolved from a Supabase Bearer JWT, the returned
 * `supabase` is a token-bound client (RLS runs as the user) rather than the
 * cookie client — otherwise a half-expired cookie session would leave every
 * downstream query running as anon.
 */
export async function requireUser(): Promise<AuthContext | Response> {
  const supabase = await createClient()
  const resolved = await resolveUser(supabase)

  if (!resolved) return unauthorized()
  return { supabase: resolved.client ?? supabase, user: resolved.user }
}

/**
 * If the request carries a device token, return the workspace it's pinned to.
 * Stateless (re-reads the header), so it's safe under concurrency — no shared
 * module state between overlapping requests. Returns null for non-device auth.
 */
async function deviceTokenWorkspace(): Promise<string | null> {
  try {
    const headerStore = await headers()
    const authHeader = headerStore.get('authorization')
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7)
      if (isDeviceToken(token)) {
        const resolved = await resolveDeviceToken(token)
        return resolved?.workspaceId ?? null
      }
    }
  } catch {
    // no request scope / no header
  }
  return null
}

/**
 * Thrown by resolveWorkspaceMembership when a membership query returns a
 * Supabase ERROR (transient DB failure, RLS misconfig, etc.) rather than a
 * clean empty result. Callers translate this into a 500 so a real DB error
 * isn't misreported as "No workspace" (which would tell a genuine member they
 * aren't in any workspace).
 *
 * The message is intentionally GENERIC and carries no upstream text: the ~20
 * legacy API callers that echo `error.message` into their 500 bodies must not
 * leak DB internals (e.g. "permission denied for table member") to clients.
 * The raw Supabase error is logged server-side at the throw site instead.
 */
class MembershipQueryError extends Error {
  constructor() {
    super('Membership query failed')
    this.name = 'MembershipQueryError'
  }
}

/**
 * Thrown by resolveWorkspaceMembership when the membership query fails because
 * the caller's Supabase JWT has EXPIRED — the half-expired-session case (the
 * cookie session authenticated the user, but the token-bound client the
 * membership query runs on carries a stale Bearer that PostgREST rejects).
 *
 * This is a distinct branch from MembershipQueryError so callers map it to a
 * 401 (SESSION_EXPIRED) the client can refresh + retry, rather than a 500 for a
 * transient DB failure. The message 'Session expired' is safe to surface (no DB
 * internals), so unlike MembershipQueryError it carries user-facing copy.
 */
class SessionExpiredError extends Error {
  constructor() {
    super('Session expired')
    this.name = 'SessionExpiredError'
  }
}

/**
 * True when a Supabase/PostgREST error is an EXPIRED-JWT rejection: PGRST303 is
 * PostgREST's dedicated expired-token code; the message check is a belt-and-
 * suspenders for older/proxied errors that carry the text but not the code.
 */
function isJwtExpiredError(error: { code?: unknown; message?: unknown }): boolean {
  return (
    error.code === 'PGRST303' ||
    /jwt expired/i.test(typeof error.message === 'string' ? error.message : '')
  )
}

/**
 * Resolve workspace + member row for an already-authenticated user in ONE
 * member query. Resolution order matches getCurrentWorkspaceId():
 * header (desktop multi-window) > cookie > first membership — and a claimed
 * workspace is only trusted when the user actually has a member row in it.
 *
 * The single query doubles as both membership verification AND member fetch,
 * replacing the old requireWorkspace -> getCurrentWorkspaceId ->
 * requireWorkspaceMember chain that re-resolved the user (a second
 * auth.getUser() network round-trip) and queried `member` twice per request.
 *
 * Returns `null` only for a genuinely-empty result (the user is in no
 * workspace). A query error throws MembershipQueryError so it surfaces as a
 * 500, never as a false "No workspace".
 */
async function resolveWorkspaceMembership(
  supabase: SupabaseClient,
  user: User,
  select: string,
): Promise<{ workspaceId: string; member: WorkspaceMember } | null> {
  let candidate: string | null = null
  try {
    const headerStore = await headers()
    candidate = headerStore.get(WORKSPACE_HEADER)
    if (!candidate) {
      const cookieStore = await cookies()
      candidate = cookieStore.get(WORKSPACE_COOKIE)?.value ?? null
    }
  } catch {
    // no request scope — fall through to first membership
  }

  const fields = `workspace_id, ${select}`

  if (candidate) {
    const { data, error } = await supabase
      .from('member')
      .select(fields)
      .eq('user_id', user.id)
      .eq('workspace_id', candidate)
      .maybeSingle<WorkspaceMember & { workspace_id: string }>()
    // A real query error must not be silently read as "not a member" — that
    // would fall through to a bogus first-membership lookup / NO_WORKSPACE.
    // Log the raw error server-side; throw a generic one (no upstream text).
    // An EXPIRED JWT (PGRST303) is its own case — a half-expired session, not a
    // DB failure — so it throws SessionExpiredError → a 401 the client retries.
    if (error) {
      console.error('[api-auth] membership verify query failed:', error)
      if (isJwtExpiredError(error)) throw new SessionExpiredError()
      throw new MembershipQueryError()
    }
    if (data) return { workspaceId: data.workspace_id, member: data }
    // Not a member of the claimed workspace: it may have been MERGED into one
    // they are in (workspace_merge, migration 402) — follow it before falling
    // through to the first membership, or a stale tab lands in the oldest one.
    const merged = await followWorkspaceMerges(supabase, user.id, candidate, select)
    if (merged) return { workspaceId: merged.workspace_id, member: merged as unknown as WorkspaceMember }
  }

  // Deterministic "first" membership — ordered to match getCurrentWorkspaceId's
  // fallback exactly, so an API route and a server-component render in the same
  // navigation can never resolve different workspaces for a cookie-less
  // multi-membership user (that divergence is how redirect decisions disagree).
  const { data, error } = await supabase
    .from('member')
    .select(fields)
    .eq('user_id', user.id)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle<WorkspaceMember & { workspace_id: string }>()

  if (error) {
    console.error('[api-auth] first-membership query failed:', error)
    if (isJwtExpiredError(error)) throw new SessionExpiredError()
    throw new MembershipQueryError()
  }
  return data ? { workspaceId: data.workspace_id, member: data } : null
}

/**
 * Resolve the authenticated user AND current workspace.
 * Returns 401 if no user, 400 if no workspace can be determined.
 *
 * Device tokens are pinned to a workspace, so for device-authed requests we
 * use that workspace directly rather than the cookie/header path (which a
 * headless device doesn't set).
 */
export async function requireWorkspace(): Promise<
  WorkspaceAuthContext | Response
> {
  const auth = await requireUser()
  if (auth instanceof Response) return auth

  // A device token's pinned workspace is checked only when it is SET, so a
  // person removed from it since must not keep reaching it: verify the member
  // row. A device-token request carries no Supabase session (auth.supabase is
  // the anon cookie client, which member RLS shows nothing), so the check runs
  // service-role, fenced on the token's own user id.
  const deviceWorkspaceId = await deviceTokenWorkspace()
  if (deviceWorkspaceId) {
    const { data: member, error } = await getServiceClient()
      .from('member')
      .select('id')
      .eq('user_id', auth.user.id)
      .eq('workspace_id', deviceWorkspaceId)
      .maybeSingle()
    if (error) {
      console.error('[api-auth] device workspace membership query failed:', error)
      return isJwtExpiredError(error) ? sessionExpired() : serverError()
    }
    if (!member) return notMember()
    return { ...auth, workspaceId: deviceWorkspaceId }
  }

  let membership: { workspaceId: string; member: WorkspaceMember } | null
  try {
    membership = await resolveWorkspaceMembership(auth.supabase, auth.user, 'id')
  } catch (err) {
    // An expired JWT is a 401 the client refreshes + retries, NOT a 500.
    if (err instanceof SessionExpiredError) return sessionExpired()
    // A DB error resolving membership is a 500, not a false "No workspace".
    if (err instanceof MembershipQueryError) return serverError()
    throw err
  }
  if (!membership) return noWorkspace()

  return { ...auth, workspaceId: membership.workspaceId }
}

/**
 * Resolve user + workspace + verify the user has a member row in the
 * workspace (and return it). This is what most account API routes need
 * when they want to reference the member by id (e.g. `assignee_id`).
 *
 * Returns 401/400 for missing user/workspace, 403 if not a member.
 */
export async function requireWorkspaceMember(options?: {
  /** Fields to fetch from the member row. Defaults to just `id`. */
  select?: string
}): Promise<MemberAuthContext | Response> {
  const auth = await requireUser()
  if (auth instanceof Response) return auth

  const { supabase, user } = auth
  const select = options?.select ?? 'id'

  // Device tokens pin the workspace, so membership is checked against it
  // directly — the only path that can still produce 403 NOT_MEMBER (cookie/
  // header resolution below only ever lands on workspaces the user is in).
  // As in requireWorkspace, a device-token request has no Supabase session
  // (`supabase` is the anon cookie client, which member RLS shows nothing), so
  // the read runs service-role, fenced on the token's user + pinned workspace.
  const deviceWorkspaceId = await deviceTokenWorkspace()
  if (deviceWorkspaceId) {
    const { data: member, error } = await getServiceClient()
      .from('member')
      .select(select)
      .eq('user_id', user.id)
      .eq('workspace_id', deviceWorkspaceId)
      .maybeSingle<WorkspaceMember>()
    if (error) {
      console.error('[api-auth] device workspace membership query failed:', error)
      return isJwtExpiredError(error) ? sessionExpired() : serverError()
    }
    if (!member) return notMember()
    return { supabase, user, workspaceId: deviceWorkspaceId, member }
  }

  let membership: { workspaceId: string; member: WorkspaceMember } | null
  try {
    membership = await resolveWorkspaceMembership(supabase, user, select)
  } catch (err) {
    // An expired JWT is a 401 the client refreshes + retries, NOT a 500.
    if (err instanceof SessionExpiredError) return sessionExpired()
    // A DB error resolving membership is a 500, not a false "No workspace".
    if (err instanceof MembershipQueryError) return serverError()
    throw err
  }
  if (!membership) return noWorkspace()

  return { supabase, user, workspaceId: membership.workspaceId, member: membership.member }
}


/**
 * Gate a route on a workspace FEATURE being effectively on.
 *
 * Call immediately after `requireWorkspace()`; a non-null return is the Response
 * to hand back. Reads the workspace settings through the caller's RLS client
 * (settings are member-readable), so it costs one extra read per call and
 * cannot see a workspace the caller isn't in.
 *
 *   const auth = await requireWorkspace(); if (auth instanceof Response) return auth
 *   const gated = await requireWorkspaceFeature(auth, 'evals'); if (gated) return gated
 */
export async function requireWorkspaceFeature(
  auth: WorkspaceAuthContext,
  feature: FeatureKey,
): Promise<Response | null> {
  const resolved = await resolveWorkspaceEdition(auth.supabase, auth.workspaceId)
  if (isFeatureEnabled(resolved, feature)) return null
  return featureDisabled(`\`${FEATURES[feature].label}\` is not enabled for this workspace`)
}
