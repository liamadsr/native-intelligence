/**
 * statusIdsForGroup — extract every workflow_state id a grouped result maps to.
 *
 * When grouping by status, the server attaches `metadata.status_ids` (all
 * member states merged into a board column across teams). We prefer that, fall
 * back to the scalar `metadata.status_id`, then to sampling the workflow_state
 * id off existing items (covers cached payloads that predate the metadata).
 *
 * Pure (no React) so the matching logic can be unit-tested directly.
 */

import type { GroupedResults } from '@/lib/views/types'

export function statusIdsForGroup(group: GroupedResults): string[] {
  const fromArray = group.metadata?.status_ids as string[] | undefined
  if (Array.isArray(fromArray) && fromArray.length > 0) return fromArray

  const scalar = group.metadata?.status_id as string | undefined
  if (scalar) return [scalar]

  const sampled = (group.items ?? [])
    .map((it) => (it.workflow_state as { id?: string } | undefined)?.id)
    .filter((id): id is string => Boolean(id))
  // De-dup the sampled ids — multiple cards in a column share the same state.
  return Array.from(new Set(sampled))
}
