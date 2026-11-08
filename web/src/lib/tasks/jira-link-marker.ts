import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * The `action_external_task.last_push_error` marker vocabulary for JIRA links.
 *
 * Shared by the three paths that can fail against one issue — the Native Intelligence→Jira
 * echo (src/lib/inngest/jira-echo-status.ts), the webhook read-back
 * (jira-apply-remote.ts) and the reconcile sweep (jira-reconcile.ts) — so a
 * marker one of them writes means the same thing to the other two.
 *
 * EVERY JIRA MARKER IS RETRYABLE. That is the deliberate difference from the
 * Asana vocabulary next door, which treats a 404 as the TERMINAL `task_deleted`
 * (see markTaskDeleted in apply-remote-task-state.ts — still correct there, and
 * still Asana's).
 *
 * Jira cannot support a terminal reading of 404: `GET /issue/{id}` answers 404
 * both for "this issue does not exist" AND for "the connected user cannot browse
 * it", and Atlassian deliberately does not distinguish them (the transitions
 * endpoint has the same property — it "uses the exact same user permissions as
 * the GUI"). So a permission scheme edited for an hour is indistinguishable from
 * a deletion, and a terminal marker would silently kill the echo for every open
 * link in a workspace with no way back except unlinking and re-pushing each
 * action — which mints duplicate issues. `task_missing` therefore records the
 * observation without foreclosing on it: the next status change re-tries the
 * link, the 6-hourly sweep keeps polling it (one GET per link per sweep), and
 * the first successful read clears the marker.
 */
export type JiraLinkMarkerCode =
  /** The token was rejected (401). Cleared by a reconnect + the next success. */
  | 'unauthorized'
  /** `GET /issue` answered 404 — deleted, OR no longer browsable. NOT terminal. */
  | 'task_missing'
  /** The workflow (or this user's permissions in it) offers no way to the target. */
  | 'no_transition'
  /** The transition POST was rejected 4xx — a validator or an off-screen field. */
  | 'transition_failed'

/** The 404 marker, named once so the three paths cannot drift apart. */
export const JIRA_TASK_MISSING: JiraLinkMarkerCode = 'task_missing'

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
export async function stampJiraLinkMarker(
  supabase: SupabaseClient,
  linkId: string,
  code: JiraLinkMarkerCode,
): Promise<void> {
  const { error } = await supabase
    .from('action_external_task')
    .update({ last_push_error: { code, at: new Date().toISOString() } })
    .eq('id', linkId)
  if (error) {
    console.warn(`[jira] failed to mark link ${linkId} ${code}:`, error.message)
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
export async function clearJiraLinkMarker(
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
    console.warn(`[jira] failed to clear the marker on link ${linkId}:`, error.message)
    return false
  }
  return true
}
