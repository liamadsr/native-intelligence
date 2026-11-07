/**
 * The kill switch and the workspace's pause at the doors a loop's job passes
 * before it runs (L5): the claim (a queued job the Mac takes) and the model
 * token (a parked job's resume, and the relay's refresh). WS-D's
 * unattendedToolReview is the one check, as at the Mac body's tool route:
 * while ACTION_REVIEW_MODE says shadow, or the agent is paused, a loop's job
 * is refused here and asked to stop (a queued one is cancelled). A job a
 * person or a typed chat turn started passes. A pause that can't be read
 * refuses for now (503) without stopping anything.
 */
import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { apiError } from '@/lib/api-errors'
import { readAgentPausedState } from '@/lib/work/agent-paused'
import { unattendedToolReview } from './unattended'

/**
 * The workspace's pause, where a read that fails is no answer (it throws):
 * the door refuses for now (503), and the job is neither cancelled nor
 * stopped on a pause that may not be there. The tool route's default counts
 * it as paused (unattended.ts), which a call can retry; a cancelled job can't.
 */
async function pausedOrUnknown(svc: SupabaseClient, workspaceId: string): Promise<boolean> {
  const state = await readAgentPausedState(svc, workspaceId)
  if (state === 'unknown') throw new Error("the workspace's agent switch couldn't be read")
  return state === 'paused'
}

/** 403 with the reason when the switch or the pause reached this loop's job; 503 when it can't tell (failing closed, nothing stopped); null to go on. */
export async function loopJobRefusal(svc: SupabaseClient, userId: string, sessionId: string): Promise<Response | null> {
  try {
    const gate = await unattendedToolReview(svc, { userId, sessionId }, { paused: pausedOrUnknown })
    return gate && 'refused' in gate ? apiError(gate.reason, { status: 403, code: gate.code }) : null
  } catch (err) {
    console.error('[local-agent] loop job check failed:', err instanceof Error ? err.message : err)
    return apiError('Could not check how this job was started. Try again.', { status: 503, code: 'UNAVAILABLE' })
  }
}
