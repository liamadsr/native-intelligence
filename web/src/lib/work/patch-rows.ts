/**
 * Patching a pushed `tracked_job` row into a list the client already holds
 * (docs/plans/agent-orchestration-product.md §1.2/§1.3: the ledger hooks patch
 * the changed row the way use-attention-items.ts does, instead of refetching).
 *
 * The realtime payload is the whole row (REPLICA IDENTITY FULL, migration 272)
 * but not the `teammate` embed the ledger reads add (queries.ts
 * WORK_ITEM_SELECT: its name and the bot it wears). A patch keeps the whole
 * embed when it can prove it (the same teammate id on the row it replaces, or
 * on any other row in the list) and otherwise reports `needsTeammate`, so the
 * hook can refetch once to name who ran it. Pure, so the hooks' merge rules are
 * tested once here.
 */
import type { WorkItem, WorkTeammate } from './types'

/** Newest first — the order the ledger reads return. */
function byCreatedDesc(a: WorkItem, b: WorkItem): number {
  return a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0
}

function knownTeammate(list: readonly WorkItem[], row: WorkItem): WorkTeammate | null {
  const id = row.ai_team_member_id ?? null
  if (!id) return null
  const same = list.find((it) => it.id === row.id)
  if (same && (same.ai_team_member_id ?? null) === id && same.teammate) return same.teammate
  return list.find((it) => (it.ai_team_member_id ?? null) === id && it.teammate)?.teammate ?? null
}

/**
 * Insert or replace `row` in `list`, newest first. Returns the new list and
 * whether the row names a teammate the list cannot name yet.
 */
export function upsertWorkRow(
  list: readonly WorkItem[],
  row: WorkItem,
): { list: WorkItem[]; needsTeammate: boolean } {
  const teammate = knownTeammate(list, row)
  const merged: WorkItem = { ...row, teammate }
  const next = list.filter((it) => it.id !== row.id)
  next.push(merged)
  next.sort(byCreatedDesc)
  return { list: next, needsTeammate: !!row.ai_team_member_id && !teammate }
}

/** `list` without the row, or the same array when it was not there. */
export function removeWorkRow(list: readonly WorkItem[], id: string): WorkItem[] {
  return list.some((it) => it.id === id) ? list.filter((it) => it.id !== id) : (list as WorkItem[])
}

/**
 * Whether a pushed row belongs to the feed that asked: its member is one of
 * the member ids the route answered for. Unknown scope (no answer yet) admits
 * nothing — the first load brings the rows.
 */
export function inFeedScope(row: Pick<WorkItem, 'member_id'>, memberIds: ReadonlySet<string> | null): boolean {
  return !!memberIds && !!row.member_id && memberIds.has(row.member_id)
}
