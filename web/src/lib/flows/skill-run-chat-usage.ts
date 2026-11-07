/**
 * A follow-up chat turn on a loop run's parked session → ai_usage_logs (bots v3
 * Phase 4). The chat route hands the turn's raw events here once they drain.
 *
 * Billed like the run it continues: to the run-as user (the run's facts; the
 * route only lets that person chat), feature `flow_run_skill`, with
 * `source: 'chat'` in the metadata, one row per completed model step under
 * eve's cost rule of record (workRunStepUsages → mapEveTurnUsage). Each step is
 * keyed once (`skill-run-chat:<item>:<turn>:<step>`, log_ai_usage_once), so a
 * re-read never double-bills (a lost cursor advance replays a turn into the
 * next send's read). eve numbers turns per SESSION, so a chat that reopened in
 * a new one (loop-run-chat-reopen.ts) keys its steps by that session too
 * (`skill-run-chat:<item>:<session>:<turn>:<step>`): under the item's key they
 * would collide with the parked session's turns and never be billed. The
 * parked session keeps its key, so a step billed before this never bills again
 * under another. The work-run chat keys the same way (work-run-usage.ts).
 * Never throws.
 */
import type { HandleMessageStreamEvent } from 'eve/client'
import { logUsage } from '@/lib/ai/auth'
import { appModelIdFromGatewaySlug, usageProviderLabel } from '@/lib/ai/models'
import { usageCacheMetadata } from '@/lib/chat/eve-usage'
import { workRunStepUsages } from '@/lib/agent-run/work-run-usage'

export const SKILL_RUN_CHAT_USAGE_FEATURE = 'flow_run_skill'

/** The once-only key for one step of a loop run's chat (of one of its reopened chat's sessions, when `sessionId` is given). */
export function skillRunChatUsageKey(workItemId: string, turnId: string, stepIndex: number, sessionId?: string): string {
  return sessionId
    ? `skill-run-chat:${workItemId}:${sessionId}:${turnId}:${stepIndex}`
    : `skill-run-chat:${workItemId}:${turnId}:${stepIndex}`
}

export async function logSkillRunChatUsage(args: {
  userId: string
  workspaceId: string
  workItemId: string
  /** The session read, when it is one a reopened chat continues in (reopenedChatSessionOf): its steps are keyed by it. */
  sessionId?: string
  skillId: string
  teammateId: string | null
  /** The run's model (bare app id), for a step that names none. */
  model: string
  events: readonly HandleMessageStreamEvent[]
}): Promise<number> {
  try {
    const steps = workRunStepUsages(args.events)
    for (const step of steps) {
      const u = step.usage
      const model = appModelIdFromGatewaySlug(step.modelId) ?? args.model
      await logUsage(args.userId, {
        provider: usageProviderLabel(model),
        model,
        feature: SKILL_RUN_CHAT_USAGE_FEATURE,
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        durationMs: u.durationMs,
        costUsd: u.costUsd ?? undefined,
        idempotencyKey: skillRunChatUsageKey(args.workItemId, step.turnId, step.stepIndex, args.sessionId),
        metadata: {
          workspace_id: args.workspaceId,
          work_item_id: args.workItemId,
          skill_id: args.skillId,
          ...(args.teammateId ? { ai_team_member_id: args.teammateId } : {}),
          source: 'chat',
          runtime: 'eve',
          turn_id: step.turnId,
          ...(args.sessionId ? { eve_session_id: args.sessionId } : {}),
          step_index: step.stepIndex,
          gateway_model: step.modelId,
          toolCalls: u.toolCalls,
          ...(u.webSearchCostUsd != null ? { webSearchCostUsd: u.webSearchCostUsd } : {}),
          ...(u.generationIds.length > 0 ? { generationIds: u.generationIds } : {}),
          ...usageCacheMetadata(u),
        },
      })
    }
    return steps.length
  } catch (err) {
    console.warn('[skill-run-chat-usage] could not log usage', {
      workItemId: args.workItemId,
      error: err instanceof Error ? err.message : String(err),
    })
    return 0
  }
}
