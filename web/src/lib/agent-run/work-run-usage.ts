/**
 * A work run's model spend → ai_usage_logs (followups issue 15).
 *
 * A work run's model calls happen on the eve work-agent. Until this, nothing
 * logged them: the spend was only in the AI Gateway under the run's tag. Every
 * read of the run's session stream hands its events here: the dispatcher's
 * drain (run-work-eve.ts drainTurn) and the follow-up chat route
 * (/api/account/agent-runs/[id]/chat). Each completed model step becomes one
 * row, feature `work_run`, through logUsage like every other server model
 * call (so it is billed to the run's user the same way), with eve's cost rule
 * of record (mapEveTurnUsage: eve's cost when it can be trusted, else the
 * log_ai_usage RPC prices the tokens).
 *
 * ONE ROW PER STEP, keyed `work-run:<run>:<turn>:<step>` (log_ai_usage_once).
 * The same step can be read more than once: a turn spans two watch windows,
 * or an Inngest retry re-attaches at an older cursor and reads it again. A
 * per-drain or per-turn key would drop or double-bill steps; the step key
 * bills each model call once however often the stream is re-read. eve
 * numbers turns per SESSION (turn_0, turn_1, …), so a chat that reopened in
 * a new session (run-chat-reopen.ts) keys its steps by that session too
 * (`work-run:<run>:<session>:<turn>:<step>`): under the run's key they would
 * collide with the run's own turns and never be billed.
 *
 * Best-effort: it never throws. A failed bill is retried by logUsage itself.
 */
import type { HandleMessageStreamEvent } from 'eve/client'
import type { SupabaseClient } from '@supabase/supabase-js'
import { logUsage } from '@/lib/ai/auth'
import { appModelIdFromGatewaySlug, usageProviderLabel } from '@/lib/ai/models'
import { mapEveTurnUsage, usageCacheMetadata } from '@/lib/chat/eve-usage'
import { isModelTier, modelRouteMetadata, tierReasoning, type ModelRoute } from '@/lib/ai/model-route'

export const WORK_RUN_USAGE_FEATURE = 'work_run'

/** Where the events were read: the dispatcher's drain, or the run's follow-up chat. */
export type WorkRunUsageSource = 'dispatch' | 'chat'

interface StepGroup {
  modelId: string | null
  events: HandleMessageStreamEvent[]
}

/**
 * Split a stream read into one group per model step: a group opens at
 * `step.started` and keeps what follows (the step's `step.completed`, then the
 * results of the actions it requested) until the next `step.started`. Events
 * before the first `step.started` (a read that began mid-step) form a group
 * with no model. Only groups holding a `step.completed` are billable. Pure.
 */
export function groupEventsBySteps(events: readonly HandleMessageStreamEvent[]): StepGroup[] {
  const groups: StepGroup[] = []
  let current: StepGroup = { modelId: null, events: [] }
  for (const ev of events) {
    if (ev.type === 'step.started') {
      if (current.events.length > 0) groups.push(current)
      current = { modelId: ev.data.modelId ?? null, events: [] }
    }
    current.events.push(ev)
  }
  if (current.events.length > 0) groups.push(current)
  return groups.filter((g) => g.events.some((e) => e.type === 'step.completed'))
}

/** One billable step: its idempotency key parts, model and usage. */
export interface WorkRunStepUsage {
  turnId: string
  stepIndex: number
  modelId: string
  usage: ReturnType<typeof mapEveTurnUsage>
}

/**
 * The billable steps in a stream read. A step read without its `step.started`
 * takes the model of the read's first started step (a run keeps one model per
 * role), else 'unknown'. A step that spent nothing is left out. Pure.
 */
export function workRunStepUsages(events: readonly HandleMessageStreamEvent[]): WorkRunStepUsage[] {
  const groups = groupEventsBySteps(events)
  const fallbackModel = groups.find((g) => g.modelId)?.modelId ?? 'unknown'
  const out: WorkRunStepUsage[] = []
  for (const g of groups) {
    const done = g.events.find((e) => e.type === 'step.completed')
    if (!done || done.type !== 'step.completed') continue
    const usage = mapEveTurnUsage(g.events)
    if (usage.inputTokens + usage.outputTokens === 0 && usage.costUsd == null) continue
    out.push({
      turnId: done.data.turnId,
      stepIndex: done.data.stepIndex,
      modelId: g.modelId ?? fallbackModel,
      usage,
    })
  }
  return out
}

/** The once-only key for one step of one run (of one of its reopened chat's sessions, when `sessionId` is given). */
export function workRunUsageKey(agentRunId: string, turnId: string, stepIndex: number, sessionId?: string): string {
  return sessionId ? `work-run:${agentRunId}:${sessionId}:${turnId}:${stepIndex}` : `work-run:${agentRunId}:${turnId}:${stepIndex}`
}

/**
 * Log every billable step in a stream read of a work run's session. Reads the
 * run once for its payer (`triggered_by`) and teammate. Returns how many rows
 * were handed to logUsage (duplicates included). Never throws.
 */
export async function logWorkRunUsage(
  supabase: SupabaseClient,
  args: {
    agentRunId: string
    workspaceId: string
    events: readonly HandleMessageStreamEvent[]
    source: WorkRunUsageSource
    /** The session read, when it is one a reopened chat continues in (reopenedChatSessionOf): its steps are keyed by it. */
    sessionId?: string
  },
): Promise<number> {
  try {
    const steps = workRunStepUsages(args.events)
    if (steps.length === 0) return 0
    const { data: run, error } = await supabase
      .from('agent_run')
      .select('triggered_by, ai_team_member_id, origin, model_tier, model_tier_by')
      .eq('id', args.agentRunId)
      .eq('workspace_id', args.workspaceId)
      .maybeSingle()
    if (error) throw new Error(error.message)
    const userId = (run as { triggered_by?: string | null } | null)?.triggered_by
    if (!userId) return 0
    const teammateId = (run as { ai_team_member_id?: string | null }).ai_team_member_id ?? null
    const origin = (run as { origin?: string | null }).origin ?? null
    // The run's tier (migration 345): set when a background helper started,
    // else the default, Think (run-work-spec-rebuild.ts reads it the same way).
    const storedTier = (run as { model_tier?: string | null }).model_tier
    const storedBy = (run as { model_tier_by?: string | null }).model_tier_by
    const tier = isModelTier(storedTier) ? storedTier : 'think'
    // Who decided, as the start stored it ('cap' when Strong was refused);
    // a run with no stored tier ran the fixed default.
    const by: ModelRoute['by'] = !isModelTier(storedTier)
      ? 'fixed'
      : storedBy === 'rule' || storedBy === 'jev' || storedBy === 'timeout' || storedBy === 'cap' || storedBy === 'fixed' || storedBy === 'agent'
        ? storedBy
        : 'rule'
    const modelRoute: ModelRoute = modelRouteMetadata({
      tier,
      by,
      signals: [isModelTier(storedTier) ? 'run_tier' : 'default'],
      reasoning: tierReasoning(tier),
    })
    for (const step of steps) {
      const u = step.usage
      // A step's model is the Gateway slug it ran ('deepseek/deepseek-v4-flash');
      // usage rows and the price table key on the app id ('deepseek-v4-flash').
      const model = appModelIdFromGatewaySlug(step.modelId) ?? 'unknown'
      await logUsage(userId, {
        provider: usageProviderLabel(model),
        model,
        feature: WORK_RUN_USAGE_FEATURE,
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        durationMs: u.durationMs,
        costUsd: u.costUsd ?? undefined,
        idempotencyKey: workRunUsageKey(args.agentRunId, step.turnId, step.stepIndex, args.sessionId),
        metadata: {
          workspace_id: args.workspaceId,
          agent_run_id: args.agentRunId,
          ...(teammateId ? { ai_team_member_id: teammateId } : {}),
          ...(origin ? { origin } : {}),
          source: args.source,
          turn_id: step.turnId,
          ...(args.sessionId ? { eve_session_id: args.sessionId } : {}),
          step_index: step.stepIndex,
          gateway_model: step.modelId,
          toolCalls: u.toolCalls,
          model_route: modelRoute,
          ...(u.webSearchCostUsd != null ? { webSearchCostUsd: u.webSearchCostUsd } : {}),
          ...(u.generationIds.length > 0 ? { generationIds: u.generationIds } : {}),
          ...usageCacheMetadata(u),
        },
      })
    }
    return steps.length
  } catch (err) {
    console.warn('[work-run-usage] could not log usage', {
      agentRunId: args.agentRunId,
      source: args.source,
      error: err instanceof Error ? err.message : String(err),
    })
    return 0
  }
}
