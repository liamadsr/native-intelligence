/**
 * Voice ID matching — pure scoring and decision logic.
 *
 * Extracted from VoiceIdService so the open-set identification math is
 * unit-testable without a Web Worker or audio pipeline. Three layers:
 *
 *   1. Vector ops: l2Normalize / meanVector / cosineSimilarity
 *   2. Scoring: rankCandidates — multi-prototype max-similarity per contact
 *   3. Decision: evaluateVotes — margin-aware sliding-window majority
 *
 * Design notes (why this looks the way it does):
 *
 * - Contacts are scored against multiple per-session PROTOTYPES instead of
 *   one global centroid. A single mean over every enrollment blurs sessions
 *   recorded on different mics/rooms toward a generic "voice-like" vector
 *   that matches everyone with the same gender/accent/channel. Max-over-
 *   prototypes keeps genuine scores high (you match your own best session)
 *   which is what makes the higher thresholds below viable.
 *
 * - Every vote carries the RUNNER-UP score. Open-set identification cannot
 *   be done with an absolute threshold alone: as the gallery grows, the
 *   chance that *someone* clears a fixed bar compounds. A vote only counts
 *   toward resolution when the best contact beats the runner-up by a margin;
 *   "consistently ambiguous between A and B" now surfaces as ambiguity
 *   instead of silently crediting whichever contact iterates first.
 *
 * - Trust tiers no longer LOWER the similarity bar. The old scheme dropped
 *   the threshold to 0.78–0.82 for trusted contacts — squarely inside the
 *   same-gender/same-accent impostor range for wavlm-base-plus-sv (the
 *   model's published verification operating point is ~0.86 cosine). Trust
 *   now only controls HOW a match is surfaced (silent / countdown / ask);
 *   the biometric evidence required is tier-independent and higher.
 */

// ── Trust tiers ──────────────────────────────────────────────

/**
 * Progressive trust tiers based on confirmation_count.
 *
 * unrecognized: 0    confirmations → never suggests, collects silently
 * learning:     1–2  confirmations → "Possible match: Name?", explicit accept
 * suggesting:   3–5  confirmations → suggestion chip, explicit accept/dismiss
 * recognizing:  6–10 confirmations → suggestion chip, auto-accept countdown
 * trusted:     11–19 confirmations → auto-assign when evidence is strong
 * fullyTrusted: 20+  confirmations → silent auto-assign when evidence is strong
 */
export type TrustTier = 'unrecognized' | 'learning' | 'suggesting' | 'recognizing' | 'trusted' | 'fullyTrusted'

export function getTrustTier(confirmationCount: number): TrustTier {
  if (confirmationCount >= 20) return 'fullyTrusted'
  if (confirmationCount >= 11) return 'trusted'
  if (confirmationCount >= 6) return 'recognizing'
  if (confirmationCount >= 3) return 'suggesting'
  if (confirmationCount >= 1) return 'learning'
  return 'unrecognized'
}

export function getTrustTierLabel(tier: TrustTier): string {
  switch (tier) {
    case 'unrecognized': return 'Unrecognized'
    case 'learning': return 'Learning'
    case 'suggesting': return 'Suggesting'
    case 'recognizing': return 'Recognizing'
    case 'trusted': return 'Trusted'
    case 'fullyTrusted': return 'Fully Trusted'
  }
}

export function getNextTierThreshold(confirmationCount: number): number | null {
  if (confirmationCount < 1) return 1
  if (confirmationCount < 3) return 3
  if (confirmationCount < 6) return 6
  if (confirmationCount < 11) return 11
  if (confirmationCount < 20) return 20
  return null // already at max tier
}

// ── Thresholds ───────────────────────────────────────────────

/**
 * Minimum AVERAGE similarity (over qualifying votes) to surface a match,
 * per trust tier. wavlm-base-plus-sv's published verification threshold is
 * ~0.86 cosine; same-accent/same-gender impostor pairs routinely score
 * 0.78–0.85, so no tier goes below 0.86. Low-trust tiers require more
 * because their enrollment data is sparser.
 */
export const TIER_THRESHOLDS: Record<TrustTier, number> = {
  unrecognized: 1.00, // never matches — skipped entirely
  learning:     0.92,
  suggesting:   0.89,
  recognizing:  0.88,
  trusted:      0.87,
  fullyTrusted: 0.86,
}

/** Votes below this best-similarity never count toward a majority. */
export const VOTE_FLOOR_THRESHOLD = 0.80

/** A vote only counts when best beats runner-up by at least this margin. */
export const VOTE_MIN_MARGIN = 0.03

/**
 * Silent/trusted auto-assign additionally requires this much average
 * similarity and average margin — auto-assignment must be unambiguous,
 * not merely above the suggestion bar.
 */
export const AUTO_ASSIGN_MIN_SIMILARITY = 0.90
export const AUTO_ASSIGN_MIN_MARGIN = 0.05

export const VOTING_WINDOW_SIZE = 6 // sliding window of recent match results
export const VOTING_MAJORITY = 4    // qualifying votes needed (higher tiers)
export const VOTING_MAJORITY_EARLY = 3 // learning/suggesting surface sooner
export const VOTING_MIN_SAMPLES = 3 // don't evaluate until 3 results collected

/**
 * Extra similarity required while enrollment spans few distinct SESSIONS.
 * Session count (not raw row count) is what matters: 40 embeddings from one
 * meeting are one channel/one day — nearly as correlated as a single sample.
 */
export function getSessionCountBoost(sessionCount: number): number {
  if (sessionCount <= 1) return 0.04
  if (sessionCount <= 2) return 0.03
  if (sessionCount <= 4) return 0.015
  return 0
}

// ── Vector ops ───────────────────────────────────────────────

export function l2Normalize(vec: number[]): number[] {
  let sumSq = 0
  for (const v of vec) sumSq += v * v
  const norm = Math.sqrt(sumSq)
  if (norm === 0 || !Number.isFinite(norm)) return vec.slice()
  return vec.map((v) => v / norm)
}

/** Mean of vectors on the unit sphere: normalize → average → renormalize. */
export function meanVector(vecs: number[][]): number[] {
  if (vecs.length === 0) return []
  const dim = vecs[0].length
  const sum = new Array<number>(dim).fill(0)
  for (const vec of vecs) {
    const unit = l2Normalize(vec)
    for (let i = 0; i < dim; i++) sum[i] += unit[i]
  }
  for (let i = 0; i < dim; i++) sum[i] /= vecs.length
  return l2Normalize(sum)
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0
  let normA = 0
  let normB = 0
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
}

// ── Scoring ──────────────────────────────────────────────────

export interface GalleryContact {
  contactId: string
  contactName: string
  /** Unit-norm session prototype embeddings (server-aggregated). */
  prototypes: number[][]
}

export interface RankedCandidate {
  contactId: string
  contactName: string
  similarity: number
}

/**
 * Score a query embedding against every gallery contact and return the
 * candidates sorted by similarity (best first).
 *
 * Contact score = MAX similarity across that contact's session prototypes.
 * A genuine speaker matches their own best-conditions session; a centroid
 * would dilute that with every other room/mic they've been recorded in.
 */
export function rankCandidates(
  embedding: number[],
  gallery: GalleryContact[],
  excludeContactIds?: ReadonlySet<string>,
): RankedCandidate[] {
  const ranked: RankedCandidate[] = []
  for (const contact of gallery) {
    if (excludeContactIds?.has(contact.contactId)) continue
    let best = -1
    for (const proto of contact.prototypes) {
      const sim = cosineSimilarity(embedding, proto)
      if (sim > best) best = sim
    }
    if (best >= 0) {
      ranked.push({ contactId: contact.contactId, contactName: contact.contactName, similarity: best })
    }
  }
  ranked.sort((a, b) => b.similarity - a.similarity)
  return ranked
}

// ── Decision ─────────────────────────────────────────────────

export interface MatchVote {
  /** Best-scoring contact for this segment (null = nothing above floor). */
  best: RankedCandidate | null
  /** Second-best contact — the open-set impostor check. */
  runnerUp: RankedCandidate | null
  /** best.similarity − runnerUp.similarity (best.similarity if no runner-up). */
  margin: number
  timestamp: number
}

export interface VoteContactInfo {
  tier: TrustTier
  sessionCount: number
}

export type VoteDecision =
  | { type: 'none' }
  | {
      type: 'resolve'
      contactId: string
      contactName: string
      /** Average similarity across the qualifying votes. */
      confidence: number
      tier: TrustTier
      /**
       * How to surface it: 'auto' = assign without asking (trusted+ with
       * unambiguous evidence), 'suggest' = user must accept.
       */
      mode: 'auto' | 'suggest'
      /** True when the evidence was close between two contacts. */
      ambiguous: boolean
    }

/**
 * Evaluate a speaker's sliding vote window.
 *
 * A vote QUALIFIES for a contact when that contact is the vote's best match
 * with similarity ≥ VOTE_FLOOR_THRESHOLD and margin ≥ VOTE_MIN_MARGIN.
 * A contact resolves when it has enough qualifying votes AND the average
 * similarity clears its tier threshold (+ sparse-session boost). When
 * several contacts qualify simultaneously the HIGHEST average similarity
 * wins (never map-iteration order).
 *
 * Auto-assign (trusted/fullyTrusted) additionally requires
 * AUTO_ASSIGN_MIN_SIMILARITY and AUTO_ASSIGN_MIN_MARGIN on average —
 * otherwise the match downgrades to a suggestion the user must accept.
 */
export function evaluateVotes(
  votes: readonly MatchVote[],
  getContactInfo: (contactId: string) => VoteContactInfo | null,
): VoteDecision {
  if (votes.length < VOTING_MIN_SAMPLES) return { type: 'none' }

  const byContact = new Map<string, { contactName: string; similarities: number[]; margins: number[] }>()
  for (const vote of votes) {
    if (!vote.best) continue
    if (vote.best.similarity < VOTE_FLOOR_THRESHOLD) continue
    if (vote.margin < VOTE_MIN_MARGIN) continue // ambiguous vote — counts for no one
    const entry = byContact.get(vote.best.contactId)
    if (entry) {
      entry.similarities.push(vote.best.similarity)
      entry.margins.push(vote.margin)
    } else {
      byContact.set(vote.best.contactId, {
        contactName: vote.best.contactName,
        similarities: [vote.best.similarity],
        margins: [vote.margin],
      })
    }
  }

  interface Qualifier {
    contactId: string
    contactName: string
    avgSimilarity: number
    avgMargin: number
    tier: TrustTier
  }
  const qualifiers: Qualifier[] = []

  for (const [contactId, data] of byContact) {
    const info = getContactInfo(contactId)
    if (!info || info.tier === 'unrecognized') continue

    const requiredMajority = info.tier === 'learning' || info.tier === 'suggesting'
      ? VOTING_MAJORITY_EARLY
      : VOTING_MAJORITY
    if (data.similarities.length < requiredMajority) continue

    const avgSimilarity = data.similarities.reduce((a, b) => a + b, 0) / data.similarities.length
    const avgMargin = data.margins.reduce((a, b) => a + b, 0) / data.margins.length
    const threshold = Math.min(TIER_THRESHOLDS[info.tier] + getSessionCountBoost(info.sessionCount), 0.99)
    if (avgSimilarity < threshold) continue

    qualifiers.push({ contactId, contactName: data.contactName, avgSimilarity, avgMargin, tier: info.tier })
  }

  if (qualifiers.length === 0) return { type: 'none' }

  // Strongest average similarity wins — deterministic, not map order.
  qualifiers.sort((a, b) => b.avgSimilarity - a.avgSimilarity)
  const winner = qualifiers[0]

  const canAutoAssign = (winner.tier === 'trusted' || winner.tier === 'fullyTrusted')
    && winner.avgSimilarity >= AUTO_ASSIGN_MIN_SIMILARITY
    && winner.avgMargin >= AUTO_ASSIGN_MIN_MARGIN
    && qualifiers.length === 1

  return {
    type: 'resolve',
    contactId: winner.contactId,
    contactName: winner.contactName,
    confidence: winner.avgSimilarity,
    tier: winner.tier,
    mode: canAutoAssign ? 'auto' : 'suggest',
    ambiguous: qualifiers.length > 1 || winner.avgMargin < AUTO_ASSIGN_MIN_MARGIN,
  }
}

/**
 * Pick an evenly spaced subset of session embeddings for enrollment.
 * Consecutive segments from one meeting are highly correlated; storing all
 * of them lets a single channel/day dominate the contact's voice profile.
 */
export function sampleEmbeddingsForEnrollment(embeddings: number[][], max = 8): number[][] {
  if (embeddings.length <= max) return embeddings
  const result: number[][] = []
  const step = (embeddings.length - 1) / (max - 1)
  for (let i = 0; i < max; i++) {
    result.push(embeddings[Math.round(i * step)])
  }
  return result
}
