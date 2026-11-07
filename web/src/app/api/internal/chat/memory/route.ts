/**
 * POST /api/internal/chat/memory
 *
 * INTERNAL-ONLY. The chat agent's eve memory slot
 * (agents/chat-agent/memory/profile.ts; docs/plans/always-on-agent.md §3,
 * slices A2a and A2c) calls this for every memory operation, dispatched on `op`:
 *
 *   recall   { op: 'recall', phase: 'turn.started' | 'compaction.completed',
 *              operationId, sessionId, scope: [userId, workspaceId] }
 *            → 200 { result: { messages: [{ id: 'facts', … }, { id: 'facts-delta', … }] } }
 *            The epochs, the delta and the memo: src/lib/memory/profile-recall.ts.
 *   pin      { op: 'pin', phase, operationId, sessionId, scope, result }
 *            → 200 { result }: what the provider returned when it had to fall
 *            back, stored for the operation unless something already was; the
 *            stored bytes come back (the provider returns those), so a later
 *            replay gets exactly what the turn got.
 *   capture  { op: 'capture', phase: 'compaction.requested', operationId,
 *              sessionId, scope, sequence?, messages: [{ role, text }] }
 *            → 200 { result: { queued, replayed } } as soon as the pass is queued (Inngest
 *            `chat/memory.capture`): src/lib/memory/profile-capture.ts.
 *   checkpoint { op: 'checkpoint', phase: 'compaction.completed', operationId,
 *              sessionId, scope, text }
 *            → 200 { result: { stored, unchanged } }: eve's new checkpoint text
 *            (posted beside the recall at compaction.completed, A3), capped
 *            and stored on the token's conversation as checkpoint_summary /
 *            checkpoint_at for the home thread's re-prime
 *            (src/lib/chat/home-thread.ts storeCheckpoint; idempotent on the
 *            text, so a replay never moves checkpoint_at).
 *
 * ── Auth (exactly as /api/internal/chat/tool) ───────────────────────────────
 * 1. the shared internal secret (constant-time): our own eve runtime;
 * 2. a chat-run token whose HMAC verifies: the ONLY source of tenancy. The
 *    body's `scope` (eve's locked memory scope) must name the token's own user
 *    and workspace, or the call is refused. Expiry:
 *      - recall: an EXPIRED token may only replay a result already stored for
 *        its operationId (same bytes, no new work), else 401;
 *      - capture, pin and checkpoint: a token up to CAPTURE_TOKEN_GRACE_MS past expiry is
 *        accepted, because idle compaction runs on the last turn's token
 *        (eve does not refresh auth.current for a compaction); past that, 401;
 * 3. a surface token (the device ask) must still own its ephemeral row.
 * A teammate token is refused: a teammate chat has its own memory, and the
 * slot resolves no scope for one. So is a guest's (428): someone the owner
 * added never reads or writes the owner's memory.
 */
import { NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/admin'
import { apiError, badRequest, forbidden, serverError, unauthorized } from '@/lib/api-errors'
import {
  extractChatRunToken,
  extractInternalSecret,
  verifyChatRunToken,
  verifyInternalSecret,
} from '@/lib/chat/chat-run-token'
import { chatRunBindingRefusal } from '@/lib/chat/surface-run-guard'
import { inngest } from '@/lib/inngest/client'
import { validateSlice } from '@/lib/memory/capture-slice'
import { CAPTURE_TOKEN_GRACE_MS, queueProfileCapture } from '@/lib/memory/profile-capture'
import { isProfileRecallPhase, parseRecallResult, pinRecallResult, recallProfileMemory } from '@/lib/memory/profile-recall'
import { HOME_CHECKPOINT_MAX_CHARS, storeCheckpoint } from '@/lib/chat/home-thread'

export const dynamic = 'force-dynamic'

/** eve's limits: a scope component ≤1 KiB; an operationId is built from the session id and a few short parts. */
const MAX_SESSION_ID = 1024
const MAX_OPERATION_ID = 2048
const isId = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max

const STATUS_CODES = { 401: 'UNAUTHORIZED', 403: 'FORBIDDEN', 409: 'CONFLICT', 500: 'INTERNAL' } as const

export async function POST(request: Request) {
  if (!verifyInternalSecret(extractInternalSecret(request))) return unauthorized()
  const token = extractChatRunToken(request)
  const live = verifyChatRunToken(token)
  const claims = live ?? verifyChatRunToken(token, { allowExpired: true })
  if (!claims) return unauthorized('invalid or expired run token')
  if (claims.teammateId) return forbidden('a teammate chat keeps its own memory')
  // A guest's text turn (428): the owner's memory is never read or written from it.
  if (claims.guestId) return forbidden("a guest's conversation never reaches the owner's memory")

  let body: Record<string, unknown>
  try {
    const raw = (await request.json()) as unknown
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return badRequest('Send a JSON object.')
    body = raw as Record<string, unknown>
  } catch {
    return badRequest('invalid JSON body')
  }

  if (body.op !== 'recall' && body.op !== 'capture' && body.op !== 'pin' && body.op !== 'checkpoint') {
    return badRequest("op must be 'recall', 'pin', 'capture' or 'checkpoint'.")
  }
  if ((body.op === 'recall' || body.op === 'pin') && !isProfileRecallPhase(body.phase)) return badRequest("phase must be 'turn.started' or 'compaction.completed'.")
  if (body.op === 'capture' && body.phase !== 'compaction.requested') return badRequest("phase must be 'compaction.requested'.")
  if (body.op === 'checkpoint' && body.phase !== 'compaction.completed') return badRequest("phase must be 'compaction.completed'.")
  if (!isId(body.operationId, MAX_OPERATION_ID)) return badRequest('operationId is required.')
  if (!isId(body.sessionId, MAX_SESSION_ID)) return badRequest('sessionId is required.')
  const scope = body.scope
  if (!Array.isArray(scope) || scope.length !== 2 || scope[0] !== claims.userId || scope[1] !== claims.workspaceId) {
    return forbidden("scope must be the run token's own user and workspace")
  }
  // Capture, pin and checkpoint accept a token for a while past its expiry; never longer.
  if (body.op !== 'recall' && !live && claims.exp <= Date.now() - CAPTURE_TOKEN_GRACE_MS) {
    return unauthorized('run token expired too long ago')
  }

  const supabase = getServiceClient()
  const refused = await chatRunBindingRefusal(claims, supabase)
  if (refused) return refused

  if (body.op === 'pin') {
    const result = parseRecallResult(body.result)
    if (!result) return badRequest('result must be a recall result: { messages: [{ id, content }] }.')
    try {
      const outcome = await pinRecallResult(
        supabase,
        {
          userId: claims.userId,
          workspaceId: claims.workspaceId,
          conversationId: claims.conversationId,
          sessionId: body.sessionId,
          operationId: body.operationId,
          phase: body.phase as 'turn.started' | 'compaction.completed',
        },
        result,
      )
      if (!outcome.ok) return apiError(outcome.error, { status: outcome.status, code: STATUS_CODES[outcome.status] })
      return NextResponse.json({ result: outcome.result, replayed: outcome.replayed })
    } catch (err) {
      console.error('[chat memory] pin failed:', err instanceof Error ? err.message : err)
      return serverError('memory pin failed')
    }
  }

  if (body.op === 'checkpoint') {
    // The slot caps it too; anything far past the cap is no checkpoint it sent.
    if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > HOME_CHECKPOINT_MAX_CHARS * 2) {
      return badRequest('text must be the checkpoint text.')
    }
    try {
      const outcome = await storeCheckpoint(supabase, {
        conversationId: claims.conversationId,
        userId: claims.userId,
        workspaceId: claims.workspaceId,
        text: body.text,
      })
      return NextResponse.json({ result: outcome })
    } catch (err) {
      console.error('[chat memory] checkpoint failed:', err instanceof Error ? err.message : err)
      return serverError('memory checkpoint failed')
    }
  }

  if (body.op === 'capture') {
    if (!Array.isArray(body.messages)) return badRequest('messages must be a list of { role, text }.')
    const sequence = typeof body.sequence === 'number' && Number.isInteger(body.sequence) && body.sequence >= 0 ? body.sequence : null
    try {
      const outcome = await queueProfileCapture(
        supabase,
        {
          userId: claims.userId,
          workspaceId: claims.workspaceId,
          conversationId: claims.conversationId,
          sessionId: body.sessionId,
          operationId: body.operationId,
          phase: 'compaction.requested',
          sequence,
          slice: validateSlice(body.messages),
        },
        (event) => inngest.send(event),
      )
      if (!outcome.ok) return apiError(outcome.error, { status: outcome.status, code: STATUS_CODES[outcome.status] })
      // The slot's postChatMemory reads `result`: without it every capture would count as failed.
      return NextResponse.json({ result: { queued: outcome.queued, replayed: outcome.replayed } })
    } catch (err) {
      console.error('[chat memory] capture failed:', err instanceof Error ? err.message : err)
      return serverError('memory capture failed')
    }
  }

  try {
    const outcome = await recallProfileMemory(supabase, {
      userId: claims.userId,
      workspaceId: claims.workspaceId,
      conversationId: claims.conversationId,
      sessionId: body.sessionId,
      operationId: body.operationId,
      phase: body.phase as 'turn.started' | 'compaction.completed',
      // An expired (but genuinely signed) token may only REPLAY a stored result.
      replayOnly: !live,
    })
    if (!outcome.ok) return apiError(outcome.error, { status: outcome.status, code: STATUS_CODES[outcome.status] })
    return NextResponse.json({ result: outcome.result, replayed: outcome.replayed })
  } catch (err) {
    console.error('[chat memory] recall failed:', err instanceof Error ? err.message : err)
    return serverError('memory recall failed')
  }
}
