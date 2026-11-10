import { inngest } from './client'
import { getServiceClient } from '@/lib/admin'
import { getValidTokenForAccount } from '@/lib/oauth/token-manager'
import { AsanaApiError, AsanaUnauthorizedError, getTask } from '@/lib/integrations/asana-api'
import { ASANA_PROVIDER, loadAsanaWebhookAuth } from '@/lib/tasks/asana-config'
import {
  applyRemoteTaskState,
  markTaskDeleted,
  type ApplyRemoteResult,
  type RemoteTaskLink,
} from '@/lib/tasks/apply-remote-task-state'

// =====================================================================
// Asana → Native Intelligence read-back (webhook fast path)
//
// Fired by the receiver (src/app/api/webhooks/asana/[syncStateId]/route.ts) with
// the task gids named in one delivery. Asana events are COMPACT — they carry no
// state at all — so every gid is re-GET against the API for its current
// `completed` flag, and the shared applyRemoteTaskState decides what (if
// anything) that means for the Native Intelligence action. The reconcile sweep
// (asana-reconcile.ts) calls the same helper, so the two paths cannot drift.
//
// HOUSE RULE — no `step.*` inside a `step.run` callback: nesting them deadlocks
// silently in production. Everything below is structured so each phase is ONE
// flat step.run, and the only step.sendEvent (the self-chain) is at the top
// level of the handler.
//
// BOUNDED: at most MAX_GIDS_PER_RUN gids per invocation (a burst of activity in
// a busy project can name far more), with the remainder self-chained. That keeps
// the worst-case Asana call count per run flat and predictable.
// =====================================================================

interface RemoteChangeEventData {
  syncStateId: string
  workspaceId: string
  taskGids: string[]
}

/** Asana GETs per invocation. The remainder self-chains. */
const MAX_GIDS_PER_RUN = 25

export const asanaApplyRemote = inngest.createFunction(
  {
    id: 'asana-apply-remote-change',
    retries: 3,
    // Per-workspace cap, matching the echo: a noisy Asana project can't
    // stampede our own API budget or the database.
    concurrency: [{ limit: 5, key: 'event.data.workspaceId' }],
    triggers: [{ event: 'tasks/asana-remote-change' }],
  },
  async ({ event, step }) => {
    const { syncStateId, workspaceId, taskGids } = event.data as RemoteChangeEventData

    const allGids = [...new Set((taskGids ?? []).filter((g) => typeof g === 'string' && g))]
    if (allGids.length === 0) {
      return { status: 'skipped' as const, reason: 'no_task_gids' }
    }
    const gids = allGids.slice(0, MAX_GIDS_PER_RUN)
    const remainder = allGids.slice(MAX_GIDS_PER_RUN)

    // ── Phase 1: token + the links these gids actually map to ───────────────
    // One batched link read (the (provider, external_id) index covers it) rather
    // than a query per gid. Anything unlinked — a task created directly in Asana,
    // or one whose link was deleted — simply isn't in the result and is skipped.
    const context = await step.run('load-context', async () => {
      const supabase = getServiceClient()
      const auth = await loadAsanaWebhookAuth(syncStateId)
      if (!auth) return null

      const { data } = await supabase
        .from('action_external_task')
        .select('id, action_id, external_id, completed')
        .eq('workspace_id', workspaceId)
        .eq('provider', ASANA_PROVIDER)
        .in('external_id', gids)

      const links = (data ?? []) as RemoteTaskLink[]
      if (links.length === 0) return { links, token: null, actorUserId: auth.userId }

      const resolved = await getValidTokenForAccount(auth.accountId)
      return { links, token: resolved?.token ?? null, actorUserId: auth.userId }
    })

    if (!context) {
      return { status: 'skipped' as const, reason: 'no_sync_state' }
    }
    if (context.links.length === 0) {
      return { status: 'skipped' as const, reason: 'no_links', gids: gids.length }
    }
    if (!context.token) {
      // Disconnected or unrefreshable account: a clean no-op, not a retry. The
      // reconcile sweep picks the work up once the user reconnects.
      return { status: 'skipped' as const, reason: 'no_token' }
    }

    // ── Phase 2: GET each task, then apply ──────────────────────────────────
    const outcome = await step.run('apply-remote-state', async () => {
      const supabase = getServiceClient()
      const results: ApplyRemoteResult[] = []

      for (const link of context.links) {
        let remoteCompleted: boolean
        try {
          const task = await getTask(context.token!, link.external_id)
          remoteCompleted = task?.completed === true
        } catch (err) {
          if (err instanceof AsanaUnauthorizedError) {
            // The token died mid-run. Stop cleanly for the WHOLE run rather than
            // burning retries on calls that will all 401 — the reconcile sweep
            // resumes after a reconnect.
            console.warn(
              `[asana-apply-remote] token rejected for workspace ${workspaceId}; aborting run.`,
            )
            return { aborted: 'unauthorized' as const, results }
          }
          if (err instanceof AsanaApiError && err.status === 404) {
            // The task was deleted in Asana. Terminal marker, then carry on with
            // the rest of the batch.
            await markTaskDeleted(supabase, link.id)
            results.push({ linkId: link.id, outcome: 'task_deleted' })
            continue
          }
          throw err // transient — let Inngest retry the step
        }

        results.push(
          await applyRemoteTaskState({
            supabase,
            workspaceId,
            actorUserId: context.actorUserId,
            link,
            remoteCompleted,
          }),
        )
      }

      return { aborted: null, results }
    })

    // ── Phase 3 (TOP LEVEL): self-chain the remainder ───────────────────────
    // step.sendEvent lives here, never inside a step.run callback.
    if (remainder.length > 0 && !outcome.aborted) {
      await step.sendEvent('continue-remote-change', {
        name: 'tasks/asana-remote-change',
        data: { syncStateId, workspaceId, taskGids: remainder },
      })
      return {
        status: 'continued' as const,
        applied: outcome.results,
        remaining: remainder.length,
      }
    }

    if (outcome.aborted) {
      return { status: 'aborted' as const, reason: outcome.aborted, applied: outcome.results }
    }

    return { status: 'ok' as const, applied: outcome.results }
  },
)
