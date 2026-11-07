// @vitest-environment jsdom
/**
 * THE EDITOR-SIDE WATERMARK'S TWO DECISIONS.
 *
 * Capture STATE is freshened by refetch paths that deliberately do NOT push to
 * the editor (the 25s poll tick, useEntityDetailSync's socket-recovery refetch,
 * the capture-ended handler mid-recording) — so neither the realtime push gate
 * nor the SUBSCRIBED resync skip may compare an incoming summary against state.
 * Both compare against the EDITOR watermark (the full summary string the editor
 * last received) instead:
 *
 *  - decideRealtimeSummary splits the leg into a state-merge decision (skip the
 *    redundant setCapture for per-transcript-append rebroadcasts) and an
 *    editor-push decision. The sleep/wake bug this pins: state already holds
 *    the new summary (a non-pushing refetch won the race) while the editor
 *    lags → merge must be skipped but the push MUST run.
 *  - shouldSkipSubscribedResync skips the (expensive, full-row) resync only
 *    when the fetch stamp is fresh AND the editor is in sync with state. A
 *    fresh stamp from a non-pushing refetch with a lagging editor must let the
 *    resync run — it is the only remaining path that pushes.
 */
import { describe, it, expect, vi } from 'vitest'

// The panel's editor stack reaches react-tweet, which ships raw CSS modules
// node can't load — stub the editor at its module boundary. This test only
// exercises the pure decision helpers the panel exports.
vi.mock('@/app/account/(dashboard)/views/note-editor', () => ({ NoteEditor: () => null }))

import {
  decideRealtimeSummary,
  shouldSkipSubscribedResync,
} from '../capture-detail-panel'

describe('decideRealtimeSummary', () => {
  it('merges and pushes a summary that is new to both state and editor', () => {
    expect(decideRealtimeSummary('new text', 'old text', 'old text')).toEqual({
      merge: true,
      push: true,
    })
  })

  it('pushes even when state already holds the summary (non-pushing refetch won the race)', () => {
    // THE bug scenario: a poll-tick / detail-sync / capture-ended refetch
    // merged the new summary into state without touching the editor, then the
    // realtime event arrives. A state-based compare suppressed the push
    // forever; the editor watermark keeps it alive.
    expect(decideRealtimeSummary('new text', 'new text', 'old text')).toEqual({
      merge: false,
      push: true,
    })
  })

  it('skips both for a per-append rebroadcast already in state AND the editor', () => {
    expect(decideRealtimeSummary('same', 'same', 'same')).toEqual({
      merge: false,
      push: false,
    })
  })

  it('merges without pushing when only the editor is ahead (user typed, echo pending)', () => {
    // handleSummaryChange stamps the watermark at type time; the echo of the
    // save arrives with state still behind — merge state, leave the doc alone.
    expect(decideRealtimeSummary('typed', 'old', 'typed')).toEqual({
      merge: true,
      push: false,
    })
  })

  it("propagates '' (a deliberate clear) through both decisions", () => {
    expect(decideRealtimeSummary('', 'old', 'old')).toEqual({ merge: true, push: true })
    expect(decideRealtimeSummary('', '', '')).toEqual({ merge: false, push: false })
  })

  it('pushes against a null watermark (editor mounted on the non-ai fallback)', () => {
    expect(decideRealtimeSummary('first summary', null, null)).toEqual({
      merge: true,
      push: true,
    })
    // A clear is also new relative to a null watermark.
    expect(decideRealtimeSummary('', null, null)).toEqual({ merge: true, push: true })
  })

  it('does nothing for the {{streaming}} sentinel or non-string payloads', () => {
    expect(decideRealtimeSummary('{{streaming}}', 'old', 'old')).toEqual({
      merge: false,
      push: false,
    })
    expect(decideRealtimeSummary(null, 'old', 'old')).toEqual({ merge: false, push: false })
    expect(decideRealtimeSummary(undefined, 'old', 'old')).toEqual({
      merge: false,
      push: false,
    })
  })
})

describe('shouldSkipSubscribedResync', () => {
  const T = 1_000_000

  it('skips when the fetch stamp is fresh AND the editor is in sync with state', () => {
    expect(shouldSkipSubscribedResync(T, T - 1_000, 'summary', 'summary')).toBe(true)
  })

  it('runs when the stamp is fresh but the editor LAGS state (sleep/wake heal)', () => {
    // detail-sync's recovery refetch stamped the fetch time WITHOUT pushing;
    // the channel finishes rejoining inside the 5s window. Skipping here left
    // the editor stale forever — the resync must run (it pushes).
    expect(shouldSkipSubscribedResync(T, T - 1_000, 'old summary', 'new summary')).toBe(false)
  })

  it('runs when the stamp is stale, even with the editor in sync', () => {
    expect(shouldSkipSubscribedResync(T, T - 10_000, 'summary', 'summary')).toBe(false)
  })

  it('treats a null watermark as in sync only with a null state summary', () => {
    // Plain open of a capture with no ai_summary: both null → skip (this is
    // the double-download the recency guard exists to avoid).
    expect(shouldSkipSubscribedResync(T, T - 1_000, null, null)).toBe(true)
    // Editor never received the summary state holds → run.
    expect(shouldSkipSubscribedResync(T, T - 1_000, null, 'summary')).toBe(false)
  })
})
