/**
 * Tests for releaseSessionSegments (src/hooks/use-recording.ts) — the pure core
 * of clearSessionAccumulators' segment-store rewrite (incident hotfix H3).
 * Extracted so the post-stop transcript contract is unit-testable without a
 * recording harness (the hook itself has none — same rationale as
 * decideMicRecovery / deriveTranscriptSignals).
 *
 * WHY THIS EXISTS (recording-cache review, critical). H3's first cut emptied the
 * live segment ARRAY at stop. useDisplayTranscriptSegments (live-capture-header)
 * falls back to the capture row's PERSISTED transcript the instant `liveSegments`
 * is empty, and that row is only refreshed by the panel's one-shot
 * loadTranscript() — which can resolve against a row the final force-save hasn't
 * landed on yet. So the pane rendered blank/truncated for the panel's whole
 * lifetime even though the DB row was correct moments later.
 *
 * Contracts under test:
 *   - STOP keeps every text-bearing segment, so the pane can never go blank
 *     whatever the panel's fetch timing (the fix's core guarantee).
 *   - STOP still releases the memory: the per-word payloads — the multi-MB half
 *     of the retained accumulators — are stripped from every segment.
 *   - Word-free segments come back BY REFERENCE (no needless allocation on a
 *     repeat release or a session that captured no word timings).
 *   - DISCARD (dropSegments) empties the array outright — the capture row is
 *     deleted, so no post-stop reader survives.
 *   - The input array is never mutated in place (the pre-clear snapshot a
 *     mounted consumer may still hold must stay coherent until it re-reads).
 */
import { describe, it, expect } from 'vitest'
import { releaseSessionSegments } from '@/hooks/use-recording'
import type { TranscriptSegment, TranscriptWord } from '@/lib/deepgram-stream'

let wordCounter = 0
function words(count: number): TranscriptWord[] {
  return Array.from({ length: count }, () => ({
    word: `w${wordCounter++}`,
    start: 0,
    end: 1,
    confidence: 0.9,
    speaker: 0,
  })) as TranscriptWord[]
}

let segCounter = 0
function seg(speaker: string, text: string, wordCount: number): TranscriptSegment {
  const i = segCounter++
  return {
    id: `seg-${i}`,
    text,
    stream: speaker.startsWith('local') ? 'mic' : 'system',
    speaker,
    startTime: i,
    endTime: i + 1,
    isFinal: true,
    words: words(wordCount),
  }
}

describe('releaseSessionSegments', () => {
  it('KEEPS the meeting text at stop — the post-stop pane can never go blank', () => {
    // A meeting's worth of finals, exactly what the pane is painting when Stop
    // is clicked and the panel's transcript GET is still racing the final save.
    const segments = [
      seg('local_1', 'so the migration ships Friday', 6),
      seg('remote_1', 'and Sam owns the rollout', 5),
      seg('local_1', 'agreed, I will write it up', 7),
    ]

    const released = releaseSessionSegments(segments)

    // The pane's fallback is `liveSegments.length > 0`; a zero-length result is
    // precisely the blank-pane bug. Text and speakers must survive verbatim.
    expect(released.length).toBe(3)
    expect(released.map((s) => s.text)).toEqual([
      'so the migration ships Friday',
      'and Sam owns the rollout',
      'agreed, I will write it up',
    ])
    expect(released.map((s) => s.speaker)).toEqual(['local_1', 'remote_1', 'local_1'])
    // The rest of the display shape is untouched too (ids key the React list,
    // isFinal drives the opacity, times drive ordering).
    expect(released.map((s) => s.id)).toEqual(segments.map((s) => s.id))
    expect(released.every((s) => s.isFinal)).toBe(true)
  })

  it('still releases the memory: every per-word payload is stripped', () => {
    const segments = [
      seg('local_1', 'a', 400),
      seg('remote_1', 'b', 350),
      seg('local_1', 'c', 275),
    ]
    expect(segments.reduce((n, s) => n + s.words.length, 0)).toBe(1025)

    const released = releaseSessionSegments(segments)

    expect(released.reduce((n, s) => n + s.words.length, 0)).toBe(0)
    expect(released.every((s) => Array.isArray(s.words))).toBe(true)
  })

  it('returns word-free segments BY REFERENCE (no needless re-allocation)', () => {
    const withWords = seg('local_1', 'has words', 3)
    const withoutWords = seg('remote_1', 'already lightened', 0)

    const released = releaseSessionSegments([withWords, withoutWords])

    expect(released[0]).not.toBe(withWords) // rewritten (words dropped)
    expect(released[1]).toBe(withoutWords) // untouched

    // A repeat release (stop → discard, or a double-invoked tail) allocates
    // nothing new at all.
    const again = releaseSessionSegments(released)
    expect(again[0]).toBe(released[0])
    expect(again[1]).toBe(released[1])
  })

  it('empties the array on the DISCARD path (dropSegments)', () => {
    const segments = [seg('local_1', 'throwaway', 4), seg('remote_1', 'also throwaway', 4)]
    expect(releaseSessionSegments(segments, true)).toEqual([])
  })

  it('never mutates the input array or its segments in place', () => {
    const original = seg('local_1', 'immutable please', 5)
    const segments = [original]

    releaseSessionSegments(segments)

    expect(segments.length).toBe(1)
    expect(segments[0]).toBe(original)
    expect(original.words.length).toBe(5)
  })

  it('handles an empty session (nothing was ever captured)', () => {
    expect(releaseSessionSegments([])).toEqual([])
    expect(releaseSessionSegments([], true)).toEqual([])
  })
})
