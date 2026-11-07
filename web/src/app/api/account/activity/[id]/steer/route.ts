import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { apiError, badRequest, serverError } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/supabase/service'
import { steerItemAsPerson, type RelayRefusalCode } from '@/lib/bots/bot-relay'
import { addMessage, isUuid, LocalAgentError } from '@/lib/local-agent/store'
import { localAgentSessionIdOf } from '@/lib/local-agent/transcript-view'

/**
 * POST /api/account/activity/[id]/steer — the person types into a running
 * helper's row in the chat's Agents widget (docs/plans/always-on-agent.md
 * decision 10, A4 slice 6): one steer into that work run's live turn, marked
 * "You → …" in its history. The relay's own live-run steer
 * (bot-relay.ts steerItemAsPerson → steerLiveRun): the run's own server
 * principal, `turnPolicy: 'steer'`, a bot_relay row the run's watcher marks
 * applied or drains as a continuation. The browser never holds a run token,
 * the secret or the session id.
 *
 * Who may steer: the row's owner who started the run (the relay's
 * findOwnItem + NOT_STARTER fences, on the service client, each fenced on the
 * caller explicitly), in the workspace the request names (x-workspace-id: the
 * widget spans workspaces). Only a RUNNING workspace work run takes a steer;
 * anything else refuses with the relay's reason code, and nothing is sent:
 *   400 INPUT_INVALID      empty or too long
 *   404 NOT_FOUND          not the caller's item, or not in this workspace
 *   403 NOT_STARTER        someone else started the run
 *   409 STILL_RUNNING      starting, no live session yet
 *   409 WAITING_ON_ANSWER  waiting on the person's answer (answer it instead)
 *   409 DELEGATION_PARKED  waiting on teammates it handed work to
 *   409 NO_RUN_CHAT        work with no steerable session (not a work run)
 *   409 NOT_RUNNING        settled
 *   409 STEER_IN_FLIGHT    the person's last steer to it is still on its way
 *   429 USAGE_LIMIT        over the AI usage limit (a retry of that request too)
 * eve not taking it (the run had just ended) is a 502 NOT_DELIVERED.
 *
 * Body: `{ message: string, request_id?: string }`. `request_id` (one per
 * submit, 1–200 characters with no colon) makes a double submit or a retry
 * steer once.
 *
 * A local agent's turn (`kind: 'local_agent'`, local-agents contract G) is no
 * work run: the message goes to its SESSION as the person (the library's
 * addMessage, author `person`), which stores it with its transcript event and
 * rings the Mac. It lands while the session works, starts its next turn while
 * it idles, answers its open question, and resumes an interrupted one; a
 * session that ended refuses (409 NOT_RUNNING). Its owner check is the
 * library's (the session is the caller's, or 404). `policy` ('steer' |
 * 'queue', default steer) says how a working session takes it. `request_id`
 * keys the message (`steer:<request_id>`): a double submit or a retry sends
 * once, and answers as the first did (`duplicate: true`).
 */

type RouteContext = { params: Promise<{ id: string }> }

const MAX_MESSAGE_LENGTH = 4000
/** A request id is one segment of the relay row's key (`steer:person:<user>:<item>:<id>`). */
const REQUEST_ID = /^[^:]{1,200}$/

/** The person's words for each refusal (the relay's reasons are written for the main agent). */
const REFUSALS: Partial<Record<RelayRefusalCode, { status: number; message: string }>> = {
  INPUT_INVALID: { status: 400, message: 'Type a message to send.' },
  NOT_FOUND: { status: 404, message: 'Work item not found' },
  NOT_STARTER: { status: 403, message: 'Only the person who started this run can steer it' },
  STILL_RUNNING: { status: 409, message: 'It is still starting up. Try again in a moment.' },
  WAITING_ON_ANSWER: { status: 409, message: 'It is waiting on your answer to its question. Answer it instead.' },
  DELEGATION_PARKED: { status: 409, message: 'It is waiting on teammates it handed work to. It picks up when they finish.' },
  NO_RUN_CHAT: { status: 409, message: 'This work can’t take a message while it runs.' },
  NOT_RUNNING: { status: 409, message: 'It isn’t working right now, so nothing was sent.' },
  STEER_IN_FLIGHT: { status: 409, message: 'Your last message is still on its way. Send the next one in a moment.' },
  USAGE_LIMIT: { status: 429, message: 'You have reached your AI usage limit.' },
}

/**
 * Stated (review fix 5): a steer that raced the run's settle is drained in
 * after() (bot-relay.ts drainSteerIfUnwatched), cancelled at 270 s.
 */
export const maxDuration = 300

export async function POST(request: NextRequest, { params }: RouteContext) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { user, workspaceId } = auth
  const { id } = await params

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return badRequest('Invalid JSON')
  }
  const { message, request_id: requestId, policy } = (body ?? {}) as { message?: unknown; request_id?: unknown; policy?: unknown }
  if (typeof message !== 'string' || !message.trim()) return apiError(REFUSALS.INPUT_INVALID!.message, { status: 400, code: 'INPUT_INVALID' })
  if (message.length > MAX_MESSAGE_LENGTH) return apiError(`Keep it under ${MAX_MESSAGE_LENGTH} characters.`, { status: 400, code: 'INPUT_INVALID' })
  if (requestId !== undefined && (typeof requestId !== 'string' || !REQUEST_ID.test(requestId))) {
    return badRequest('request_id must be 1 to 200 characters, with no colon')
  }

  if (policy !== undefined && policy !== 'steer' && policy !== 'queue') return badRequest('policy must be steer or queue')

  const svc = getServiceClient()
  // A local agent's turn: its session takes the message (see above).
  let local: { sessionId: string | null } | null
  try {
    local = await localAgentTurn(svc, id, workspaceId)
  } catch (err) {
    console.error('[activity/steer] row read failed:', err instanceof Error ? err.message : String(err))
    return serverError('Could not send the message')
  }
  if (local) {
    if (!local.sessionId) return apiError(REFUSALS.NO_RUN_CHAT!.message, { status: 409, code: 'NO_RUN_CHAT' })
    try {
      const sent = await addMessage(svc, {
        userId: user.id,
        sessionId: local.sessionId,
        author: 'person',
        text: message.trim(),
        policy: policy === 'queue' ? 'queue' : 'steer',
        ...(typeof requestId === 'string' ? { idempotencyKey: `steer:${requestId}` } : {}),
      })
      return NextResponse.json({
        ok: true,
        relay_id: null,
        status: 'steered',
        message_id: sent.messageId,
        requeued: sent.requeued,
        ...(sent.duplicate ? { duplicate: true } : {}),
      })
    } catch (err) {
      if (err instanceof LocalAgentError) {
        if (err.code === 'not_found') return apiError(REFUSALS.NOT_FOUND!.message, { status: 404, code: 'NOT_FOUND' })
        if (err.code === 'conflict') return apiError(err.message, { status: 409, code: 'NOT_RUNNING' })
        return apiError(err.message, { status: 400, code: 'INPUT_INVALID' })
      }
      console.error('[activity/steer] local agent message not sent:', err instanceof Error ? err.message : String(err))
      return serverError('Could not send the message')
    }
  }

  let out: Record<string, unknown>
  try {
    out = await steerItemAsPerson(svc, {
      userId: user.id,
      workspaceId,
      itemId: id,
      message,
      ...(typeof requestId === 'string' ? { requestId } : {}),
    })
  } catch (err) {
    console.error('[activity/steer] not sent:', err instanceof Error ? err.message : String(err))
    return serverError('Could not send the message')
  }

  if (out.status === 'refused') {
    const code = String(out.code) as RelayRefusalCode
    const refusal = REFUSALS[code] ?? { status: 409, message: 'Nothing was sent.' }
    return apiError(refusal.message, { status: refusal.status, code })
  }
  if (out.status === 'failed') {
    return apiError('The message didn’t reach it (it may have just finished). Nothing was changed.', { status: 502, code: 'NOT_DELIVERED' })
  }
  // 'steered', or 'steering' for a retried send still on its way.
  return NextResponse.json({ ok: true, relay_id: out.relay_id ?? null, status: out.status })
}

/**
 * The row when it is a local agent's turn in this workspace (with its
 * session, or null when it names none), else null: any other row, one in
 * another workspace, or none goes to the relay, which answers for it.
 */
async function localAgentTurn(
  svc: ReturnType<typeof getServiceClient>,
  itemId: string,
  workspaceId: string,
): Promise<{ sessionId: string | null } | null> {
  if (!isUuid(itemId)) return null
  const { data, error } = await svc
    .from('tracked_job')
    .select('id, kind, workspace_id, source')
    .eq('id', itemId)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  const row = data as { kind?: string | null; source?: Record<string, unknown> | null } | null
  if (!row || row.kind !== 'local_agent') return null
  return { sessionId: localAgentSessionIdOf(row) }
}
