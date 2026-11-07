/**
 * The shadow `nudge.worth` check (live sidekick Phase 7, PR 2): after a
 * say_to_user nudge was DELIVERED, ask Jev whether it was worth interrupting
 * the person for, and record the answer. It never changes what the person sees.
 *
 * ── Zero added latency ──────────────────────────────────────────────────────
 * The tool route calls shadowNudgeWorth after the tool ran and returns its
 * result at once: the whole check (its reads and the Jev call) runs in Next's
 * `after()`, past the response. Nothing here is awaited on the nudge path, and
 * nothing throws into it: a failure is one log line.
 *
 * ── What Jev sees ───────────────────────────────────────────────────────────
 *   - the nudge's text and kind (the tool's own input, in hand);
 *   - `recent`: the run token's `recentTail` claim (the last ~600 characters of
 *     the tick's window, signed by the cloud route; live-agent-run-token.ts);
 *   - the person's goal for the call and the heads-ups already shown: read HERE,
 *     inside after(), never on the response path. The tool route has neither in
 *     hand (the cloud route reads them into the prompt), and these reads run
 *     only for a delivered nudge, which the quiet sidekick sends rarely.
 *
 * ── What it records ─────────────────────────────────────────────────────────
 * runDecision writes the ai_usage_logs row (feature `decision.nudge.worth`,
 * decision_mode 'shadow') with `message_id` = the nudge's id (its chat row's
 * ui_message_id, the same id the person's thumbs record as
 * eval_candidate.ref_id), so reporting/nudge-worth.ts can join the two.
 *
 * Eval captures are skipped: runDecision bills the Jev call to the user, and
 * an eval run never bills (the cloud route logs its own usage with
 * skipBilling); nothing would read the answer anyway.
 */
import { after } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { NudgeWorthInput } from '@/lib/ai/decisions/tasks/nudge-worth'
import { fetchPriorNudges } from '@/lib/live-agent/already-told'
import { findRequesterConversationId } from '@/lib/live-agent/turn-composition'
import { findMeetingGoalForCapture } from '@/lib/meetings/meeting-goal'

export interface NudgeWorthShadowArgs {
  supabase: SupabaseClient
  userId: string
  workspaceId: string
  captureId: string
  isEvalCapture: boolean
  /** The delivered nudge: its id (= the chat row's ui_message_id), text and kind. */
  nudge: { id: string; message: string; kind: NudgeWorthInput['kind'] }
  /** The token's recentTail claim, when the cloud route carried one. */
  recent?: string
}

export interface NudgeWorthShadowDeps {
  /** Where the check runs (default: Next's after(); outside a request scope it floats). */
  defer?: (work: Promise<unknown>) => void
  /** The goal and the heads-ups already shown (default: two bounded reads). */
  loadContext?: (args: NudgeWorthShadowArgs) => Promise<{ goal: string | null; alreadyTold: string[] }>
  /** The Jev call (default: runDecision('nudge.worth', …, shadow)). */
  decide?: (input: NudgeWorthInput, args: NudgeWorthShadowArgs) => Promise<unknown>
}

/** after() holds the invocation open past the response; outside a request scope (tests) the work just floats. */
function deferAfter(work: Promise<unknown>): void {
  try {
    after(work)
  } catch {
    void work
  }
}

/**
 * The person's goal for this call and the heads-ups already shown this call
 * (this one excluded), each best-effort: a failed read is none.
 */
async function defaultLoadContext(args: NudgeWorthShadowArgs): Promise<{ goal: string | null; alreadyTold: string[] }> {
  const { supabase, userId, workspaceId, captureId } = args
  const [goal, alreadyTold] = await Promise.all([
    findMeetingGoalForCapture(supabase, { workspaceId, userId, captureId })
      .then((g) => g?.goal?.trim() || null)
      .catch(() => null),
    findRequesterConversationId(supabase, captureId, userId)
      .then((conversationId) => fetchPriorNudges(supabase, conversationId, { excludeMessageId: args.nudge.id }))
      .then((rows) => rows.map((r) => r.text))
      .catch(() => [] as string[]),
  ])
  return { goal, alreadyTold }
}

async function defaultDecide(input: NudgeWorthInput, args: NudgeWorthShadowArgs): Promise<unknown> {
  const { runDecision } = await import('@/lib/ai/decisions/run-decision')
  return runDecision('nudge.worth', input, {
    userId: args.userId,
    workspaceId: args.workspaceId,
    runId: args.captureId,
    mode: 'shadow',
    messageId: args.nudge.id,
  })
}

/**
 * Record, in shadow, whether Jev thinks a delivered nudge was worth it.
 * Returns at once (the work is deferred); never throws. Skips eval captures.
 */
export function shadowNudgeWorth(args: NudgeWorthShadowArgs, deps: NudgeWorthShadowDeps = {}): void {
  if (args.isEvalCapture) return
  const work = (async () => {
    const context = await (deps.loadContext ?? defaultLoadContext)(args)
    // Cut well inside the schema's caps (the task clips again to its own sizes),
    // so a long model-written nudge or row never fails validation.
    const input: NudgeWorthInput = {
      nudge: args.nudge.message.slice(0, 2000),
      kind: args.nudge.kind,
      goal: context.goal ? context.goal.slice(0, 2000) : null,
      alreadyTold: context.alreadyTold.slice(-10).map((t) => t.slice(0, 2000)),
      recent: args.recent ? args.recent.slice(-2000) : null,
    }
    await (deps.decide ?? defaultDecide)(input, args)
  })().catch((err: unknown) => {
    console.warn('[live-agent] nudge.worth shadow skipped:', err instanceof Error ? err.message : String(err))
  })
  ;(deps.defer ?? deferAfter)(work)
}
