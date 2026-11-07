import { describe, it, expect, vi } from 'vitest'

// The weaver module registers an Inngest function at import time; stub the
// client so importing the pure helpers doesn't construct real infrastructure.
vi.mock('@/lib/inngest/client', () => ({
  inngest: { createFunction: vi.fn(() => ({})) },
}))

import {
  AnchorStats,
  anchorDisplay,
  anchorEmbedText,
  anchorThresholds,
  cosineSimilarity,
  lexicalOverlap,
  mergeDuplicate,
  mergeKeeperIsSelf,
  filterClaimsVisibleToNobody,
  parseEmbedding,
  partitionCandidates,
  partitionAnchorCandidates,
  scoreAnchorCandidates,
  selectBackfillClaims,
  selectBriefStaleWorkspaces,
  shouldJudgeAnchors,
  unionWorkspaces,
  validateAnchorVerdict,
  PROJECT_LINK_AUTO,
  PROJECT_LINK_FLOOR,
  SIM_AUTO_MERGE,
  SIM_FLOOR,
  type AnchorCandidate,
  type AnchorPartition,
  type WeaveCandidate,
} from '../knowledge-weaver'
import {
  normalizeWeaverSettings,
  anchorTypesFromSettings,
  FEATURE_ANCHOR_TYPES,
} from '@/lib/knowledge/anchor-types'
import { anchorDescriptor } from '@/lib/knowledge/entity-registry'
import {
  DEFAULT_SKILL_RUN_MODEL,
  DEFAULT_SKILL_RUN_MODEL_SLUG,
  gatewayModelSlug,
  usageProviderLabel,
} from '@/lib/ai/models'

/**
 * The weaver's cost/correctness tiering lives in these pure helpers:
 *   - below SIM_FLOOR: no work at all
 *   - at/above SIM_AUTO_MERGE *and* lexically near-identical: merge, no LLM
 *   - everything else in the band: goes to the (budgeted) LLM judge
 *
 * The load-bearing case: "launch in Q2" vs "launch moved to Q3" — embeddings
 * call them near-duplicates, but they CONTRADICT. The lexical second factor
 * must push disagreeing-value pairs to the judge instead of auto-merging.
 */

const cand = (
  text: string,
  similarity: number,
  id = `c-${similarity}-${text.length}`,
): WeaveCandidate => ({
  claim_id: id,
  claim_text: text,
  confirmation: 'suggested',
  similarity,
})

describe('lexicalOverlap', () => {
  it('is 1 for identical statements (modulo punctuation/case)', () => {
    expect(
      lexicalOverlap(
        'The API keys unblock Sprint 4 integration stories.',
        'the api keys unblock sprint 4 integration stories',
      ),
    ).toBe(1)
  })

  it('drops when a load-bearing value differs', () => {
    const a = 'The product launch is scheduled for Q2 2026.'
    const b = 'The product launch is scheduled for Q3 2026.'
    expect(lexicalOverlap(a, b)).toBeLessThan(0.9)
  })

  it('is low for unrelated statements', () => {
    expect(
      lexicalOverlap('Atlas manages communication preferences.', 'Sprint grooming is on Thursday.'),
    ).toBeLessThan(0.2)
  })

  it('handles empty input', () => {
    expect(lexicalOverlap('', 'anything')).toBe(0)
  })
})

describe('partitionCandidates', () => {
  const claimText = 'The partner gateway team delivered the API keys for the product domain endpoints.'

  it('drops candidates below the similarity floor', () => {
    const { autoMerge, judge } = partitionCandidates(claimText, [
      cand('Totally unrelated claim.', SIM_FLOOR - 0.05),
    ])
    expect(autoMerge).toHaveLength(0)
    expect(judge).toHaveLength(0)
  })

  it('auto-merges only when vectors AND lexical overlap agree', () => {
    const nearIdentical = cand(
      'The partner gateway team delivered the API keys for the product domain endpoints!',
      SIM_AUTO_MERGE + 0.01,
    )
    const { autoMerge, judge } = partitionCandidates(claimText, [nearIdentical])
    expect(autoMerge).toHaveLength(1)
    expect(judge).toHaveLength(0)
  })

  it('sends high-similarity pairs with diverging values to the judge, never auto-merge', () => {
    // The contradiction trap: embeddings say "same", the date says "opposite".
    const disagreeing = cand(
      'The partner gateway team has NOT yet delivered the API keys for the product domain endpoints, blocking several stories.',
      SIM_AUTO_MERGE + 0.01,
    )
    const { autoMerge, judge } = partitionCandidates(claimText, [disagreeing])
    expect(autoMerge).toHaveLength(0)
    expect(judge).toHaveLength(1)
  })

  it('sends the mid band to the judge and caps candidate count', () => {
    const band = Array.from({ length: 8 }, (_, i) =>
      cand(`Related statement number ${i} about the gateway keys.`, 0.85, `id-${i}`),
    )
    const { autoMerge, judge } = partitionCandidates(claimText, band)
    expect(autoMerge).toHaveLength(0)
    expect(judge.length).toBeLessThanOrEqual(5)
    expect(judge.length).toBeGreaterThan(0)
  })
})

/**
 * mergeDuplicate carries the dupe's provenance to the keeper. The load-bearing
 * fix (plan item 8): it MOVES the dupe's entity_link edges to the keeper (both
 * directions, re-pointed), which the previous version silently dropped — so a
 * merged claim keeps its about→project / committed_to→member / related_to→claim
 * graph edges instead of losing them when status flips. MOVE (not copy): after
 * re-pointing, the dupe's ORIGINAL edges are deleted so a superseded claim's
 * stale edges don't stay visible to direct entity_link readers — EXCEPT the
 * keeper→dupe supersedes edge (the supersession chain), which must survive.
 */
describe('mergeDuplicate edge-move', () => {
  const WS = 'ws-1'
  const KEEPER = 'keeper-1' // older → becomes keeper
  const DUPE = 'dupe-1'

  /**
   * Supabase stub tailored to mergeDuplicate's call sequence. `dupeEdges` is
   * what the entity_link SELECT of the dupe's edges returns; every entity_link
   * UPSERT payload is recorded so the test can assert the re-pointed rows, and
   * every entity_link DELETE (with its recorded eq/or filters) so the test can
   * assert the originals were removed and the supersedes edge preserved.
   */
  function stub(dupeEdges: Array<Record<string, unknown>>) {
    const entityLinkUpserts: Array<Array<Record<string, unknown>>> = []
    const entityLinkDeletes: Array<{ eqs: Record<string, unknown>; ors: string[] }> = []

    // A chainable query object. Terminal ops resolve; `.limit()` on an
    // entity_link SELECT resolves to the dupe's edges. DELETE chains record
    // their eq/or filters so the test can assert what was removed.
    function query(table: string, op: 'select' | 'upsert' | 'update' | 'delete', payload?: unknown) {
      const q: Record<string, unknown> = {}
      const deleteFilter = { eqs: {} as Record<string, unknown>, ors: [] as string[] }
      if (table === 'entity_link' && op === 'delete') entityLinkDeletes.push(deleteFilter)
      q.eq = (col: string, val: unknown) => {
        if (op === 'delete') deleteFilter.eqs[col] = val
        return q
      }
      q.or = (clause: string) => {
        if (op === 'delete') deleteFilter.ors.push(clause)
        return q
      }
      // update()...eq()...eq() resolves to {error:null}; the final await lands
      // on `then`. select()...limit() resolves with data.
      q.limit = () =>
        Promise.resolve({
          data: table === 'entity_link' && op === 'select' ? dupeEdges : [],
          error: null,
        })
      q.then = (resolve: (v: unknown) => unknown) =>
        resolve({ data: null, error: null })
      if (table === 'entity_link' && op === 'upsert') {
        entityLinkUpserts.push(
          (Array.isArray(payload) ? payload : [payload]) as Array<Record<string, unknown>>,
        )
      }
      return q
    }

    const supabase = {
      from: (table: string) => ({
        update: (payload: unknown) => query(table, 'update', payload),
        upsert: (payload: unknown) => query(table, 'upsert', payload),
        select: () => query(table, 'select'),
        delete: () => query(table, 'delete'),
      }),
    } as never

    return { supabase, entityLinkUpserts, entityLinkDeletes }
  }

  const older = { id: KEEPER, confirmation: 'confirmed', created_at: '2026-01-01T00:00:00Z' }
  const newer = { id: DUPE, confirmation: 'suggested', created_at: '2026-02-01T00:00:00Z' }

  it('re-points the dupe OUTBOUND edges (claim/dupe → X) onto the keeper', async () => {
    const { supabase, entityLinkUpserts } = stub([
      { source_type: 'claim', source_id: DUPE, target_type: 'project', target_id: 'proj-9', relation: 'about', weight: null, created_by: null },
    ])
    const ok = await mergeDuplicate(supabase, WS, older, newer)
    expect(ok).toBe(true)
    // First entity_link upsert is the supersedes edge (keeper → dupe); the
    // edge-copy upsert is the one carrying the re-pointed project edge.
    const copied = entityLinkUpserts.flat().find((r) => r.target_type === 'project')
    expect(copied).toMatchObject({
      workspace_id: WS,
      source_type: 'claim',
      source_id: KEEPER, // re-pointed off the dupe
      target_type: 'project',
      target_id: 'proj-9',
      relation: 'about',
    })
  })

  it('re-points the dupe INBOUND edges (Y → claim/dupe) onto the keeper', async () => {
    const { supabase, entityLinkUpserts } = stub([
      { source_type: 'claim', source_id: 'other-claim', target_type: 'claim', target_id: DUPE, relation: 'related_to', weight: null, created_by: null },
    ])
    await mergeDuplicate(supabase, WS, older, newer)
    const copied = entityLinkUpserts.flat().find((r) => r.source_id === 'other-claim')
    expect(copied).toMatchObject({
      source_type: 'claim',
      source_id: 'other-claim',
      target_type: 'claim',
      target_id: KEEPER, // inbound edge now points at the keeper
      relation: 'related_to',
    })
  })

  it('MOVE: deletes the dupe OUTBOUND originals after re-pointing (not left behind)', async () => {
    const { supabase, entityLinkDeletes } = stub([
      { source_type: 'claim', source_id: DUPE, target_type: 'project', target_id: 'proj-9', relation: 'about', weight: null, created_by: null },
    ])
    await mergeDuplicate(supabase, WS, older, newer)
    // An outbound-originals delete: eq(source_type='claim'), eq(source_id=dupe),
    // no or() filter (all outbound rows removed).
    const outboundDelete = entityLinkDeletes.find(
      (d) => d.eqs.source_type === 'claim' && d.eqs.source_id === DUPE,
    )
    expect(outboundDelete).toBeDefined()
    expect(outboundDelete!.eqs.workspace_id).toBe(WS)
    expect(outboundDelete!.ors).toHaveLength(0)
  })

  it('MOVE: deletes the dupe INBOUND originals EXCEPT the keeper→dupe supersedes edge', async () => {
    const { supabase, entityLinkDeletes } = stub([
      { source_type: 'claim', source_id: 'other-claim', target_type: 'claim', target_id: DUPE, relation: 'related_to', weight: null, created_by: null },
    ])
    await mergeDuplicate(supabase, WS, older, newer)
    // An inbound-originals delete: eq(target_type='claim'), eq(target_id=dupe),
    // guarded by an or() that spares the keeper's supersedes edge.
    const inboundDelete = entityLinkDeletes.find(
      (d) => d.eqs.target_type === 'claim' && d.eqs.target_id === DUPE,
    )
    expect(inboundDelete).toBeDefined()
    expect(inboundDelete!.eqs.workspace_id).toBe(WS)
    // The complement predicate: (source_id != keeper) OR (relation != supersedes)
    // — so the keeper→dupe supersedes edge is the only inbound survivor.
    expect(inboundDelete!.ors).toEqual([`source_id.neq.${KEEPER},relation.neq.supersedes`])
  })

  it('drops keeper↔keeper self-loops (the no-self-loop CHECK would else error)', async () => {
    // An edge keeper → dupe, when re-pointed, would become keeper → keeper.
    // (This is exactly the shape of the supersedes edge written during merge.)
    const { supabase, entityLinkUpserts } = stub([
      { source_type: 'claim', source_id: KEEPER, target_type: 'claim', target_id: DUPE, relation: 'supersedes', weight: null, created_by: null },
    ])
    await mergeDuplicate(supabase, WS, older, newer)
    // No re-pointed copy should be a self-loop.
    const selfLoop = entityLinkUpserts
      .flat()
      .find((r) => r.source_type === r.target_type && r.source_id === r.target_id)
    expect(selfLoop).toBeUndefined()
  })

  it('is a no-op edge-copy when the dupe has no edges (only the supersedes edge is written)', async () => {
    const { supabase, entityLinkUpserts } = stub([])
    await mergeDuplicate(supabase, WS, older, newer)
    // Only the supersedes edge from upsertClaimEdge; no edge-copy upsert.
    const copied = entityLinkUpserts.flat().filter((r) => r.relation !== 'supersedes')
    expect(copied).toHaveLength(0)
  })
})

/**
 * mergeKeeperIsSelf + the loser short-circuit (FIX 3). When the CURRENT claim
 * loses an auto-merge (becomes the dupe, superseded into a keeper), the weave
 * loop must stop processing it: no further merges of remaining candidates INTO
 * the now-dead claim, and no judge phase. mergeKeeperIsSelf is the pure
 * predicate that drives that break. Same rank rule as mergeDuplicate: confirmed
 * beats suggested, then OLDER wins.
 */
describe('mergeKeeperIsSelf', () => {
  const confirmedOld = { confirmation: 'confirmed', created_at: '2026-01-01T00:00:00Z' }
  const suggestedNew = { confirmation: 'suggested', created_at: '2026-02-01T00:00:00Z' }
  const suggestedOld = { confirmation: 'suggested', created_at: '2026-01-01T00:00:00Z' }

  it('current WINS (keeper is self) when it is confirmed and the other is suggested', () => {
    expect(mergeKeeperIsSelf(confirmedOld, suggestedNew)).toBe(true)
  })

  it('current LOSES (keeper is the other) when the other outranks it', () => {
    // current = suggested+new, other = confirmed+old → other keeps.
    expect(mergeKeeperIsSelf(suggestedNew, confirmedOld)).toBe(false)
  })

  it('older wins the tie at equal confirmation', () => {
    expect(mergeKeeperIsSelf(suggestedOld, suggestedNew)).toBe(true)
    expect(mergeKeeperIsSelf(suggestedNew, suggestedOld)).toBe(false)
  })
})

describe('weave loop loser short-circuit', () => {
  // Faithful transcription of the weave loop's autoMerge-processing shape: for
  // each candidate, merge current↔candidate; if the current claim was merged
  // AWAY (keeper is NOT self), set mergedAway and STOP — subsequent candidates
  // must NOT be merged, and the judge phase must NOT run. This mirrors the
  // `break` + `!mergedAway` guard added in knowledge-weaver.ts.
  it('claim loses to candidate 1 → candidate 2 is not merged, and the judge phase is skipped', async () => {
    const merged: string[] = []
    // current claim is suggested+new so it LOSES to a confirmed+old candidate 1.
    const current = { id: 'cur', confirmation: 'suggested', created_at: '2026-03-01T00:00:00Z' }
    const cand1 = { id: 'k1', confirmation: 'confirmed', created_at: '2026-01-01T00:00:00Z' }
    const cand2 = { id: 'k2', confirmation: 'confirmed', created_at: '2026-01-15T00:00:00Z' }
    const autoMergeCandidates = [cand1, cand2]

    let mergedAway = false
    for (const other of autoMergeCandidates) {
      // Stand-in for mergeDuplicate: record the merge, always "succeeds".
      merged.push(other.id)
      if (!mergeKeeperIsSelf(current, other)) {
        mergedAway = true
        break // <-- the fix: stop after the current claim is merged away
      }
    }

    // Only candidate 1 was merged; candidate 2 was NOT touched.
    expect(merged).toEqual(['k1'])
    expect(mergedAway).toBe(true)

    // Judge phase is guarded by `!mergedAway` → it must be skipped.
    const judgeRan = !mergedAway
    expect(judgeRan).toBe(false)
  })

  it('claim WINS candidate 1 → keeps absorbing candidate 2 (no short-circuit)', async () => {
    const merged: string[] = []
    // current claim is confirmed+old → it WINS every merge and keeps going.
    const current = { id: 'cur', confirmation: 'confirmed', created_at: '2026-01-01T00:00:00Z' }
    const cand1 = { id: 'd1', confirmation: 'suggested', created_at: '2026-02-01T00:00:00Z' }
    const cand2 = { id: 'd2', confirmation: 'suggested', created_at: '2026-03-01T00:00:00Z' }

    let mergedAway = false
    for (const other of [cand1, cand2]) {
      merged.push(other.id)
      if (!mergeKeeperIsSelf(current, other)) {
        mergedAway = true
        break
      }
    }

    // Both dupes absorbed into the surviving current claim.
    expect(merged).toEqual(['d1', 'd2'])
    expect(mergedAway).toBe(false)
    expect(!mergedAway).toBe(true) // judge phase still runs
  })
})

/**
 * Phase 2b — claim↔project linking (plan item 17). The vector-embedding helpers
 * back the two-tier match: the claim's already-loaded embedding is cosine-
 * compared to project embeddings, then tiered exactly like claim↔claim.
 */
describe('parseEmbedding', () => {
  it('parses a pgvector JSON-array wire string into number[]', () => {
    expect(parseEmbedding('[0.1,0.2,0.3]')).toEqual([0.1, 0.2, 0.3])
  })

  it('passes through an already-numeric array', () => {
    expect(parseEmbedding([1, 2, 3])).toEqual([1, 2, 3])
  })

  it('returns null for non-numeric / malformed input (so a bad row cannot crash the pass)', () => {
    expect(parseEmbedding('not json')).toBeNull()
    expect(parseEmbedding('{"a":1}')).toBeNull()
    expect(parseEmbedding(['a', 'b'])).toBeNull()
    expect(parseEmbedding(null)).toBeNull()
    expect(parseEmbedding(42)).toBeNull()
  })
})

describe('cosineSimilarity', () => {
  it('is 1 for identical directions and 0 for orthogonal', () => {
    expect(cosineSimilarity([1, 0], [2, 0])).toBeCloseTo(1)
    expect(cosineSimilarity([1, 0], [0, 5])).toBeCloseTo(0)
  })

  it('is 0 (not NaN) for a zero vector', () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0)
  })
})

/**
 * partitionAnchorCandidates is the generalization of the old project-only
 * tiering: candidates from EVERY anchor type are pooled, each type is tiered
 * against ITS OWN thresholds, and the ambiguous remainders merge into ONE
 * judge list. The two behavior changes to pin down are (a) per-type
 * thresholds, so a type with a low bar can auto-link at a similarity another
 * type would only judge, and (b) MULTI-winner autos — a claim clearly about a
 * company does not stop being about a project.
 */
describe('partitionAnchorCandidates', () => {
  const cand = (
    entity_type: string,
    similarity: number,
    entity_id = `${entity_type}-${similarity}`,
  ): AnchorCandidate => ({
    entity_type,
    entity_id,
    name: `${entity_type} ${entity_id}`,
    description: null,
    similarity,
  })

  // Deliberately different bars per type, so a shared-threshold regression
  // would fail rather than accidentally pass.
  const thresholds = (type: string) =>
    type === 'company' ? { auto: 0.7, floor: 0.4 } : { auto: 0.85, floor: 0.55 }

  it('returns nothing when every type is below its own floor', () => {
    const { auto, judge } = partitionAnchorCandidates(
      [cand('project', 0.5), cand('company', 0.3)],
      thresholds,
    )
    expect(auto).toHaveLength(0)
    expect(judge).toHaveLength(0)
  })

  it('auto-links the single best candidate WITHIN a type, no judge call needed', () => {
    const { auto, judge } = partitionAnchorCandidates(
      [cand('project', 0.9, 'p-best'), cand('project', 0.86, 'p-other')],
      thresholds,
    )
    expect(auto.map((c) => c.entity_id)).toEqual(['p-best'])
    expect(judge).toHaveLength(0)
  })

  it('applies each type its OWN thresholds', () => {
    // 0.72 auto-links a company (bar 0.7) but only bands a project (bar 0.85).
    const { auto, judge } = partitionAnchorCandidates(
      [cand('project', 0.72, 'p-1'), cand('company', 0.72, 'co-1')],
      thresholds,
    )
    expect(auto.map((c) => c.entity_id)).toEqual(['co-1'])
    expect(judge.map((c) => c.entity_id)).toEqual(['p-1'])
  })

  it('TIE-BREAK: every type clearing its own auto bar is linked — several at once', () => {
    const { auto, judge } = partitionAnchorCandidates(
      [cand('project', 0.9, 'p-1'), cand('company', 0.95, 'co-1')],
      thresholds,
    )
    // Both linked; best-first. This is the deliberate break from the
    // project-only contract of at most ONE anchor per claim.
    expect(auto.map((c) => c.entity_id)).toEqual(['co-1', 'p-1'])
    expect(judge).toHaveLength(0)
  })

  it('TIE-BREAK: both types below auto → the judge is offered BOTH, pooled and ranked', () => {
    const { auto, judge } = partitionAnchorCandidates(
      [cand('project', 0.6, 'p-1'), cand('company', 0.65, 'co-1')],
      thresholds,
    )
    expect(auto).toHaveLength(0)
    expect(judge.map((c) => c.entity_id)).toEqual(['co-1', 'p-1'])
  })

  it('a type that auto-linked is NOT also offered to the judge', () => {
    const { auto, judge } = partitionAnchorCandidates(
      [cand('project', 0.9, 'p-1'), cand('project', 0.6, 'p-2'), cand('company', 0.6, 'co-1')],
      thresholds,
    )
    expect(auto.map((c) => c.entity_id)).toEqual(['p-1'])
    expect(judge.map((c) => c.entity_id)).toEqual(['co-1'])
  })

  it('caps the POOLED judge list at 5, so N types cost one type of prompt', () => {
    const band = [
      ...Array.from({ length: 5 }, (_, i) => cand('project', 0.7, `p-${i}`)),
      ...Array.from({ length: 5 }, (_, i) => cand('company', 0.6, `co-${i}`)),
    ]
    const { judge } = partitionAnchorCandidates(band, thresholds)
    expect(judge.length).toBeLessThanOrEqual(5)
  })

  it('picks the true top within a type even when candidates arrive out of order', () => {
    const { auto } = partitionAnchorCandidates(
      [cand('project', 0.6, 'p-mid'), cand('project', 0.95, 'p-top'), cand('project', 0.56, 'p-low')],
      thresholds,
    )
    expect(auto.map((c) => c.entity_id)).toEqual(['p-top'])
  })

  it('defaults to the REGISTRY thresholds when none are passed', () => {
    const registry = anchorDescriptor('project')
    expect(registry).toBeDefined()
    const { auto } = partitionAnchorCandidates([
      cand('project', (registry?.autoThreshold ?? 1) + 0.01, 'p-1'),
    ])
    expect(auto.map((c) => c.entity_id)).toEqual(['p-1'])
  })

  it('falls back to the project pair for a type carrying no registry anchor', () => {
    // A type with no anchor descriptor must not yield UNDEFINED thresholds —
    // NaN comparisons silently never link. `action` is registered but
    // deliberately not an anchor; `widget` is not registered at all.
    for (const type of ['action', 'widget']) {
      expect(anchorDescriptor(type), type).toBeUndefined()
      expect(anchorThresholds(type), type).toEqual({
        auto: PROJECT_LINK_AUTO,
        floor: PROJECT_LINK_FLOOR,
      })
    }
  })

  it("uses campaign's OWN registry thresholds now that it is an anchor", () => {
    // Slice 2b registered `campaign`, so it stops taking the project fallback —
    // the ONE registry entry is the whole change (this file is untouched
    // source-side).
    const registry = anchorDescriptor('campaign')
    expect(registry).toBeDefined()
    expect(anchorThresholds('campaign')).toEqual({
      auto: registry!.autoThreshold,
      floor: registry!.floorThreshold,
    })
  })
})

/**
 * shouldJudgeAnchors is the pure control-flow gate for the LLM half of the
 * linking pass. The auto tier is deliberately NOT its concern: with per-type
 * thresholds a claim can be auto-decided for one type and ambiguous for
 * another, so the caller writes auto edges unconditionally and this covers
 * only the spend — budget SHARING (claim-relations first, remainder here) and
 * the kill switch.
 */
describe('shouldJudgeAnchors', () => {
  const band = (): AnchorPartition => ({
    auto: [],
    judge: [
      { entity_type: 'project', entity_id: 'p-1', name: 'P', description: null, similarity: 0.7 },
    ],
  })
  const none = (): AnchorPartition => ({ auto: [], judge: [] })
  const autoOnly = (): AnchorPartition => ({
    auto: [
      { entity_type: 'project', entity_id: 'p-1', name: 'P', description: null, similarity: 0.95 },
    ],
    judge: [],
  })

  it('JUDGE path: an ambiguous band with the judge on and budget left is judged', () => {
    expect(shouldJudgeAnchors(band(), true, 5)).toBe(true)
  })

  it('KILL-SWITCH off → auto-tier only: the ambiguous band is never judged', () => {
    expect(shouldJudgeAnchors(band(), false, 30)).toBe(false)
  })

  it('BUDGET SHARING: an ambiguous band skips once the shared judge budget is exhausted', () => {
    expect(shouldJudgeAnchors(band(), true, 0)).toBe(false)
    expect(shouldJudgeAnchors(band(), true, 1)).toBe(true)
  })

  it('an auto-only partition never spends a judge call', () => {
    expect(shouldJudgeAnchors(autoOnly(), true, 30)).toBe(false)
  })

  it('skips when nothing cleared any floor', () => {
    expect(shouldJudgeAnchors(none(), true, 30)).toBe(false)
  })
})

/**
 * The pooled verdict must be validated as a PAIR. A judge that answers a
 * project type with a company id has invented a candidate, and writing it
 * would put a company id behind a project-typed edge.
 */
describe('validateAnchorVerdict', () => {
  const offered: AnchorCandidate[] = [
    { entity_type: 'project', entity_id: 'p-1', name: 'P', description: null, similarity: 0.7 },
    { entity_type: 'company', entity_id: 'co-1', name: 'C', description: null, similarity: 0.6 },
  ]

  it('accepts a candidate that was actually offered', () => {
    expect(
      validateAnchorVerdict({ anchor_type: 'company', anchor_id: 'co-1' }, offered)?.entity_id,
    ).toBe('co-1')
  })

  it('rejects a MIXED pair (offered type, other type’s id)', () => {
    expect(validateAnchorVerdict({ anchor_type: 'project', anchor_id: 'co-1' }, offered)).toBeNull()
  })

  it('rejects an id that was never offered', () => {
    expect(validateAnchorVerdict({ anchor_type: 'project', anchor_id: 'p-9' }, offered)).toBeNull()
  })

  it('treats nulls (and a half-null) as "no anchor fits"', () => {
    expect(validateAnchorVerdict({ anchor_type: null, anchor_id: null }, offered)).toBeNull()
    expect(validateAnchorVerdict({ anchor_type: 'project', anchor_id: null }, offered)).toBeNull()
    expect(validateAnchorVerdict({ anchor_type: null, anchor_id: 'p-1' }, offered)).toBeNull()
  })
})

/**
 * scoreAnchorCandidates is where the per-claim "only the types it is MISSING"
 * rule lands: a claim already linked to its company must not be offered
 * companies again, but is still a candidate for every other type.
 */
describe('scoreAnchorCandidates', () => {
  const anchors = [
    { entity_type: 'project', entity_id: 'p-1', name: 'P', description: null, embedding: [1, 0] },
    { entity_type: 'company', entity_id: 'co-1', name: 'C', description: null, embedding: [0, 1] },
  ]

  it('scores every anchor when no type filter is given', () => {
    const out = scoreAnchorCandidates([1, 0], anchors)
    expect(out.map((c) => c.entity_id)).toEqual(['p-1', 'co-1'])
    expect(out[0].similarity).toBeCloseTo(1)
    expect(out[1].similarity).toBeCloseTo(0)
  })

  it('offers ONLY the types the claim is missing', () => {
    const out = scoreAnchorCandidates([1, 0], anchors, new Set(['company']))
    expect(out.map((c) => c.entity_type)).toEqual(['company'])
  })

  it('offers nothing when the claim is already fully anchored', () => {
    expect(scoreAnchorCandidates([1, 0], anchors, new Set())).toEqual([])
  })
})

/**
 * Per-type embed-text composition. The company case is the one that matters:
 * a freshly-created company row often has an empty `description`, and its Exa
 * enrichment blob is the only real text it has — if that does not reach the
 * embedding, company anchoring cannot work at all.
 */
describe('anchorEmbedText', () => {
  it('composes a project from name + description', () => {
    const text = anchorEmbedText('project', {
      name: 'Atlas migration',
      description: 'Move the API off the legacy cluster',
    })
    expect(text).toContain('Atlas migration')
    expect(text).toContain('legacy cluster')
  })

  it('folds a company’s ENRICHMENT blob into its embed text', () => {
    const text = anchorEmbedText('company', {
      name: 'Northwind',
      domain: 'northwind.example',
      industry: 'Logistics',
      description: null,
      metadata: {
        enrichment: {
          summary: 'Northwind runs regional freight brokerage across the Midwest.',
        },
      },
    })
    expect(text).toContain('Northwind')
    expect(text).toContain('northwind.example')
    expect(text).toContain('freight brokerage')
  })

  it('is empty for a type carrying no anchor descriptor', () => {
    expect(anchorEmbedText('document', { title: 'x' })).toBe('')
  })

  it('caps the embedded text so one verbose company cannot dominate', () => {
    const text = anchorEmbedText('company', {
      name: 'Verbose',
      description: 'x'.repeat(10000),
    })
    expect(text.length).toBeLessThanOrEqual(2000)
  })
})

/**
 * The judge prompt is ONE LINE PER CANDIDATE — a newline inside a description
 * would split a candidate across two bullets and leave its id unattributable,
 * which matters most for company, whose embed text is several fields deep.
 */
describe('anchorDisplay', () => {
  it('splits name from description and collapses newlines to one line', () => {
    const { name, description } = anchorDisplay('company', {
      name: 'Northwind',
      domain: 'nw.example',
      industry: 'Logistics',
      description: null,
      metadata: { enrichment: { summary: 'Regional freight brokerage.' } },
    })
    expect(name).toBe('Northwind')
    expect(description).toBe('nw.example Logistics Regional freight brokerage.')
    expect(description).not.toContain('\n')
  })

  it('is description-less when the anchor has nothing but a name', () => {
    expect(anchorDisplay('project', { name: 'Atlas', description: null })).toEqual({
      name: 'Atlas',
      description: null,
    })
  })
})

/**
 * Instrumentation. The first real nightly runs are the only source of data for
 * tuning the per-type thresholds, so the summary must carry the FULL incoming
 * similarity distribution — including candidates that auto-linked and never
 * reached the judge, which would otherwise skew the sample to the ambiguous
 * band only.
 */
describe('AnchorStats', () => {
  const c = (entity_type: string, similarity: number): AnchorCandidate => ({
    entity_type,
    entity_id: `${entity_type}-${similarity}`,
    name: 'x',
    description: null,
    similarity,
  })

  it('reports count, max, p50, floor-clearing count and auto-links PER TYPE', () => {
    const stats = new AnchorStats()
    stats.record([c('project', 0.2), c('project', 0.6), c('project', 0.9)])
    stats.record([c('company', 0.95)])
    stats.recordAutoLink('company')

    const out = stats.summarize()
    expect(out.project).toEqual({
      candidates: 3,
      max: 0.9,
      p50: 0.6,
      // PROJECT_LINK_FLOOR-equivalent from the registry: 0.6 and 0.9 clear it.
      above_floor: 2,
      auto_linked: 0,
    })
    expect(out.company.candidates).toBe(1)
    expect(out.company.auto_linked).toBe(1)
  })

  it('is empty when no candidate was ever scored', () => {
    expect(new AnchorStats().summarize()).toEqual({})
  })
})

/**
 * The anchor-type resolver: FEATURES pick the default set, an explicit
 * settings list overrides it, and — the load-bearing part — nothing a
 * workspace can put in its settings blob may throw or silently disable
 * anchoring altogether.
 */
describe('resolveWorkspaceAnchorTypes (pure half)', () => {
  it('derives the default from the workspace’s effective FEATURES', () => {
    // The `full` edition (the default) has every feature on.
    expect(anchorTypesFromSettings({})).toContain('project')
    expect(anchorTypesFromSettings({})).toContain('company')
  })

  it('drops an anchor whose feature the workspace switched OFF', () => {
    const types = anchorTypesFromSettings({ feature_overrides: { crm: 'off' } })
    expect(types).toContain('project')
    expect(types).not.toContain('company')
  })

  it('never anchors to `contact` — that is the committed_to machinery, untouched', () => {
    expect(anchorTypesFromSettings({})).not.toContain('contact')
  })

  it('maps the campaigns FEATURE to the campaign anchor, now that both exist', () => {
    const row = FEATURE_ANCHOR_TYPES.find((r) => r.feature === 'campaigns')
    expect(row?.anchor).toBe('campaign')
    // An unstamped workspace resolves to the `full` edition, whose feature set
    // is the `'all'` sentinel — so it gets every anchor, campaigns included.
    expect(anchorTypesFromSettings({})).toContain('campaign')
    // Every edition presets every feature, so a workspace on any preset gets
    // it too…
    for (const edition of ['sales', 'notes', 'brain']) {
      expect(anchorTypesFromSettings({ edition })).toContain('campaign')
    }
    // …until it switches Campaigns off.
    expect(
      anchorTypesFromSettings({ edition: 'sales', feature_overrides: { campaigns: 'off' } }),
    ).not.toContain('campaign')
  })

  it('an explicit settings list WINS over the feature-derived default', () => {
    expect(
      anchorTypesFromSettings({ weaver: { anchor_types: ['company'] } }),
    ).toEqual(['company'])
  })

  it('degrades unknown / invalid entries to the default instead of throwing', () => {
    for (const raw of [
      'project',
      42,
      {},
      ['nonsense', 7, null],
      [],
    ]) {
      const types = anchorTypesFromSettings({ weaver: { anchor_types: raw } })
      // Falls back to the feature-derived default — never an empty set, which
      // would silently switch anchoring off for the whole workspace.
      expect(types).toContain('project')
    }
  })

  it('keeps the VALID entries of a partly-garbage list', () => {
    expect(
      anchorTypesFromSettings({ weaver: { anchor_types: ['company', 'nonsense', 12] } }),
    ).toEqual(['company'])
  })

  it("a Marketing stamp of [company, campaign] now resolves to BOTH — the promised no-re-stamp payoff", () => {
    // Onboarding (role → anchor set) stamped `campaign` ahead of its registry
    // entry, and the resolver dropped it as unregistered while keeping the
    // rest of the choice. Slice 2b registered it, so the SAME stored setting —
    // written before campaigns existed — starts anchoring to campaigns with no
    // re-stamp and no backfill. That is the whole point of stamping early.
    expect(
      anchorTypesFromSettings({ weaver: { anchor_types: ['company', 'campaign'] } }),
    ).toEqual(['company', 'campaign'])
  })

  it('fails open on a missing / non-object settings blob', () => {
    for (const raw of [undefined, null, 'nope', 7]) {
      expect(anchorTypesFromSettings(raw)).toContain('project')
    }
  })

  it('reads the judge kill switch from the same blob, default ON', () => {
    expect(normalizeWeaverSettings({}).llmJudge).toBe(true)
    expect(normalizeWeaverSettings({ weaver: {} }).llmJudge).toBe(true)
    expect(normalizeWeaverSettings({ weaver: { llm_judge: false } }).llmJudge).toBe(false)
    // Only an explicit `false` switches it off.
    expect(normalizeWeaverSettings({ weaver: { llm_judge: 'no' } }).llmJudge).toBe(true)
  })
})

/**
 * Judge billing attribution (A4). The judge and project-link calls run on the
 * WORKSPACE's "Knowledge graph" model, but both logUsage sites used to hardcode
 * DEFAULT_SKILL_RUN_MODEL — so a workspace that picked Sonnet had its weaver
 * spend logged as DeepSeek. The fix logs the model that actually ran.
 *
 * The form matters as much as the value: ai_model_costs is keyed by the BARE
 * app id ('deepseek-v4-flash'), never the Gateway slug
 * ('deepseek/deepseek-v4-flash'). A slug in logUsage.model would miss the
 * pricing row and bill at the $15/$75 catch-all. So the weaver resolves the
 * bare id (resolveWorkspaceModel, not …Slug), logs it verbatim, and converts to
 * a slug only at the aiModel() call — the same shape every other logUsage site
 * in the app uses.
 */
describe('weaver judge usage attribution', () => {
  // Stand-ins for what resolveWorkspaceModel(…, 'knowledge') can return: the
  // code default, and a workspace that overrode the surface to Anthropic.
  const WORKSPACE_MODELS = [DEFAULT_SKILL_RUN_MODEL, 'claude-sonnet-4-5-20250929']

  it('logs a BARE app id, never the Gateway slug (ai_model_costs is keyed by the bare id)', () => {
    for (const model of WORKSPACE_MODELS) {
      // What the logUsage sites write is the resolved model verbatim…
      expect(model).not.toContain('/')
      // …while the Gateway call converts the same value to a slug.
      expect(gatewayModelSlug(model)).toContain('/')
    }
    expect(DEFAULT_SKILL_RUN_MODEL_SLUG).toBe(`deepseek/${DEFAULT_SKILL_RUN_MODEL}`)
  })

  it('derives the provider label from the model that actually ran, per workspace', () => {
    // Default surface → DeepSeek, logged verbatim (NOT the legacy 'claude').
    expect(usageProviderLabel(DEFAULT_SKILL_RUN_MODEL)).toBe('deepseek')
    expect(usageProviderLabel(DEFAULT_SKILL_RUN_MODEL)).not.toBe('claude')
    // A workspace that overrode to Anthropic must NOT be logged as deepseek —
    // that mismatch is exactly what the hardcoded constant produced.
    expect(usageProviderLabel('claude-sonnet-4-5-20250929')).toBe('claude')
  })

  it('a slug passed to the ONE converter is idempotent (no double-prefixing)', () => {
    expect(gatewayModelSlug(DEFAULT_SKILL_RUN_MODEL_SLUG)).toBe(
      DEFAULT_SKILL_RUN_MODEL_SLUG,
    )
  })
})

/**
 * A1 — BRIEF STARVATION. Phase 3 used to run only for workspaces on the weave
 * list (active claims with woven_at IS NULL). A workspace whose claims keep
 * changing (promoted / edited / merged) but which adds no NEW claims falls off
 * that list, and its briefs freeze permanently. Brief freshness is a function
 * of claim updated_at vs the workspace-scope brief's generated_at, so it gets
 * its own selection, unioned with the weave list.
 */
describe('selectBriefStaleWorkspaces', () => {
  const claim = (workspace_id: string, updated_at: string) => ({
    workspace_id,
    updated_at,
  })
  const brief = (workspace_id: string, generated_at: string) => ({
    workspace_id,
    generated_at,
  })

  it('selects a workspace whose newest claim is NEWER than its brief', () => {
    // The PROD shape: brief frozen days ago, claims still moving.
    const stale = selectBriefStaleWorkspaces(
      [claim('ws-frozen', '2026-09-09T00:00:00Z')],
      [brief('ws-frozen', '2026-09-05T00:00:00Z')],
      20,
    )
    expect(stale).toEqual(['ws-frozen'])
  })

  it('does NOT select a workspace whose brief is newer than every claim', () => {
    const stale = selectBriefStaleWorkspaces(
      [claim('ws-fresh', '2026-09-01T00:00:00Z')],
      [brief('ws-fresh', '2026-09-09T00:00:00Z')],
      20,
    )
    expect(stale).toEqual([])
  })

  it('selects a workspace with enough claims but NO brief row at all', () => {
    const stale = selectBriefStaleWorkspaces(
      [
        claim('ws-new', '2026-09-01T00:00:00Z'),
        claim('ws-new', '2026-09-02T00:00:00Z'),
        claim('ws-new', '2026-09-03T00:00:00Z'),
      ],
      [],
      20,
    )
    expect(stale).toEqual(['ws-new'])
  })

  it('does NOT select a brief-less workspace below the MIN_CLAIMS floor', () => {
    // generateBriefForScope would return 'empty' for these — selecting them
    // would just burn a step for nothing.
    const stale = selectBriefStaleWorkspaces(
      [claim('ws-tiny', '2026-09-01T00:00:00Z'), claim('ws-tiny', '2026-09-02T00:00:00Z')],
      [],
      20,
    )
    expect(stale).toEqual([])
  })

  it('uses the NEWEST claim per workspace, whatever order the rows arrive in', () => {
    const stale = selectBriefStaleWorkspaces(
      [
        claim('ws-a', '2026-09-01T00:00:00Z'), // older than the brief
        claim('ws-a', '2026-09-09T00:00:00Z'), // newer → stale
      ],
      [brief('ws-a', '2026-09-05T00:00:00Z')],
      20,
    )
    expect(stale).toEqual(['ws-a'])
  })

  it('caps the selection (a bounded extra step budget per run)', () => {
    const claims = Array.from({ length: 50 }, (_, i) =>
      claim(`ws-${i}`, '2026-09-09T00:00:00Z'),
    )
    const briefs = Array.from({ length: 50 }, (_, i) =>
      brief(`ws-${i}`, '2026-09-01T00:00:00Z'),
    )
    expect(selectBriefStaleWorkspaces(claims, briefs, 20)).toHaveLength(20)
  })

  it('ignores unparseable claim timestamps instead of crashing the scan', () => {
    const stale = selectBriefStaleWorkspaces(
      [claim('ws-bad', 'not-a-date')],
      [brief('ws-bad', '2026-09-05T00:00:00Z')],
      20,
    )
    expect(stale).toEqual([])
  })
})

describe('unionWorkspaces', () => {
  it('dedupes while keeping the processed workspaces first', () => {
    expect(unionWorkspaces(['a', 'b'], ['b', 'c'])).toEqual(['a', 'b', 'c'])
  })

  it('handles empty lists on either side', () => {
    expect(unionWorkspaces([], ['c'])).toEqual(['c'])
    expect(unionWorkspaces(['a'], [])).toEqual(['a'])
    expect(unionWorkspaces([], [])).toEqual([])
  })
})

/**
 * A3 — PHASE 2C BACKFILL eligibility. Claims that are FULLY anchored (they
 * already carry an `about` edge to EVERY one of the workspace's active anchor
 * types) must be excluded BEFORE the per-run cap is applied (the query does
 * this in SQL via .not('id','in',…)); this is the same rule expressed purely,
 * so the cap is never wasted on claims that would be dropped anyway. A claim
 * missing only SOME types stays eligible — the caller offers it just those.
 */
describe('selectBackfillClaims', () => {
  const c = (id: string) => ({ id, text: `claim ${id}` })

  it('excludes claims that are already anchored to every active type', () => {
    const picked = selectBackfillClaims(
      [c('a'), c('linked'), c('b')],
      new Set(['linked']),
      10,
    )
    expect(picked.map((x) => x.id)).toEqual(['a', 'b'])
  })

  it('spends the cap only on genuinely link-less claims', () => {
    // If exclusion happened AFTER the cap, a cap of 2 over [linked, linked, a]
    // would yield zero claims. Exclusion first means the cap buys real work.
    const picked = selectBackfillClaims(
      [c('l1'), c('l2'), c('a'), c('b')],
      new Set(['l1', 'l2']),
      2,
    )
    expect(picked.map((x) => x.id)).toEqual(['a', 'b'])
  })

  it('caps the batch', () => {
    const claims = Array.from({ length: 100 }, (_, i) => c(`c-${i}`))
    expect(selectBackfillClaims(claims, new Set(), 40)).toHaveLength(40)
  })

  it('returns nothing when every candidate is already linked', () => {
    expect(selectBackfillClaims([c('a')], new Set(['a']), 40)).toEqual([])
  })

  it('still fills the batch when the SQL NOT-IN list was truncated', () => {
    // The query sends at most BACKFILL_EXCLUDE_MAX ids (the URL has a size
    // limit) and over-fetches 2x, so linked claims beyond that slice come back
    // from SQL and must be dropped here — without starving the batch.
    const rows = [c('l-a'), c('l-b'), ...Array.from({ length: 5 }, (_, i) => c(`n-${i}`))]
    const picked = selectBackfillClaims(rows, new Set(['l-a', 'l-b']), 5)
    expect(picked.map((x) => x.id)).toEqual(['n-0', 'n-1', 'n-2', 'n-3', 'n-4'])
  })
})

/**
 * A3 — BUDGET SEPARATION. The backfill judge runs on its OWN counter, not the
 * claim-relation pass's leftovers, so it can never reduce claim-relation
 * judging capacity. shouldJudgeAnchors is budget-agnostic (it just reads the
 * number it is handed), so what this locks is the two counters being
 * independent: a claim-relation pass that spent everything still leaves the
 * backfill its full allowance. Pooling the judge across anchor types is what
 * keeps this budget unchanged as types are added — one call classifies all.
 */
describe('backfill judge budget separation', () => {
  const band = (): AnchorPartition => ({
    auto: [],
    judge: [
      { entity_type: 'project', entity_id: 'p-1', name: 'P', description: null, similarity: 0.7 },
      { entity_type: 'company', entity_id: 'co-1', name: 'C', description: null, similarity: 0.65 },
    ],
  })

  it('the backfill still judges after the claim-relation budget is exhausted', () => {
    const relationBudget = 0 // claim↔claim pass spent all 30
    const backfillBudget = 10 // its own, untouched allowance

    // Phase 2b (shared budget) correctly declines…
    expect(shouldJudgeAnchors(band(), true, relationBudget)).toBe(false)
    // …while the backfill, on its separate counter, proceeds.
    expect(shouldJudgeAnchors(band(), true, backfillBudget)).toBe(true)
  })

  it('the backfill budget is itself bounded — it stops when spent', () => {
    let budget = 2
    const decisions: boolean[] = []
    for (let i = 0; i < 4; i++) {
      const d = shouldJudgeAnchors(band(), true, budget)
      decisions.push(d)
      if (d) budget -= 1
    }
    expect(decisions).toEqual([true, true, false, false])
  })

  it('ONE pooled call covers every anchor type — two types, one budget unit', () => {
    // Both types are in the same judge list, so the two-type band costs the
    // same single call a one-type band would.
    expect(band().judge).toHaveLength(2)
    let budget = 1
    if (shouldJudgeAnchors(band(), true, budget)) budget -= 1
    expect(budget).toBe(0)
  })

  it('the kill-switch still governs the backfill (auto tier only)', () => {
    expect(shouldJudgeAnchors(band(), false, 10)).toBe(false)
  })
})

/**
 * A2 — PER-WORKSPACE ERROR ISOLATION. One workspace's step rejecting (a step
 * that exhausted its own retries) used to be function-fatal: the nightly run
 * aborted for every workspace after it, briefs included. The handler now wraps
 * each workspace's work, records the failure, and continues.
 */
describe('per-workspace error isolation', () => {
  it('a throwing workspace is recorded and the loop continues to the rest', async () => {
    // Faithful transcription of the handler's loop shape.
    const workspaceIds = ['ws-a', 'ws-boom', 'ws-c']
    const processed: string[] = []
    const failures: Record<string, unknown>[] = []
    const work = async (ws: string) => {
      if (ws === 'ws-boom') throw new Error('step exhausted retries')
      processed.push(ws)
    }

    for (const ws of workspaceIds) {
      try {
        await work(ws)
      } catch (err) {
        failures.push({
          workspace_id: ws,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    expect(processed).toEqual(['ws-a', 'ws-c'])
    expect(failures).toEqual([
      { workspace_id: 'ws-boom', error: 'step exhausted retries' },
    ])
  })

  it('briefs still run for the failed workspace (Phase 3 is its own loop)', () => {
    // The union is built from the FULL workspace list, not the survivors — a
    // workspace whose weave failed must still get its briefs attempted.
    const workspaceIds = ['ws-a', 'ws-boom', 'ws-c']
    const briefStale = ['ws-quiet']
    expect(unionWorkspaces(workspaceIds, briefStale)).toEqual([
      'ws-a',
      'ws-boom',
      'ws-c',
      'ws-quiet',
    ])
  })
})

/**
 * Capture visibility: the weaver is UNATTENDED, so it runs with no requester —
 * every private capture is hidden regardless of who created it, because the
 * weave's outputs (merges, graph edges, and the Phase-3 briefs) are
 * workspace-readable. A claim is visible iff it has zero sources OR at least one
 * source that is not a hidden capture. See docs/design-capture-visibility.md.
 */
describe('filterClaimsVisibleToNobody', () => {
  const visibleCaptures = new Set(['cap-public'])
  const claims = [
    { id: 'c-none' },
    { id: 'c-public-capture' },
    { id: 'c-private-capture' },
    { id: 'c-mixed' },
    { id: 'c-document' },
    { id: 'c-dangling' },
  ]
  const sources = [
    { claim_id: 'c-public-capture', source_type: 'capture', source_id: 'cap-public' },
    { claim_id: 'c-private-capture', source_type: 'capture', source_id: 'cap-private' },
    // Mixed provenance: one hidden capture + one visible one → stays visible.
    { claim_id: 'c-mixed', source_type: 'capture', source_id: 'cap-private' },
    { claim_id: 'c-mixed', source_type: 'capture', source_id: 'cap-public' },
    // Non-capture sources always count as visible.
    { claim_id: 'c-document', source_type: 'document', source_id: 'doc-1' },
    // Dangling capture reference counts as hidden (fail closed).
    { claim_id: 'c-dangling', source_type: 'capture', source_id: null },
  ]

  it('keeps claims with no sources, a visible capture source, or a non-capture source', () => {
    const kept = filterClaimsVisibleToNobody(claims, sources, visibleCaptures).map((c) => c.id)
    expect(kept).toEqual(['c-none', 'c-public-capture', 'c-mixed', 'c-document'])
  })

  it('drops a claim sourced ONLY from a private capture', () => {
    const kept = filterClaimsVisibleToNobody(claims, sources, visibleCaptures).map((c) => c.id)
    expect(kept).not.toContain('c-private-capture')
  })

  it('fails closed on a dangling capture reference', () => {
    const kept = filterClaimsVisibleToNobody(claims, sources, visibleCaptures).map((c) => c.id)
    expect(kept).not.toContain('c-dangling')
  })

  it('never weaves a claim known only from someone\'s chat (353): a chat is its owner\'s, and the weave has no owner', () => {
    const chatClaims = [{ id: 'c-chat' }, { id: 'c-chat-plus-doc' }]
    const chatSources = [
      { claim_id: 'c-chat', source_type: 'conversation', source_id: 'conv-1' },
      { claim_id: 'c-chat-plus-doc', source_type: 'conversation', source_id: 'conv-1' },
      { claim_id: 'c-chat-plus-doc', source_type: 'document', source_id: 'doc-1' },
    ]
    expect(filterClaimsVisibleToNobody(chatClaims, chatSources, visibleCaptures).map((c) => c.id)).toEqual(['c-chat-plus-doc'])
  })

  it('hides every capture-sourced claim when no capture is workspace-visible', () => {
    const kept = filterClaimsVisibleToNobody(claims, sources, new Set<string>()).map((c) => c.id)
    expect(kept).toEqual(['c-none', 'c-document'])
  })
})
