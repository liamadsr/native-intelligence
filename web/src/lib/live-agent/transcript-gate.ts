/**
 * Transcript Gate — accumulates transcript segments and flushes them
 * to a callback when both audio streams have been silent for SILENCE_MS.
 *
 * Tracks the last final segment time per stream (mic / system).
 * After each segment, schedules a check — if both streams have had no
 * new segments for 3 seconds, the accumulated text is flushed.
 *
 * SIZE FLOOR (GATE_MIN_FLUSH_CHARS): silence alone is not enough to flush.
 * A rapid back-and-forth meeting pauses briefly every few seconds, so a
 * pure silence gate emits tiny "crumb" windows (hundreds of chars) many
 * times a minute. The downstream extraction contract is "extract from THIS
 * window", so crumb windows correctly yield nothing — starving extraction
 * (prod capture b9abb272: ~2 items in 40 min vs. a healthy 17–69). We now
 * only flush on silence once the buffer clears the floor, so each window
 * carries enough conversational arc to extract from.
 *
 * STANDING AGE TIMER (GATE_MAX_ACCUMULATION_MS): the silence check only runs
 * between segments, so on a CONTINUOUS call (interims every ~100-300ms, never
 * 3s of dual silence) it never fires and the buffer would grow unbounded until
 * capture stop. A standing timer, armed when the first final segment enters an
 * empty buffer, guarantees a non-empty buffer flushes at most
 * GATE_MAX_ACCUMULATION_MS after its first segment — even under nonstop speech —
 * so mid-call extraction turns keep firing. The explicit flush() at capture
 * stop always bypasses both the floor and the timer.
 */

import type { TranscriptSegment } from '@/lib/deepgram-stream'

export const SILENCE_MS = 3000 // 3 seconds of silence on BOTH streams before flushing

/** Minimum formatted length (the same `[speaker]: text` join doFlush emits)
 *  before a silence-triggered flush is allowed. Below this, the buffer keeps
 *  accumulating so extraction sees a substantive window, not a crumb. */
export const GATE_MIN_FLUSH_CHARS = 1200
/** Hard ceiling on how long a non-empty buffer may sit unflushed, enforced by a
 *  standing timer (not the silence check). A non-empty buffer flushes at most
 *  this long after its first segment even during continuous speech, so mid-call
 *  extraction keeps firing and content is never stranded. */
export const GATE_MAX_ACCUMULATION_MS = 60_000

export type OnFlushCallback = (text: string, segments: TranscriptSegment[]) => void

export class TranscriptGate {
  private accumulatedSegments: TranscriptSegment[] = []
  private lastMicSegmentAt = 0
  private lastSystemSegmentAt = 0
  // Timestamp of the first segment in the CURRENT buffer (0 = empty buffer).
  // Cleared on flush/reset.
  private firstAccumulatedAt = 0
  private checkTimer: ReturnType<typeof setTimeout> | null = null
  // Standing GATE_MAX_ACCUMULATION_MS timer, armed when the first final segment
  // enters an empty buffer and cleared whenever the buffer empties. Guarantees a
  // flush even under continuous speech, where the silence check never fires.
  private ageTimer: ReturnType<typeof setTimeout> | null = null
  private onFlush: OnFlushCallback
  private enabled = false

  constructor(onFlush: OnFlushCallback) {
    this.onFlush = onFlush
  }

  /** Enable/disable the gate (disabled = transcripts are not accumulated) */
  setEnabled(enabled: boolean) {
    this.enabled = enabled
    if (!enabled) {
      this.reset()
    }
  }

  /** Call this for every transcript segment (interim or final) from Deepgram */
  addSegment(segment: TranscriptSegment) {
    if (!this.enabled) return

    // Update last activity time for this stream (interim OR final = someone is talking)
    const now = Date.now()
    if (segment.stream === 'mic') {
      this.lastMicSegmentAt = now
    } else {
      this.lastSystemSegmentAt = now
    }

    // Only accumulate final segments for the flush content
    if (segment.isFinal) {
      if (this.accumulatedSegments.length === 0) {
        this.firstAccumulatedAt = now
        // First segment into an empty buffer: arm the standing age timer so the
        // buffer flushes at most GATE_MAX_ACCUMULATION_MS from here, regardless of
        // silence — the silence check never fires during continuous speech.
        this.ageTimer = setTimeout(() => {
          this.ageTimer = null
          this.doFlush()
        }, GATE_MAX_ACCUMULATION_MS)
      }
      this.accumulatedSegments.push(segment)
    }

    // Schedule a silence check
    this.scheduleCheck()
  }

  /** VAD events are no longer used — kept for API compatibility */
  handleVadEvent() {}

  /** Is any final transcript waiting in the buffer? (live-agent messaging L3:
   *  a record turn flushes it as a window rather than sending no new text.) */
  hasPending(): boolean {
    return this.accumulatedSegments.length > 0
  }

  /** Force flush any accumulated text (e.g., when capture ends). BYPASSES the
   *  size floor — at stop we want whatever exists, however small. */
  flush() {
    this.clearCheck()
    this.doFlush()
  }

  /** Reset all state */
  reset() {
    this.accumulatedSegments = []
    this.lastMicSegmentAt = 0
    this.lastSystemSegmentAt = 0
    this.firstAccumulatedAt = 0
    this.clearCheck()
    this.clearAgeTimer()
  }

  private scheduleCheck() {
    this.clearCheck()

    // Find the most recent segment time across both streams
    const lastActivity = Math.max(this.lastMicSegmentAt, this.lastSystemSegmentAt)
    const elapsed = Date.now() - lastActivity
    const remaining = SILENCE_MS - elapsed

    if (remaining <= 0) {
      // Already been silent long enough on both — check now
      this.checkAndFlush()
    } else {
      // Check again when the silence window expires
      this.checkTimer = setTimeout(() => {
        this.checkTimer = null
        this.checkAndFlush()
      }, remaining + 50) // small buffer to avoid race
    }
  }

  private checkAndFlush() {
    if (this.accumulatedSegments.length === 0) return

    const now = Date.now()
    // Only check silence on streams that have actually produced segments
    const micActive = this.lastMicSegmentAt > 0
    const sysActive = this.lastSystemSegmentAt > 0
    const micAge = micActive ? now - this.lastMicSegmentAt : -1
    const sysAge = sysActive ? now - this.lastSystemSegmentAt : -1
    const micSilent = !micActive || micAge >= SILENCE_MS
    const systemSilent = !sysActive || sysAge >= SILENCE_MS

    if (micSilent && systemSilent) {
      // Both streams are quiet, but silence alone no longer flushes: hold the
      // buffer until it clears the floor. Without the floor, a rapid-exchange
      // meeting emits crumb windows every few seconds that starve extraction
      // (see file header). A sub-floor buffer that never resumes still flushes
      // when the standing age timer fires — aging is not this check's job.
      if (this.formattedLength() >= GATE_MIN_FLUSH_CHARS) {
        this.doFlush()
      }
    } else {
      // One stream is still active — check again later
      this.scheduleCheck()
    }
  }

  /** Formatted length of the current buffer — the exact `[speaker]: text` join
   *  doFlush emits, so the floor check measures what extraction actually sees.
   *  Segment counts per window are small, so recomputing on each check is cheap. */
  private formattedLength(): number {
    return this.formatSegments(this.accumulatedSegments).length
  }

  private formatSegments(segments: TranscriptSegment[]): string {
    return segments
      .map((s) => {
        const speaker = s.speaker || 'unknown'
        return `[${speaker}]: ${s.text}`
      })
      .join('\n')
  }

  private doFlush() {
    if (this.accumulatedSegments.length === 0) return

    const segments = [...this.accumulatedSegments]
    const text = this.formatSegments(segments)

    // Buffer empties here — cancel the standing age timer so a flush triggered by
    // silence/floor/stop doesn't leave a stale timer firing on the next buffer.
    this.clearAgeTimer()
    this.accumulatedSegments = []
    this.firstAccumulatedAt = 0
    this.onFlush(text, segments)
  }

  private clearCheck() {
    if (this.checkTimer) {
      clearTimeout(this.checkTimer)
      this.checkTimer = null
    }
  }

  private clearAgeTimer() {
    if (this.ageTimer) {
      clearTimeout(this.ageTimer)
      this.ageTimer = null
    }
  }
}
