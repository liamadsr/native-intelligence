import * as Sentry from '@sentry/nextjs'
import { inngest } from './client'
import { getServiceClient } from '@/lib/supabase/service'
import { runLogUsageRpc, type LogUsageParams } from '@/lib/ai/auth'

/**
 * Durable retry for usage logging (P0-2).
 *
 * When log_ai_usage fails inline (DB blip mid-request), auth.ts emits
 * `billing/usage-log-failed` carrying the exact payload. Inngest re-runs the
 * RPC with backoff so the spend is eventually recorded and drawn from the
 * wallet — usage must never be silently free.
 *
 * The RPC inserts an ai_usage_logs row and (for overage) an ai_credit_ledger
 * row keyed on the new log id. Because each retry produces a fresh log id, a
 * retry only ever runs if the ORIGINAL call left no row — i.e. it truly failed.
 * A partial success (row written, network dropped on the way back) would be
 * re-run here and double-count; that window is small and strictly better than
 * silently losing the spend. Reconciliation (Phase 4) catches any drift. A
 * payload with an idempotencyKey (eve chat turns) has no such window: the keyed
 * RPC (migration 278) turns the re-run into a no-op.
 */
export const usageLogRetry = inngest.createFunction(
  {
    id: 'billing-usage-log-retry',
    retries: 4,
    triggers: [{ event: 'billing/usage-log-failed' }],
  },
  async ({ event, step }) => {
    const { userId, params } = event.data as {
      userId: string
      params: LogUsageParams
    }

    await step.run('log-ai-usage', async () => {
      const serviceClient = getServiceClient()
      // Same RPC as logUsage (auth.ts), including a skipBilling run's forced
      // zero cost and — when the original call carried an idempotencyKey — the
      // keyed log_ai_usage_once, so a failure that actually committed is
      // deduped here instead of billed twice.
      const { error } = await runLogUsageRpc(serviceClient, userId, params, 'inngest-retry')
      if (error) {
        // Throwing makes Inngest retry (per the retries config above). After
        // the last attempt it lands in the Inngest dead-letter view; alert.
        Sentry.captureException(error, {
          tags: { area: 'billing', op: 'usage-log-retry' },
          extra: { userId, feature: params.feature },
        })
        throw new Error(`log_ai_usage retry failed: ${error.message}`)
      }
    })
  },
)
