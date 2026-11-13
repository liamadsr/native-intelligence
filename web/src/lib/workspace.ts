import { cookies, headers } from 'next/headers'
import { createStatelessClient } from '@/lib/supabase/stateless'
import { createClient } from '@/lib/supabase/server'
import { isDeviceToken, isDeviceWorkspaceMember, resolveDeviceToken } from '@/lib/device-tokens'
import { serverError, sessionExpired } from '@/lib/api-errors'
import type { SupabaseClient, User } from '@supabase/supabase-js'

/**
 * Thrown by getCurrentWorkspaceId() when the membership query itself fails.
 * `kind` distinguishes the half-expired-session case (dead cookie, stale
 * Bearer — PostgREST rejects the JWT with PGRST303) from a genuine transient
 * DB failure, so callers can map the former to a 401 the client refreshes on
 * rather than an unhandled 500. Messages stay GENERIC (no upstream text) so
 * legacy callers that echo `error.message` can't leak DB internals.
 */
/**
 * A cookie or header can name a workspace that was MERGED away (migration
 * 402): `workspace_merge` says where it went. Follow it, a few hops at most
 * (A into B, B into C), to a workspace the person is in; null if none. Runs
 * only on a membership miss, on the caller's own client: the record is
 * readable to the destination's members (RLS), which is exactly who may be
 * sent on. Without this a stale tab lands in the person's OLDEST workspace.
 */
export async function followWorkspaceMerges(
  supabase: SupabaseClient,
  userId: string,
  candidate: string,
  select = 'workspace_id',
): Promise<Record<string, unknown> & { workspace_id: string } | null> {
  let current = candidate
  for (let hop = 0; hop < 5; hop++) {
    const { data: merge, error } = await supabase
      .from('workspace_merge')
      .select('destination_workspace_id')
      .eq('source_workspace_id', current)
      .maybeSingle<{ destination_workspace_id: string }>()
    if (error || !merge?.destination_workspace_id) return null
    current = merge.destination_workspace_id
    const { data: member } = await supabase
      .from('member')
      .select(select.includes('workspace_id') ? select : `workspace_id, ${select}`)
      .eq('user_id', userId)
      .eq('workspace_id', current)
      .maybeSingle<Record<string, unknown> & { workspace_id: string }>()
    if (member) return member
  }
  return null
}

export class WorkspaceLookupError extends Error {
  constructor(readonly kind: 'session_expired' | 'query_failed') {
    super(kind === 'session_expired' ? 'Session expired' : 'Membership query failed')
    this.name = 'WorkspaceLookupError'
  }
}

/**
 * Result of resolving the user. `client` is the Supabase client the caller
 * MUST use for downstream RLS queries so they run under the resolved identity:
 *   - cookie/device auth  → `null` (caller keeps the cookie-based client)
 *   - Supabase Bearer JWT → a token-bound anon client
 *
 * Without this, a half-expired cookie session (dead cookie, live Bearer) would
 * leave the membership queries below running as ANON, returning zero rows and
 * reporting a real member as having no workspace. Mirrors api-auth.ts.
 */
interface ResolvedUser {
  user: User
  client: SupabaseClient | null
}

/**
 * Resolve the user from the cookie session, falling back to an
 * `Authorization: Bearer <token>` header (non-browser clients: desktop,
 * hardware devices, MCP). Kept in sync with the resolver in api-auth.ts.
 *
 * When resolved from a Supabase Bearer JWT, returns a client bound to that
 * token so downstream RLS queries run AS the user. A device token (`nid_…`)
 * is opaque, not a JWT, so no client can be bound to it and this returns null
 * — device callers pin the workspace separately, which
 * `getCurrentWorkspaceId` handles through `deviceTokenWorkspace()` BEFORE it
 * reaches here.
 */
async function resolveUser(supabase: SupabaseClient): Promise<ResolvedUser | null> {
  const { data: { user } } = await supabase.auth.getUser()
  if (user) return { user, client: null }

  // Additive Bearer fallback; tolerate being called outside a request scope.
  try {
    const headerStore = await headers()
    const authHeader = headerStore.get('authorization')
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7)
      // Opaque Native Intelligence device token: not a JWT, can't bind a client to it.
      if (isDeviceToken(token)) return null
      // Validate the Supabase access token AND bind a client to it so the
      // membership queries below run as this user rather than as anon.
      // Disable session persistence / auto-refresh: this client is created
      // per-request and thrown away, and the default auto-refresh starts a
      // permanent 30s interval timer that would never be cleared (one leaked
      // timer + pinned closure per Bearer request).
      const tokenClient = createStatelessClient(
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
      const { data } = await tokenClient.auth.getUser(token)
      if (!data.user) return null
      return { user: data.user, client: tokenClient }
    }
  } catch {
    // no-op
  }

  return null
}

/**
 * If the request carries a device token, return the workspace it is pinned to.
 *
 * A device token is opaque, so `resolveUser` cannot bind a client to it and
 * returns null — and a server-to-server caller has no cookie session either.
 * Without this branch every device-authed call to `getCurrentWorkspaceId`
 * resolves to null and the route 400s "No workspace" before it reads anything,
 * which is what the eval run driver hits on every trial. `resolveDeviceToken`
 * verifies the token hash and its expiry, but it does NOT re-check that the
 * pinned `active_workspace_id` is still one the owner belongs to: the pin is
 * membership-checked only when it is SET (the device's workspace picker), so a
 * user who later leaves that workspace keeps a stale pin. So the member row is
 * re-checked here (`isDeviceWorkspaceMember`, service-role, fenced on the
 * token's user), as `api-auth.ts`'s twin does: a stale pin resolves no
 * workspace, and a lookup error throws (a 500, not a false answer).
 *
 * Stateless (re-reads the header), so it is safe under concurrency — no shared
 * module state between overlapping requests. Returns null for non-device auth.
 * Mirrors `deviceTokenWorkspace()` in api-auth.ts.
 */
async function deviceTokenWorkspace(): Promise<string | null> {
  let resolved: { userId: string; workspaceId: string | null } | null = null
  try {
    const headerStore = await headers()
    const authHeader = headerStore.get('authorization')
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7)
      if (isDeviceToken(token)) {
        resolved = await resolveDeviceToken(token)
      }
    }
  } catch {
    // no request scope / no header
  }
  if (!resolved?.workspaceId) return null
  // Outside the try above: a membership query error must surface, not read as
  // "no device token".
  let isMember: boolean
  try {
    isMember = await isDeviceWorkspaceMember(resolved.userId, resolved.workspaceId)
  } catch {
    throw new WorkspaceLookupError('query_failed')
  }
  return isMember ? resolved.workspaceId : null
}

export const WORKSPACE_COOKIE = 'workspace_id'
/** Header used by multi-window desktop app to override the workspace cookie. */
export const WORKSPACE_HEADER = 'x-workspace-id'

/** Read current workspace ID from header → cookie → first membership.
 *  When the ID comes from an untrusted source (header), verify membership.
 *
 *  Throws on a genuine membership query ERROR (transient DB failure) so the
 *  caller surfaces a 500 rather than a false "no workspace". A clean empty
 *  result (the user really is in no workspace) still returns null.
 *
 *  Use this from **API routes**, where a thrown error becomes a clean 500.
 *  **Server components** (page/layout render paths) must NOT call this bare:
 *  an uncaught throw escalates to global-error.tsx and blanks the whole
 *  dashboard. There, `workspaceId` is optional render context — use
 *  `getCurrentWorkspaceIdSafe()` instead, which degrades to null. */
export async function getCurrentWorkspaceId(): Promise<string | null> {
  // A device token is PINNED to one workspace, and that pin wins over both the
  // header and the cookie — deliberately. Honouring `x-workspace-id` here
  // would let anyone holding a device token read a workspace it was never
  // issued for, since the pin is the only membership check a device call gets.
  const deviceWorkspaceId = await deviceTokenWorkspace()
  if (deviceWorkspaceId) return deviceWorkspaceId

  const headerStore = await headers()
  const fromHeader = headerStore.get(WORKSPACE_HEADER)

  const cookieStore = await cookies()
  const fromCookie = cookieStore.get(WORKSPACE_COOKIE)?.value

  // Candidate workspace: prefer header (desktop multi-window), then cookie
  const candidate = fromHeader || fromCookie

  const cookieClient = await createClient()
  const resolved = await resolveUser(cookieClient)
  if (!resolved) return null
  const { user } = resolved
  // Run membership queries on the token-bound client when the user came from
  // a Bearer JWT — otherwise a half-expired cookie session runs them as anon.
  const supabase = resolved.client ?? cookieClient

  if (candidate) {
    // Always verify the user is actually a member of the claimed workspace
    const { data: membership, error } = await supabase
      .from('member')
      .select('workspace_id')
      .eq('user_id', user.id)
      .eq('workspace_id', candidate)
      .maybeSingle()

    // A real query error must not be swallowed into a false "not a member".
    // Log the raw Supabase error server-side, but throw a GENERIC message so
    // no DB internals (e.g. "permission denied for table member") leak to the
    // ~20 legacy API callers that echo error.message into their 500 bodies.
    // An EXPIRED JWT (PGRST303) is the half-expired-session case (dead cookie,
    // stale Bearer): throw 'Session expired' — safe to leak (no DB internals),
    // so the legacy callers that echo the message return an honest string.
    if (error) {
      console.error('[workspace] membership verify query failed:', error)
      throw new WorkspaceLookupError(isJwtExpiredError(error) ? 'session_expired' : 'query_failed')
    }
    if (membership) return membership.workspace_id
    // Not a member: the workspace may have been merged into one they are in.
    const merged = await followWorkspaceMerges(supabase, user.id, candidate)
    if (merged) return merged.workspace_id
    // Otherwise fall through to first membership
  }

  // Deterministic "first" membership: without an ORDER BY, Postgres may return
  // a different row per query plan, so two requests in the same navigation
  // (e.g. the dashboard layout's redirect check and an onboarding API call)
  // could resolve DIFFERENT workspaces for a multi-membership user with no
  // cookie — which is how redirect decisions end up disagreeing. Oldest
  // membership matches the historical de-facto order (heap insert order).
  const { data, error } = await supabase
    .from('member')
    .select('workspace_id')
    .eq('user_id', user.id)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  // `.maybeSingle()` returns null (not an error) for zero rows, so any error
  // here is a genuine DB failure — surface it as a 500, not a false null.
  // Generic message (no upstream text) for the same info-disclosure reason.
  // An expired JWT (PGRST303) surfaces the safe 'Session expired' string.
  if (error) {
    console.error('[workspace] first-membership query failed:', error)
    throw new WorkspaceLookupError(isJwtExpiredError(error) ? 'session_expired' : 'query_failed')
  }
  return data?.workspace_id ?? null
}

/**
 * True when a Supabase/PostgREST error is an EXPIRED-JWT rejection: PGRST303 is
 * PostgREST's dedicated expired-token code; the message check is a belt-and-
 * suspenders for older/proxied errors that carry the text but not the code.
 * Mirrors the twin in api-auth.ts (kept local — this module has no shared
 * error-helpers dependency and the ~20 legacy callers only import from here).
 */
function isJwtExpiredError(error: { code?: unknown; message?: unknown }): boolean {
  return (
    error.code === 'PGRST303' ||
    /jwt expired/i.test(typeof error.message === 'string' ? error.message : '')
  )
}

/**
 * Server-component-safe wrapper around getCurrentWorkspaceId().
 *
 * getCurrentWorkspaceId() now THROWS on a transient membership-query error
 * (error honesty for API routes). Server components render with no error
 * boundary between them and global-error.tsx, so an uncaught throw would blank
 * the entire dashboard on a blip like pool exhaustion. Here the workspace id
 * is optional context, so we degrade to null (every render call site already
 * handles null) and log for observability. Use this from page/layout render
 * paths; use getCurrentWorkspaceId() directly from API routes.
 */
export async function getCurrentWorkspaceIdSafe(): Promise<string | null> {
  try {
    return await getCurrentWorkspaceId()
  } catch (err) {
    console.error('[workspace] membership query failed:', err)
    return null
  }
}

/**
 * API-route variant of getCurrentWorkspaceId() that converts a lookup FAILURE
 * into the standard error Response instead of throwing: an expired JWT maps to
 * 401 SESSION_EXPIRED (the client refreshes + retries) and a transient DB
 * failure to a clean 500 — previously both escaped as unhandled 500s (Sentry
 * noise + no refresh signal). A clean "not in any workspace" is still null.
 *
 * Usage:
 *   const workspaceId = await getCurrentWorkspaceIdOrResponse()
 *   if (workspaceId instanceof Response) return workspaceId
 *   if (!workspaceId) return noWorkspace()
 */
export async function getCurrentWorkspaceIdOrResponse(): Promise<string | null | Response> {
  try {
    return await getCurrentWorkspaceId()
  } catch (err) {
    if (err instanceof WorkspaceLookupError) {
      return err.kind === 'session_expired' ? sessionExpired() : serverError(err.message)
    }
    throw err
  }
}

/** One membership row, flattened: the user's member id in that workspace. */
export interface UserMembership {
  memberId: string
  workspaceId: string
}

/**
 * Every (member id, workspace id) pair the user holds.
 *
 * THIS IS THE FENCE FOR "PERSONAL SCOPE" — a query that spans all of a user's
 * workspaces instead of the active one (My Actions across workspaces, the
 * cross-workspace notification feed). A caller that wants personal scope must
 * constrain its query BY THESE IDS and never by a workspace list that arrived
 * in a request body: the client says "personal scope", the server says which
 * workspaces that is. Without that rule the scope flag becomes a way to ask
 * for someone else's workspace by id.
 *
 * One query, on the CALLER'S session client, so `member`'s RLS
 * (`is_workspace_member`) is what decides which rows come back — a forged
 * `userId` returns nothing rather than someone else's memberships. `member` is
 * one row per (user_id, workspace_id) (migration 013), so the result is
 * exactly the user's workspaces, one entry each.
 *
 * Ordered oldest membership first, matching `getCurrentWorkspaceId`'s
 * first-membership fallback, so every surface that walks "the user's
 * workspaces" walks them in the same order.
 *
 * Deliberately dependency-free (client in, ids out): it is called from API
 * routes, from the views query engine, and from background jobs that hold a
 * client but no request scope.
 */
export async function resolveMemberIdsForUser(
  supabase: SupabaseClient,
  userId: string,
): Promise<UserMembership[]> {
  const { data, error } = await supabase
    .from('member')
    .select('id, workspace_id')
    .eq('user_id', userId)
    .order('created_at', { ascending: true })

  // A real query error must not be swallowed into "this user has no
  // workspaces" — that would silently empty a personal-scope list instead of
  // reporting the failure. Same generic-message rule as the lookups above.
  if (error) {
    console.error('[workspace] member-ids query failed:', error)
    throw new WorkspaceLookupError(isJwtExpiredError(error) ? 'session_expired' : 'query_failed')
  }

  return ((data ?? []) as { id: string; workspace_id: string }[]).map((row) => ({
    memberId: row.id,
    workspaceId: row.workspace_id,
  }))
}

/** Like getCurrentWorkspaceId but throws if missing — use in API routes. */
export async function requireWorkspaceId(): Promise<string> {
  const id = await getCurrentWorkspaceId()
  if (!id) throw new Error('No workspace found')
  return id
}

