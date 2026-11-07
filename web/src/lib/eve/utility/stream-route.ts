/**
 * A route that streams one utility-agent answer straight back to the browser
 * (note continuation, /api/ai/complete): the route's time budget for the
 * model call, and the stream with its usage row.
 */

import { createTextStreamResponse } from 'ai'
import { logUsage } from '@/lib/ai/auth'
import { apiError } from '@/lib/api-errors'
import type { UtilityKind } from '@/lib/eve/utility-run-token'
import { CANCEL_TIMEOUT_MS, streamUtilityText } from '@/lib/eve/utility/run-utility'
import { usageCacheMetadata } from '@/lib/chat/eve-usage'
import { usageProviderLabel } from '@/lib/ai/models'

export interface StreamUtilityResponseArgs {
  userId: string
  /** Feature id for usage logging (e.g. 'generate_title'). */
  feature: string
  /** Model id WITHOUT provider prefix. */
  model: string
  prompt: string
  /** Extra metadata for the usage row (e.g. { captureId }). */
  metadata?: Record<string, unknown>
  /** The utility kind to run (a text kind, whose system prompt lives in its spec). */
  kind: UtilityKind
  /** The caller's workspace (Gateway tagging), or null when it has none. */
  workspaceId: string | null
  /** The person runs on their own ChatGPT plan (streamUtilityText's chatgptPlan). */
  chatgptPlan?: boolean
  /**
   * The wall clock (create + stream). Omitted → the kind's default. A route
   * passes routeModelTimeoutMs so its own pre-work comes out of the budget;
   * `null` (no budget left) answers 503 without starting an eve session.
   */
  timeoutMs?: number | null
}

/**
 * What a route keeps back from its maxDuration besides the model call and the
 * post-timeout cancel: the usage write after the answer, and the response.
 */
const ROUTE_TAIL_MS = 2_000
/** A model call never gets less than this, however slow the route's pre-work was. */
const MIN_ROUTE_MODEL_TIMEOUT_MS = 10_000

/**
 * The model-call timeout for a route that started at `routeStartedAt`: the
 * kind's default, cut short by what the route already spent on auth, the
 * usage-limit check, the workspace and model lookups, so the call, its
 * cancel (≤ CANCEL_TIMEOUT_MS) and the usage write end inside `maxDurationMs`
 * instead of Vercel killing the function before the cancel lands — which
 * would leave the eve session running, billed at the Gateway with no usage
 * row. Mirrors stepModelTimeoutMs (reference-ingest.ts).
 *
 * `null` when less than MIN_ROUTE_MODEL_TIMEOUT_MS is left: a shorter call is
 * not worth making, and a floored one would overrun maxDuration and orphan
 * its session — so streamUtilityResponse answers 503 and starts none.
 */
export function routeModelTimeoutMs(
  kindDefaultMs: number,
  routeStartedAt: number,
  maxDurationMs: number,
  now: number = Date.now(),
): number | null {
  const left = maxDurationMs - CANCEL_TIMEOUT_MS - ROUTE_TAIL_MS - Math.max(0, now - routeStartedAt)
  if (left < MIN_ROUTE_MODEL_TIMEOUT_MS) return null
  return Math.min(kindDefaultMs, left)
}

/**
 * Stream the answer from the eve utility agent as it is written, logging
 * usage once the session completes.
 *
 * Rejects when the session cannot even start (no secret, the session create
 * failed or timed out) — the route's catch turns that into its error
 * response. Once streaming, a failure errors the stream.
 */
export async function streamUtilityResponse(args: StreamUtilityResponseArgs): Promise<Response> {
  // The route's own pre-work used up its budget: refuse before any eve session
  // exists, so nothing can outlive the function unbilled.
  if (args.timeoutMs === null) {
    return apiError('Completion unavailable, try again', { status: 503, code: 'ROUTE_BUDGET_EXHAUSTED' })
  }

  const startTime = Date.now()
  const { stream } = await streamUtilityText({
    kind: args.kind,
    workspaceId: args.workspaceId,
    userId: args.userId,
    chatgptPlan: args.chatgptPlan,
    // The route already resolved the workspace's model; the session runs
    // exactly that model (or, on the person's ChatGPT plan, the plan's).
    model: args.model,
    message: args.prompt,
    timeoutMs: args.timeoutMs,
    // Usage once the session completes, before the stream closes — what
    // streamText's onEnd did: same user, provider label, model, feature and
    // metadata. Tokens are summed from eve's step.completed events; eve's
    // cost (0 or absent) becomes null → omitted → the RPC prices the row.
    onCompleted: async ({ usage, model }) => {
      // Provider from the model that ran: a hardcoded 'claude' made a DeepSeek
      // completion miss its (provider, model) price row and bill at the RPC's
      // $15/$75 fallback whenever eve's cost is null.
      const metadata = { ...args.metadata, ...usageCacheMetadata(usage) }
      // The model that ran: a plan run's `chatgpt-plan/<model>` logs at no cost.
      await logUsage(args.userId, {
        provider: usageProviderLabel(model),
        model,
        feature: args.feature,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        durationMs: Date.now() - startTime,
        costUsd: usage.costUsd ?? undefined,
        metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
      })
    },
  })

  return createTextStreamResponse({ stream })
}
