import { describe, it, expect } from 'vitest'

/**
 * Tests for src/lib/voice-id-matching.ts — the open-set speaker
 * identification math behind Voice ID.
 *
 * The scenarios encode the failure modes that motivated the rewrite:
 * - A DIFFERENT person with a similar voice (same accent/gender) scoring
 *   ~0.82–0.85 against an enrolled contact must NOT resolve, no matter how
 *   consistent the votes are. The old per-tier thresholds (0.78–0.82 for
 *   trusted contacts) accepted exactly this.
 * - Two enrolled contacts scoring nearly the same (ambiguous votes) must
 *   never auto-assign to either.
 * - When multiple contacts clear the bar, the STRONGEST must win — never
 *   map-iteration order.
 */

import {
  l2Normalize,
  meanVector,
  cosineSimilarity,
  rankCandidates,
  evaluateVotes,
  sampleEmbeddingsForEnrollment,
  getTrustTier,
  getSessionCountBoost,
  TIER_THRESHOLDS,
  AUTO_ASSIGN_MIN_SIMILARITY,
  type MatchVote,
  type VoteContactInfo,
  type TrustTier,
} from '@/lib/voice-id-matching'

// ── Helpers ──────────────────────────────────────────────────

function vote(
  best: { id: string; name?: string; sim: number } | null,
  runnerUp?: { id: string; sim: number },
): MatchVote {
  return {
    best: best ? { contactId: best.id, contactName: best.name ?? best.id, similarity: best.sim } : null,
    runnerUp: runnerUp ? { contactId: runnerUp.id, contactName: runnerUp.id, similarity: runnerUp.sim } : null,
    margin: best ? best.sim - (runnerUp?.sim ?? 0) : 0,
    timestamp: 0,
  }
}

function contactInfo(entries: Record<string, VoteContactInfo>) {
  return (contactId: string) => entries[contactId] ?? null
}

// ── Vector ops ───────────────────────────────────────────────

describe('l2Normalize', () => {
  it('produces a unit vector', () => {
    const normalized = l2Normalize([3, 4])
    expect(normalized[0]).toBeCloseTo(0.6)
    expect(normalized[1]).toBeCloseTo(0.8)
  })

  it('returns a copy of the zero vector unchanged', () => {
    expect(l2Normalize([0, 0])).toEqual([0, 0])
  })
})

describe('meanVector', () => {
  it('normalizes inputs before averaging so magnitude cannot dominate', () => {
    // Same direction, wildly different magnitudes — mean must be that direction
    const mean = meanVector([[100, 0], [0.001, 0]])
    expect(mean[0]).toBeCloseTo(1)
    expect(mean[1]).toBeCloseTo(0)
  })

  it('returns a unit vector', () => {
    const mean = meanVector([[1, 0], [0, 1]])
    const norm = Math.sqrt(mean[0] ** 2 + mean[1] ** 2)
    expect(norm).toBeCloseTo(1)
  })
})

describe('cosineSimilarity', () => {
  it('is 1 for identical directions and 0 for orthogonal', () => {
    expect(cosineSimilarity([1, 0], [2, 0])).toBeCloseTo(1)
    expect(cosineSimilarity([1, 0], [0, 5])).toBeCloseTo(0)
  })
})

// ── rankCandidates ───────────────────────────────────────────

describe('rankCandidates', () => {
  const gallery = [
    { contactId: 'a', contactName: 'Alice', prototypes: [l2Normalize([1, 0, 0]), l2Normalize([0.9, 0.1, 0])] },
    { contactId: 'b', contactName: 'Bob', prototypes: [l2Normalize([0, 1, 0])] },
  ]

  it('scores each contact by its BEST prototype and sorts descending', () => {
    const query = l2Normalize([1, 0.05, 0])
    const ranked = rankCandidates(query, gallery)
    expect(ranked[0].contactId).toBe('a')
    expect(ranked[1].contactId).toBe('b')
    expect(ranked[0].similarity).toBeGreaterThan(0.99)
  })

  it('excludes contacts in the exclusion set', () => {
    const ranked = rankCandidates([1, 0, 0], gallery, new Set(['a']))
    expect(ranked.map((r) => r.contactId)).toEqual(['b'])
  })
})

// ── Trust tiers ──────────────────────────────────────────────

describe('getTrustTier', () => {
  it('maps confirmation counts to tiers at the documented boundaries', () => {
    expect(getTrustTier(0)).toBe('unrecognized')
    expect(getTrustTier(1)).toBe('learning')
    expect(getTrustTier(3)).toBe('suggesting')
    expect(getTrustTier(6)).toBe('recognizing')
    expect(getTrustTier(11)).toBe('trusted')
    expect(getTrustTier(20)).toBe('fullyTrusted')
  })
})

describe('thresholds', () => {
  it('never drops below the model verification operating point (~0.86) for any tier', () => {
    for (const tier of Object.keys(TIER_THRESHOLDS) as TrustTier[]) {
      if (tier === 'unrecognized') continue
      expect(TIER_THRESHOLDS[tier]).toBeGreaterThanOrEqual(0.86)
    }
  })

  it('requires MORE similarity when enrollment spans few sessions', () => {
    expect(getSessionCountBoost(1)).toBeGreaterThan(getSessionCountBoost(3))
    expect(getSessionCountBoost(10)).toBe(0)
  })
})

// ── evaluateVotes — the core decision ────────────────────────

describe('evaluateVotes', () => {
  const trusted = contactInfo({ A: { tier: 'trusted', sessionCount: 8 } })

  it('does not decide before the minimum sample count', () => {
    const votes = [vote({ id: 'A', sim: 0.95 }), vote({ id: 'A', sim: 0.95 })]
    expect(evaluateVotes(votes, trusted).type).toBe('none')
  })

  it('REJECTS a consistent same-accent impostor scoring ~0.84 against a trusted contact', () => {
    // The exact scenario from the field: a new person with the same accent
    // as an enrolled contact. The old code (trusted threshold 0.80) accepted
    // this every time; it must not resolve at all now.
    const votes = Array.from({ length: 6 }, () => vote({ id: 'A', sim: 0.84 }))
    expect(evaluateVotes(votes, trusted).type).toBe('none')
  })

  it('auto-assigns the genuine speaker: high similarity, clear margin, trusted tier', () => {
    const votes = Array.from({ length: 4 }, () => vote({ id: 'A', sim: 0.93 }, { id: 'B', sim: 0.70 }))
    const decision = evaluateVotes(votes, trusted)
    expect(decision).toMatchObject({ type: 'resolve', contactId: 'A', mode: 'auto' })
  })

  it('downgrades to a suggestion when similarity clears the tier bar but not the auto-assign bar', () => {
    const sim = (TIER_THRESHOLDS.trusted + AUTO_ASSIGN_MIN_SIMILARITY) / 2 // ~0.885
    const votes = Array.from({ length: 4 }, () => vote({ id: 'A', sim }, { id: 'B', sim: 0.70 }))
    const decision = evaluateVotes(votes, trusted)
    expect(decision).toMatchObject({ type: 'resolve', contactId: 'A', mode: 'suggest' })
  })

  it('never counts ambiguous votes (margin below minimum) toward a majority', () => {
    // Two contacts nearly tied on every segment — "A or B" must not resolve
    // silently to either, even at very high similarity.
    const votes = Array.from({ length: 6 }, () =>
      vote({ id: 'A', sim: 0.93 }, { id: 'B', sim: 0.92 }))
    const info = contactInfo({
      A: { tier: 'trusted', sessionCount: 8 },
      B: { tier: 'trusted', sessionCount: 8 },
    })
    expect(evaluateVotes(votes, info).type).toBe('none')
  })

  it('picks the STRONGEST qualifying contact, not the first seen', () => {
    // B appears later in the votes but scores higher — B must win.
    const votes = [
      ...Array.from({ length: 3 }, () => vote({ id: 'A', name: 'Alice', sim: 0.90 }, { id: 'x', sim: 0.60 })),
      ...Array.from({ length: 3 }, () => vote({ id: 'B', name: 'Bob', sim: 0.95 }, { id: 'x', sim: 0.60 })),
    ]
    const info = contactInfo({
      A: { tier: 'suggesting', sessionCount: 8 },
      B: { tier: 'suggesting', sessionCount: 8 },
    })
    const decision = evaluateVotes(votes, info)
    expect(decision).toMatchObject({ type: 'resolve', contactId: 'B' })
    // Split window means neither is unambiguous — must not auto-assign.
    if (decision.type === 'resolve') expect(decision.mode).toBe('suggest')
  })

  it('never resolves unrecognized-tier contacts', () => {
    const votes = Array.from({ length: 6 }, () => vote({ id: 'A', sim: 0.97 }, { id: 'B', sim: 0.5 }))
    const info = contactInfo({ A: { tier: 'unrecognized', sessionCount: 8 } })
    expect(evaluateVotes(votes, info).type).toBe('none')
  })

  it('requires extra similarity while enrollment data spans a single session', () => {
    // suggesting tier (0.89) + single-session boost (0.04) → needs ≥0.93
    const info = contactInfo({ A: { tier: 'suggesting', sessionCount: 1 } })
    const below = Array.from({ length: 4 }, () => vote({ id: 'A', sim: 0.91 }, { id: 'B', sim: 0.6 }))
    expect(evaluateVotes(below, info).type).toBe('none')
    const above = Array.from({ length: 4 }, () => vote({ id: 'A', sim: 0.94 }, { id: 'B', sim: 0.6 }))
    expect(evaluateVotes(above, info).type).toBe('resolve')
  })

  it('learning tier resolves with fewer votes but only as a suggestion', () => {
    const info = contactInfo({ A: { tier: 'learning', sessionCount: 8 } })
    const votes = Array.from({ length: 3 }, () => vote({ id: 'A', sim: 0.95 }, { id: 'B', sim: 0.6 }))
    const decision = evaluateVotes(votes, info)
    expect(decision).toMatchObject({ type: 'resolve', mode: 'suggest', tier: 'learning' })
  })

  it('ignores votes for contacts the info lookup excludes (dismissed/assigned elsewhere)', () => {
    const votes = Array.from({ length: 6 }, () => vote({ id: 'A', sim: 0.95 }, { id: 'B', sim: 0.6 }))
    const decision = evaluateVotes(votes, () => null)
    expect(decision.type).toBe('none')
  })
})

// ── Enrollment sampling ──────────────────────────────────────

describe('sampleEmbeddingsForEnrollment', () => {
  it('returns everything when under the cap', () => {
    const embeddings = [[1], [2], [3]]
    expect(sampleEmbeddingsForEnrollment(embeddings, 8)).toEqual(embeddings)
  })

  it('samples evenly across the session, keeping first and last', () => {
    const embeddings = Array.from({ length: 100 }, (_, i) => [i])
    const sampled = sampleEmbeddingsForEnrollment(embeddings, 8)
    expect(sampled).toHaveLength(8)
    expect(sampled[0]).toEqual([0])
    expect(sampled[7]).toEqual([99])
  })
})
