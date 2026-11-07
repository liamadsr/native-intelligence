import { inngest } from './client'
import { ensureJiraWebhook, retireJiraWebhook } from '@/lib/tasks/jira-webhook'

// =====================================================================
// Jira webhook registration — the convergence driver
//
// A thin wrapper around ensureJiraWebhook (src/lib/tasks/jira-webhook.ts), which
// holds all the logic and is idempotent by design. This exists so the three
// triggers can be fire-and-forget:
//   - the jira-settings PATCH (project picked, changed or cleared) — the user
//     must not wait on an Atlassian round-trip;
//   - the /api/cron/jira-sync tick — self-heal AND the 7-day refresh that keeps
//     Atlassian's 30-day expiry from silently ending read-back;
//   - a retry of either.
//
// HOUSE RULE — no `step.*` inside a `step.run` callback (silent production
// deadlock). There is exactly one step here and it calls a plain async function.
// =====================================================================

interface EnsureWebhookEventData {
  syncStateId: string
  /**
   * A registration on a site we have just STOPPED pointing at (the settings
   * PATCH switched the Atlassian site). It cannot be deleted by the convergence
   * pass, which addresses the new cloudId — see retireJiraWebhook.
   */
  retireWebhook?: { webhookId: string; cloudId: string }
}

export const jiraEnsureWebhook = inngest.createFunction(
  {
    id: 'jira-ensure-webhook',
    retries: 2,
    // Coalesce bursts: a settings PATCH and the next cron tick landing within a
    // minute of each other should produce ONE registration attempt, not two
    // racing creates — which would also burn two of the five slots Atlassian
    // allows per app, per user, per site.
    debounce: { key: 'event.data.syncStateId', period: '60s' },
    // Hard serialization per sync state. Two concurrent runs could each see "no
    // id", both create, and leave an orphan holding a slot until it expires.
    concurrency: [{ limit: 1, key: 'event.data.syncStateId' }],
    triggers: [{ event: 'tasks/jira-ensure-webhook' }],
  },
  async ({ event, step }) => {
    const { syncStateId, retireWebhook } = event.data as EnsureWebhookEventData
    if (!syncStateId) {
      return { status: 'skipped' as const, reason: 'no_sync_state_id' }
    }

    // ONE flat step. ensureJiraWebhook performs no step.* work of its own — it
    // is a plain async convergence routine.
    const result = await step.run('ensure-webhook', async () =>
      ensureJiraWebhook({ syncStateId }),
    )

    // A SECOND flat step, deliberately AFTER the first: create-before-delete
    // holds across a site switch too, so the old tenant keeps delivering until
    // the new registration exists. Its own step so a failed tidy-up cannot
    // re-run the registration above.
    let retired: string | null = null
    if (retireWebhook?.webhookId && retireWebhook.cloudId) {
      const outcome = await step.run('retire-previous-site-webhook', async () =>
        retireJiraWebhook({
          syncStateId,
          webhookId: retireWebhook.webhookId,
          cloudId: retireWebhook.cloudId,
        }),
      )
      retired = outcome.status
    }

    return { status: result.status, webhookId: result.webhookId ?? null, retired }
  },
)
