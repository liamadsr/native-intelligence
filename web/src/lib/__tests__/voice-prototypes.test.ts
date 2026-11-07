import { describe, it, expect } from 'vitest'

/**
 * Tests for src/lib/voice-prototypes.ts — aggregation of raw enrollment
 * rows into per-session prototypes.
 *
 * Key behaviors to lock in:
 * - One prototype per SESSION (not per row, not one global centroid).
 * - Consensus filtering drops a session that matches no other session —
 *   that's how a wrong-person enrollment stops poisoning matching.
 * - Prototype count is capped, most recent sessions first.
 */

import { buildContactProfile, MAX_PROTOTYPES, type EnrollmentRow } from '@/lib/voice-prototypes'
import { cosineSimilarity, l2Normalize } from '@/lib/voice-id-matching'

function row(embedding: number[], sessionId: string | null, createdAt = '2026-01-01T00:00:00Z'): EnrollmentRow {
  return { embedding, session_id: sessionId, created_at: createdAt }
}

/** A noisy variant of a base direction (still strongly correlated). */
function noisy(base: number[], seedOffset: number): number[] {
  return base.map((v, i) => v + 0.05 * Math.sin(i * 7.3 + seedOffset))
}

describe('buildContactProfile', () => {
  it('returns null for no usable rows', () => {
    expect(buildContactProfile([])).toBeNull()
    expect(buildContactProfile([row([], 's1')])).toBeNull()
  })

  it('builds one unit-norm prototype per session', () => {
    const base = [1, 0, 0, 0]
    const profile = buildContactProfile([
      row(noisy(base, 1), 's1'),
      row(noisy(base, 2), 's1'),
      row(noisy(base, 3), 's2'),
    ])!
    expect(profile.sessionCount).toBe(2)
    expect(profile.prototypes).toHaveLength(2)
    for (const proto of profile.prototypes) {
      const norm = Math.sqrt(proto.reduce((s, v) => s + v * v, 0))
      expect(norm).toBeCloseTo(1)
    }
    expect(profile.enrollmentCount).toBe(3)
  })

  it('orders prototypes most-recent-session first and caps at MAX_PROTOTYPES', () => {
    const base = [0, 1, 0, 0]
    const rows: EnrollmentRow[] = []
    for (let s = 0; s < MAX_PROTOTYPES + 5; s++) {
      rows.push(row(noisy(base, s), `s${s}`, `2026-01-${String(s + 1).padStart(2, '0')}T00:00:00Z`))
    }
    const profile = buildContactProfile(rows)!
    expect(profile.prototypes).toHaveLength(MAX_PROTOTYPES)
    // Most recent session (largest date) is first
    const newest = l2Normalize(noisy(base, MAX_PROTOTYPES + 4))
    expect(cosineSimilarity(profile.prototypes[0], newest)).toBeGreaterThan(0.999)
  })

  it('drops a poisoned session that resembles no other session', () => {
    const genuine = [1, 0.2, 0, 0.1]
    const impostor = [0, 0, 1, 0] // orthogonal — a different voice entirely
    const profile = buildContactProfile([
      row(noisy(genuine, 1), 's1'),
      row(noisy(genuine, 2), 's2'),
      row(noisy(genuine, 3), 's3'),
      row(impostor, 's4-poison'),
    ])!
    expect(profile.droppedSessionCount).toBe(1)
    expect(profile.sessionCount).toBe(3)
    for (const proto of profile.prototypes) {
      expect(cosineSimilarity(proto, l2Normalize(impostor))).toBeLessThan(0.5)
    }
  })

  it('keeps everything when no consensus can form (fewer than 3 sessions)', () => {
    const profile = buildContactProfile([
      row([1, 0], 's1'),
      row([0, 1], 's2'), // orthogonal but only 2 sessions — no consensus
    ])!
    expect(profile.sessionCount).toBe(2)
    expect(profile.droppedSessionCount).toBe(0)
  })

  it('does not drop everything when all sessions are mutually dissimilar', () => {
    const profile = buildContactProfile([
      row([1, 0, 0], 's1'),
      row([0, 1, 0], 's2'),
      row([0, 0, 1], 's3'),
    ])!
    expect(profile.prototypes.length).toBe(3)
    expect(profile.droppedSessionCount).toBe(0)
  })

  it('treats legacy null-session rows as singleton sessions', () => {
    const base = [1, 1, 0]
    const profile = buildContactProfile([
      row(noisy(base, 1), null),
      row(noisy(base, 2), null),
    ])!
    expect(profile.sessionCount).toBe(2)
  })

  it('normalizes magnitude differences between rows (legacy un-normalized embeddings)', () => {
    const profile = buildContactProfile([
      row([100, 0], 's1'),
      row([0.01, 0.0001], 's1'),
    ])!
    // Both rows point ~[1,0]; a raw mean would be dominated by the large one
    // either way, but the prototype must be unit-norm regardless.
    expect(profile.prototypes[0][0]).toBeCloseTo(1, 1)
  })
})
