import { inngest } from './client'
import { getServiceClient } from '@/lib/admin'
import { getValidTokenForAccount } from '@/lib/oauth/token-manager'
import {
  getIssue,
  issueStateName,
  issueStateType,
  LinearUnauthorizedError,
} from '@/lib/integrations/linear-api'
import {
  LINEAR_PROVIDER,
  loadLinearReconcileState,
  stampLinearReconciledAt,
} from '@/lib/tasks/linear-config'
import {
  clearLinearLinkMarker,
  stampLinearLinkMarker,
  LINEAR_TASK_MISSING,
} from '@/lib/tasks/linear-link-marker'
import { linearBucketForStateType, linearRemoteState } from '@/lib/tasks/lifecycle'
import {
  applyRemoteTaskState,
  type ApplyRemoteResult,
  type RemoteTaskLink,
} from '@/lib/tasks/apply-remote-task-state'

// =====================================================================
// Linear → Dial8 reconciliation sweep (the safety net)
//
// Linear's webhooks are the better of the three providers' — signed, app-level,
// no expiry to keep alive — and this sweep still exists, for three reasons that
// are structural rather than defensive:
//   - Linear retries a failed delivery only THREE times (+1min / +1h / +6h) and
//     may then DISABLE the webhook outright. Nothing tells us when that happens;
//     read-back simply stops.
//   - Webhook silence is indistinguishable from "nothing changed", so nothing
//     downstream can raise an alarm.
//   - The app console holds ONE webhook URL. Dev and preview connections
//     therefore deliver to the PRODUCTION receiver, which finds no matching
//     links and drops them — so in every non-production environment this sweep
//     is not the backstop, it is the ONLY read-back path.
//
// It is the SLOW path by design. Webhooks handle seconds-latency; this walks
// every open link every 6 hours to catch what they dropped. Both paths end in
// the same shared applyRemoteTaskState, so a rule change lands in both at once.
//
// NOTE what has no counterpart here: the Jira cron dispatches an ensure-webhook
// event alongside this one, because a Jira registration expires 30 days after
// its last refresh. Linear's app-level webhook has no registration we own and no
// expiry, so `/api/cron/linear-sync` fires this event and nothing else.
//
// HOUSE RULE — no `step.*` inside a `step.run` callback (silent production
// deadlock). Each phase is one flat step.run; the self-chain sendEvent is at the
// top level.
//
// DELIBERATELY NOT DEBOUNCED. A walk self-chains through `tasks/linear-reconcile`
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
/** Pages per invocation — 2 × 50 = 100 Linear reads, well inside rate limits. */
const MAX_PAGES_PER_RUN = 2

export const linearReconcile = inngest.createFunction(
  {
    id: 'linear-reconcile',
    retries: 2,
    // One sweep per sync state at a time: a slow self-chaining walk must not
    // overlap the next tick and double-read the same page. This plus the 6-hour
    // gate is ALL the deduplication there is — see "deliberately not debounced".
    concurrency: [{ limit: 1, key: 'event.data.syncStateId' }],
    triggers: [{ event: 'tasks/linear-reconcile' }],
  },
  async ({ event, step }) => {
    const { syncStateId, cursorCreatedAt, cursorId } = event.data as ReconcileEventData
    const continuing = !!(cursorCreatedAt && cursorId)

    // ── Phase 1: the 6-hour gate + token ───────────────────────────────────
    const context = await step.run('load-context', async () => {
      const state = await loadLinearReconcileState(syncStateId)
      if (!state) return { ok: false as const, reason: 'no_sync_state' }

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
        token: resolved.token,
      }
    })

    if (!context.ok) {
      return { status: 'skipped' as const, reason: context.reason }
    }

    // ── Phase 2: walk pages of OPEN links, read each issue, apply ───────────
    // `completed = false` is the whole scan set. The drift this exists to repair
    // is a completion we never heard about; a link already marked completed has
    // nothing a poll can add, and including it would double the sweep's cost to
    // catch the far rarer "re-opened in Linear while the delivery was dropped".
    // Ordered by (created_at, id) for a stable keyset cursor.
    //
    // NOTE there is no destination gate before this (the Jira sibling skips on a
    // missing cloudId). A Linear read needs nothing but the token — no site, no
    // team — so a workspace that connected and never picked a destination simply
    // has no links, and the first page comes back empty.
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
          .select(
            'id, action_id, external_id, completed, external_state_label, external_url, last_push_error, created_at',
          )
          .eq('workspace_id', context.workspaceId)
          .eq('provider', LINEAR_PROVIDER)
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
            external_url: string | null
            last_push_error: unknown
          }
        >
        if (rows.length === 0) {
          return { moreRemaining: false as const, aborted: null, results, last }
        }

        for (const row of rows) {
          let issue
          try {
            issue = await getIssue(context.token, row.external_id)
          } catch (err) {
            if (err instanceof LinearUnauthorizedError) {
              // Token died mid-walk. Stop the whole run cleanly (no stamp, no
              // chain) so the next tick resumes from the top after a reconnect.
              console.warn(
                `[linear-reconcile] token rejected for workspace ${context.workspaceId}; aborting sweep.`,
              )
              return {
                moreRemaining: false as const,
                aborted: 'unauthorized' as const,
                results,
                last,
              }
            }
            throw err // transient — Inngest retries the step
          }

          // Null or trashed — "gone OR invisible OR never existed", which Linear
          // does not distinguish, and its 30-day delete grace window. The marker
          // is RETRYABLE and the link stays in the scan set: the very next sweep
          // re-reads it (one read per link per sweep, the cost this walk already
          // pays) and a restored permission repairs itself.
          if (!issue || issue.trashed === true) {
            await stampLinearLinkMarker(supabase, row.id, LINEAR_TASK_MISSING)
            results.push({ linkId: row.id, outcome: 'task_missing' })
            continue
          }

          const type = issueStateType(issue)
          const label = issueStateName(issue)

          // Readable again → retire any stale marker (no write when there is
          // none, so a quiet sweep stays read-only).
          await clearLinearLinkMarker(supabase, row.id, row.last_push_error)

          // An unrecognized state type is NO SIGNAL — leave the action alone
          // rather than defaulting it open. Same rule as the webhook path.
          if (linearBucketForStateType(type) === null) {
            results.push({ linkId: row.id, outcome: 'unchanged' })
          } else {
            results.push(
              await applyRemoteTaskState({
                supabase,
                workspaceId: context.workspaceId,
                actorUserId: context.actorUserId,
                link: row,
                ...linearRemoteState(type),
              }),
            )
          }

          // Keep the displayed state name and the issue URL honest too, and only
          // for what actually moved — an unchanged sweep must stay read-only on
          // the database.
          //
          // The URL matters here because a team move rewrites an issue's
          // identifier and its canonical URL, and this sweep is the backstop for
          // every delivery the webhook path dropped. A missing url is never
          // written back as null — absent means the read didn't say.
          const url = typeof issue.url === 'string' && issue.url ? issue.url : null
          const patch: Record<string, string | null> = {}
          if (label !== row.external_state_label) patch.external_state_label = label
          if (url !== null && url !== row.external_url) patch.external_url = url

          if (Object.keys(patch).length > 0) {
            const { error: patchError } = await supabase
              .from('action_external_task')
              .update(patch)
              .eq('id', row.id)
            if (patchError) {
              console.warn(
                `[linear-reconcile] could not update the display fields for link ${row.id}:`,
                patchError.message,
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
        name: 'tasks/linear-reconcile',
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
      const { error } = await stampLinearReconciledAt(syncStateId)
      if (error) console.warn('[linear-reconcile] stamp failed:', error)
      return { stamped: !error }
    })

    return { status: 'complete' as const, applied: sweep.results.length }
  },
)
