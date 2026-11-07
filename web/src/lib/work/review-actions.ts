/**
 * The actions a run is working, which an agent finishing moves to REVIEW,
 * never Done (decision 9; CreateToolsOptions.actionRules.reviewActionIds).
 *
 * Read off the run's own ledger row, server-side:
 *   - its `source.action_id` (a delegated action's work run, a For you Start);
 *   - its `source` entity when that is an action (a loop fired by an action's
 *     status change: startFlowWork's `{ entity_type: 'action', entity_id }`),
 *     so a flow that completes the action that triggered it sends it to review;
 *   - the same on its ROOT row (`root_id`): a delegated child run completing
 *     the parent's action goes to review too.
 * The tool routes ask only for a complete_action / update_action call, so no
 * other call pays for the reads. Never throws: a failed read answers what it
 * has.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

interface LedgerRef {
  id: string
  root_id?: string | null
  source?: Record<string, unknown> | null
}

function actionsOf(row: LedgerRef | null): string[] {
  const s = row?.source ?? null
  if (!s || typeof s !== 'object') return []
  const out: string[] = []
  if (typeof s.action_id === 'string' && s.action_id) out.push(s.action_id)
  if (s.entity_type === 'action' && typeof s.entity_id === 'string' && s.entity_id) out.push(s.entity_id)
  return out
}

export async function reviewActionIdsForWork(
  supabase: SupabaseClient,
  workItemId: string | null | undefined,
): Promise<string[]> {
  if (!workItemId) return []
  const ids = new Set<string>()
  try {
    const { data } = await supabase.from('tracked_job').select('id, root_id, source').eq('id', workItemId).maybeSingle()
    const row = (data as LedgerRef | null) ?? null
    for (const id of actionsOf(row)) ids.add(id)
    if (row?.root_id && row.root_id !== row.id) {
      const { data: root } = await supabase.from('tracked_job').select('id, root_id, source').eq('id', row.root_id).maybeSingle()
      for (const id of actionsOf((root as LedgerRef | null) ?? null)) ids.add(id)
    }
  } catch (err) {
    console.warn('[review-actions] ledger read failed:', err instanceof Error ? err.message : err)
  }
  return [...ids]
}

/** The tools whose completion of a run's own action goes to review. */
export const REVIEW_ROUTED_TOOLS: ReadonlySet<string> = new Set(['complete_action', 'update_action'])
