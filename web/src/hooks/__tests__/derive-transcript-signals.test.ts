/**
 * Tests for deriveTranscriptSignals (src/hooks/use-recording.ts) — the pure
 * core of publishTranscriptSegments' derived-signal publishing (audit finding
 * 7). Extracted so the store contracts are unit-testable without a recording
 * harness (the hook itself has none — same rationale as decideMicRecovery).
 *
 * Contracts under test:
 *   - finalCount counts FINAL segments only; interims are invisible to it.
 *   - finalCountChanged / speakersChanged flag genuine changes only, so the
 *     ref-backed stores notify nobody on the ~150ms interim-flush hot path.
 *   - When the speaker set is unchanged, `speakers` returns prevSpeakers BY
 *     REFERENCE — the getSnapshot-caching rule useSyncExternalStore relies on.
 *   - Speaker ordering: local_* first, then numeric-aware lexicographic.
 */
import { describe, it, expect } from 'vitest'
import { deriveTranscriptSignals } from '@/hooks/use-recording'
import type { TranscriptSegment } from '@/lib/deepgram-stream'

let idCounter = 0
function seg(speaker: string, isFinal = true): TranscriptSegment {
  return {
    id: `seg-${idCounter++}`,
    stream: speaker.startsWith('local') ? 'mic' : 'system',
    speaker,
    text: 'some words',
    startTime: 0,
    endTime: 1,
    isFinal,
    words: [],
  } as TranscriptSegment
}

describe('deriveTranscriptSignals', () => {
  it('counts final segments only — interims are invisible', () => {
    const out = deriveTranscriptSignals(
      [seg('local_1'), seg('remote_1'), seg('local_1', false)],
      0,
      [],
    )
    expect(out.finalCount).toBe(2)
    expect(out.finalCountChanged).toBe(true)
    expect(out.speakers).toEqual(['local_1', 'remote_1'])
    expect(out.speakersChanged).toBe(true)
  })

  it('flags no change on an interim-only republish (the ~150ms hot path)', () => {
    const prevSpeakers = ['local_1', 'remote_1']
    const out = deriveTranscriptSignals(
      [seg('local_1'), seg('remote_1'), seg('remote_1', false)],
      2,
      prevSpeakers,
    )
    expect(out.finalCountChanged).toBe(false)
    expect(out.speakersChanged).toBe(false)
    // Identity rule: unchanged set → the SAME reference back (getSnapshot cache).
    expect(out.speakers).toBe(prevSpeakers)
  })

  it('flags a count change without a speaker change when a known speaker adds a final', () => {
    const prevSpeakers = ['local_1']
    const out = deriveTranscriptSignals([seg('local_1'), seg('local_1')], 1, prevSpeakers)
    expect(out.finalCount).toBe(2)
    expect(out.finalCountChanged).toBe(true)
    expect(out.speakersChanged).toBe(false)
    expect(out.speakers).toBe(prevSpeakers)
  })

  it('flags a speaker change when a NEW speaker lands a final', () => {
    const out = deriveTranscriptSignals(
      [seg('local_1'), seg('remote_1')],
      1,
      ['local_1'],
    )
    expect(out.speakersChanged).toBe(true)
    expect(out.speakers).toEqual(['local_1', 'remote_1'])
  })

  it('orders locals first, then numeric-aware within each group', () => {
    const out = deriveTranscriptSignals(
      [seg('remote_10'), seg('remote_2'), seg('local_10'), seg('local_2')],
      0,
      [],
    )
    expect(out.speakers).toEqual(['local_2', 'local_10', 'remote_2', 'remote_10'])
  })

  it('handles the empty publish (start-of-meeting reset) against non-empty prevs', () => {
    const out = deriveTranscriptSignals([], 12, ['local_1', 'remote_1'])
    expect(out.finalCount).toBe(0)
    expect(out.finalCountChanged).toBe(true)
    expect(out.speakers).toEqual([])
    expect(out.speakersChanged).toBe(true)
  })

  it('is a full no-op signal on an identical republish', () => {
    const prevSpeakers = ['local_1']
    const out = deriveTranscriptSignals([seg('local_1')], 1, prevSpeakers)
    expect(out.finalCountChanged).toBe(false)
    expect(out.speakersChanged).toBe(false)
    expect(out.speakers).toBe(prevSpeakers)
  })
})
