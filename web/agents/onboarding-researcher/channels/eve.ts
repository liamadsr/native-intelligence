/**
 * eve HTTP channel + route-auth policy for the onboarding research agent.
 *
 * A Supabase AuthFn chain (the chat-agent's channel runs the same resolver):
 *
 *   1. supabaseSession() — resolves the app's Supabase session from the raw
 *      Request (cookie session or `Bearer <jwt>`) and stamps user + workspace
 *      onto the session principal. Returns null (skip) when there is no session.
 *   2. sessionOwnershipAcl() — Phase-1 upgrade of the Phase-0 TODO: on requests
 *      that TARGET an existing session (ANY route under /eve/.../session/:id —
 *      send, stream, cancel/compact/clear/reset, subagent streams), after auth
 *      resolves, verifies the caller OWNS that session id (registered in some
 *      member's onboarding_progress.research.sessionId for THIS user).
 *      Registered-to-this-user -> allowed; registered-to-another-user,
 *      unregistered, or a query error -> 403 (fail closed; see
 *      isSessionOwnedByOther in ../lib/auth.ts).
 *      A session CREATE (the bare `POST .../session`) is refused unless it
 *      carries the app's internal secret: only the kickoff route starts
 *      research (isUnvouchedSessionCreate).
 *   3. localDevOffVercel() — dev-only fallback so `eve dev` / local smoke works
 *      without a real session: eve's localDev(), refused whenever VERCEL or
 *      VERCEL_ENV is set (../lib/auth.ts), so it never admits anyone on a
 *      deployment.
 *
 * `GET /eve/v1/health` is always public and skips this walk entirely.
 *
 * The ordering is exact: ownership must run AFTER a principal is established
 * (it needs the userId) but BEFORE localDev (which would admit a synthetic
 * principal that owns nothing). We express that by having supabaseSession()
 * perform the ownership check inline once it has resolved the user — see
 * makeSupabaseSessionWithAcl below — rather than as a separate skipping entry,
 * because an AuthFn that returns a principal STOPS the walk (a later entry can't
 * revoke it). Throwing ForbiddenError from within the authenticating entry is
 * the only way to reject an already-authenticated-but-unauthorized caller.
 */
import { eveChannel } from 'eve/channels/eve'
import { ForbiddenError, type AuthFn } from 'eve/channels/auth'
import { resolveSupabaseSession, isSessionOwnedByOther, isUnvouchedSessionCreate, localDevOffVercel, vouchedPlanToken } from '../lib/auth.js'
import { PLAN_TOKEN_ATTRIBUTE } from '../lib/model.js'

/**
 * AuthFn that authenticates against the app's Supabase auth AND enforces
 * session ownership for session-targeting routes, in one entry.
 *
 * Why combined: a returning AuthFn stops the walk, so a separate "ACL" entry
 * placed AFTER this one would never run (this one already accepted). And an ACL
 * entry placed BEFORE this one has no principal to check against. So the
 * ownership gate lives here, right after the principal is known: authenticate,
 * then — if the request targets a specific session id — reject (403) when that
 * id is registered to a DIFFERENT user.
 */
function supabaseSessionWithAcl(): AuthFn<Request> {
  return async (request) => {
    const session = await resolveSupabaseSession(request)
    if (!session) return null // skip; fall through to localDevOffVercel()

    // Only the app's kickoff route creates a research session (it vouches
    // with the internal secret, after its owner and ChatGPT free-tier checks):
    // a signed-in browser can stream its own run, never start one.
    if (isUnvouchedSessionCreate(request)) {
      throw new ForbiddenError({
        code: 'session_create_forbidden',
        message: 'Onboarding research starts only from the app.',
      })
    }

    // Ownership ACL for session-targeting routes. Cheap: one indexed lookup,
    // and only when the path carries a session id.
    const owned = await isSessionOwnedByOther(request, session.userId)
    if (owned) {
      throw new ForbiddenError({
        code: 'session_forbidden',
        message: 'This research session belongs to another user.',
      })
    }

    // A free user's research runs on their own ChatGPT plan: the kickoff
    // route vouches for the create with the plan token the plan proxy pays
    // with (lib/model.ts). Everyone else has none.
    const planToken = vouchedPlanToken(request)
    return {
      authenticator: 'app',
      principalId: session.userId,
      principalType: 'user',
      // `attributes` only accepts string | string[]. workspaceId is '' when the
      // user has no membership yet (tools must treat '' as "no workspace").
      attributes: { workspaceId: session.workspaceId, ...(planToken ? { [PLAN_TOKEN_ATTRIBUTE]: planToken } : {}) },
    }
  }
}

export default eveChannel({
  auth: [supabaseSessionWithAcl(), localDevOffVercel()],
})
