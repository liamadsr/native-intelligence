/**
 * eve HTTP channel + route-auth policy for the user-facing `chat-agent` (Phase 4
 * — main chat → eve durable sessions).
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ Supabase AuthFn + session-ownership ACL, keyed on the ownership record   │
 * │ `chat_conversations.eve_session_id` (migration 190). The resolver is a   │
 * │ twin of the onboarding-researcher's (../lib/auth.ts says which half).    │
 * │ This channel ALSO stamps the chat-run token + per-turn ctx headers onto  │
 * │ the principal so the dynamic resolvers can reach the internal spec/tool  │
 * │ routes.                                                                  │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * The auth walk runs at the channel layer, gating every inbound request to
 * `/eve/chat-agent/v1/session*` before any model work. It is an
 * ORDERED chain:
 *
 *  -1. evalRunnerAuth() — the deterministic safety evals' runner (P3,
 *      evals/README.md): a `Bearer d8eval_…` token, only when
 *      EVE_EVAL_AUTH_ENABLED=1 on a NON-production deployment, for one fixed
 *      test principal whose workspace is a marked, single-member fixture. The
 *      only entry that ever permits tool stubs. Skips (null) for every
 *      other request; an eval bearer it does not admit is refused, never
 *      passed down the walk. See ../lib/eval-auth.ts.
 *   0. serverCompactionAuth() — the app's server callers (idle-time compaction
 *      and server-written home turns): the chat family's internal secret
 *      (`x-chat-run-secret`) plus a chat-run token for the conversation.
 *      Admitted ONLY for `POST /session/:id/compact`, `GET /session/:id/stream`
 *      and, with a `server: 'home_turn'` token, a queued `POST /session/:id`
 *      send into a home thread; and only when `:id` is the session registered
 *      on the token's own conversation (403 otherwise; a wrong secret is 401).
 *      Skips (null) when the header is absent, so person and device traffic
 *      never reach it. See ../lib/auth.ts.
 *   1. supabaseSessionWithAcl() — resolves the app's Supabase session from the
 *      raw Request (cookie session or `Bearer <jwt>`), stamps the user +
 *      workspace onto the session principal, AND — on requests that TARGET an
 *      existing session (ANY route under /eve/.../session/:id — send, stream,
 *      cancel/compact/clear/reset, subagent streams) — verifies the
 *      caller OWNS that session id (registered on some `chat_conversations` row's
 *      `eve_session_id` for THIS user + workspace). Registered-to-another → 403;
 *      the caller's own → allowed; unregistered/unknown → 403 (fail closed).
 *      On a request that STARTS model work (POST create / send / compact) it
 *      also requires a verified chat-run token for the same user + workspace
 *      (403 otherwise) — see assertTurnRunToken in ../lib/auth.ts.
 *      Returns null (skip) when there is no session, so the walk falls through.
 *   2. deviceTokenAuthWithAcl() — the same, for a `Bearer d8d_…` DEVICE token
 *      (/api/device/ask relays the device's own credential to run its one-shot
 *      session here). Resolves the token's owner + active workspace and
 *      applies the SAME ownership ACL — the route registers every device session
 *      on a chat_conversations row it owns before streaming it — so a device
 *      session can only be driven by its owner. Skips (null) for anything that is
 *      not a device token. See ../lib/auth.ts.
 *   3. localDevOffVercel() — dev-only fallback: eve's localDev(), which admits a
 *      synthetic `local-dev` principal on an `eve dev` server so local smoke
 *      tests work without a real session. It goes by environment flags, not the
 *      caller, so ../lib/auth.ts refuses it whenever VERCEL or VERCEL_ENV is set:
 *      it never admits anyone on a deployment.
 *
 * `GET /eve/v1/health` is always public and skips this walk entirely.
 *
 * The ordering is exact: ownership must run AFTER a principal is established (it
 * needs the userId + workspaceId) but BEFORE localDev (which would admit a
 * synthetic principal that owns nothing). We express that by having
 * supabaseSessionWithAcl() perform the ownership check inline once it has
 * resolved the user — a returning AuthFn STOPS the walk (a later "ACL" entry
 * would never run, and an earlier one has no principal to check against), so
 * throwing ForbiddenError from within the authenticating entry is the only way
 * to reject an already-authenticated-but-unauthorized caller.
 */
import { eveChannel } from 'eve/channels/eve'
import { ForbiddenError, type AuthFn } from 'eve/channels/auth'
import {
  resolveSupabaseSession,
  isSessionOwnedByOther,
  chatRunHeaders,
  chatReplyIdHeader,
  deviceTokenAuthWithAcl,
  assertTurnRunToken,
  serverCompactionAuth,
  localDevOffVercel,
} from '../lib/auth.js'
import { evalRunnerAuth } from '../lib/eval-auth.js'

/**
 * AuthFn that authenticates against the app's Supabase auth, enforces session
 * ownership for session-targeting routes, and forwards the chat-run token +
 * per-turn ctx onto the principal — all in one entry.
 *
 * Why combined: a returning AuthFn stops the walk, so a separate "ACL" entry
 * placed AFTER this one would never run (this one already accepted), and one
 * placed BEFORE has no principal to check against. So the ownership gate lives
 * here, right after the principal is known: authenticate, then — if the request
 * targets a specific session id — reject (403) unless that id is registered to
 * THIS user AND workspace. The token/ctx headers are read LAST, only on the
 * success path, so a rejected caller never has them stamped.
 */
function supabaseSessionWithAcl(): AuthFn<Request> {
  return async (request) => {
    const session = await resolveSupabaseSession(request)
    if (!session) return null // skip; fall through to localDevOffVercel()

    // Ownership ACL for session-targeting routes. Cheap: one indexed lookup,
    // and only when the path carries a session id.
    const owned = await isSessionOwnedByOther(
      request,
      session.userId,
      session.workspaceId
    )
    if (owned) {
      throw new ForbiddenError({
        code: 'session_forbidden',
        message: 'This chat session belongs to another user or workspace.',
      })
    }

    // Forward the transport's chat-run token + pre-encoded per-turn ctx so the
    // resolvers can fetch the ChatSpec / dispatch tools. On a request that starts
    // model work (create / send / respond / compact) the token must be a VERIFIED
    // chat-run token for this same user + workspace, else 403 (assertTurnRunToken):
    // it is what the usage-limit gate checks and the usage meter bills under, so
    // a turn can no longer run on a stripped or corrupted header. The internal
    // routes still re-verify it; tenancy there is read from the token.
    const { chatRunToken, chatRunCtx } = chatRunHeaders(request)
    await assertTurnRunToken(request, session, chatRunToken)

    return {
      authenticator: 'app',
      principalId: session.userId,
      principalType: 'user',
      // `attributes` only accepts string | string[]. workspaceId is '' when the
      // user has no membership yet (tools must treat '' as "no workspace").
      attributes: {
        workspaceId: session.workspaceId,
        chatRunToken,
        chatRunCtx,
        // The reply this send starts or continues: the reply-backup hook
        // writes the server's copy of it under this id ('' = none).
        chatReplyId: chatReplyIdHeader(request),
      },
    }
  }
}

export default eveChannel({
  auth: [evalRunnerAuth(), serverCompactionAuth(), supabaseSessionWithAcl(), deviceTokenAuthWithAcl(), localDevOffVercel()],
})
