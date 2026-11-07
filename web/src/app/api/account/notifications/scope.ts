/**
 * Recipient scoping for the notification routes.
 *
 * A notification is addressed to a `member` row, and `member` is one row per
 * (user, workspace) — so "my notifications" is a different recipient id in every
 * workspace the user belongs to. Every route under this folder has always
 * resolved the ONE member row for the ACTIVE workspace and filtered on it. The
 * opt-in `all` scope widens that to the whole membership set.
 *
 * TWO RULES GOVERN EVERYTHING HERE.
 *
 *  1. THE DEFAULT DOES NOT MOVE. `workspace_scope` absent — which is every
 *     caller that existed before this file — must resolve to exactly the member
 *     id the routes resolved before, so the query they emit is unchanged down to
 *     the predicate order. `all` is strictly additive.
 *
 *  2. THE SERVER DECIDES WHICH WORKSPACES "ALL" MEANS. The widened set comes
 *     from `resolveMemberIdsForUser` (lib/workspace's personal-scope fence),
 *     read on the CALLER'S session client so `member`'s own RLS answers the
 *     question. Nothing in a query string or request body ever names a workspace
 *     or a member id — otherwise the scope flag would be a way to ask for
 *     someone else's inbox by id.
 *
 * Widening is safe against `notification`'s RLS rather than in spite of it:
 * `notification_select` (migration 031) correlates per row on the row's own
 * `workspace_id`, so a session-client read filtered by a set of the caller's own
 * member ids returns their rows in every workspace and nobody else's anywhere.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { badRequest, serverError, sessionExpired } from '@/lib/api-errors'
import {
  resolveMemberIdsForUser,
  WorkspaceLookupError,
  type UserMembership,
} from '@/lib/workspace'

/**
 * `workspace` — the active workspace only, the behaviour every caller had
 * before this existed. `all` — every workspace the caller is a member of.
 */
export type WorkspaceScope = 'workspace' | 'all'

/** The query-string / body parameter both scopes travel under. */
export const WORKSPACE_SCOPE_PARAM = 'workspace_scope'

/**
 * Validate a caller-supplied scope.
 *
 * ABSENT means the default, so old callers keep working untouched. PRESENT must
 * be one of the two literals — a typo ('everything', '') is a 400 rather than a
 * silent fall-back to the narrow scope, because a client that asked for the
 * cross-workspace inbox and quietly got one workspace's rows back has no way to
 * tell that it was ignored.
 */
export function parseWorkspaceScope(raw: unknown): WorkspaceScope | Response {
  if (raw === undefined || raw === null) return 'workspace'
  if (raw === 'workspace' || raw === 'all') return raw
  return badRequest(`${WORKSPACE_SCOPE_PARAM} must be 'workspace' or 'all'`)
}

/**
 * Read `workspace_scope` out of a JSON body, tolerating no body at all.
 *
 * The POST routes here are bodyless today (`fetch(url, { method: 'POST' })`), so
 * `request.json()` rejects on the empty body. That rejection is not an error
 * condition — it is the default scope — so it degrades to `undefined` and
 * `parseWorkspaceScope` turns that into `'workspace'`. A body that IS present
 * but malformed degrades the same way rather than 400ing a caller that never
 * meant to send one.
 */
export async function readWorkspaceScopeFromBody(request: Request): Promise<unknown> {
  try {
    const body: unknown = await request.json()
    if (body && typeof body === 'object') {
      return (body as Record<string, unknown>)[WORKSPACE_SCOPE_PARAM]
    }
  } catch {
    // No body / not JSON — the bodyless POST every existing caller sends.
  }
  return undefined
}

/**
 * Every (member id, workspace id) the caller holds, or the error Response for a
 * lookup that FAILED.
 *
 * `resolveMemberIdsForUser` throws `WorkspaceLookupError` rather than returning
 * an empty list on a query failure — an empty list would silently present as
 * "you have no notifications". The mapping here is the same one
 * `getCurrentWorkspaceIdOrResponse` applies, so a half-expired session gets the
 * 401 the client refreshes and retries on instead of an unexplained 500.
 */
export async function resolveMemberships(
  supabase: SupabaseClient,
  userId: string,
): Promise<UserMembership[] | Response> {
  try {
    return await resolveMemberIdsForUser(supabase, userId)
  } catch (err) {
    if (err instanceof WorkspaceLookupError) {
      return err.kind === 'session_expired' ? sessionExpired() : serverError(err.message)
    }
    throw err
  }
}

export type { UserMembership }
