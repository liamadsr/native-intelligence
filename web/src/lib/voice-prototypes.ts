/**
 * Voice enrollment aggregation — turns raw per-segment enrollment rows into
 * per-contact session PROTOTYPES for matching.
 *
 * Shared by the /api/account/voice-enrollments GET route (server) and unit
 * tests. Pure functions, no I/O.
 *
 * Why session prototypes instead of one centroid:
 * - Embeddings from one session share a mic, room, and day — averaging them
 *   is meaningful (noise cancels, identity stays).
 * - Averaging ACROSS sessions blurs channel differences into a generic
 *   voice vector that drifts toward "anyone with this accent/gender/mic".
 * - Matching against per-session prototypes (max similarity) keeps genuine
 *   scores high while impostors still have to beat a real recording of the
 *   real person, not a blurred average.
 *
 * Consensus filtering: with 3+ sessions, a session whose prototype doesn't
 * resemble ANY other session (max pairwise similarity < OUTLIER_MIN_SIMILARITY)
 * is likely a mislabeled recording of a different person (or unusable audio)
 * and is excluded from matching. The rows stay in the database — corrections
 * and future re-aggregation can still see them.
 */

import { l2Normalize, meanVector, cosineSimilarity } from '@/lib/voice-id-matching'

export interface EnrollmentRow {
  embedding: number[]
  session_id: string | null
  created_at: string | null
}

export interface ContactVoiceProfile {
  /** Unit-norm per-session prototypes, most recent session first. */
  prototypes: number[][]
  /** Unit-norm mean of the kept prototypes (legacy single-centroid shape). */
  centroid: number[]
  /** Distinct sessions represented in the kept prototypes. */
  sessionCount: number
  /** Raw enrollment rows seen (before outlier filtering). */
  enrollmentCount: number
  /** Sessions dropped by consensus filtering. */
  droppedSessionCount: number
}

/** Keep at most this many session prototypes (most recent first). */
export const MAX_PROTOTYPES = 10

/**
 * A session prototype must resemble at least one other session this much to
 * be kept (only enforced when there are 3+ sessions to form a consensus).
 */
export const OUTLIER_MIN_SIMILARITY = 0.70

interface SessionGroup {
  embeddings: number[][]
  latestCreatedAt: number
}

export function buildContactProfile(rows: EnrollmentRow[]): ContactVoiceProfile | null {
  const valid = rows.filter((r) => Array.isArray(r.embedding) && r.embedding.length > 0)
  if (valid.length === 0) return null

  // Group by session. Legacy rows without a session_id become singleton
  // pseudo-sessions — they were saved one-per-utterance and we can't tell
  // which belong together.
  const groups = new Map<string, SessionGroup>()
  let anonCounter = 0
  for (const row of valid) {
    const key = row.session_id ?? `__legacy_${anonCounter++}`
    const createdAt = row.created_at ? Date.parse(row.created_at) : 0
    const group = groups.get(key)
    if (group) {
      group.embeddings.push(row.embedding)
      group.latestCreatedAt = Math.max(group.latestCreatedAt, createdAt)
    } else {
      groups.set(key, { embeddings: [row.embedding], latestCreatedAt: createdAt })
    }
  }

  // One unit-norm prototype per session, most recent session first.
  const sessions = Array.from(groups.values())
    .sort((a, b) => b.latestCreatedAt - a.latestCreatedAt)
  let prototypes = sessions.map((s) => meanVector(s.embeddings))

  // Consensus filter: with 3+ sessions, drop prototypes that resemble no
  // other session — likely a wrong-person recording poisoning the profile.
  let droppedSessionCount = 0
  if (prototypes.length >= 3) {
    const kept: number[][] = []
    for (let i = 0; i < prototypes.length; i++) {
      let maxSim = -1
      for (let j = 0; j < prototypes.length; j++) {
        if (i === j) continue
        const sim = cosineSimilarity(prototypes[i], prototypes[j])
        if (sim > maxSim) maxSim = sim
      }
      if (maxSim >= OUTLIER_MIN_SIMILARITY) {
        kept.push(prototypes[i])
      } else {
        droppedSessionCount++
      }
    }
    // If consensus filtering would remove everything, keep the originals —
    // a profile of mutually dissimilar sessions has no majority to trust.
    if (kept.length > 0) prototypes = kept
    else droppedSessionCount = 0
  }

  const sessionCount = prototypes.length
  prototypes = prototypes.slice(0, MAX_PROTOTYPES)

  return {
    prototypes,
    centroid: prototypes.length === 1 ? l2Normalize(prototypes[0]) : meanVector(prototypes),
    sessionCount,
    enrollmentCount: valid.length,
    droppedSessionCount,
  }
}
