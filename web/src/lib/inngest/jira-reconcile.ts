import { inngest } from './client'
import { getServiceClient } from '@/lib/admin'
import { getValidTokenForAccount } from '@/lib/oauth/token-manager'
import {
  getIssue,
  issueStatusCategoryKey,
  issueStatusName,
  JiraApiError,
  JiraUnauthorizedError,
} from '@/lib/integrations/jira-api'
import {
  JIRA_PROVIDER,
  loadJiraReconcileState,
  stampJiraReconciledAt,
} from '@/lib/tasks/jira-config'
import {
  clearJiraLinkMarker,
  stampJiraLinkMarker,
  JIRA_TASK_MISSING,
} from '@/lib/tasks/jira-link-marker'
import { jiraRemoteState, type JiraRemoteState } from '@/lib/tasks/lifecycle'
import {
  applyRemoteTaskState,
  type ApplyRemoteResult,
  type RemoteTaskLink,
} from '@/lib/tasks/apply-remote-task-state'

// =====================================================================
// Jira → Dial8 reconciliation sweep (the safety net)
//
// Jira retries a failed delivery — 5 attempts over 5–15 minutes, then once per
// interval — which is better than Asana's at-most-once. It is still not enough
// to skip a poll, for three documented reasons:
//   - A 3LO app CANNOT see what it missed. `GET /webhook/failed` is
//     Connect-apps-only, so this sweep is our ONLY visibility into dropped
//     deliveries.
//   - A registration expires 30 days after its last refresh and goes silent
//     without any error surfacing, and for a non-public app deliveries can stop
//     entirely on an app-owner/registering-user mismatch — with a 200 at
//     registration time and nothing else to see.
//   - Webhook silence is indistinguishable from "nothing changed", so nothing
//     downstream can raise an alarm.
//
// It is the SLOW path by design. Webhooks handle seconds-latency; this walks
// every open link every 6 hours to catch what they dropped. Both paths end in
// the same shared applyRemoteTaskState, so a rule change lands in both at once.
//
// HOUSE RULE — no `step.*` inside a `step.run` callback (silent production
// deadlock). Each phase is one flat step.run; the self-chain sendEvent is at the
// top level.
//
// DELIBERATELY NOT DEBOUNCED. A walk self-chains through `tasks/jira-reconcile`
// — the same event the cron fires — so any debounce would delay its OWN
// continuations, stretching a multi-page sweep by the debounce period per page.
// `concurrency: 1` keyed on the sync state serializes overlapping runs, and the
// 6-hour gate turns every redundant tick into one cheap read.
// =====================================================================

interface ReconcileEventData {
  syncStateId: string
  /** Keyset cursor carried across self-chained continuations. */
  cursorCreatedAt?: string
  cursorId?: string
}

/** Only sweep when the last full walk is at least this old. */
const RECONCILE_INTERVAL_MS = 6 * 60 * 60 * 1000
/** Links per page. */
const PAGE_SIZE = 50
/** Pages per invocation — 2 × 50 = 100 Jira GETs, well inside rate limits. */
const MAX_PAGES_PER_RUN = 2

export const jiraReconcile = inngest.createFunction(
  {
    id: 'jira-reconcile',
    retries: 2,
    // One sweep per sync state at a time: a slow self-chaining walk must not
    // overlap the next tick and double-GET the same page. This plus the 6-hour
    // gate is ALL the deduplication there is — see "deliberately not debounced".
    concurrency: [{ limit: 1, key: 'event.data.syncStateId' }],
    triggers: [{ event: 'tasks/jira-reconcile' }],
  },
  async ({ event, step }) => {
    const { syncStateId, cursorCreatedAt, cursorId } = event.data as ReconcileEventData
    const continuing = !!(cursorCreatedAt && cursorId)

    // ── Phase 1: the 6-hour gate + site + token ─────────────────────────────
    const context = await step.run('load-context', async () => {
      const state = await loadJiraReconcileState(syncStateId)
      if (!state) return { ok: false as const, reason: 'no_sync_state' }
      // No site picked yet ⇒ no push has ever landed ⇒ nothing to reconcile,
      // and no way to address a read even if there were.
      if (!state.cloudId) return { ok: false as const, reason: 'no_destination' }

      // The cron fires this every 30 min for every connected workspace; the gate
      // is what turns that into a 6-hourly sweep. Skipped for a CONTINUATION —
      // a self-chained page is the middle of a walk that already passed the
      // gate, and re-checking would silently truncate the walk the moment
      // stamping moved earlier.
      if (!continuing && state.lastReconcileAt) {
        const age = Date.now() - new Date(state.lastReconcileAt).getTime()
        if (Number.isFinite(age) && age < RECONCILE_INTERVAL_MS) {
          return { ok: false as const, reason: 'too_soon' }
        }
      }

      const resolved = await getValidTokenForAccount(state.accountId)
      if (!resolved) return { ok: false as const, reason: 'no_token' }

      return {
        ok: true as const,
        workspaceId: state.workspaceId,
        actorUserId: state.userId,
        cloudId: state.cloudId,
        token: resolved.token,
      }
    })

    if (!context.ok) {
      return { status: 'skipped' as const, reason: context.reason }
    }

    // ── Phase 2: walk pages of OPEN links, GET each issue, apply ────────────
    // `completed = false` is the whole scan set. The drift this exists to repair
    // is a completion we never heard about; a link already marked completed has
    // nothing a poll can add, and including it would double the sweep's cost to
    // catch the far rarer "re-opened in Jira while the delivery was dropped".
    // Ordered by (created_at, id) for a stable keyset cursor.
    const sweep = await step.run('reconcile-page-batch', async () => {
      const supabase = getServiceClient()
      const results: ApplyRemoteResult[] = []
      let after: { createdAt: string; id: string } | null = continuing
        ? { createdAt: cursorCreatedAt!, id: cursorId! }
        : null
      let last = after

      for (let page = 0; page < MAX_PAGES_PER_RUN; page++) {
        let query = supabase
          .from('action_external_task')
          .select('id, action_id, external_id, external_scope, completed, external_state_label, last_push_error, created_at')
          .eq('workspace_id', context.workspaceId)
          .eq('provider', JIRA_PROVIDER)
          .eq('completed', false)
          .order('created_at', { ascending: true })
          .order('id', { ascending: true })
          .limit(PAGE_SIZE)

        if (after) {
          query = query.or(
            `created_at.gt.${after.createdAt},and(created_at.eq.${after.createdAt},id.gt.${after.id})`,
          )
        }

        const { data, error } = await query
        if (error) throw error

        const rows = (data ?? []) as Array<
          RemoteTaskLink & {
            created_at: string
            external_state_label: string | null
            external_scope: string | null
            last_push_error: unknown
          }
        >
        if (rows.length === 0) {
          return { moreRemaining: false as const, aborted: null, results, last }
        }

        for (const row of rows) {
          let landing: JiraRemoteState
          let label: string | null
          // Address the read to the site the LINK lives on. Issue ids are
          // per-site, so re-pointing the destination must not silently start
          // applying a different tenant's issues to these actions.
          const issueCloudId = row.external_scope || context.cloudId
          try {
            const issue = await getIssue(context.token, issueCloudId, row.external_id, 'status')
            label = issueStatusName(issue)
            landing = jiraRemoteState(issueStatusCategoryKey(issue), label)
          } catch (err) {
            if (err instanceof JiraUnauthorizedError) {
              // Token died mid-walk. Stop the whole run cleanly (no stamp, no
              // chain) so the next tick resumes from the top after a reconnect.
              console.warn(
                `[jira-reconcile] token rejected for workspace ${context.workspaceId}; aborting sweep.`,
              )
              return {
                moreRemaining: false as const,
                aborted: 'unauthorized' as const,
                results,
                last,
              }
            }
            if (err instanceof JiraApiError && err.status === 404) {
              // "Gone OR forbidden" — Jira does not distinguish them, so this
              // marker is RETRYABLE and the link stays in the scan set: the very
              // next sweep re-reads it (one GET per link per sweep, the cost
              // this walk already pays) and a restored permission repairs
              // itself. See jira-link-marker.ts.
              await stampJiraLinkMarker(supabase, row.id, JIRA_TASK_MISSING)
              results.push({ linkId: row.id, outcome: 'task_missing' })
              continue
            }
            throw err // transient — Inngest retries the step
          }

          // Readable again → retire any stale marker (no write when there is
          // none, so a quiet sweep stays read-only).
          await clearJiraLinkMarker(supabase, row.id, row.last_push_error)

          results.push(
            await applyRemoteTaskState({
              supabase,
              workspaceId: context.workspaceId,
              actorUserId: context.actorUserId,
              link: row,
              ...landing,
            }),
          )

          // Keep the displayed status name honest too, and only when it moved —
          // an unchanged sweep must stay read-only on the database.
          if (label !== row.external_state_label) {
            const { error: labelError } = await supabase
              .from('action_external_task')
              .update({ external_state_label: label })
              .eq('id', row.id)
            if (labelError) {
              console.warn(
                `[jira-reconcile] could not update the status label for link ${row.id}:`,
                labelError.message,
              )
            }
          }
        }

        const tail = rows[rows.length - 1]
        after = { createdAt: tail.created_at, id: tail.id }
        last = after

        // Short page → the walk drained.
        if (rows.length < PAGE_SIZE) {
          return { moreRemaining: false as const, aborted: null, results, last }
        }
      }

      return { moreRemaining: true as const, aborted: null, results, last }
    })

    if (sweep.aborted) {
      return { status: 'aborted' as const, reason: sweep.aborted, applied: sweep.results.length }
    }

    // ── Phase 3 (TOP LEVEL): chain or stamp ────────────────────────────────
    if (sweep.moreRemaining && sweep.last) {
      await step.sendEvent('continue-reconcile', {
        name: 'tasks/jira-reconcile',
        data: {
          syncStateId,
          cursorCreatedAt: sweep.last.createdAt,
          cursorId: sweep.last.id,
        },
      })
      return { status: 'continued' as const, applied: sweep.results.length }
    }

    // Only the run that DRAINS the walk stamps the clock — stamping per page
    // would start the 6-hour cooldown before the tail of a large workspace had
    // ever been looked at.
    await step.run('stamp-reconciled', async () => {
      const { error } = await stampJiraReconciledAt(syncStateId)
      if (error) console.warn('[jira-reconcile] stamp failed:', error)
      return { stamped: !error }
    })

    return { status: 'complete' as const, applied: sweep.results.length }
  },
)
