import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TranscriptSegment } from '@/lib/deepgram-stream'
import {
  GATE_MAX_ACCUMULATION_MS,
  GATE_MIN_FLUSH_CHARS,
  TranscriptGate,
} from '../transcript-gate'

/**
 * The gate's job is to protect LIVE extraction quality. A rapid-exchange meeting
 * pauses every few seconds, so a pure 3s-silence gate emits tiny "crumb" windows
 * that the extraction contract ("extract from THIS window") correctly returns
 * nothing on — starving live extraction (prod capture b9abb272: ~2 items in 40
 * min). These tests pin the size floor's behavior: silence alone no longer
 * flushes, but nothing is ever STRANDED — the buffer still flushes once it clears
 * the floor, once the standing age timer fires (GATE_MAX_ACCUMULATION_MS after the
 * first segment, even under continuous speech), or on an explicit flush() at
 * capture stop (which bypasses the floor entirely). The end-of-meeting batch pass
 * covers completeness; the floor is purely about live.
 */

const SILENCE_MS = 3000 // mirrors the gate's internal silence window

// The formatted line the gate emits per segment is `[speaker]: text`, so its
// length is speaker + 4 (`[`, `]`, `:`, ` `) + text, joined by `\n`. We build
// segments whose TEXT length lets us land precisely under or over the floor.
function makeSegment(text: string, opts: Partial<TranscriptSegment> = {}): TranscriptSegment {
  return {
    id: opts.id ?? `seg-${Math.random().toString(36).slice(2)}`,
    text,
    stream: opts.stream ?? 'mic',
    speaker: opts.speaker ?? 'local_1',
    startTime: 0,
    endTime: 0,
    isFinal: opts.isFinal ?? true,
    words: [],
  }
}

/** A single final segment whose FORMATTED length is exactly `chars`. */
function segmentOfFormattedLength(chars: number, opts: Partial<TranscriptSegment> = {}): TranscriptSegment {
  const speaker = opts.speaker ?? 'local_1'
  const prefix = `[${speaker}]: `.length // speaker + "[]: "
  const textLen = Math.max(0, chars - prefix)
  return makeSegment('x'.repeat(textLen), { ...opts, speaker })
}

describe('TranscriptGate size floor', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('does NOT flush sub-floor content after 3s of silence', () => {
    const onFlush = vi.fn()
    const gate = new TranscriptGate(onFlush)
    gate.setEnabled(true)

    // Well under GATE_MIN_FLUSH_CHARS — a "crumb" window.
    gate.addSegment(segmentOfFormattedLength(200))

    // Let the silence window (plus the internal buffer) elapse.
    vi.advanceTimersByTime(SILENCE_MS + 100)

    expect(onFlush).not.toHaveBeenCalled()
  })

  it('flushes ONCE with all accumulated text after the buffer crosses the floor', () => {
    const onFlush = vi.fn()
    const gate = new TranscriptGate(onFlush)
    gate.setEnabled(true)

    // Two chunks: individually sub-floor, together over it.
    const half = Math.ceil(GATE_MIN_FLUSH_CHARS / 2) + 50
    gate.addSegment(segmentOfFormattedLength(half, { id: 'a' }))
    // Below floor after one segment → a silence check here must NOT flush.
    vi.advanceTimersByTime(SILENCE_MS + 100)
    expect(onFlush).not.toHaveBeenCalled()

    gate.addSegment(segmentOfFormattedLength(half, { id: 'b' }))
    // Now over the floor → the next silence flushes exactly once.
    vi.advanceTimersByTime(SILENCE_MS + 100)

    expect(onFlush).toHaveBeenCalledTimes(1)
    const [, segments] = onFlush.mock.calls[0]
    // ALL accumulated segments flush together — nothing is lost or split.
    expect(segments.map((s: TranscriptSegment) => s.id)).toEqual(['a', 'b'])
  })

  it('flushes sub-floor content when the standing age timer fires, with no further segments', () => {
    const onFlush = vi.fn()
    const gate = new TranscriptGate(onFlush)
    gate.setEnabled(true)

    gate.addSegment(segmentOfFormattedLength(200))

    // Silence passes, but the buffer is sub-floor → held, not flushed.
    vi.advanceTimersByTime(SILENCE_MS + 100)
    expect(onFlush).not.toHaveBeenCalled()

    // The standing age timer (armed on the first segment) fires at exactly
    // GATE_MAX_ACCUMULATION_MS from that segment even though no new segment ever
    // arrives — the escape hatch that keeps thin buffers from stranding.
    vi.advanceTimersByTime(GATE_MAX_ACCUMULATION_MS - (SILENCE_MS + 100))
    expect(onFlush).toHaveBeenCalledTimes(1)
    const [text] = onFlush.mock.calls[0]
    expect(text.length).toBeLessThan(GATE_MIN_FLUSH_CHARS)
  })

  it('explicit flush() bypasses the floor and emits whatever exists', () => {
    const onFlush = vi.fn()
    const gate = new TranscriptGate(onFlush)
    gate.setEnabled(true)

    // A tiny buffer that would never clear the floor on its own.
    gate.addSegment(makeSegment('quick note'))
    gate.flush()

    expect(onFlush).toHaveBeenCalledTimes(1)
    const [text] = onFlush.mock.calls[0]
    expect(text).toContain('quick note')
    expect(text.length).toBeLessThan(GATE_MIN_FLUSH_CHARS)
  })

  it('hasPending() says whether a final segment is buffered (the record turn flushes it, L3)', () => {
    const onFlush = vi.fn()
    const gate = new TranscriptGate(onFlush)
    gate.setEnabled(true)
    expect(gate.hasPending()).toBe(false)
    // An interim only marks activity; it is never flushed content.
    gate.addSegment(makeSegment('um', { isFinal: false }))
    expect(gate.hasPending()).toBe(false)
    gate.addSegment(makeSegment('quick note'))
    expect(gate.hasPending()).toBe(true)
    gate.flush()
    expect(gate.hasPending()).toBe(false)
    gate.addSegment(makeSegment('again'))
    gate.reset()
    expect(gate.hasPending()).toBe(false)
  })

  it('never loses content: a floor-blocked buffer + more speech flushes everything on the next silence', () => {
    const onFlush = vi.fn()
    const gate = new TranscriptGate(onFlush)
    gate.setEnabled(true)

    // First segment: sub-floor, blocked on silence.
    gate.addSegment(segmentOfFormattedLength(300, { id: 'first' }))
    vi.advanceTimersByTime(SILENCE_MS + 100)
    expect(onFlush).not.toHaveBeenCalled()

    // More speech arrives (resetting silence), pushing the buffer over the floor.
    gate.addSegment(segmentOfFormattedLength(GATE_MIN_FLUSH_CHARS, { id: 'second' }))
    vi.advanceTimersByTime(SILENCE_MS + 100)

    // One flush, and it carries BOTH segments — the early sub-floor content is
    // not dropped when the later content triggers the flush.
    expect(onFlush).toHaveBeenCalledTimes(1)
    const [, segments] = onFlush.mock.calls[0]
    expect(segments.map((s: TranscriptSegment) => s.id)).toEqual(['first', 'second'])
  })

  it('reset() clears the buffer and cancels the standing age timer', () => {
    const onFlush = vi.fn()
    const gate = new TranscriptGate(onFlush)
    gate.setEnabled(true)

    gate.addSegment(segmentOfFormattedLength(200))
    // Silence check runs (sub-floor → no flush); the standing age timer is armed.
    vi.advanceTimersByTime(SILENCE_MS + 100)
    expect(onFlush).not.toHaveBeenCalled()

    gate.reset()

    // After reset, the previously-armed age timer must NOT fire a flush (the
    // buffer and firstAccumulatedAt were cleared), and an explicit flush is a no-op.
    vi.advanceTimersByTime(GATE_MAX_ACCUMULATION_MS * 2)
    gate.flush()
    expect(onFlush).not.toHaveBeenCalled()
  })

  it('continuous speech (no 3s silence) still flushes at ~GATE_MAX_ACCUMULATION_MS with all segments', () => {
    const onFlush = vi.fn()
    const gate = new TranscriptGate(onFlush)
    gate.setEnabled(true)

    // Segments every 250ms right up to (but not across) the accumulation window —
    // the silence check never fires (activity resets it each time), so ONLY the
    // standing age timer can flush. This is the continuous-call regression the
    // age timer fixes. Stop one step short of 60s so the loop never crosses the
    // boundary; the flush is asserted afterward.
    const STEP = 250
    const steps = Math.floor(GATE_MAX_ACCUMULATION_MS / STEP) - 1
    for (let i = 0; i < steps; i++) {
      gate.addSegment(makeSegment('word ', { id: `s-${i}` }))
      vi.advanceTimersByTime(STEP)
      // Nothing flushes mid-window: buffer is sub-floor and never dual-silent.
      expect(onFlush).not.toHaveBeenCalled()
    }

    // Cross the 60s boundary from the first segment → the standing timer fires.
    vi.advanceTimersByTime(STEP * 2)
    expect(onFlush).toHaveBeenCalledTimes(1)
    const [, segments] = onFlush.mock.calls[0]
    // Every accumulated segment lands in the one window — none stranded.
    expect(segments).toHaveLength(steps)
    expect(segments[0].id).toBe('s-0')
    expect(segments[segments.length - 1].id).toBe(`s-${steps - 1}`)
  })

  it('a floor+silence flush before 60s does NOT later fire a spurious age-timer flush', () => {
    const onFlush = vi.fn()
    const gate = new TranscriptGate(onFlush)
    gate.setEnabled(true)

    // Cross the floor in one segment, then go silent → flush well before 60s.
    gate.addSegment(segmentOfFormattedLength(GATE_MIN_FLUSH_CHARS + 100))
    vi.advanceTimersByTime(SILENCE_MS + 100)
    expect(onFlush).toHaveBeenCalledTimes(1)

    // The standing age timer must have been cleared on that flush — advancing
    // past its original deadline produces no second, empty-buffer flush.
    vi.advanceTimersByTime(GATE_MAX_ACCUMULATION_MS)
    expect(onFlush).toHaveBeenCalledTimes(1)
  })

  it('setEnabled(false) cancels the standing age timer (no later flush)', () => {
    const onFlush = vi.fn()
    const gate = new TranscriptGate(onFlush)
    gate.setEnabled(true)

    gate.addSegment(segmentOfFormattedLength(200))
    // Disable mid-buffer (reset() runs internally, cancelling both timers).
    gate.setEnabled(false)

    vi.advanceTimersByTime(GATE_MAX_ACCUMULATION_MS * 2)
    expect(onFlush).not.toHaveBeenCalled()
  })

  it('doFlush clears the age timer: a silence flush leaves no stale timer to prematurely flush the next buffer', () => {
    const onFlush = vi.fn()
    const gate = new TranscriptGate(onFlush)
    gate.setEnabled(true)

    // Buffer #1: over-floor at t=0 → its own 60s age timer is armed (deadline t=60000).
    gate.addSegment(segmentOfFormattedLength(GATE_MIN_FLUSH_CHARS + 100, { id: 'first' }))
    // Silence + floor → flush #1 well before 60s. doFlush must clear buffer #1's age timer.
    vi.advanceTimersByTime(SILENCE_MS + 100) // t ≈ 3100
    expect(onFlush).toHaveBeenCalledTimes(1)
    expect(onFlush.mock.calls[0][1].map((s: TranscriptSegment) => s.id)).toEqual(['first'])

    // Buffer #2: a sub-floor segment at ~t=10s. Only ITS OWN age timer (deadline t≈70s)
    // can flush it — never silence (sub-floor) and never buffer #1's timer (must be dead).
    vi.advanceTimersByTime(6900) // t ≈ 10000
    gate.addSegment(segmentOfFormattedLength(200, { id: 'second' }))

    // Advance PAST buffer #1's original 60s deadline (t=60000). A stale timer left by
    // the doFlush mutant would fire here, emitting a premature crumb window from buffer #2.
    vi.advanceTimersByTime(51000) // t ≈ 61000
    expect(onFlush).toHaveBeenCalledTimes(1)

    // Advance to buffer #2's OWN 60s deadline (armed at t≈10000 → fires t≈70000).
    vi.advanceTimersByTime(9100) // t ≈ 70100
    expect(onFlush).toHaveBeenCalledTimes(2)
    // Flush #2 carries ONLY the post-flush segment — nothing from buffer #1 leaks in.
    expect(onFlush.mock.calls[1][1].map((s: TranscriptSegment) => s.id)).toEqual(['second'])
  })

  it('reset clears the age timer: a re-added post-reset buffer flushes on its own timer, not the pre-reset one', () => {
    const onFlush = vi.fn()
    const gate = new TranscriptGate(onFlush)
    gate.setEnabled(true)

    // Buffer #1: segment at t=0 → age timer armed (deadline t=60000).
    gate.addSegment(segmentOfFormattedLength(200, { id: 'pre-reset' }))

    // reset() at ~t=5s must cancel buffer #1's age timer.
    vi.advanceTimersByTime(5000) // t ≈ 5000
    gate.reset()

    // Buffer #2: a sub-floor segment at ~t=10s. Only its OWN age timer (deadline t≈70s)
    // can flush it — never silence, and never buffer #1's stale timer.
    vi.advanceTimersByTime(5000) // t ≈ 10000
    gate.addSegment(segmentOfFormattedLength(200, { id: 'post-reset' }))

    // Advance PAST buffer #1's original 60s deadline. Buffer #2 now exists, so the reset
    // mutant's stale timer would flush IT early here → onFlush must NOT have been called yet.
    vi.advanceTimersByTime(51000) // t ≈ 61000
    expect(onFlush).not.toHaveBeenCalled()

    // Advance to buffer #2's OWN 60s deadline (armed at t≈10000 → fires t≈70000).
    vi.advanceTimersByTime(9100) // t ≈ 70100
    expect(onFlush).toHaveBeenCalledTimes(1)
    // The one flush carries ONLY the post-reset segment.
    expect(onFlush.mock.calls[0][1].map((s: TranscriptSegment) => s.id)).toEqual(['post-reset'])
  })

  it('after an age flush, the next segment starts a fresh buffer with a fresh 60s timer', () => {
    const onFlush = vi.fn()
    const gate = new TranscriptGate(onFlush)
    gate.setEnabled(true)

    // First buffer flushes via the standing age timer.
    gate.addSegment(makeSegment('first note', { id: 'a' }))
    vi.advanceTimersByTime(GATE_MAX_ACCUMULATION_MS)
    expect(onFlush).toHaveBeenCalledTimes(1)
    expect(onFlush.mock.calls[0][1].map((s: TranscriptSegment) => s.id)).toEqual(['a'])

    // New segment → fresh buffer + fresh standing timer. It must NOT flush at the
    // old cadence: still nothing just under a full new window from THIS segment.
    gate.addSegment(makeSegment('second note', { id: 'b' }))
    vi.advanceTimersByTime(GATE_MAX_ACCUMULATION_MS - 100)
    expect(onFlush).toHaveBeenCalledTimes(1)

    // Cross the fresh 60s boundary → the second buffer flushes on its own timer.
    vi.advanceTimersByTime(200)
    expect(onFlush).toHaveBeenCalledTimes(2)
    expect(onFlush.mock.calls[1][1].map((s: TranscriptSegment) => s.id)).toEqual(['b'])
  })
})
