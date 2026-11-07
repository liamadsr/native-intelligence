/**
 * /api/account/chat/feedback — a thumbs rating on an assistant message, the
 * evals flywheel's first signal (src/lib/evals/flywheel/types.ts; migration
 * 349). A rating is an `eval_candidate` row: `thumbs_down` (a turn to fix) or
 * `thumbs_up` (a turn to keep), one per message per person.
 *
 *   GET  ?conversationId=<uuid>
 *        → 200 { ratings: { [uiMessageId]: 'up' | 'down' } }, the caller's own.
 *   POST { conversationId, messageId, rating: 'up' | 'down' | null, reason?, nudge_reason? }
 *        → 200 { rating }. 400 bad input; 404 NOT_FOUND when the conversation
 *        is not the caller's or the message is not persisted yet; 409 LOCKED
 *        when a reviewer already promoted or exported the rating (it stays:
 *        `details.rating` says which).
 *
 * The evidence (the request, the reply's opening, the tool path) is built
 * here from the stored `chat_messages` rows, never from the client: the body's
 * only free text is `reason` (≤ 500). `null` clears a rating still `new`;
 * changing a rating updates its row in place (recordEvalCandidate).
 *
 * `nudge_reason` is a thumbs-down nudge's quick reason chip (NUDGE_REASONS:
 * not_useful, repeated, wrong, too_late), rated after the call on the capture
 * page. Validated here (zod): an unknown chip, a chip on anything but a
 * thumbs-down, or a chip on a message that is not a live nudge is a 400. It
 * is stored as `evidence.nudge_reason` so the learning step can count it (the
 * table has no column for it; no migration). The same thumbs-down again keeps
 * its chip unless a new one came, as `reason` does.
 *
 * The person proves themselves with their session (requireWorkspace) and the
 * conversation must be theirs in this workspace. Rows are written with the
 * service role (the table has no client write policy), every read scoped to
 * the person.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { requireWorkspace } from '@/lib/api-auth'
import { apiError, badRequest, notFound, serverError } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/admin'
import { loadChatTurnEvidence } from '@/lib/evals/flywheel/chat-evidence'
import { recordEvalCandidate } from '@/lib/evals/flywheel/record'
import {
  evalCandidateKey,
  FLYWHEEL_LIMITS,
  isNudgeReason,
  NUDGE_REASONS,
  type EvalCandidateSource,
  type NudgeReason,
} from '@/lib/evals/flywheel/types'

export const dynamic = 'force-dynamic'

type Rating = 'up' | 'down'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** A UIMessage id: what chat_messages.ui_message_id holds (and the dedupe key's limit allows). */
const MESSAGE_ID_RE = /^[A-Za-z0-9_\-:.]{1,200}$/

const SOURCE_OF: Record<Rating, EvalCandidateSource> = { up: 'thumbs_up', down: 'thumbs_down' }

function ratingOf(source: unknown): Rating | null {
  return source === 'thumbs_up' ? 'up' : source === 'thumbs_down' ? 'down' : null
}

type Service = ReturnType<typeof getServiceClient>

/** Whether the conversation is the person's, in this workspace. */
async function ownsConversation(service: Service, conversationId: string, userId: string, workspaceId: string): Promise<boolean | 'error'> {
  const { data, error } = await service
    .from('chat_conversations')
    .select('id')
    .eq('id', conversationId)
    .eq('user_id', userId)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  if (error) return 'error'
  return !!data
}

export async function GET(request: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { user, workspaceId } = auth

  const conversationId = new URL(request.url).searchParams.get('conversationId') ?? ''
  if (!UUID_RE.test(conversationId)) return badRequest('conversationId must be a uuid')

  const service = getServiceClient()
  const owns = await ownsConversation(service, conversationId, user.id, workspaceId)
  if (owns === 'error') return serverError()
  if (!owns) return notFound('Conversation not found')

  const { data, error } = await service
    .from('eval_candidate')
    .select('ref_id, source')
    .eq('workspace_id', workspaceId)
    .eq('user_id', user.id)
    .eq('conversation_id', conversationId)
    .in('source', ['thumbs_up', 'thumbs_down'])
  if (error) return serverError()

  const ratings: Record<string, Rating> = {}
  for (const row of (data ?? []) as Array<{ ref_id: string | null; source: string }>) {
    const rating = ratingOf(row.source)
    if (row.ref_id && rating) ratings[row.ref_id] = rating
  }
  return NextResponse.json({ ratings })
}

interface FeedbackBody {
  conversationId: string
  messageId: string
  rating: Rating | null
  reason?: string
  nudgeReason?: NudgeReason
}

/** A nudge's quick reason chip: one of NUDGE_REASONS, or absent. */
const NudgeReasonSchema = z.enum(NUDGE_REASONS).optional()

function parseBody(body: unknown): FeedbackBody | string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'body must be an object'
  const b = body as Record<string, unknown>
  if (typeof b.conversationId !== 'string' || !UUID_RE.test(b.conversationId)) return 'conversationId must be a uuid'
  if (typeof b.messageId !== 'string' || !MESSAGE_ID_RE.test(b.messageId)) return 'messageId is not a message id'
  if (!('rating' in b) || (b.rating !== 'up' && b.rating !== 'down' && b.rating !== null)) return "rating must be 'up', 'down' or null"
  if (b.reason !== undefined && b.reason !== null && typeof b.reason !== 'string') return 'reason must be a string'
  const reason = typeof b.reason === 'string' ? b.reason.trim() : undefined
  if (reason && reason.length > FLYWHEEL_LIMITS.reason) return `reason must be at most ${FLYWHEEL_LIMITS.reason} characters`
  const chip = NudgeReasonSchema.safeParse(b.nudge_reason ?? undefined)
  if (!chip.success) return `nudge_reason must be one of ${NUDGE_REASONS.join(', ')}`
  if (chip.data && b.rating !== 'down') return 'nudge_reason goes with a thumbs-down only'
  return {
    conversationId: b.conversationId,
    messageId: b.messageId,
    rating: b.rating,
    ...(reason ? { reason } : {}),
    ...(chip.data ? { nudgeReason: chip.data } : {}),
  }
}

function locked(rating: Rating | null) {
  return apiError('This rating was already reviewed, so it stays as it is.', { status: 409, code: 'LOCKED', details: { rating } })
}

export async function POST(request: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { user, workspaceId } = auth

  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return badRequest('Invalid JSON')
  }
  const body = parseBody(raw)
  if (typeof body === 'string') return badRequest(body)

  const service = getServiceClient()
  const owns = await ownsConversation(service, body.conversationId, user.id, workspaceId)
  if (owns === 'error') return serverError()
  if (!owns) return notFound('Conversation not found')

  const dedupeKey = evalCandidateKey.feedback(body.messageId)
  const { data: existing, error: readError } = await service
    .from('eval_candidate')
    .select('id, status, source, evidence')
    .eq('workspace_id', workspaceId)
    .eq('user_id', user.id)
    .eq('dedupe_key', dedupeKey)
    .maybeSingle()
  if (readError) return serverError()
  const current = existing as { id: string; status: string; source: string; evidence?: unknown } | null
  const currentRating = current ? ratingOf(current.source) : null

  // Clearing: only a rating nobody reviewed yet.
  if (body.rating === null) {
    if (!current) return NextResponse.json({ rating: null })
    if (current.status !== 'new') return locked(currentRating)
    const { data: removed, error } = await service.from('eval_candidate').delete().eq('id', current.id).eq('status', 'new').select('id')
    if (error) return serverError()
    // Fenced on 'new': nothing removed means a reviewer took it since the read.
    if (Array.isArray(removed) && removed.length === 0) return locked(currentRating)
    return NextResponse.json({ rating: null })
  }

  if (current && current.status !== 'new') {
    // The same rating again changes nothing; a different one would rewrite a reviewed case.
    return currentRating === body.rating ? NextResponse.json({ rating: body.rating }) : locked(currentRating)
  }

  const turn = await loadChatTurnEvidence(service, { conversationId: body.conversationId, userId: user.id, messageId: body.messageId })
  if (!turn) return notFound('Message not found')
  // The chips are a nudge's (the evidence builder marks a nudge with its kind).
  if (body.nudgeReason && !turn.evidence.nudge_kind) return badRequest('nudge_reason is only for a live nudge')

  const sameRating = currentRating === body.rating
  // The same thumbs-down again keeps its chip unless a new one came (as `reason` does).
  const keptChip = (current?.evidence as { nudge_reason?: unknown } | null | undefined)?.nudge_reason
  const nudgeReason = body.nudgeReason ?? (sameRating && body.rating === 'down' && isNudgeReason(keptChip) ? keptChip : undefined)
  const outcome = await recordEvalCandidate(service, {
    workspaceId,
    userId: user.id,
    source: SOURCE_OF[body.rating],
    dedupeKey,
    evidence: nudgeReason ? { ...turn.evidence, nudge_reason: nudgeReason } : turn.evidence,
    refType: 'chat_message',
    refId: body.messageId,
    conversationId: body.conversationId,
    skillSlugs: turn.skillSlugs,
    tools: turn.tools,
    // The same rating again keeps its reason unless a new one came; a changed rating starts over.
    reason: body.reason ?? (sameRating ? undefined : null),
  })
  if (outcome === 'locked') return locked(currentRating)
  if (outcome === 'failed') return serverError('Could not save the rating')
  return NextResponse.json({ rating: body.rating })
}
