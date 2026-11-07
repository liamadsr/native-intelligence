/**
 * The capture pass's job (always-on plan §3b, slice A2c): a queued
 * `chat/memory.capture` (from the memory route at compaction, or the nightly
 * catch-up) is read on the utility agent (kind memory_capture) and written:
 * stated facts saved, inferred ones proposed, replacements and removals only
 * of what the model was shown (src/lib/memory/capture-pass.ts). One
 * `chat_checkpoint` log line, then the operation is marked applied.
 *
 * One at a time per person, so two passes never race on the same facts. The
 * event id (the operation's hash), the applied mark and the writers' dedupe
 * keep a replay from writing twice. Usage counts as the person's (decision
 * 8): the background usage gate first, then logUsage under feature
 * `memory_capture`, keyed on the operation so a retried step bills once.
 */
import { getServiceClient } from '@/lib/admin'
import { logUsage } from '@/lib/ai/auth'
import { usageProviderLabel } from '@/lib/ai/models'
import { usageCacheMetadata } from '@/lib/chat/eve-usage'
import { runUtilityTask } from '@/lib/eve/utility/run-utility'
import {
  MEMORY_CAPTURE_EVENT,
  MemoryCaptureSchema,
  applyCapture,
  buildCaptureMessage,
  loadCaptureJob,
  logCheckpoint,
  markCaptureApplied,
  type MemoryCaptureAnswer,
} from '@/lib/memory/capture-pass'
import type { MemoryCaptureEventData } from '@/lib/memory/profile-capture'
import { inngest } from './client'
import { guardBackgroundUsageOnPlan } from './usage-guard'

export const memoryCapture = inngest.createFunction(
  {
    id: 'chat-memory-capture',
    retries: 2,
    concurrency: [{ limit: 1, key: 'event.data.userId' }],
    triggers: [{ event: MEMORY_CAPTURE_EVENT }],
  },
  async ({ event, step }) => {
    const data = event.data as MemoryCaptureEventData
    const supabase = getServiceClient()

    const loaded = await step.run('load', () => loadCaptureJob(supabase, data))
    if ('skip' in loaded) return { skipped: loaded.skip }
    const input = loaded.input

    // In a step: a replayed run (after the model step) must not re-check, and a
    // refusal must be recorded once.
    // Opted in to the ChatGPT free tier: a free user's capture runs on their own plan.
    const { chatgptPlan } = await step.run('guard', () => guardBackgroundUsageOnPlan(input.userId))

    const answer: MemoryCaptureAnswer = await step.run('read', async () => {
      const result = await runUtilityTask({
        kind: 'memory_capture',
        supabase,
        workspaceId: input.workspaceId,
        userId: input.userId,
        chatgptPlan,
        outputSchema: MemoryCaptureSchema,
        message: buildCaptureMessage(input),
      })
      await logUsage(input.userId, {
        provider: usageProviderLabel(result.model),
        model: result.model,
        feature: 'memory_capture',
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        durationMs: 0,
        costUsd: result.usage.costUsd ?? undefined,
        idempotencyKey: `memory-capture:${input.operationId}`,
        metadata: { workspace_id: input.workspaceId, session_id: input.sessionId, ...usageCacheMetadata(result.usage) },
      })
      return MemoryCaptureSchema.parse(result.object)
    })

    const outcome = await step.run('write', () => applyCapture(supabase, input, answer))

    await step.run('checkpoint', async () => {
      await logCheckpoint(supabase, input, outcome)
      await markCaptureApplied(supabase, input.operationId, outcome)
    })
    return outcome
  },
)
