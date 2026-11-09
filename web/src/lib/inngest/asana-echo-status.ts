import { inngest } from './client'
import { getServiceClient } from '@/lib/admin'
import { getValidTokenForAccount } from '@/lib/oauth/token-manager'
import {
  addTaskToSection,
  updateTaskCompleted,
  AsanaApiError,
  AsanaUnauthorizedError,
} from '@/lib/integrations/asana-api'
import { ASANA_PROVIDER, loadAsanaSyncState } from '@/lib/tasks/asana-config'
import { asanaWriteForBucket, bucketForCategory } from '@/lib/tasks/lifecycle'

// =====================================================================
// Native Intelligence → Asana status echo
//
// The write half of two-way completion sync: when a Native Intelligence action moves to a new
// workflow state, every Asana task linked to it is updated to match. (The read
// half — Asana → Native Intelligence over a webhook — is Phase B.)
//
// It rides the EXISTING `flow/entity.status_changed` event rather than minting
// its own: that event is already the single choke point every status writer
// funnels through (emitStatusChange, GEN-112), so subscribing here means the
// echo fires from the board drag, the ticket dropdown, the AI tools, bulk
// operations and proposal applies without touching any of them. Inngest happily
// fans one event out to multiple functions, so flowDispatchOnStatusChange keeps
// working untouched beside this one.
//
// NOTE the event payload is snake_case (`workspace_id`, `entity_id`, …) — the
// concurrency keys below must match those names exactly or they'd silently
// resolve to undefined and degrade to a single global queue.
//
// Every gate is a clean, logged no-op — never a throw — so a workspace without
// Asana (the overwhelming majority) never accretes failing runs from ordinary
// status changes. Only genuinely transient failures throw and let Inngest retry.
//
// PERMANENT-FAILURE MARKERS (action_external_task.last_push_error), mirroring
// hubspot-push-contact's metadata marker. The two codes have DIFFERENT
// lifetimes, and the marker is read on every subsequent run:
//   - 404 → { code: 'task_deleted', at } — the Asana task was deleted out from
//     under the link. TERMINAL: nothing this function can do brings it back, so
//     a marked link is skipped BEFORE any Asana I/O on every later run (outcome
//     'marked_failed'). The link row stays so the UI can show why it stopped
//     syncing, and only an explicit unlink clears it.
//   - 401 → { code: 'unauthorized', at } — the token was not accepted. Marked,
//     then no-op for THIS run, but RETRIED on the next status change: a
//     reconnect between the two runs fixes it, and nothing else would ever
//     retire the marker. Retrying also means the already_synced fast path must
//     not swallow it — see the loop below.
// A successful echo CLEARS the marker.
// =====================================================================

interface StatusChangedEventData {
  entity_type: string
  entity_id: string
  workspace_id: string
  to_status_id: string
}

interface LinkRow {
  id: string
  external_id: string
  completed: boolean
  /** { code, at } permanent-failure marker, or null. See the header. */
  last_push_error: unknown
}

export const asanaEchoStatus = inngest.createFunction(
  {
    id: 'asana-echo-status',
    retries: 3,
    // Two constraints (Inngest evaluates both):
    //  - per-workspace cap (limit 5) mirrors the other integration functions —
    //    a bulk status change over 100 actions can't stampede Asana.
    //  - per-action serialization (limit 1) keeps two rapid status flips on the
    //    same action from racing each other to opposite completion states.
    concurrency: [
      { limit: 5, key: 'event.data.workspace_id' },
      { limit: 1, key: 'event.data.entity_id' },
    ],
    triggers: [{ event: 'flow/entity.status_changed' }],
  },
  async ({ event, step }) => {
    const { entity_type, entity_id, workspace_id, to_status_id } =
      event.data as StatusChangedEventData

    // Gate 1: actions are the only entity that can carry an external task link.
    // Project/initiative/milestone status changes share this event.
    if (entity_type !== 'action') {
      return { status: 'skipped' as const, reason: 'not_an_action' }
    }

    const supabase = getServiceClient()

    // Gate 2: does this action have any Asana links at all? This is the cheap
    // read that makes the echo free for every workspace that doesn't use Asana.
    const links = await step.run('load-links', async () => {
      const { data } = await supabase
        .from('action_external_task')
        .select('id, external_id, completed, last_push_error')
        .eq('action_id', entity_id)
        .eq('workspace_id', workspace_id)
        .eq('provider', ASANA_PROVIDER)
      return (data ?? []) as LinkRow[]
    })

    if (links.length === 0) {
      return { status: 'skipped' as const, reason: 'no_links' }
    }

    // Gate 3: the target status's CATEGORY — the only status property that
    // maps to an external lifecycle (names are per-team and arbitrary).
    const bucket = await step.run('resolve-bucket', async () => {
      const { data } = await supabase
        .from('workflow_state')
        .select('category')
        .eq('id', to_status_id)
        .maybeSingle()
      return bucketForCategory((data?.category as string | null) ?? '')
    })

    // Gate 4: destination + token. A workspace can hold links from an Asana
    // account that was since disconnected — no state / no token is a clean
    // no-op, not a retry.
    const destination = await step.run('resolve-destination', async () => {
      const state = await loadAsanaSyncState(workspace_id)
      if (!state) return null
      const resolved = await getValidTokenForAccount(state.accountId)
      if (!resolved) return null
      return { token: resolved.token, sectionMap: state.config.section_map ?? null }
    })

    if (!destination) {
      return { status: 'skipped' as const, reason: 'no_asana_account' }
    }

    const write = asanaWriteForBucket(bucket, destination.sectionMap)

    const results = await step.run('echo-tasks', async () => {
      const summary: Array<{ linkId: string; outcome: string }> = []

      for (const link of links) {
        const marker = markerCodeOf(link.last_push_error)

        // TERMINAL marker: the Asana task is gone. Re-attempting only earns
        // another 404, so skip every Asana call for this link — the marker is
        // retired by an unlink, never by this function.
        if (marker === 'task_deleted') {
          summary.push({ linkId: link.id, outcome: 'marked_failed' })
          continue
        }

        // Nothing to do: the task already carries the target completion state
        // and this bucket has no section mapped. Saves the round-trip on the
        // very common "moved between two not-started columns" transition.
        //
        // A link carrying a RETRYABLE marker ('unauthorized') is excluded from
        // this fast path even when it looks in sync: the marker is stale state
        // in its own right, and skipping here would leave it stamped forever
        // (nothing else clears it) with the integration silently shown as
        // broken. Falling through re-attempts whatever writes are outstanding —
        // possibly none — and the success path below clears the marker.
        if (link.completed === write.completed && !write.sectionGid && !marker) {
          summary.push({ linkId: link.id, outcome: 'already_synced' })
          continue
        }

        try {
          if (link.completed !== write.completed) {
            await updateTaskCompleted(destination.token, link.external_id, write.completed)
          }
          if (write.sectionGid) {
            // Idempotent by contract: re-adding a task to the section it's
            // already in is a no-op on Asana's side.
            await addTaskToSection(destination.token, write.sectionGid, link.external_id)
          }
        } catch (err) {
          const marker = markerForError(err)
          if (!marker) throw err // transient — let Inngest retry the whole step

          await supabase
            .from('action_external_task')
            .update({
              last_push_error: { code: marker, at: new Date().toISOString() },
            })
            .eq('id', link.id)

          console.warn(
            `[asana-echo-status] ${marker} echoing action ${entity_id} to Asana task ` +
              `${link.external_id}; marked and skipped.`,
          )
          summary.push({ linkId: link.id, outcome: marker })
          continue
        }

        // Success: record the new provider state and retire any earlier marker.
        // This is also the ONLY thing that clears a stale 'unauthorized' — it
        // runs even when the fall-through above found no Asana write to make.
        await supabase
          .from('action_external_task')
          .update({
            completed: write.completed,
            last_synced_at: new Date().toISOString(),
            last_push_error: null,
          })
          .eq('id', link.id)

        summary.push({ linkId: link.id, outcome: 'synced' })
      }

      return summary
    })

    return {
      status: 'ok' as const,
      bucket,
      completed: write.completed,
      results,
    }
  },
)

/**
 * Classify an Asana failure into a permanent-failure marker, or null when it's
 * transient and the run should retry.
 *
 * Only two failures are permanent from the echo's side: the token is rejected
 * (401 — reconnect required) and the task no longer exists (404 — deleted in
 * Asana). Everything else (429 past the client's own backoff, 5xx, network)
 * gets Inngest's retries.
 */
function markerForError(err: unknown): 'unauthorized' | 'task_deleted' | null {
  if (err instanceof AsanaUnauthorizedError) return 'unauthorized'
  if (err instanceof AsanaApiError && err.status === 404) return 'task_deleted'
  return null
}

/**
 * Read the `code` out of a stored `last_push_error` marker.
 *
 * The column is untrusted jsonb (hand-edited rows, a future writer with a
 * different shape), so anything that isn't `{ code: <string> }` reads as "no
 * marker" — degrading to the normal echo rather than wedging a link.
 */
function markerCodeOf(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const code = (raw as { code?: unknown }).code
  return typeof code === 'string' && code.length > 0 ? code : null
}
