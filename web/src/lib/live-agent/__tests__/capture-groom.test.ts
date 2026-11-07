/**
 * Tests for Capture Groom's deterministic predicates (GEN-135).
 * Archiving is destructive-ish, so the trigger is pure and tightly tested:
 * only short AND transcript-less captures archive.
 */
import { describe, it, expect } from 'vitest'
import {
  shouldAutoArchiveCapture,
  isUntitledCapture,
  JUNK_MAX_DURATION_SECONDS,
} from '../capture-groom'

describe('shouldAutoArchiveCapture', () => {
  it('archives a short capture with no transcript (the mis-fire case)', () => {
    expect(shouldAutoArchiveCapture({ durationSeconds: 8, transcript: '' })).toBe(true)
    expect(shouldAutoArchiveCapture({ durationSeconds: 3, transcript: null })).toBe(true)
    expect(shouldAutoArchiveCapture({ durationSeconds: 0, transcript: '   ' })).toBe(true)
  })

  it('KEEPS a short capture that DOES have a transcript (a quick real note)', () => {
    expect(
      shouldAutoArchiveCapture({ durationSeconds: 12, transcript: 'Remember to email the vendor about pricing.' }),
    ).toBe(false)
  })

  it('KEEPS a long capture even with an empty transcript (possible transcription failure)', () => {
    expect(shouldAutoArchiveCapture({ durationSeconds: 1800, transcript: '' })).toBe(false)
    expect(shouldAutoArchiveCapture({ durationSeconds: 300, transcript: null })).toBe(false)
  })

  it('KEEPS a short transcript-less capture that has a real AI summary (content survives cleared transcript)', () => {
    // Verified on prod: "Live Chat UI Review" had a 291-char summary + 0 transcript.
    expect(
      shouldAutoArchiveCapture({
        durationSeconds: null,
        transcript: '',
        aiSummary: 'Reviewed the live chat UI and triaged three bugs; agreed to fix the scroll jump first.',
      }),
    ).toBe(false)
  })

  it('KEEPS a short transcript-less capture the user renamed (a real, non-default title)', () => {
    expect(
      shouldAutoArchiveCapture({
        durationSeconds: 5,
        transcript: '',
        title: 'Idea: weekend project',
      }),
    ).toBe(false)
  })

  it('KEEPS a short transcript-less capture the user typed notes into', () => {
    expect(
      shouldAutoArchiveCapture({
        durationSeconds: 20,
        transcript: '',
        userNotes: 'Call the vendor about Q3 pricing before Friday.',
      }),
    ).toBe(false)
  })

  it('KEEPS a real long meeting whose duration_seconds is null/clamped, via the wall-clock span', () => {
    // The prod case: a real 2-min recording with a lost transcript and a
    // clamped/null duration must NOT be archived — the span proves it was long.
    expect(
      shouldAutoArchiveCapture({
        durationSeconds: 37, // clamped, wrong
        transcript: '',
        startedAt: '2026-06-18T13:00:00Z',
        endedAt: '2026-06-18T13:02:13Z', // 133s real span
      }),
    ).toBe(false)
    expect(
      shouldAutoArchiveCapture({
        durationSeconds: null, // never populated
        transcript: '',
        startedAt: '2026-06-18T13:00:00Z',
        endedAt: '2026-06-18T13:45:00Z', // 45-min meeting
      }),
    ).toBe(false)
  })

  it('archives a mis-fire whose short span AGREES with a short/null duration', () => {
    expect(
      shouldAutoArchiveCapture({
        durationSeconds: null,
        transcript: '',
        startedAt: '2026-06-18T13:00:00Z',
        endedAt: '2026-06-18T13:00:06Z', // 6s span — a real mis-fire
      }),
    ).toBe(true)
  })

  it('still archives a mis-fire with a default title and a trivial/empty summary', () => {
    expect(
      shouldAutoArchiveCapture({
        durationSeconds: 4,
        transcript: '',
        aiSummary: '',
        title: 'Untitled Capture',
      }),
    ).toBe(true)
    // A stub summary below the meaningful threshold doesn't rescue it.
    expect(
      shouldAutoArchiveCapture({ durationSeconds: 4, transcript: '', aiSummary: '...', title: 'Capture Jun 10' }),
    ).toBe(true)
  })

  it('treats a tiny transcript (a few stray chars) as transcript-less', () => {
    expect(shouldAutoArchiveCapture({ durationSeconds: 10, transcript: 'uh' })).toBe(true)
    expect(shouldAutoArchiveCapture({ durationSeconds: 10, transcript: '...' })).toBe(true)
  })

  it('is exclusive at the duration boundary (>= 60s is not short)', () => {
    expect(shouldAutoArchiveCapture({ durationSeconds: JUNK_MAX_DURATION_SECONDS, transcript: '' })).toBe(false)
    expect(shouldAutoArchiveCapture({ durationSeconds: JUNK_MAX_DURATION_SECONDS - 1, transcript: '' })).toBe(true)
  })

  it('handles null/undefined duration as 0 (short)', () => {
    expect(shouldAutoArchiveCapture({ durationSeconds: null, transcript: '' })).toBe(true)
    expect(shouldAutoArchiveCapture({ durationSeconds: undefined, transcript: '' })).toBe(true)
  })
})

describe('isUntitledCapture', () => {
  it('flags null / empty / whitespace titles', () => {
    expect(isUntitledCapture(null)).toBe(true)
    expect(isUntitledCapture(undefined)).toBe(true)
    expect(isUntitledCapture('')).toBe(true)
    expect(isUntitledCapture('   ')).toBe(true)
  })

  it('flags the creation default and generic auto-names (case-insensitive)', () => {
    for (const t of ['Untitled Capture', 'untitled capture', 'Untitled', 'New Capture', 'Recording', 'NEW RECORDING']) {
      expect(isUntitledCapture(t), t).toBe(true)
    }
  })

  it('flags auto-generated timestamp titles ("Capture Jul 1 7:46 PM")', () => {
    for (const t of ['Capture Jul 1 7:46 PM', 'Capture Jun 28 10:05 AM', 'Capture Dec 3 9:00 AM']) {
      expect(isUntitledCapture(t), t).toBe(true)
    }
  })

  it('does NOT flag a real title that merely starts with a month-like word', () => {
    // "Capture" is required by the pattern; these are genuine titles.
    expect(isUntitledCapture('June planning offsite')).toBe(false)
    expect(isUntitledCapture('Capture strategy for Q3')).toBe(false) // no month+day after "Capture"
  })

  it('does NOT flag a real title', () => {
    for (const t of ['Weekly standup', 'Koko Link PMO review', 'Call with Sarah', 'Untitled thoughts on Q3']) {
      expect(isUntitledCapture(t), t).toBe(false)
    }
  })
})
