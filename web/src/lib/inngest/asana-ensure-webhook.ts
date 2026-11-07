import { inngest } from './client'
import { ensureAsanaWebhook } from '@/lib/tasks/asana-webhook'

// =====================================================================
// Asana webhook registration — the convergence driver
//
// A thin wrapper around ensureAsanaWebhook (src/lib/tasks/asana-webhook.ts),
// which holds all the logic and is idempotent by design. This exists so the
// three triggers can be fire-and-forget:
//   - the asana-settings PATCH (project picked or changed) — the user must not
//     wait on an Asana round-trip that blocks on a webhook handshake;
//   - the /api/cron/asana-sync tick — self-heal for a registration Asana
//     garbage-collected, a create that failed, or a settings fire that dropped;
//   - a retry of either.
//
// HOUSE RULE — no `step.*` inside a `step.run` callback (silent production
// deadlock). There is exactly one step here and it calls a plain async function.
// =====================================================================

interface EnsureWebhookEventData {
  syncStateId: string
}

export const asanaEnsureWebhook = inngest.createFunction(
  {
    id: 'asana-ensure-webhook',
    retries: 2,
    // Coalesce bursts: the settings PATCH and the next cron tick landing within
    // a minute of each other should produce ONE registration attempt, not two
    // racing creates.
    debounce: { key: 'event.data.syncStateId', period: '60s' },
    // Hard serialization per sync state. Two concurrent runs could each see
    // "no gid", both create, and leave an orphaned webhook delivering to us.
    concurrency: [{ limit: 1, key: 'event.data.syncStateId' }],
    triggers: [{ event: 'tasks/asana-ensure-webhook' }],
  },
  async ({ event, step }) => {
    const { syncStateId } = event.data as EnsureWebhookEventData
    if (!syncStateId) {
      return { status: 'skipped' as const, reason: 'no_sync_state_id' }
    }

    // ONE flat step. ensureAsanaWebhook performs no step.* work of its own —
    // it is a plain async convergence routine.
    const result = await step.run('ensure-webhook', async () =>
      ensureAsanaWebhook({ syncStateId }),
    )

    return { status: result.status, webhookGid: result.webhookGid ?? null }
  },
)
