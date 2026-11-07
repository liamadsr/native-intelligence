/**
 * POST /api/account/chat/eve-persist — the BROWSER-facing writer of eve
 * main-chat turns (Phase 4, Stage 3). The chat-agent's reply backup
 * (/api/internal/chat/reply) also writes each reply, as a provisional row this
 * write replaces, so a reply survives a page that died mid-turn.
 *
 * WHY THIS EXISTS (and not `/api/internal/chat/persist`): the persistence
 * projection + knowledge-hook + usage wiring were originally shaped as an
 * internal route gated on the shared CHAT_INTERNAL_SECRET. But the EveChatTransport
 * that finalizes a turn — and holds the rendered message id + the turn's stream
 * events — runs in the BROWSER, which must NEVER hold the internal secret. So the
 * internal route had no possible caller. This cookie-authed wrapper is the real
 * caller: it proves the user with their Supabase session (same as every other
 * /api/account route), verifies the chat-run token the transport already holds,
 * and requires the token's userId to be the authenticated user before writing.
 *
 * ── Auth (two independent checks) ────────────────────────────────────────────
 *   1. Supabase session (requireWorkspace) — the caller is a signed-in user.
 *   2. A valid chat-run token (x-chat-run-token) whose `userId` === the
 *      authenticated user's id (403 otherwise). The token scopes the write to ONE
 *      conversation; tenancy inside the writer stays TOKEN-derived (persistEveTurn
 *      → persistEveMessage re-asserts the token's (userId, workspaceId) against the
 *      conversation's actual owner row, so a token for conversation A can only
 *      write A). The Supabase check binds the token to a real logged-in identity;
 *      the writer's owner-assertion binds it to the conversation. Neither alone is
 *      trusted for tenancy — the body's userId/workspaceId are never read.
 *
 * The transport calls this best-effort at turn completion: a persist failure must
 * never break the visible turn (the user already saw the streamed reply).
 *
 * BILLING IS NOT HERE: the body's `usage` is what the browser says, so it is
 * never billed (a client could under-report its own bill). The chat-agent's
 * usage-meter hook bills each turn server-side via /api/internal/chat/usage.
 */
import { requireWorkspace } from '@/lib/api-auth'
import { badRequest, forbidden, serverError, unauthorized } from '@/lib/api-errors'
import { NextResponse, type NextRequest } from 'next/server'
import { getServiceClient } from '@/lib/admin'
import { extractChatRunToken, verifyChatRunToken } from '@/lib/chat/chat-run-token'
import { persistEveTurn, parsePersistEveTurnBody } from '@/lib/chat/persist-eve-turn'
import { ttftProperties } from '@/lib/chat/turn-timings'
import { steerProperties } from '@/lib/chat/steer-telemetry'
import { trackServerEvent } from '@/lib/posthog'
import { signalChatSessionActivity } from '@/lib/chat/idle-compaction-signal'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  // 1 — the caller is a signed-in user (Supabase cookies / Bearer).
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { user } = auth

  // 2 — a valid chat-run token; its userId MUST be the authenticated user.
  const claims = verifyChatRunToken(extractChatRunToken(request))
  if (!claims) {
    return unauthorized('invalid or expired run token')
  }
  if (claims.userId !== user.id) {
    // A token minted for a different user — never write into someone else's
    // conversation on this caller's behalf.
    return forbidden('run token does not belong to the authenticated user')
  }
  if (claims.surface) {
    // A server-minted surface token (the device one-shot) scopes an ephemeral
    // run whose conversation row is deleted when the ask ends — never an in-app
    // chat history to persist into. The token never leaves the server, so this
    // is defense in depth.
    return forbidden('run token is not for an in-app chat')
  }
  if (claims.server) {
    // A token the server minted for itself (idle compaction, a home turn): the
    // server writes its own turns (home-turn-server.ts); a browser never
    // persists one. Defense in depth: the token never leaves the server.
    return forbidden('run token is not for an in-app chat')
  }

  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return badRequest('invalid JSON body')
  }

  const parsed = parsePersistEveTurnBody(raw)
  if (!parsed.ok) {
    return badRequest(parsed.error)
  }

  // Tenancy is TOKEN-derived (the writer re-asserts it against the owner row).
  // A service client is used so the projection + activity hook run regardless of
  // RLS — the writer's owner-assertion is the tenancy boundary, not RLS.
  try {
    const result = await persistEveTurn(getServiceClient(), claims, parsed.body)
    // A turn just ended: restart this conversation's idle-compaction timer
    // (idle-compaction-signal.ts; ids only, sent after the response).
    signalChatSessionActivity({
      conversationId: claims.conversationId,
      workspaceId: claims.workspaceId,
      userId: claims.userId,
      source: 'turn',
    })
    // The `ai_chat_message_sent` launch event — emitted by the deleted cloud
    // route before streaming, and by nothing on the eve path until now. Once per
    // user turn: only when the turn carried its opening user message AND the
    // assistant row is new (a replayed persist is a dedup no-op, never a second
    // event). Only what this route can see rides along; the cloud route's
    // message_count / mentioned_* counts are not reconstructed. The turn's
    // time-to-first-token phases ride along as ttft_* (docs/plans/chat-ttft.md).
    // A write that replaced the reply backup's provisional row is this turn's
    // first persist from the browser too (the backup never emits the event).
    const firstPersist = result.written || result.replaced === true
    if (parsed.body.userMessage && firstPersist) {
      trackServerEvent(
        'ai_chat_message_sent',
        { userId: user.id, workspaceId: claims.workspaceId, email: user.email },
        {
          has_attachments: parsed.body.userMessage.parts.some((p) => p.type === 'file'),
          ...(parsed.body.usage?.model ? { model: parsed.body.usage.model } : {}),
          runtime: 'eve',
          ...ttftProperties(parsed.body.timings),
          // The message steered a running reply (UI-2): how it landed and waited.
          ...steerProperties(parsed.body.steer),
        },
      )
    }
    // The same phases once per newly written turn, so runtime logs can be
    // queried too. Timings, flags, model and the conversation id only (the id
    // the writer's own log lines carry), never message text.
    if (firstPersist && parsed.body.timings) {
      console.info(
        '[chat-ttft]',
        JSON.stringify({ conversationId: claims.conversationId, ...parsed.body.timings }),
      )
    }
    // A steered turn's facts once per newly written turn (numbers and enums
    // only, the same way as the timings line above).
    if (firstPersist && parsed.body.steer) {
      console.info(
        '[chat-steer]',
        JSON.stringify({ conversationId: claims.conversationId, ...parsed.body.steer }),
      )
    }
    return NextResponse.json({
      written: result.written,
      ...(result.replaced ? { replaced: true } : {}),
      conversationId: result.conversationId,
      activityFired: result.activityFired,
      reason: result.reason,
    })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'persist failed')
  }
}
