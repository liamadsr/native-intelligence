/**
 * Every microphone of a call, mixed into one mono stream on the wall clock.
 * Pure (it calls `write` with what it made; ./audio-file.ts puts that on disk).
 *
 *   - Sample n of the stream was heard at originMs + n / rate: the file's time
 *     is the call's time, so a word's place in the transcript (milliseconds
 *     from the feed session's start) is its place in the file, after the
 *     take's offset. Where nobody spoke there is silence; nothing is ever
 *     squeezed out or stretched.
 *   - Each track's frames run on from where its last one ended: a track's
 *     frames are its own clock, so 10 ms frames arriving a little early or
 *     late do not click, and a burst after a stall (the event loop busy, a
 *     garbage collection) lands where it was heard, not on top of what came
 *     after it. A muted track's frames move its clock on without sound
 *     (`skip`). Only a real gap moves a track: frames that stopped coming for
 *     more than GAP_MS (a stall that long is past the window anyway) are
 *     placed again where the wall clock says, and so is a track that stays
 *     more than LAG_MS behind it for LAG_HOLD_MS (samples lost before they
 *     reached the recorder: a burst after a stall catches up within itself,
 *     a loss never does), by moving it on: silence where the lost samples
 *     were, nothing dropped. A track running ahead of the wall clock is held
 *     to DRIFT_MS ahead. `maxDriftMs` is the furthest any track strayed from
 *     the wall clock while its frames kept coming (a real gap is not counted;
 *     logged when a take ends).
 *   - Frames are summed into a window of the last `capacityMs` and written out
 *     `latencyMs` behind the wall clock, in order, once: what arrives later
 *     than that for a stretch already written is dropped (counted in `late`).
 *     So memory is bounded by the window, whatever the call's length or its
 *     number of microphones. A stretch with no sound is not written at all
 *     (the file's holes read as silence).
 *   - Sums are clamped to 16 bits (several people at once never wrap around).
 */

/** A track this far ahead of the wall clock is held back to it. */
export const DRIFT_MS = 120
/** A track this far behind the wall clock had a real gap (its frames stopped): placed again. */
export const GAP_MS = 1_000
/** A track this far behind the wall clock for LAG_HOLD_MS lost samples: moved on to it. */
export const LAG_MS = 100
export const LAG_HOLD_MS = 1_500

export interface MixerOptions {
  sampleRate: number
  /** When sample 0 was heard (epoch ms). */
  originMs: number
  /** The first sample this mixer may write (a take taken up again goes on from where it stopped). */
  fromSample: number
  /** How far behind the wall clock it writes. */
  latencyMs: number
  /** How much it holds (at least the latency, and a margin). */
  capacityMs: number
  /** A stretch of the stream, from sample `at`. Called in order, never twice for a sample. */
  write: (at: number, pcm: Int16Array) => void
}

export class Mixer {
  private readonly rate: number
  private readonly origin: number
  private readonly latency: number
  private readonly cap: number
  private readonly sum: Int32Array
  private readonly writeOut: MixerOptions['write']
  /** Every sample before this one is written (or was before this mixer). */
  private flushed: number
  private readonly cursors = new Map<string, number>()
  /** Since when (wall ms) each track has been more than LAG_MS behind. */
  private readonly behind = new Map<string, number>()
  /** The furthest any track was from the wall clock, in ms (either way). */
  maxDriftMs = 0
  /** Samples dropped for arriving after their stretch was written. */
  late = 0
  /** Whether any stretch with sound was written. */
  voiced = false

  constructor(opts: MixerOptions) {
    this.rate = opts.sampleRate
    this.origin = opts.originMs
    this.latency = Math.round((opts.latencyMs * opts.sampleRate) / 1000)
    this.cap = Math.max(this.latency * 2, Math.round((opts.capacityMs * opts.sampleRate) / 1000))
    this.sum = new Int32Array(this.cap)
    this.writeOut = opts.write
    this.flushed = Math.max(0, Math.floor(opts.fromSample))
  }

  /** The sample heard at this wall-clock time. */
  sampleAt(wallMs: number): number {
    return Math.floor(((wallMs - this.origin) * this.rate) / 1000)
  }

  /** The samples written so far (the stream's length once finished). */
  get length(): number {
    return this.flushed
  }

  /** Where a track's next `n` samples go, its last heard at `endWallMs`; its clock moved past them. */
  private place(key: string, n: number, endWallMs: number): number {
    const expected = this.sampleAt(endWallMs) - n
    const ms = (samples: number) => (samples * 1000) / this.rate
    let start = this.cursors.get(key)
    // Drift is how far a track's own clock strays while its frames keep coming: a real gap (frames
    // that stopped for over GAP_MS, someone's network gone) is not drift and is left out.
    if (start !== undefined && ms(expected - start) <= GAP_MS) this.maxDriftMs = Math.max(this.maxDriftMs, Math.abs(ms(expected - start)))
    const lagging = start !== undefined && ms(expected - start) > LAG_MS
    if (!lagging) this.behind.delete(key)
    else if (!this.behind.has(key)) this.behind.set(key, endWallMs)
    if (start === undefined || ms(expected - start) > GAP_MS || (lagging && endWallMs - this.behind.get(key)! >= LAG_HOLD_MS)) {
      start = expected
      this.behind.delete(key)
    } else if (ms(start - expected) > DRIFT_MS) start = expected + Math.round((DRIFT_MS * this.rate) / 1000)
    this.cursors.set(key, start + n)
    return start
  }

  /** A frame of a track that adds no sound (it is muted): its clock moves on, so its next sound lands in place. */
  skip(key: string, samples: number, endWallMs: number): void {
    if (samples > 0) this.place(key, samples, endWallMs)
  }

  /** One frame of one track, whose last sample was heard at `endWallMs`. */
  push(key: string, pcm: Int16Array, endWallMs: number): void {
    const n = pcm.length
    if (n === 0) return
    const start = this.place(key, n, endWallMs)
    // Ahead of the window (a frame stamped far in the future): what is held goes out first.
    if (start + n > this.flushed + this.cap) this.flushTo(start + n - this.cap)
    let from = 0
    if (start < this.flushed) {
      from = Math.min(n, this.flushed - start)
      this.late += from
    }
    for (let i = from; i < n; i++) {
      const at = start + i
      this.sum[at % this.cap] += pcm[i]
    }
  }

  /** A track ended: its next frame (a new track) is placed afresh. */
  forget(key: string): void {
    this.cursors.delete(key)
    this.behind.delete(key)
  }

  /** Write out what is `latencyMs` old by now. */
  drain(nowMs: number): void {
    this.flushTo(this.sampleAt(nowMs) - this.latency)
  }

  /** Write out everything up to now (the take stops). Returns the stream's length in samples. */
  finish(nowMs: number): number {
    this.flushTo(this.sampleAt(nowMs))
    return this.flushed
  }

  private flushTo(to: number): void {
    // Never more than the window holds at once.
    while (to > this.flushed) {
      const end = Math.min(to, this.flushed + this.cap)
      const out = new Int16Array(end - this.flushed)
      let any = false
      for (let at = this.flushed, j = 0; at < end; at++, j++) {
        const k = at % this.cap
        const v = this.sum[k]
        this.sum[k] = 0
        if (v !== 0) {
          any = true
          out[j] = v > 32767 ? 32767 : v < -32768 ? -32768 : v
        }
      }
      if (any) {
        this.voiced = true
        this.writeOut(this.flushed, out)
      }
      this.flushed = end
    }
  }
}
