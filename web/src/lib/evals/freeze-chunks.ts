/**
 * Frozen flush windows — the replay's chunk boundaries, computed ONCE at
 * authoring time from a script's own `t_ms` values (spec decision 1).
 *
 * WHY THIS EXISTS RATHER THAN A CLOCK-INJECTED GATE: the real
 * {@link import('@/lib/live-agent/transcript-gate').TranscriptGate} measures
 * WALL-CLOCK silence — four `Date.now()` reads and two `setTimeout`s. It never
 * looks at a segment's own timestamp, so feeding it a script as fast as the
 * loop can go collapses the whole meeting into one end-of-call flush, and
 * feeding it in real time means a 19-minute case takes 19 minutes. Teaching the
 * gate about a virtual clock would mean editing the file that governs every
 * real meeting. So this is a pure reimplementation of its three rules over the
 * script's timeline instead: nothing in production changes, the boundaries are
 * identical at every replay speed, and the equivalence is provable — the test
 * drives the REAL gate under fake timers over the same segments and asserts the
 * same windows come out.
 *
 * THE THREE RULES, in the gate's own order:
 *
 *   1. SILENCE + FLOOR. When both streams have been quiet for `SILENCE_MS`, the
 *      buffer flushes — but only once its formatted length clears
 *      `GATE_MIN_FLUSH_CHARS`. Below the floor it keeps accumulating, because a
 *      rapid back-and-forth pauses every few seconds and a pure silence gate
 *      emits crumb windows that starve extraction.
 *   2. AGE CEILING. A non-empty buffer flushes at most
 *      `GATE_MAX_ACCUMULATION_MS` after its FIRST segment, whatever the floor
 *      says. On a continuous call the silence check never fires, so without
 *      this the buffer would grow until capture stop.
 *   3. STOP. The final buffer always flushes, floor and ceiling bypassed.
 *
 * All three tuning constants — `SILENCE_MS`, `GATE_MIN_FLUSH_CHARS` and
 * `GATE_MAX_ACCUMULATION_MS` — are imported from the gate itself, so a tuning
 * change there moves these boundaries too and the two can never drift.
 */
import {
  GATE_MAX_ACCUMULATION_MS,
  GATE_MIN_FLUSH_CHARS,
  SILENCE_MS,
} from '@/lib/live-agent/transcript-gate'
import type { FrozenChunk, ScriptSegment } from './types'

/**
 * Silence required on BOTH streams before a flush is considered — re-exported
 * from the gate under this module's own name so callers that reason about
 * frozen windows have one import, and so there is exactly ONE definition of the
 * number. The equivalence test drives the real gate over the same script and
 * asserts identical boundaries, which is what proves the reimplementation below
 * still matches after any tuning change.
 */
export const FREEZE_SILENCE_MS = SILENCE_MS

/** The exact `[speaker]: text` join the gate's `doFlush` emits, so the floor
 *  check here measures what extraction actually sees — and so the stored
 *  `chunk.text` is byte-identical to what a real meeting would have produced. */
function formatSegments(segments: ScriptSegment[]): string {
  return segments
    .map((s) => `[${s.speaker || 'unknown'}]: ${s.text}`)
    .join('\n')
}

/**
 * Compute the flush windows a script would have produced on a real call.
 *
 * Segments are sorted by `t_ms` first: an author writing a script by hand may
 * interleave two speakers out of order, and the gate only ever sees segments in
 * arrival order.
 *
 * @returns one {@link FrozenChunk} per flush, in order, covering every segment
 *          exactly once. An empty script yields no chunks.
 */
export function freezeChunks(script: ScriptSegment[]): FrozenChunk[] {
  const indexed = script
    .map((segment, index) => ({ segment, index }))
    .sort((a, b) => a.segment.t_ms - b.segment.t_ms || a.index - b.index)

  const chunks: FrozenChunk[] = []
  // The current buffer, as (segment, original script index) pairs.
  let buffer: { segment: ScriptSegment; index: number }[] = []
  // `t_ms` of the first segment in the current buffer — the age ceiling's clock.
  let firstAt = 0
  // Last activity per stream, mirroring the gate's two counters. `0` = the
  // stream has produced nothing yet, which the gate treats as "silent".
  let lastMicAt = 0
  let lastSystemAt = 0

  const flush = (atMs: number) => {
    if (buffer.length === 0) return
    const segments = buffer.map((b) => b.segment)
    chunks.push({
      index: chunks.length,
      t_ms_start: firstAt,
      t_ms_end: atMs,
      segment_indices: buffer.map((b) => b.index),
      text: formatSegments(segments),
    })
    buffer = []
    firstAt = 0
  }

  for (const entry of indexed) {
    const { segment } = entry
    const now = segment.t_ms

    // Rule 1, evaluated at this segment's arrival: the gate's silence timer
    // would have fired somewhere in the gap since the previous segment. It
    // fires at `lastActivity + SILENCE_MS`, so the flush is stamped there
    // rather than here — the window ends when the room went quiet, not when
    // the next person started talking.
    if (buffer.length > 0) {
      const lastActivity = Math.max(lastMicAt, lastSystemAt)
      const silenceAt = lastActivity + FREEZE_SILENCE_MS
      // Rule 2 races rule 1: whichever deadline comes first inside this gap
      // wins, and the age ceiling ignores the floor entirely.
      const ageAt = firstAt + GATE_MAX_ACCUMULATION_MS
      if (ageAt <= now && ageAt <= silenceAt) {
        flush(ageAt)
      } else if (
        silenceAt <= now &&
        formatSegments(buffer.map((b) => b.segment)).length >= GATE_MIN_FLUSH_CHARS
      ) {
        flush(silenceAt)
      } else if (ageAt <= now) {
        // The age ceiling fell inside the gap but AFTER the silence deadline
        // that the floor blocked. It still fires — aging is not the floor's
        // business.
        flush(ageAt)
      }
    }

    if (buffer.length === 0) firstAt = now
    buffer.push(entry)
    if (segment.stream === 'mic') lastMicAt = now
    else lastSystemAt = now
  }

  // Rule 3: whatever is left at capture stop flushes, floor and ceiling
  // bypassed. Stamped at the last segment's own time — a script has no "stop"
  // event of its own, and the driver replays to the end of the transcript.
  if (buffer.length > 0) {
    flush(buffer[buffer.length - 1].segment.t_ms)
  }

  return chunks
}
