/**
 * The ringtone of an incoming call: a soft two-note chime every few
 * seconds, made with Web Audio. Every chime of the ring is scheduled on the
 * audio clock when it starts (no timer, no loop: the page does nothing while
 * it rings), and the ring's length bounds it. Stopping closes the context,
 * which ends them all at once and lets go of the audio device.
 *
 * Its own context, not the UI sounds' (src/lib/sounds/engine.ts): a call
 * rings even with sound effects off. A browser that keeps audio locked until
 * the page has had a click (only on a page the person hasn't touched yet)
 * stays silent; the card and the desktop banner still show.
 */

/** Seconds between chimes, and the notes of one (Hz, start offset, length). */
export const RINGTONE_PERIOD_S = 3
export const RINGTONE_NOTES: ReadonlyArray<{ hz: number; at: number; len: number }> = [
  { hz: 784, at: 0, len: 0.42 },
  { hz: 659.25, at: 0.24, len: 0.6 },
  { hz: 784, at: 1.0, len: 0.42 },
  { hz: 659.25, at: 1.24, len: 0.6 },
]

/** When each chime starts (s from now), for a ring of `seconds`. */
export function chimeStarts(seconds: number): number[] {
  const out: number[] = []
  for (let t = 0; t < seconds; t += RINGTONE_PERIOD_S) out.push(t)
  return out
}

type AudioContextCtor = new () => AudioContext

function audioContextCtor(): AudioContextCtor | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor }
  return w.AudioContext ?? w.webkitAudioContext ?? null
}

/** Ring for `seconds` (at most). Returns stop; never throws. */
export function startRingtone(seconds: number, ctor: AudioContextCtor | null = audioContextCtor()): () => void {
  if (!ctor) return () => {}
  let ctx: AudioContext
  try {
    ctx = new ctor()
  } catch {
    return () => {}
  }
  try {
    void ctx.resume?.().catch(() => undefined)
    const master = ctx.createGain()
    master.gain.value = 0.18
    master.connect(ctx.destination)
    const t0 = ctx.currentTime + 0.05
    for (const start of chimeStarts(seconds)) {
      for (const note of RINGTONE_NOTES) {
        const at = t0 + start + note.at
        const osc = ctx.createOscillator()
        const env = ctx.createGain()
        osc.type = 'sine'
        osc.frequency.value = note.hz
        env.gain.setValueAtTime(0.0001, at)
        env.gain.exponentialRampToValueAtTime(1, at + 0.015)
        env.gain.exponentialRampToValueAtTime(0.0001, at + note.len)
        osc.connect(env)
        env.connect(master)
        osc.start(at)
        osc.stop(at + note.len + 0.02)
      }
    }
  } catch {
    // A context that can't schedule: silent.
  }
  let stopped = false
  return () => {
    if (stopped) return
    stopped = true
    void ctx.close?.().catch(() => undefined)
  }
}
