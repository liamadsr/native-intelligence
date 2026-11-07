/**
 * Pure logic for the capture / document / attachment PERMANENT-DELETE
 * knowledge-graph cleanup.
 *
 * The actual delete runs inside a Postgres function (migration 178) so the
 * partition + delete is atomic. This module is the executable specification of
 * what that SQL does: given a claim's evidence rows and the set of sources
 * being deleted, decide which claims are sole-sourced (hard-deleted) vs shared
 * (evidence pruned, claim kept), and which entity_link edges get removed.
 *
 * Keeping the decision here mirrors `move-artifacts.ts` — it documents the
 * policy in one readable place and lets the branch logic be unit-tested without
 * a live database.
 *
 * Policy (see migration 178 header): "permanently delete" means the derived
 * knowledge whose ONLY evidence was this source is deleted too. Claims that
 * also have evidence from other sources survive with just this source's
 * evidence pruned.
 */

/** A source being torn down, e.g. { source_type: 'capture', source_id: '…' }
 * or { source_type: 'attachment', source_id: '…' }. */
export interface DeletedSource {
  source_type: string
  source_id: string
}

/** A claim's evidence row (claim_source). */
export interface ClaimSourceRow {
  claim_id: string
  source_type: string
  source_id: string | null
}

/** A polymorphic graph edge (entity_link). */
export interface EntityLinkRow {
  id: string
  source_type: string
  source_id: string
  target_type: string
  target_id: string
}

/**
 * Partition claims linked to the deleted sources into:
 *   - soleSourced: EVERY claim_source row of the claim points at one of the
 *     deleted sources → the claim is hard-deleted.
 *   - shared: at least one claim_source row points elsewhere → the claim is
 *     kept, and only its evidence rows pointing at a deleted source are pruned.
 *
 * `claimIds` is the set of claims that have AT LEAST ONE piece of evidence
 * pointing at a deleted source (the SQL computes this with a join; here the
 * caller passes it, or we derive it from the rows). A claim with no evidence
 * rows at all is not in scope (it isn't sourced by anything being deleted).
 */
export function partitionClaimsForDeletion(
  deletedSources: DeletedSource[],
  claimSourceRows: ClaimSourceRow[],
): { soleSourced: string[]; shared: string[] } {
  const deleted = new Set(
    deletedSources.map((s) => `${s.source_type}::${s.source_id}`),
  )
  const isDeleted = (row: ClaimSourceRow) =>
    row.source_id !== null && deleted.has(`${row.source_type}::${row.source_id}`)

  const rowsByClaim = new Map<string, ClaimSourceRow[]>()
  for (const row of claimSourceRows) {
    const list = rowsByClaim.get(row.claim_id)
    if (list) list.push(row)
    else rowsByClaim.set(row.claim_id, [row])
  }

  // Only claims that actually have evidence pointing at a deleted source are in
  // scope — the SQL joins claim_source to the deleted set to find them.
  const linkedClaimIds = [...rowsByClaim.keys()].filter((claimId) =>
    (rowsByClaim.get(claimId) ?? []).some(isDeleted),
  )

  const soleSourced: string[] = []
  const shared: string[] = []
  for (const claimId of linkedClaimIds) {
    const rows = rowsByClaim.get(claimId) ?? []
    // bool_and(row belongs to a deleted source) — every evidence row is dead.
    if (rows.length > 0 && rows.every(isDeleted)) soleSourced.push(claimId)
    else shared.push(claimId)
  }
  return { soleSourced, shared }
}

/**
 * The claim_source rows to DELETE for the shared claims: rows pointing at a
 * deleted source that belong to a claim which is NOT sole-sourced (sole-sourced
 * claims are removed wholesale, so their claim_source rows cascade — no need to
 * list them). Returns the row identities to prune.
 */
export function prunedSharedEvidence(
  deletedSources: DeletedSource[],
  claimSourceRows: ClaimSourceRow[],
): ClaimSourceRow[] {
  const { soleSourced } = partitionClaimsForDeletion(deletedSources, claimSourceRows)
  const sole = new Set(soleSourced)
  const deleted = new Set(
    deletedSources.map((s) => `${s.source_type}::${s.source_id}`),
  )
  return claimSourceRows.filter(
    (row) =>
      row.source_id !== null &&
      deleted.has(`${row.source_type}::${row.source_id}`) &&
      !sole.has(row.claim_id),
  )
}

/**
 * The entity_link edges to DELETE. Three classes, matching migration 178:
 *   1. Any edge touching a sole-sourced (about-to-be-deleted) claim id, as
 *      source OR target.
 *   2. Mirrored claim↔deleted-source edges for the SURVIVING shared claims.
 *   3. Any edge whose endpoint IS one of the deleted sources itself
 *      (e.g. capture↔contact), regardless of the other endpoint.
 */
export function edgesToDelete(
  deletedSources: DeletedSource[],
  claimSourceRows: ClaimSourceRow[],
  edges: EntityLinkRow[],
): EntityLinkRow[] {
  const { soleSourced, shared } = partitionClaimsForDeletion(
    deletedSources,
    claimSourceRows,
  )
  const soleClaims = new Set(soleSourced)
  const sharedClaims = new Set(shared)
  const deletedKey = new Set(
    deletedSources.map((s) => `${s.source_type}::${s.source_id}`),
  )
  const endpointIsDeleted = (t: string, id: string) => deletedKey.has(`${t}::${id}`)

  const out: EntityLinkRow[] = []
  const seen = new Set<string>()
  const push = (e: EntityLinkRow) => {
    if (seen.has(e.id)) return
    seen.add(e.id)
    out.push(e)
  }

  for (const e of edges) {
    // 1. touches a sole-sourced claim (either endpoint)
    if (
      (e.source_type === 'claim' && soleClaims.has(e.source_id)) ||
      (e.target_type === 'claim' && soleClaims.has(e.target_id))
    ) {
      push(e)
      continue
    }
    // 2. mirrored edge: a surviving shared claim ↔ a deleted source
    const sharedClaimToDeleted =
      e.source_type === 'claim' &&
      sharedClaims.has(e.source_id) &&
      endpointIsDeleted(e.target_type, e.target_id)
    const deletedToSharedClaim =
      e.target_type === 'claim' &&
      sharedClaims.has(e.target_id) &&
      endpointIsDeleted(e.source_type, e.source_id)
    if (sharedClaimToDeleted || deletedToSharedClaim) {
      push(e)
      continue
    }
    // 3. endpoint IS a deleted source itself
    if (
      endpointIsDeleted(e.source_type, e.source_id) ||
      endpointIsDeleted(e.target_type, e.target_id)
    ) {
      push(e)
      continue
    }
  }
  return out
}
