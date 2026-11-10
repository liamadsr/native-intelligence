import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * The `action_external_task.last_push_error` marker vocabulary for LINEAR links.
 *
 * Shared by the paths that can fail against one issue — the Native Intelligence→Linear echo,
 * the webhook read-back and the reconcile sweep — so a marker one of them writes
 * means the same thing to the others.
 *
 * EVERY LINEAR MARKER IS RETRYABLE, matching the Jira vocabulary next door and
 * diverging from Asana's, which treats a 404 as the TERMINAL `task_deleted`
 * (markTaskDeleted in apply-remote-task-state.ts — still correct there, because
 * an Asana gid that 404s really is gone).
 *
 * Linear cannot support a terminal reading, for a sharper version of Jira's
 * reason: `issue(id:)` returns a clean `{ data: { issue: null } }` with NO
 * `errors` entry for THREE different situations — the issue was deleted, the
 * connected user cannot see it, or the id never existed. There is no field to
 * tell them apart. A terminal marker would therefore silently kill the sync for
 * every link a permissions change touched, with no way back except unlinking and
 * re-pushing each action — which mints duplicate issues. `task_missing` records
 * the observation without foreclosing on it: the next status change re-tries the
 * link, the 6-hourly sweep keeps polling it, and the first successful read clears
 * the marker.
 *
 * `trashed` issues get the SAME marker rather than one of their own. Linear's
 * delete is a 30-day grace window, so a trashed issue is genuinely
 * "gone-for-now, possibly back" — which is what task_missing already means, and
 * inventing a second code would only give the three writers two ways to say it.
 */
export type LinearLinkMarkerCode =
  /** The token was rejected (401/403). Cleared by a reconnect + the next success. */
  | 'unauthorized'
  /** `issue(id:)` answered null, or the issue is trashed. NOT terminal. */
  | 'task_missing'
  /**
   * The destination's state map has no state for the bucket we need to write.
   *
   * Linear's own doing, not a misconfiguration: a team is not guaranteed to have
   * a state of every type, and a team with no canceled-type state is ordinary.
   * The echo declines rather than writing the nearest closed state — landing a
   * canceled action on "Done" would tell the customer's team the work shipped.
   */
  | 'no_target_state'
  /** `issueUpdate` was rejected — a stale state id, or a transient failure. */
  | 'update_failed'

/** The null/trashed marker, named once so the three paths cannot drift apart. */
export const LINEAR_TASK_MISSING: LinearLinkMarkerCode = 'task_missing'

/**
 * Read the `code` out of a stored marker.
 *
 * The column is untrusted jsonb (hand-edited rows, a future writer with a
 * different shape), so anything that isn't `{ code: <string> }` reads as "no
 * marker" — degrading to normal behaviour rather than wedging a link.
 */
export function markerCodeOf(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const code = (raw as { code?: unknown }).code
  return typeof code === 'string' && code.length > 0 ? code : null
}

/** Stamp a retryable failure marker on a link. */
export async function stampLinearLinkMarker(
  supabase: SupabaseClient,
  linkId: string,
  code: LinearLinkMarkerCode,
): Promise<void> {
  const { error } = await supabase
    .from('action_external_task')
    .update({ last_push_error: { code, at: new Date().toISOString() } })
    .eq('id', linkId)
  if (error) {
    console.warn(`[linear] failed to mark link ${linkId} ${code}:`, error.message)
  }
}

/**
 * Retire a marker after a successful read.
 *
 * Called by the read-back paths, which otherwise write only `completed` /
 * `last_synced_at` / `external_state_label` and would leave a `task_missing`
 * stamp on a link whose issue became readable again. Only fires when a marker is
 * actually stored, so a quiet sweep over unchanged issues stays read-only.
 */
export async function clearLinearLinkMarker(
  supabase: SupabaseClient,
  linkId: string,
  storedMarker: unknown,
): Promise<boolean> {
  if (!markerCodeOf(storedMarker)) return false
  const { error } = await supabase
    .from('action_external_task')
    .update({ last_push_error: null })
    .eq('id', linkId)
  if (error) {
    console.warn(`[linear] failed to clear the marker on link ${linkId}:`, error.message)
    return false
  }
  return true
}
