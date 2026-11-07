/**
 * Pure logic shared by the workspace-move preflight routes.
 *
 * The move engine (migration 221) relocates a knowledge claim only when EVERY
 * one of its evidence rows points at something moving in the same transaction
 * — a claim with outside evidence stays behind. The preflight endpoints have
 * to predict that split to disclose it honestly, so the rule lives here once
 * rather than once per entity.
 *
 * `partitionClaimsBySource` in `@/lib/captures/move-artifacts` is the
 * capture-shaped ancestor of this helper (capture + its attachments,
 * hard-coded). This one takes the moving set as explicit (type, id) pairs, so
 * a document, a project's whole document set, or any future entity can reuse
 * it — the same shape `_wsmove_claims(p_pairs)` receives in SQL.
 */

/** A row of `claim_source`: one piece of evidence behind a claim. */
export interface ClaimSourceRow {
  claim_id: string
  source_type: string
  source_id: string | null
}

/** One entity moving in the transaction, expressed in `claim_source` terms. */
export interface MovingSource {
  type: string
  id: string
}

/** Joined on a separator neither field can contain, so a (type, id) pair can
 * never be confused with a different pair that splits the other way. */
const pairKey = (type: string, id: string) => `${type}\u0000${id}`

/**
 * Split claim ids into sole-sourced (every evidence row points at one of the
 * moving entities — the claim travels) and shared (evidence from elsewhere
 * too — ambiguous, stays behind).
 *
 * A claim with no visible evidence rows counts as shared: without evidence
 * there's no proof it belongs solely to the moving set, and the SQL side
 * likewise only ever considers claims with at least one matching row.
 */
export function partitionClaimsForSources(
  claimIds: string[],
  sourceRows: ClaimSourceRow[],
  pairs: MovingSource[],
): { soleSourced: string[]; shared: string[] } {
  const moving = new Set(pairs.map((p) => pairKey(p.type, p.id)))
  const isMoving = (row: ClaimSourceRow) =>
    row.source_id !== null && moving.has(pairKey(row.source_type, row.source_id))

  const rowsByClaim = new Map<string, ClaimSourceRow[]>()
  for (const row of sourceRows) {
    const list = rowsByClaim.get(row.claim_id)
    if (list) list.push(row)
    else rowsByClaim.set(row.claim_id, [row])
  }

  const soleSourced: string[] = []
  const shared: string[] = []
  for (const claimId of claimIds) {
    const rows = rowsByClaim.get(claimId) ?? []
    if (rows.length > 0 && rows.every(isMoving)) soleSourced.push(claimId)
    else shared.push(claimId)
  }
  return { soleSourced, shared }
}
