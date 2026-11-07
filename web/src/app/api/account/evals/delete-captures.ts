/**
 * Delete the eval captures a set of cases owned — the TEMPLATE each case was
 * authored from, and the per-trial CLONE every run of it wrote.
 *
 * The composite FK runs case → capture, so deleting a case leaves its capture
 * behind: an `is_eval` row no screen lists and nothing else ever collects.
 * Both DELETE routes call this after their own cascade has landed.
 *
 * Three guards, in the order they matter:
 *   - the service client, because a template capture is `visibility: 'private'`
 *     under whoever authored the case, and the person deleting the suite need
 *     not be that person;
 *   - `.eq('is_eval', true)` ON THE DELETE ITSELF, not merely on a preceding
 *     read, so a mis-seeded case pointing at a REAL capture can never take one
 *     down with it (spec §3.2 — the same reason the composite FK exists);
 *   - `.eq('workspace_id', ...)`, so a capture id smuggled in from another
 *     workspace deletes nothing.
 *
 * A failure is logged, never thrown: the case rows are already gone by the
 * time this runs, and turning a leftover capture into a 500 would tell the
 * user their delete failed when the part they can see succeeded.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { trialGoalEventId } from '@/lib/evals/clone-trial-capture'

/**
 * The CLONE captures every trial of these cases ran against.
 *
 * `cloneTrialCapture` writes a fresh `captures` row per trial (plus its
 * participant rows and a `chat_conversations` row), and the trial is the only
 * thing that ever points at it. The composite FK points capture → trial, so a
 * suite or case delete cascades `eval_trial` away and the clones survive with
 * no referent at all: unreachable rows holding a full synthetic transcript,
 * one per trial, forever. So they are collected BEFORE the cascade and deleted
 * after it, alongside the templates.
 *
 * Best-effort like the delete itself: a read that fails means some clones are
 * left behind, which is the status quo, not a reason to fail a delete whose
 * visible half succeeded.
 */
export async function collectTrialCaptureIds(
  service: SupabaseClient,
  workspaceId: string,
  caseIds: string[],
): Promise<string[]> {
  const ids = caseIds.filter((id) => typeof id === 'string' && id.length > 0)
  if (ids.length === 0) return []

  const { data, error } = await service
    .from('eval_trial')
    .select('capture_id')
    .in('case_id', ids)
    .eq('workspace_id', workspaceId)

  if (error) {
    console.error('[evals] trial capture collect failed:', error.message)
    return []
  }
  return ((data ?? []) as { capture_id: string | null }[])
    .map((t) => t.capture_id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
}

export async function deleteEvalCaptures(
  service: SupabaseClient,
  workspaceId: string,
  captureIds: string[],
): Promise<void> {
  const ids = captureIds.filter((id) => typeof id === 'string' && id.length > 0)
  if (ids.length === 0) return

  // A trial's goal (cloneTrialCapture) is keyed by its synthetic event id and
  // its capture link is ON DELETE SET NULL, so it would outlive the clone as a
  // goal for no meeting. Removed by that key, which only a trial writes.
  const { error: goalError } = await service
    .from('meeting_goal')
    .delete()
    .eq('workspace_id', workspaceId)
    .in('calendar_event_id', ids.map(trialGoalEventId))
  if (goalError) {
    console.error('[evals] trial goal cleanup failed:', goalError.message)
  }

  const { error } = await service
    .from('captures')
    .delete()
    .in('id', ids)
    .eq('workspace_id', workspaceId)
    .eq('is_eval', true)

  if (error) {
    console.error('[evals] template capture cleanup failed:', error.message)
  }
}
