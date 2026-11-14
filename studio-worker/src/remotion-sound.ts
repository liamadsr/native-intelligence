/**
 * Remotion's own mix of a video's sound without Remotion's FFmpeg (its compositor package, a GPL build the desktop app
 * does not carry). While renderFrames draws frames, Remotion writes each sound layer's samples, as Chrome decoded them
 * (@remotion/media's inline audio), into a 16-bit stereo WAV of its own, in JavaScript: one file per layer, each
 * frame's piece at floor(frame / fps × 48000) of it, a later piece overwriting an earlier one. renderMedia then merges
 * those files with FFmpeg (merge-inline-audio-tracks.js, @remotion/renderer 4.0.534): the layers in order of their
 * start, ten at a time, each ten mixed by `amix` without normalising (a sum) into 16 bits (clipped), the results ten at
 * a time again until one is left, then padded with silence to the video's length (as long as the furthest piece when
 * that is longer). mergeInline does exactly that here, in blocks, from the files renderFrames left.
 *
 * Proven equal, sample for sample, to renderMedia's own WAV of the same frames (test/compositor-free-e2e.ts).
 *
 * Remotion's other audio (a media file it extracts with FFmpeg: `<Audio>`/`<Video>` from `remotion` itself, not
 * @remotion/media) needs its FFmpeg: assetsInfo lists such assets, and soundOf refuses them (NEEDS_COMPOSITOR).
 */
import { open, rm } from 'node:fs/promises'

const SAMPLE_RATE = 48000
const MAX_INPUTS = 10
const BLOCK = SAMPLE_RATE * 10

/** A layer's file as renderFrames left it: samples from `start` (relative to the first frame rendered), `duration` long. */
export interface InlineTrack { file: string; start: number; duration: number }

/** The sound needs Remotion's FFmpeg (a kind of audio it extracts itself). */
export class NeedsCompositor extends Error {
  readonly code = 'NEEDS_COMPOSITOR'
}

/** What renderFrames hands back (assetsInfo), as far as the sound goes. */
export interface AssetsInfo {
  assets?: unknown[]
  downloadMap?: {
    inlineAudioMixing?: { getListOfAssets(): { outName: string; startInSamples: number; durationInSamples: number }[]; cleanup(): void }
    downloadDir?: string; complexFilter?: string; compositingDir?: string; assetDir?: string
    cleanupController?: { abort(): void }; isPreventedFromCleanup?: () => boolean
  }
}

/** The layers' files renderFrames wrote, or why the sound cannot be had without Remotion's FFmpeg. */
export function inlineTracks(info: AssetsInfo): InlineTrack[] {
  // Sound Remotion extracts with FFmpeg: any audio or video asset that is not muted and has a volume.
  // assetsInfo.assets: per frame drawn, that frame's assets (frames outside the range drawn are holes).
  const list = (info.assets ?? []).flatMap((frame) => (Array.isArray(frame) ? frame : frame ? [frame] : [])) as { type?: string; volume?: number | number[]; muted?: boolean }[]
  for (const a of list) {
    if ((a.type === 'audio' || a.type === 'video') && !a.muted && (Array.isArray(a.volume) ? a.volume.some((v) => v > 0) : (a.volume ?? 1) > 0)) {
      throw new NeedsCompositor(`a ${a.type} Remotion extracts with its own FFmpeg`)
    }
  }
  const mix = info.downloadMap?.inlineAudioMixing
  if (!mix) throw new NeedsCompositor('renderFrames gave no inline audio (another Remotion version?)')
  return mix.getListOfAssets().map((t) => ({ file: t.outName, start: t.startInSamples, duration: t.durationInSamples }))
}

/** renderFrames' scratch folders removed (renderMedia does this itself; renderFrames leaves them). */
export async function cleanAssets(info: AssetsInfo): Promise<void> {
  const d = info.downloadMap
  if (!d || d.isPreventedFromCleanup?.()) return
  d.cleanupController?.abort()
  try { d.inlineAudioMixing?.cleanup() } catch { /* already */ }
  for (const dir of [d.downloadDir, d.complexFilter, d.compositingDir, d.assetDir]) if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined)
}

/** One level of the merge: ten tracks at a time summed and clipped (in order of their start). Pure. */
export function mergePlan(tracks: { start: number; duration: number }[]): number[][][] {
  // levels[i] = groups of indices into the level's own tracks; the tracks of level i+1 are its groups' results.
  const levels: number[][][] = []
  let current = tracks.map((t, i) => ({ ...t, i })).sort((a, b) => a.start - b.start || a.i - b.i)
  while (current.length > 1) {
    const groups: number[][] = []
    const next: { start: number; duration: number; i: number }[] = []
    for (let g = 0; g < current.length; g += MAX_INPUTS) {
      const group = current.slice(g, g + MAX_INPUTS)
      groups.push(group.map((t) => t.i))
      const start = group[0]!.start
      next.push({ start, duration: Math.max(...group.map((t) => t.start - start + t.duration)), i: groups.length - 1 })
    }
    levels.push(groups)
    current = next
  }
  if (current.length === 1 && levels.length === 0) levels.push([[current[0]!.i]])
  return levels
}

/**
 * The tracks merged as Remotion merges them, written as a 16-bit stereo 48 kHz WAV at `out`, `length` samples at least
 * (the frames' length; longer when a piece runs past it). Goes ten seconds at a time; returns the samples written.
 */
export async function mergeInline(tracks: InlineTrack[], length: number, out: string): Promise<number> {
  const total = Math.max(length, ...tracks.map((t) => t.start + t.duration))
  const files = await Promise.all(tracks.map((t) => open(t.file, 'r')))
  const fh = await open(out, 'w')
  try {
    const header = Buffer.alloc(44)
    header.write('RIFF', 0, 'latin1'); header.writeUInt32LE(36 + total * 4, 4); header.write('WAVE', 8, 'latin1'); header.write('fmt ', 12, 'latin1')
    header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(2, 22); header.writeUInt32LE(SAMPLE_RATE, 24); header.writeUInt32LE(SAMPLE_RATE * 4, 28)
    header.writeUInt16LE(4, 32); header.writeUInt16LE(16, 34); header.write('data', 36, 'latin1'); header.writeUInt32LE(total * 4, 40)
    await fh.write(header, 0, 44, 0)
    // The levels as Remotion makes them: each level's tracks with their starts and lengths.
    const levels: { start: number; duration: number }[][] = [tracks.map((t) => ({ start: t.start, duration: t.duration }))]
    const plan = mergePlan(levels[0]!)
    for (const groups of plan) {
      const prev = levels.at(-1)!
      levels.push(groups.map((g) => { const start = prev[g[0]!]!.start; return { start, duration: Math.max(...g.map((i) => prev[i]!.start - start + prev[i]!.duration)) } }))
    }
    for (let from = 0; from < total; from += BLOCK) {
      const n = Math.min(BLOCK, total - from)
      // Level 0: each file's samples in this block (silence outside it).
      let current = await Promise.all(tracks.map(async (t, k) => {
        const buf = new Int16Array(n * 2)
        const a = Math.max(from, t.start), b = Math.min(from + n, t.start + t.duration)
        if (b > a) {
          const bytes = Buffer.alloc((b - a) * 4)
          await files[k]!.read(bytes, 0, bytes.length, 44 + (a - t.start) * 4)
          buf.set(new Int16Array(bytes.buffer, bytes.byteOffset, (b - a) * 2), (a - from) * 2)
        }
        return buf
      }))
      for (const groups of plan) {
        current = groups.map((g) => {
          if (g.length === 1) return current[g[0]!]!
          const sum = new Int16Array(n * 2)
          for (let i = 0; i < n * 2; i++) {
            let s = 0
            for (const k of g) s += current[k]![i]!
            sum[i] = s > 32767 ? 32767 : s < -32768 ? -32768 : s
          }
          return sum
        })
      }
      const block = current[0] ?? new Int16Array(n * 2)
      await fh.write(Buffer.from(block.buffer, block.byteOffset, n * 4), 0, n * 4, 44 + from * 4)
    }
    return total
  } finally {
    await fh.close()
    await Promise.all(files.map((f) => f.close()))
  }
}
