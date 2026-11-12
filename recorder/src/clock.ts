/**
 * When something Deepgram heard was said. Deepgram's times are seconds of
 * the audio it was sent on one socket; the audio sent is not the call's time
 * (nothing is sent while a microphone is muted, a socket that dropped is
 * opened again, its unheard audio sent once more). So each socket keeps the
 * wall-clock time of every stretch it sent: an audio time maps to the moment
 * that audio was heard in the call, whatever was skipped between. Pure.
 */

interface Anchor {
  /** Milliseconds of audio sent on this socket before this stretch. */
  audioMs: number
  /** When this stretch was heard (epoch ms). */
  wallMs: number
  /** How long it is. */
  durationMs: number
}

/** A stretch that starts within this of where the last one ended is the same stretch (frames are 10 ms apart, and a little late). */
const CONTIGUOUS_MS = 30

export class AudioClock {
  private anchors: Anchor[] = []
  private sentMs = 0

  /** Milliseconds of audio sent on this socket so far. */
  get audioMs(): number {
    return this.sentMs
  }

  /** `durationMs` of audio heard at `wallMs` was sent. */
  sent(wallMs: number, durationMs: number): void {
    const last = this.anchors[this.anchors.length - 1]
    if (last && Math.abs(wallMs - (last.wallMs + last.durationMs)) <= CONTIGUOUS_MS) {
      last.durationMs += durationMs
    } else {
      this.anchors.push({ audioMs: this.sentMs, wallMs, durationMs })
    }
    this.sentMs += durationMs
  }

  /** When the audio at `audioMs` on this socket was heard (epoch ms); null before anything was sent. */
  wallAt(audioMs: number): number | null {
    if (this.anchors.length === 0) return null
    let lo = 0
    let hi = this.anchors.length - 1
    // The last anchor that starts at or before audioMs.
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (this.anchors[mid].audioMs <= audioMs) lo = mid
      else hi = mid - 1
    }
    const a = this.anchors[lo]
    const into = Math.max(0, audioMs - a.audioMs)
    return a.wallMs + Math.min(into, a.durationMs)
  }

  /** Anchors wholly before `audioMs` are no longer needed (Deepgram has said everything before it). */
  forgetBefore(audioMs: number): void {
    while (this.anchors.length > 1 && this.anchors[1].audioMs <= audioMs) this.anchors.shift()
  }

  /** How many stretches it holds (a test's look). */
  get size(): number {
    return this.anchors.length
  }
}
