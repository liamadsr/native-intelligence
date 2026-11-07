/**
 * Frozen chunks must be what the REAL gate would have produced.
 *
 * The whole design of the replay rests on this equivalence (spec decision 1):
 * if `freezeChunks` drifts from `TranscriptGate`, every eval measures a chunk
 * cadence no real meeting ever has, and the number on the screen stops meaning
 * anything. So the assertion is not "the boundaries look sensible" — it is
 * "drive the actual gate over the actual segments under a fake clock and get
 * the same windows out", for three scripts that exercise all three rules:
 *
 *   - crumbs: short turns with long silences, which the size floor holds
 *   - continuous: nonstop speech that only the 60s age ceiling can break
 *   - alternating: normal two-speaker cadence with real pauses
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import type { TranscriptSegment } from '@/lib/deepgram-stream'
import { TranscriptGate } from '@/lib/live-agent/transcript-gate'
import { freezeChunks } from '../freeze-chunks'
import type { ScriptSegment } from '../types'

/**
 * Run a script through the real gate on a fake clock, advancing time by each
 * segment's own `t_ms` delta exactly as a real call would have, then force the
 * end-of-capture flush.
 *
 * The gate reads `Date.now()`, so the clock has to move for real — advancing
 * timers alone would leave every silence check computing a zero-length gap.
 */
async function realGateFlushes(script: ScriptSegment[]): Promise<string[]> {
  const flushes: string[] = []
  const gate = new TranscriptGate((text) => {
    flushes.push(text)
  })
  gate.setEnabled(true)

  const base = 1_700_000_000_000
  vi.setSystemTime(base)
  let cursor = 0

  for (const s of script) {
    // Advance to this segment's moment, letting every timer that would have
    // fired in between actually fire.
    await vi.advanceTimersByTimeAsync(s.t_ms - cursor)
    cursor = s.t_ms
    const segment: TranscriptSegment = {
      id: `${s.t_ms}-${s.speaker}`,
      text: s.text,
      stream: s.stream,
      speaker: s.speaker,
      startTime: s.t_ms / 1000,
      endTime: s.t_ms / 1000,
      isFinal: true,
      // The gate never reads word-level detail; the field is required by the
      // Deepgram shape, so an empty list is the honest fixture.
      words: [],
    }
    gate.addSegment(segment)
  }

  // Capture stop: whatever is left flushes, floor bypassed.
  gate.flush()
  return flushes
}

/** A line of the script. `chars` pads the text to a length, so a test can put
 *  a buffer over or under the 1,200-char floor deliberately. */
function line(
  t_ms: number,
  stream: 'mic' | 'system',
  speaker: string,
  text: string,
  chars?: number,
): ScriptSegment {
  return {
    t_ms,
    stream,
    speaker,
    text: chars ? text + ' filler'.repeat(Math.ceil(chars / 7)).slice(0, chars) : text,
  }
}

/** Short turns separated by long silences, every buffer well under the floor:
 *  the silence rule alone never flushes, so everything lands in ONE window at
 *  capture stop. This is the crumb starvation the floor exists to prevent. */
const CRUMBS: ScriptSegment[] = [
  line(0, 'mic', 'local_1', 'Hey.'),
  line(9_000, 'system', 'remote_1', 'Hi there.'),
  line(20_000, 'mic', 'local_1', 'One second.'),
  line(34_000, 'system', 'remote_1', 'Sure.'),
]

/** Nonstop speech: a segment every 800ms for 100 seconds, so both streams are
 *  never quiet for 3s and only the 60s age ceiling can break the buffer. */
const CONTINUOUS: ScriptSegment[] = Array.from({ length: 125 }, (_, i) =>
  line(i * 800, i % 2 === 0 ? 'mic' : 'system', i % 2 === 0 ? 'local_1' : 'remote_1',
    `Turn ${i} of the continuous stretch, spoken without a pause anywhere near three seconds.`),
)

/** Normal alternation: substantial turns that clear the floor, separated by
 *  realistic 4-second gaps — the cadence a `/create-eval` script should have. */
const ALTERNATING: ScriptSegment[] = [
  line(0, 'system', 'remote_1', 'Thanks for making time today, I want to walk through the renewal.', 700),
  line(12_000, 'mic', 'local_1', 'Happy to. Where did you land on the security questionnaire?', 700),
  line(24_000, 'system', 'remote_1', 'Still with our team, but the pricing is the real sticking point.', 700),
  line(40_000, 'mic', 'local_1', 'Let me pull the numbers and send them over this afternoon.', 700),
  line(58_000, 'system', 'remote_1', 'That works. We will regroup on Thursday with procurement.', 700),
]

afterEach(() => {
  vi.useRealTimers()
})

describe('freezeChunks matches the real TranscriptGate', () => {
  const scripts: [string, ScriptSegment[]][] = [
    ['short crumbs held by the size floor', CRUMBS],
    ['continuous speech hitting the 60s ceiling', CONTINUOUS],
    ['normal alternation with real pauses', ALTERNATING],
  ]

  for (const [name, script] of scripts) {
    it(`produces the same flush windows: ${name}`, async () => {
      vi.useFakeTimers()
      const real = await realGateFlushes(script)
      vi.useRealTimers()

      const frozen = freezeChunks(script)
      expect(frozen.map((c) => c.text)).toEqual(real)
    })
  }
})

describe('freezeChunks shape', () => {
  it('returns no chunks for an empty script', () => {
    expect(freezeChunks([])).toEqual([])
  })

  it('covers every segment exactly once, in order', () => {
    const chunks = freezeChunks(ALTERNATING)
    const covered = chunks.flatMap((c) => c.segment_indices)
    expect(covered).toEqual(ALTERNATING.map((_, i) => i))
  })

  it('indexes chunks from zero and never moves time backwards', () => {
    const chunks = freezeChunks(CONTINUOUS)
    expect(chunks.length).toBeGreaterThan(1)
    chunks.forEach((c, i) => {
      expect(c.index).toBe(i)
      expect(c.t_ms_end).toBeGreaterThanOrEqual(c.t_ms_start)
      if (i > 0) expect(c.t_ms_start).toBeGreaterThanOrEqual(chunks[i - 1].t_ms_start)
    })
  })

  it('sorts an out-of-order script before chunking, the way the gate sees arrivals', () => {
    const shuffled = [ALTERNATING[2], ALTERNATING[0], ALTERNATING[3], ALTERNATING[1], ALTERNATING[4]]
    const fromShuffled = freezeChunks(shuffled)
    const fromOrdered = freezeChunks(ALTERNATING)
    expect(fromShuffled.map((c) => c.text)).toEqual(fromOrdered.map((c) => c.text))
  })

  it("chunk.text is the gate's own `[speaker]: text` join", () => {
    const [chunk] = freezeChunks([
      { t_ms: 0, stream: 'mic', speaker: 'local_1', text: 'One.' },
      { t_ms: 500, stream: 'system', speaker: 'remote_1', text: 'Two.' },
    ])
    expect(chunk.text).toBe('[local_1]: One.\n[remote_1]: Two.')
  })
})
