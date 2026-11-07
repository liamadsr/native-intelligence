/**
 * DB binding fence for chat-run tokens: every internal chat route requires the
 * token's claims to still name a REAL conversation of that user in that
 * workspace, and a live membership.
 *
 * ── Why (2026-10-31 security review, P0-1) ──────────────────────────────────
 * A chat-run token is HMAC-signed with the same shared secret the eve chat
 * runtime presents as its bearer, and the runtime must hold that secret to
 * call these routes at all. So the signature alone proves only "minted by a
 * holder of the secret" — a COMPROMISED runtime could mint claims naming any
 * user and workspace. This guard turns that forgery into needing a real,
 * live conversation id of that user (an unguessable uuid the app created),
 * exactly as the Mac body's la1 token is bound to its session row
 * (src/lib/local-agent/relay.ts checkSessionToken). Every mint site derives
 * its claims from a chat_conversations row scoped by (user_id, workspace_id)
 * — the browser mint, home turns, channel turns, guest turns, the device ask,
 * idle compaction, the bot relay — so a legitimate token always binds.
 *
 * The check is two indexed reads (one round trip): the conversation row must
 * exist with the token's (user_id, workspace_id), and the token's user must
 * still be a member of the token's workspace (a removed member's token stops
 * working mid-life, as the Mac body's does).
 *
 * ── Surface tokens (the original liveness fence) ────────────────────────────
 * For a 'device_ask' token the conversation row is ALSO the run's ephemeral
 * ownership row (src/lib/chat/device-ask-eve.ts inserts it, mints the token
 * for it, and deletes it when the ask ends). Deleting the row therefore
 * REVOKES the token: the binding fails closed with 403 SURFACE_RUN_ENDED —
 * the code the chat-agent's usage gate treats as fatal to the session. A
 * channel turn's surface runs in the durable home thread: its binding is the
 * ordinary one.
 *
 * A lookup that ERRORS is not a missing row: the binding is unknown, so the
 * routes still refuse (nothing is served or dispatched on an unverified run)
 * but with 503 SURFACE_RUN_UNVERIFIED — a transient status the usage gate
 * treats as soft, so a DB blip costs the run that one spec fetch / tool call
 * instead of killing the session. Only a genuine mismatch or absence (403) is
 * fatal. The token's `exp` still bounds a run whose lookups keep failing.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { getServiceClient } from '@/lib/admin'
import type { ChatRunTokenClaims } from './chat-run-token'

/** Error code (403) when a surface run has ended (its ownership row is gone). */
export const SURFACE_RUN_ENDED = 'SURFACE_RUN_ENDED'

/**
 * Error code (403) when a token's claims don't bind to a real conversation of
 * that user in that workspace, or the user is no longer a member of it.
 */
export const RUN_TOKEN_UNBOUND = 'RUN_TOKEN_UNBOUND'

/**
 * Error code (503) when the binding could not be checked (the lookup errored
 * or threw). Transient: refused, but never treated as the run having ended.
 */
export const SURFACE_RUN_UNVERIFIED = 'SURFACE_RUN_UNVERIFIED'

/** A token's binding: bound, genuinely unbound (row gone / mismatch / not a member), or unknown (lookup failed). */
export type ChatRunBinding = 'bound' | 'unbound' | 'unknown'

/**
 * Whether this token's claims still bind to live DB state: its conversation
 * row exists with exactly the token's (user_id, workspace_id), and the user
 * is still a member of that workspace.
 */
export async function chatRunBinding(
  claims: ChatRunTokenClaims,
  supabase?: SupabaseClient,
): Promise<ChatRunBinding> {
  try {
    const svc = supabase ?? getServiceClient()
    const [conv, member] = await Promise.all([
      svc
        .from('chat_conversations')
        .select('id, user_id, workspace_id')
        .eq('id', claims.conversationId)
        .maybeSingle<{ id: string; user_id: string | null; workspace_id: string | null }>(),
      svc
        .from('member')
        .select('id')
        .eq('user_id', claims.userId)
        .eq('workspace_id', claims.workspaceId)
        .maybeSingle<{ id: string }>(),
    ])
    if (conv.error || member.error) return 'unknown'
    if (!conv.data || conv.data.user_id !== claims.userId || conv.data.workspace_id !== claims.workspaceId) {
      return 'unbound'
    }
    return member.data ? 'bound' : 'unbound'
  } catch {
    return 'unknown'
  }
}

/**
 * The refusal an internal route returns for this token, or null when the run
 * may act: 403 (SURFACE_RUN_ENDED for a device-ask token whose ownership row
 * is gone — fatal to the session via the usage gate — RUN_TOKEN_UNBOUND for
 * any other binding failure), 503 SURFACE_RUN_UNVERIFIED when the binding is
 * unknown (soft). All fail closed — the request is not served either way.
 */
export async function chatRunBindingRefusal(
  claims: ChatRunTokenClaims,
  supabase?: SupabaseClient,
): Promise<Response | null> {
  const binding = await chatRunBinding(claims, supabase)
  if (binding === 'bound') return null
  if (binding === 'unbound') {
    if (claims.surface === 'device_ask') {
      return Response.json({ error: 'this run has ended', code: SURFACE_RUN_ENDED }, { status: 403 })
    }
    return Response.json(
      { error: 'this token does not bind to a live conversation of this user', code: RUN_TOKEN_UNBOUND },
      { status: 403 },
    )
  }
  return Response.json(
    { error: 'could not verify this run is still live', code: SURFACE_RUN_UNVERIFIED },
    { status: 503 },
  )
}
