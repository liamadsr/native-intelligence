/**
 * Application-layer Reciprocal Rank Fusion (RRF) for the `find` tool.
 *
 * Two fusion jobs happen in the tool layer, both pure functions here so they're
 * unit-testable without a DB:
 *
 *  1. `fuseWorkspaces` — cross-workspace merge. When `find` fans hybrid_search
 *     out across N workspaces, each returns its own already-fused `score`. Those
 *     scores ARE comparable (same RPC, same RRF math, same corpus shape), so we
 *     merge by score and trim — the SQL already did the hard fusion per workspace.
 *
 *  2. `fuseByRank` — heterogeneous-stream merge. The attachment stream comes from
 *     a DIFFERENT embedding space (Gemini 3072-d) than the claim/capture/document
 *     stream (OpenAI 1536-d). Their `score` fields are NOT comparable across
 *     spaces — but their RANKS are. So when combining streams that don't share a
 *     scoring basis, re-fuse by rank: RRF over each stream's ordinal position.
 *
 * RRF constant k = 60 — the standard value (original RRF paper; Elastic/Weaviate
 * production hybrid search). Matches the in-SQL `1/(60+rank)` so app-layer and
 * DB-layer fusion use one consistent dampening.
 */

export const RRF_K = 60

/** A result row as returned by hybrid_search / hybrid_search_attachments, tagged with workspace. */
export interface FusableRow {
  result_type: string
  result_id: string
  score?: number | null
  [key: string]: unknown
}

/** Stable identity for a result across streams/workspaces. */
function rowKey(r: FusableRow): string {
  const ws = (r.workspace_id as string | undefined) ?? ''
  return `${ws}::${r.result_type}::${r.result_id}`
}

/**
 * Merge per-workspace hybrid_search result arrays into one list.
 *
 * Each array is already RRF-fused inside its own workspace, and the scores are
 * comparable (identical RPC over comparably-shaped corpora), so this is a plain
 * score-desc merge + trim — NOT a second RRF pass. For a single workspace this
 * is just a sort. Deduping by (workspace, type, id) guards against a row
 * appearing twice if the same workspace were ever passed in twice.
 */
export function fuseWorkspaces<T extends FusableRow>(
  perWorkspace: T[][],
  limit: number,
): T[] {
  const byKey = new Map<string, T>()
  for (const rows of perWorkspace) {
    for (const r of rows) {
      const key = rowKey(r)
      const existing = byKey.get(key)
      // Keep the higher-scoring copy on the (defensive) duplicate path.
      if (!existing || (r.score ?? 0) > (existing.score ?? 0)) byKey.set(key, r)
    }
  }
  return [...byKey.values()]
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, limit)
}

/**
 * Fuse multiple ALREADY-ORDERED streams into one ranked list by Reciprocal Rank
 * Fusion over each stream's ordinal position.
 *
 * Use this to combine streams whose `score` fields are not mutually comparable
 * (e.g. the OpenAI-space hybrid_search stream vs the Gemini-space attachment
 * stream). Each stream is assumed to arrive in its own descending-relevance
 * order; a row's contribution from a stream is `1 / (k + position)` where
 * position is 1-indexed. A row present in multiple streams sums its
 * contributions. The output is sorted by the fused RRF score.
 *
 * `fused_score` is written onto each returned row (does not clobber the original
 * per-stream `score`, which callers may still want for debugging).
 */
export function fuseByRank<T extends FusableRow>(streams: T[][], limit: number): Array<T & { fused_score: number }> {
  const acc = new Map<string, { row: T; fused: number }>()
  for (const stream of streams) {
    stream.forEach((row, idx) => {
      const key = rowKey(row)
      const contribution = 1 / (RRF_K + (idx + 1))
      const existing = acc.get(key)
      if (existing) {
        existing.fused += contribution
      } else {
        acc.set(key, { row, fused: contribution })
      }
    })
  }
  return [...acc.values()]
    .sort((a, b) => b.fused - a.fused)
    .slice(0, limit)
    .map(({ row, fused }) => ({ ...row, fused_score: fused }))
}

/**
 * Auto-boost recency for tightly-windowed queries: "last week" implies the user
 * cares which of the matches is freshest within that window. When the caller
 * didn't set recency_weight explicitly, raise it to 1.0 for windows ≤ 45 days,
 * else keep the default 0.5.
 */
export function resolveRecencyWeight(
  explicit: number | undefined,
  sinceISO: string | null,
): number {
  if (explicit !== undefined) return explicit
  if (!sinceISO) return 0.5
  const windowDays = (Date.now() - new Date(sinceISO).getTime()) / 86_400_000
  return windowDays <= 45 ? 1.0 : 0.5
}
