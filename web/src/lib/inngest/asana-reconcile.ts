import { inngest } from './client'
import { getServiceClient } from '@/lib/admin'
import { getValidTokenForAccount } from '@/lib/oauth/token-manager'
import { AsanaApiError, AsanaUnauthorizedError, getTask } from '@/lib/integrations/asana-api'
import {
  ASANA_PROVIDER,
  loadAsanaReconcileState,
  stampAsanaReconciledAt,
} from '@/lib/tasks/asana-config'
import {
  applyRemoteTaskState,
  markTaskDeleted,
  type ApplyRemoteResult,
  type RemoteTaskLink,
} from '@/lib/tasks/apply-remote-task-state'

// =====================================================================
// Asana → Native Intelligence reconciliation sweep (the safety net)
//
// Asana webhook delivery is AT-MOST-ONCE with no replay: a delivery lost to a
// deploy, a cold start, a 5xx or a brief network partition is gone for good.
// That makes a poll MANDATORY, not a nice-to-have — without it a task completed
// during a bad thirty seconds stays open in Native Intelligence forever, and the user has no
// way to tell.
//
// It is the SLOW path by design. Webhooks handle seconds-latency; this walks
// every open link every 6 hours to catch what they dropped. Both paths end in
// the same shared applyRemoteTaskState, so a fix or a rule change lands in both
// at once and they cannot diverge.
//
// HOUSE RULE — no `step.*` inside a `step.run` callback (silent production
// deadlock). Each phase is one flat step.run; the self-chain sendEvent is at
// the top level.
//
// DELIBERATELY NOT DEBOUNCED. A walk self-chains through `tasks/asana-reconcile`
// — the same event the cron fires — so any debounce on this function delays its
// OWN continuations, stretching a multi-page sweep by the debounce period per
// page. Nothing is lost by dropping it: `concurrency: 1` keyed on the sync state
// serializes overlapping runs, and the 6-hour gate turns every redundant one
// into a single cheap read. A duplicate tick costs one gated step, a debounced
// continuation costs a large workspace hours of latency.
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
/** Pages per invocation — 2 × 50 = 100 Asana GETs, well inside rate limits. */
const MAX_PAGES_PER_RUN = 2

export const asanaReconcile = inngest.createFunction(
  {
    id: 'asana-reconcile',
    retries: 2,
    // One sweep per sync state at a time: a slow self-chaining walk must not
    // overlap the next tick's invocation and double-GET the same page. This
    // (plus the 6-hour gate) is ALL the deduplication there is — see the
    // "deliberately not debounced" note above.
    concurrency: [{ limit: 1, key: 'event.data.syncStateId' }],
    triggers: [{ event: 'tasks/asana-reconcile' }],
  },
  async ({ event, step }) => {
    const { syncStateId, cursorCreatedAt, cursorId } = event.data as ReconcileEventData
    const continuing = !!(cursorCreatedAt && cursorId)

    // ── Phase 1: the 6-hour gate + token ────────────────────────────────────
    const context = await step.run('load-context', async () => {
      const state = await loadAsanaReconcileState(syncStateId)
      if (!state) return { ok: false as const, reason: 'no_sync_state' }

      // The cron fires this every 30 min for every connected workspace; the gate
      // is what turns that into a 6-hourly sweep. Skipped for a CONTINUATION —
      // a self-chained page is the middle of a walk that already passed the
      // gate, and re-checking would be fine today (the stamp only lands when the
      // walk drains) but would silently truncate the walk the moment stamping
      // moved earlier.
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
        token: resolved.token,
      }
    })

    if (!context.ok) {
      return { status: 'skipped' as const, reason: context.reason }
    }

    // ── Phase 2: walk pages of OPEN links, GET each task, apply ─────────────
    // `completed = false` is the whole scan set. The drift this exists to repair
    // is a completion we never heard about, and a link already marked completed
    // has nothing a poll can add — including it would double the sweep's cost to
    // catch the far rarer "re-opened in Asana while the delivery was dropped".
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
          .select('id, action_id, external_id, completed, created_at')
          .eq('workspace_id', context.workspaceId)
          .eq('provider', ASANA_PROVIDER)
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

        const rows = (data ?? []) as Array<RemoteTaskLink & { created_at: string }>
        if (rows.length === 0) {
          return { moreRemaining: false as const, aborted: null, results, last }
        }

        for (const row of rows) {
          let remoteCompleted: boolean
          try {
            const task = await getTask(context.token, row.external_id)
            remoteCompleted = task?.completed === true
          } catch (err) {
            if (err instanceof AsanaUnauthorizedError) {
              // Token died mid-walk. Stop the whole run cleanly (no stamp, no
              // chain) so the next tick resumes from the top after a reconnect.
              console.warn(
                `[asana-reconcile] token rejected for workspace ${context.workspaceId}; aborting sweep.`,
              )
              return {
                moreRemaining: false as const,
                aborted: 'unauthorized' as const,
                results,
                last,
              }
            }
            if (err instanceof AsanaApiError && err.status === 404) {
              await markTaskDeleted(supabase, row.id)
              results.push({ linkId: row.id, outcome: 'task_deleted' })
              continue
            }
            throw err // transient — Inngest retries the step
          }

          results.push(
            await applyRemoteTaskState({
              supabase,
              workspaceId: context.workspaceId,
              actorUserId: context.actorUserId,
              link: row,
              remoteCompleted,
            }),
          )
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

    // ── Phase 3 (TOP LEVEL): chain or stamp ─────────────────────────────────
    if (sweep.moreRemaining && sweep.last) {
      await step.sendEvent('continue-reconcile', {
        name: 'tasks/asana-reconcile',
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
      const { error } = await stampAsanaReconciledAt(syncStateId)
      if (error) console.warn('[asana-reconcile] stamp failed:', error)
      return { stamped: !error }
    })

    return { status: 'complete' as const, applied: sweep.results.length }
  },
)
