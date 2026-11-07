/**
 * A teammate's memory, written at settle (plan row 15). settleWorkRun asks
 * (requestMemorySummary) when a completed work run was done as a teammate;
 * this reads the run back, has the utility agent say what is worth
 * remembering, and writes it to agent_memory. The next run done as that
 * teammate recalls it in its brief (loadTeammateMemory, work-run-functions.ts).
 *
 * One at a time per teammate, so two runs settling together never both
 * supersede the same entry. The event id (`agent-memory:<run>`) and the
 * "already written for this run" checks keep a replay from writing twice.
 */
import { getServiceClient } from '@/lib/admin'
import { logUsage } from '@/lib/ai/auth'
import { usageProviderLabel } from '@/lib/ai/models'
import { usageCacheMetadata } from '@/lib/chat/eve-usage'
import { runUtilityTask } from '@/lib/eve/utility/run-utility'
import { AGENT_MEMORY_SUMMARIZE_EVENT } from '@/lib/work/agent-memory'
import {
  MemorySummarySchema,
  applyMemorySummary,
  buildSummaryMessage,
  loadSummaryInput,
  type MemorySummary,
} from '@/lib/work/agent-memory-summary'
import { inngest } from './client'
import { guardBackgroundUsageOnPlan } from './usage-guard'

export const agentMemorySummarize = inngest.createFunction(
  {
    id: 'agent-memory-summarize',
    retries: 2,
    concurrency: [{ limit: 1, key: 'event.data.ai_team_member_id' }],
    triggers: [{ event: AGENT_MEMORY_SUMMARIZE_EVENT }],
  },
  async ({ event, step }) => {
    const { agent_run_id, workspace_id, ai_team_member_id } = event.data as {
      agent_run_id: string
      workspace_id: string
      ai_team_member_id: string
    }
    const supabase = getServiceClient()

    const loaded = await step.run('load', () =>
      loadSummaryInput(supabase, { agentRunId: agent_run_id, workspaceId: workspace_id, teammateId: ai_team_member_id }),
    )
    if ('skip' in loaded) return { skipped: loaded.skip }
    const input = loaded.input

    // Opted in to the ChatGPT free tier: a free user's summary runs on their own plan.
    const { chatgptPlan } = await guardBackgroundUsageOnPlan(input.userId)

    const summary: MemorySummary = await step.run('summarize', async () => {
      const result = await runUtilityTask({
        kind: 'agent_memory_summary',
        supabase,
        workspaceId: input.workspaceId,
        userId: input.userId,
        chatgptPlan,
        outputSchema: MemorySummarySchema,
        message: buildSummaryMessage(input),
      })
      if (input.userId) {
        await logUsage(input.userId, {
          provider: usageProviderLabel(result.model),
          model: result.model,
          feature: 'agent_memory_summary',
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          durationMs: 0,
          costUsd: result.usage.costUsd ?? undefined,
          // A retried step bills once.
          idempotencyKey: `agent-memory:${input.agentRunId}`,
          metadata: {
            workspace_id: input.workspaceId,
            agent_run_id: input.agentRunId,
            ai_team_member_id: input.teammateId,
            ...usageCacheMetadata(result.usage),
          },
        })
      }
      return result.object as MemorySummary
    })

    return step.run('write', () => applyMemorySummary(supabase, input, summary))
  },
)
