/**
 * One item per run (bots-v3.md "One item per run", Phase 1b). A verdict run's
 * cards are stamped, when they're inserted, with the run's ledger row
 * (`payload.work_item_id`) and its loop (`payload.flow_id`): bots v3 1a,
 * verdict-apply.ts. The bubble folds two or more of one run's cards into one
 * batch item, and the jump, the peek and Open all key on the run, so a late
 * fourth card joins the batch silently.
 *
 * Pure: shared by the item lists (bubble-items.ts), the main agent's reads
 * and where an item opens (open-teammate.ts).
 */

/** A card's fields a batch is keyed by (its payload, stamped when it was inserted, and its run key). */
export type BatchableCard = { payload?: Record<string, unknown> | null; run_key?: unknown }

/**
 * The run a card belongs to, as one key: `work:<work_item_id>` (the run's
 * ledger row), else `run:<run_key>:<flow_id>` (a run with no ledger row: its
 * fire and its loop). Never the bare `run_key`: that's the Inngest event id,
 * which every loop one capture fires shares, and two loops' cards are two
 * batches, under two bots. Null: a card that names no run (an older one, a
 * proposal from elsewhere), which stands alone.
 */
export function batchKeyOf(card: BatchableCard): string | null {
  const p = card.payload ?? {}
  const workItemId = typeof p.work_item_id === 'string' && p.work_item_id ? p.work_item_id : null
  if (workItemId) return `work:${workItemId}`
  const runKey = typeof card.run_key === 'string' && card.run_key ? card.run_key : null
  const flowId = typeof p.flow_id === 'string' && p.flow_id ? p.flow_id : null
  return runKey && flowId ? `run:${runKey}:${flowId}` : null
}

/** The ledger row a batch key names (`work:<id>`), else null. */
export function batchWorkItemId(key: string): string | null {
  return key.startsWith('work:') && key.length > 5 ? key.slice(5) : null
}

/** A bubble item's id that is a run's batch, not a row's or a card's. */
export function isBatchKey(id: string): boolean {
  return id.startsWith('work:') || id.startsWith('run:')
}
