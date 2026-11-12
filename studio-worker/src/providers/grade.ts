/**
 * Matching generated shots to the real footage. Frame statistics (per-channel
 * mean and spread, brightness, warmth, and how much brighter the left half is
 * than the right: a stand-in for light direction) come from a few small
 * frames. gradeToward() makes a graded copy of a clip whose colour moves most
 * of the way toward a reference recording; continuityIssues() compares
 * neighbouring beats and names what doesn't match.
 */
import type { ContinuityIssue } from '../../../web/src/lib/studio/server/provider-contract.ts'
import { mediaTimeout, run, runBuffer } from '../media.ts'

export type FrameStats = { mean: [number, number, number]; std: [number, number, number]; luma: number; warmth: number; leftRight: number }

/** Stats of raw RGB frames (0–1). Pure. */
export function statsOf(frames: Buffer[], width: number): FrameStats {
  const sum: [number, number, number] = [0, 0, 0]
  const sq: [number, number, number] = [0, 0, 0]
  let n = 0
  let left = 0
  let right = 0
  let ln = 0
  let rn = 0
  for (const buf of frames) {
    for (let i = 0; i + 2 < buf.length; i += 3) {
      const r = buf[i]! / 255
      const g = buf[i + 1]! / 255
      const b = buf[i + 2]! / 255
      const x = (i / 3) % width
      const y = 0.2126 * r + 0.7152 * g + 0.0722 * b
      sum[0] += r
      sum[1] += g
      sum[2] += b
      sq[0] += r * r
      sq[1] += g * g
      sq[2] += b * b
      n++
      if (x < width / 2) {
        left += y
        ln++
      } else {
        right += y
        rn++
      }
    }
  }
  const mean = sum.map((v) => v / Math.max(1, n)) as [number, number, number]
  const std = sq.map((v, k) => Math.sqrt(Math.max(0, v / Math.max(1, n) - mean[k]! ** 2))) as [number, number, number]
  const r3 = (v: number) => Math.round(v * 1000) / 1000
  return {
    mean: mean.map(r3) as [number, number, number],
    std: std.map(r3) as [number, number, number],
    luma: r3(0.2126 * mean[0] + 0.7152 * mean[1] + 0.0722 * mean[2]),
    warmth: r3(mean[0] - mean[2]),
    leftRight: r3(left / Math.max(1, ln) - right / Math.max(1, rn)),
  }
}

const W = 64
const H = 36

/** Stats of a file at these seconds (a 64×36 frame each). */
export async function frameStats(file: string, seconds: number[], signal?: AbortSignal): Promise<FrameStats> {
  const frames: Buffer[] = []
  for (const t of seconds) {
    const out = await runBuffer('ffmpeg', ['-nostdin', '-v', 'error', '-ss', String(Math.max(0, t)), '-i', file, '-frames:v', '1', '-vf', `scale=${W}:${H}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1024 * 1024, timeout: 60_000, signal })
    if (out.length >= W * H * 3) frames.push(out)
  }
  if (!frames.length) throw new Error('Could not read frames to measure')
  return statsOf(frames, W)
}

/** Three moments across a stretch (20%, 50%, 80%). Pure. */
export const spread = (from: number, to: number) => [0.2, 0.5, 0.8].map((p) => from + (to - from) * p)

/** Per-channel map from a clip's colour toward a reference's (strength 0–1), as an ffmpeg lutrgb expression. Pure. */
export function gradeFilter(src: FrameStats, ref: FrameStats, strength = 0.65): string {
  const ch = ['r', 'g', 'b'] as const
  return (
    'lutrgb=' +
    ch
      .map((c, k) => {
        const gain = 1 + (ref.std[k]! / Math.max(0.02, src.std[k]!) - 1) * strength
        const target = src.mean[k]! + (ref.mean[k]! - src.mean[k]!) * strength
        return `${c}='clip((val/255-${src.mean[k]!.toFixed(4)})*${Math.max(0.6, Math.min(1.6, gain)).toFixed(4)}*255+${(target * 255).toFixed(2)},0,255)'`
      })
      .join(':')
  )
}

/** A graded copy of `clip` at `out`, its colour moved toward `reference`'s. Answers what was measured. */
export async function gradeToward(
  clip: { file: string; seconds: number },
  reference: { file: string; seconds: number },
  out: string,
  opts: { strength?: number; signal?: AbortSignal } = {},
): Promise<{ before: FrameStats; reference: FrameStats; strength: number }> {
  const strength = opts.strength ?? 0.65
  const src = await frameStats(clip.file, spread(0, clip.seconds), opts.signal)
  const ref = await frameStats(reference.file, spread(0, reference.seconds), opts.signal)
  await run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-i', clip.file, '-vf', gradeFilter(src, ref, strength), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'copy', out], {
    timeout: mediaTimeout(clip.seconds, 10),
    signal: opts.signal,
  })
  return { before: src, reference: ref, strength }
}

/** Compare each generated beat with the recorded beat it cuts to or from. Pure. */
export function continuityIssues(pairs: { beat: string; against: string; a: FrameStats; b: FrameStats }[]): ContinuityIssue[] {
  const out: ContinuityIssue[] = []
  for (const { beat, against, a, b } of pairs) {
    if (Math.abs(a.luma - b.luma) > 0.12) out.push({ beat, against, what: 'brightness', detail: `${a.luma > b.luma ? 'brighter' : 'darker'} by ${Math.round(Math.abs(a.luma - b.luma) * 100)}%` })
    if (Math.abs(a.warmth - b.warmth) > 0.08) out.push({ beat, against, what: 'colour', detail: `${a.warmth > b.warmth ? 'warmer' : 'cooler'} than the next shot` })
    if (Math.sign(a.leftRight) !== Math.sign(b.leftRight) && Math.abs(a.leftRight) > 0.04 && Math.abs(b.leftRight) > 0.04) {
      out.push({ beat, against, what: 'light direction', detail: `light comes from the ${a.leftRight > 0 ? 'left' : 'right'}, but from the ${b.leftRight > 0 ? 'left' : 'right'} in the other shot` })
    }
  }
  return out
}
