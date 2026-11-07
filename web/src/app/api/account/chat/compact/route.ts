/**
 * POST /api/account/chat/compact { conversationId } — compact one of the
 * caller's chat conversations now (src/lib/chat/manual-compaction.ts): the
 * side panel's Compact now and the composer's `/compact`.
 *
 *   → 200 { outcome }: what happened. 'compacted' (the next message starts
 *     from a summary), 'requested' / 'queued_behind_turn' (running, not seen
 *     to finish yet), 'compacting' (one was already running: no second one),
 *     or nothing to do: 'already_compacted' (nothing new since
 *     the last one), 'no_recent_step' / 'no_events' / 'no_session' /
 *     'session_inactive' (nothing to compact), 'kept_history' (eve kept the
 *     history: the summary failed or had nothing to do).
 *   → 409 TURN_RUNNING while a reply is running: compact after it.
 *   → 429 RATE_LIMITED past the usage limits (a compaction is billed).
 *   → 400 a bad body; 404 NOT_FOUND when the conversation is not the
 *     caller's in this workspace (or a capture's); 500 on anything else.
 *
 * It waits for the outcome (MANUAL_COMPACTION_WATCH_MS), so the request can
 * take a minute: maxDuration covers the whole of it.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { requireWorkspace } from '@/lib/api-auth'
import { apiError, badRequest, notFound, rateLimited, serverError } from '@/lib/api-errors'
import { compactConversationNow, manualCompactionLogLine } from '@/lib/chat/manual-compaction'

export const dynamic = 'force-dynamic'
/** At least MANUAL_COMPACTION_MAX_DURATION_S (a literal: Next reads it statically; its test pins the pair). */
export const maxDuration = 120

const BodySchema = z.object({ conversationId: z.string().uuid('conversationId must be a uuid') })

export async function POST(request: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth

  const parsed = BodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? 'Invalid body')
  const { conversationId } = parsed.data

  const result = await compactConversationNow(supabase, { conversationId, userId: user.id, workspaceId })
  console.log(manualCompactionLogLine({ conversationId, ...result }))

  switch (result.outcome) {
    case 'not_found':
    case 'capture_conversation':
      return notFound('Conversation not found')
    case 'turn_running':
    case 'recent_activity':
      return apiError('A reply is still running. Compact once it finishes.', { status: 409, code: 'TURN_RUNNING' })
    case 'usage_limited':
      return rateLimited("You've reached your usage limit, so the conversation can't be compacted right now.")
    case 'compacted':
    case 'kept_history':
    case 'queued_behind_turn':
    case 'requested':
    case 'compacting':
    case 'already_compacted':
    case 'no_recent_step':
    case 'no_events':
    case 'no_session':
    case 'session_inactive':
      return NextResponse.json({ outcome: result.outcome })
    default:
      return serverError("The conversation couldn't be compacted. Try again in a moment.")
  }
}
