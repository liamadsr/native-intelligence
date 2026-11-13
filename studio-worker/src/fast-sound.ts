/**
 * The fast export's sound, mixed here instead of in Chrome, the way Remotion mixes it:
 * - the layers are the composition's own (web/src/lib/studio/engine/sound-layers.ts: each recording's sound under its
 *   clips with the cut fades, each audio track's segments with gain and fades);
 * - @remotion/media hands Remotion, for every frame of a layer, the file's samples from the frame's time to the next
 *   frame's (from floor(t × 48000) to ceil((t + 1/fps) × 48000), t = frame/fps × rate + trimBefore/fps), decoded,
 *   turned into 16-bit as Chrome turns float audio into it, mono doubled to stereo, multiplied by the frame's level
 *   and truncated (an Int16Array keeps the integer part), and nothing at all when the level is 0;
 * - Remotion writes each frame's piece at floor(frame/fps × 48000) of its layer's file, a later frame overwriting an
 *   earlier one where they overlap, and sums the layers (amix, normalize=0), clipped to 16 bits.
 * Only for what was proven against Remotion's own mix (test/fast-export-e2e.ts): 48 kHz AAC or PCM sources, mono or
 * stereo, at 1x, no ducking. Otherwise (soundPlan says why) the sound is Remotion's, the picture still FFmpeg's.
 */
import { createRequire } from 'node:module'
import { open } from 'node:fs/promises'
import type { EditorProject } from '../../web/src/lib/studio/engine/contracts.ts'
import { runBuffer } from './media.ts'

const require = createRequire(import.meta.url)
const { soundLayers } = require('../../web/src/lib/studio/engine/sound-layers.ts') as typeof import('../../web/src/lib/studio/engine/sound-layers.ts')
type Layer = ReturnType<typeof soundLayers>[number]

export const SAMPLE_RATE = 48000

/** The sound's layers, or why the sound must be Remotion's. `probe`: each file's first audio stream. Pure. */
export function soundPlan(project: EditorProject, probe: (file: string) => { codec?: string; sampleRate?: number; channels?: number } | null): { layers: (Layer & { file: string; channels: number })[] } | { reason: string } {
  if (project.audioTracks.some((t) => !t.muted && t.duck)) return { reason: 'a track is ducked' }
  if (![30, 60].includes(project.output.fps)) return { reason: `${project.output.fps} fps` }
  const layers: (Layer & { file: string; channels: number })[] = []
  for (const layer of soundLayers(project)) {
    const asset = project.assets.find((a) => a.id === layer.assetId)
    if (!asset) return { reason: 'a sound names a missing file' }
    if (layer.playbackRate !== 1) return { reason: 'a sound plays at another speed' }
    const p = probe(asset.file)
    if (!p) continue // no audio stream: Remotion hears nothing from it either
    if (!['aac', 'pcm_s16le'].includes(p.codec ?? '')) return { reason: `a sound is ${p.codec}` }
    if (p.sampleRate !== SAMPLE_RATE) return { reason: `a sound is at ${p.sampleRate} Hz` }
    if (p.channels !== 1 && p.channels !== 2) return { reason: `a sound has ${p.channels} channels` }
    layers.push({ ...layer, file: asset.file, channels: p.channels })
  }
  return { layers }
}

/** Remotion's floating-point fix (convert-audiodata.ts in @remotion/media), so floor and ceil land where it lands them. */
const fix = (value: number) => {
  const decimal = Math.abs(value % 1)
  if (decimal < 0.0000001) return value < 0 ? Math.ceil(value) : Math.floor(value)
  if (decimal > 0.9999999) return value < 0 ? Math.floor(value) : Math.ceil(value)
  return value
}

/** The samples [start, end) of a file that a layer's frame `f` plays, as @remotion/media takes them. Pure. */
export function frameSamples(layer: Pick<Layer, 'trimBefore' | 'playbackRate'>, f: number, fps: number): [number, number] {
  const t = (f / fps) * layer.playbackRate + layer.trimBefore / fps, d = (1 / fps) * layer.playbackRate
  return [Math.floor(fix(t * SAMPLE_RATE)), Math.ceil(fix((t + d) * SAMPLE_RATE))]
}

/** Where Remotion writes frame `k`'s piece (samples from the start of the video). Pure. */
export const framePosition = (k: number, fps: number) => Math.floor(fix((k / fps) * SAMPLE_RATE))

/** A float sample as Chrome's AudioData turns it into 16 bits: in single precision, ×32768 below zero, ×32767 above,
 *  the fraction dropped (fitted against Remotion's own mix: all but 21 of 279,200 samples, those one step apart). */
export const toS16 = (x: number) => {
  const c = Math.fround(Math.max(-1, Math.min(1, x)))
  return Math.trunc(Math.fround(c < 0 ? c * 32768 : c * 32767))
}

/**
 * Mix `layers` (soundPlan) for a video of `frames` frames into a 16-bit stereo 48 kHz WAV at `out`. `path` makes a
 * project file a path on disk. Streams through the video a few seconds at a time; each file is decoded once.
 */
export async function mixSound(layers: (Layer & { file: string; channels: number })[], frames: number, fps: number, path: (file: string) => string, out: string, signal?: AbortSignal): Promise<void> {
  const perFrame = SAMPLE_RATE / fps
  const decoded = new Map<string, Int16Array>()
  for (const file of new Set(layers.map((l) => l.file))) {
    const channels = layers.find((l) => l.file === file)!.channels
    const raw = await runBuffer('ffmpeg', ['-nostdin', '-v', 'error', '-i', path(file), '-map', '0:a:0', '-f', 'f32le', '-acodec', 'pcm_f32le', '-'], { signal, maxBuffer: 4 * 1024 * 1024 * 1024 })
    const f32 = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4)
    const stereo = new Int16Array((f32.length / channels) * 2)
    for (let i = 0, n = f32.length / channels; i < n; i++) {
      const l = toS16(f32[i * channels]!), r = channels === 2 ? toS16(f32[i * channels + 1]!) : l
      stereo[i * 2] = l
      stereo[i * 2 + 1] = r
    }
    decoded.set(file, stereo)
  }
  // As long as the furthest piece reaches: a last frame's piece can run a sample past the video's end, and Remotion keeps it.
  let total = frames * perFrame
  for (const layer of layers) {
    const srcFrames = decoded.get(layer.file)!.length / 2
    for (let k = layer.from; k < Math.min(layer.from + layer.duration, frames); k++) {
      const f = k - layer.from
      if (!(layer.volume(f) > 0)) continue
      const [s0, s1] = frameSamples(layer, f, fps), a = Math.max(0, s0), b = Math.min(srcFrames, s1)
      if (b > a) total = Math.max(total, framePosition(k, fps) + (a - s0) + (b - a))
    }
  }
  const fh = await open(out, 'w')
  try {
    const header = Buffer.alloc(44)
    header.write('RIFF', 0, 'latin1'); header.writeUInt32LE(36 + total * 4, 4); header.write('WAVE', 8, 'latin1'); header.write('fmt ', 12, 'latin1')
    header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(2, 22); header.writeUInt32LE(SAMPLE_RATE, 24); header.writeUInt32LE(SAMPLE_RATE * 4, 28)
    header.writeUInt16LE(4, 32); header.writeUInt16LE(16, 34); header.write('data', 36, 'latin1'); header.writeUInt32LE(total * 4, 40)
    await fh.write(header, 0, 44, 0)
    const blockFrames = fps * 10
    for (let first = 0; first < frames; first += blockFrames) {
      if (signal?.aborted) throw new Error('Cancelled')
      const last = Math.min(frames, first + blockFrames), from = framePosition(first, fps), to = last === frames ? total : framePosition(last, fps)
      const mix = new Int32Array((to - from) * 2)
      const layerBuf = new Int16Array((to - from) * 2)
      for (const layer of layers) {
        layerBuf.fill(0)
        let wrote = false
        const src = decoded.get(layer.file)!, srcFrames = src.length / 2
        // Two frames before the block too: a piece can run a sample past its frame, and a later frame overwrites it.
        for (let k = Math.max(layer.from, first - 2); k < Math.min(layer.from + layer.duration, last, frames); k++) {
          const f = k - layer.from, v = layer.volume(f)
          if (!(v > 0)) continue
          const [s0, s1] = frameSamples(layer, f, fps)
          const a = Math.max(0, s0), b = Math.min(srcFrames, s1)
          if (b <= a) continue
          const at = framePosition(k, fps) + (a - s0) - from
          for (let i = a; i < b; i++) {
            const o = at + (i - a)
            if (o < 0 || o >= to - from) continue
            let l = src[i * 2]!, r = src[i * 2 + 1]!
            if (v !== 1) { l = Math.trunc(Math.max(-32768, Math.min(32767, l * v))); r = Math.trunc(Math.max(-32768, Math.min(32767, r * v))) }
            layerBuf[o * 2] = l
            layerBuf[o * 2 + 1] = r
            wrote = true
          }
        }
        if (wrote) for (let i = 0; i < mix.length; i++) mix[i]! += layerBuf[i]!
      }
      const pcm = Buffer.alloc(mix.length * 2)
      for (let i = 0; i < mix.length; i++) pcm.writeInt16LE(Math.max(-32768, Math.min(32767, mix[i]!)), i * 2)
      await fh.write(pcm, 0, pcm.length, 44 + from * 4)
    }
  } finally {
    await fh.close()
  }
}

/**
 * Remotion's sound differs from the file's own decoding only where Chrome's AAC decoder starts cold: the first ~100 ms
 * of a file played from its start (Chrome gives 448 samples of silence, then its ramp; FFmpeg the encoder delay
 * already removed). Those frames, and a few frames to check by (the first of each layer that starts mid-video and one
 * 80 % in), are mixed by Remotion itself: the first spliced in, the others compared. Pure.
 */
export function soundWindows(layers: Pick<Layer, 'from' | 'duration' | 'trimBefore' | 'playbackRate'>[], frames: number, fps: number): { warm: [number, number][]; check: [number, number][] } {
  const cold = new Set<number>()
  for (const layer of layers) for (let f = 0; f < layer.duration && layer.from + f < frames; f++) {
    if (frameSamples(layer, f, fps)[0] >= 4800) break
    cold.add(layer.from + f)
  }
  const ranges = (set: Set<number>) => [...set].sort((a, b) => a - b).reduce<[number, number][]>((out, k) => {
    const last = out.at(-1)
    if (last && k <= last[1] + 1) last[1] = Math.max(last[1], k); else out.push([k, k])
    return out
  }, [])
  const check = new Set<number>()
  const starts = [...new Set(layers.map((l) => l.from).filter((f) => f > 0 && f < frames))].slice(0, 2)
  for (const s of [...starts, Math.floor(frames * 0.8)]) for (let k = Math.max(0, s - 2); k < Math.min(frames, s + 8); k++) if (!cold.has(k)) check.add(k)
  return { warm: ranges(cold), check: ranges(check) }
}

/** A window of Remotion's sound (frames [a, b], its WAV starting at frame a) against the mix: samples that differ and by how much. */
export async function compareWindow(mix: string, window: string, [a, b]: [number, number], fps: number): Promise<{ samples: number; differing: number; maxDiff: number; rms: number }> {
  const { readFile } = await import('node:fs/promises')
  const [m, w] = [pcmOf(await readFile(mix)), pcmOf(await readFile(window))]
  const from = framePosition(a, fps) * 2, n = (framePosition(b + 1, fps) - framePosition(a, fps)) * 2
  let differing = 0, maxDiff = 0, sq = 0
  for (let i = 0; i < n; i++) {
    const d = Math.abs((m[from + i] ?? 0) - (w[i] ?? 0))
    if (d) { differing++; maxDiff = Math.max(maxDiff, d); sq += d * d }
  }
  return { samples: n / 2, differing, maxDiff, rms: n ? Math.sqrt(sq / n) : 0 }
}

/** Remotion's window (frames [a, b]) written over the mix. */
export async function spliceWindow(mix: string, window: string, [a, b]: [number, number], fps: number): Promise<void> {
  const { readFile } = await import('node:fs/promises')
  const w = pcmOf(await readFile(window)), n = (framePosition(b + 1, fps) - framePosition(a, fps)) * 2
  const buf = Buffer.alloc(n * 2)
  for (let i = 0; i < n; i++) buf.writeInt16LE(w[i] ?? 0, i * 2)
  const fh = await open(mix, 'r+')
  try { await fh.write(buf, 0, buf.length, 44 + framePosition(a, fps) * 4) } finally { await fh.close() }
}

/** The 16-bit samples of a PCM WAV (its data chunk). */
function pcmOf(buf: Buffer): Int16Array {
  let at = 12
  while (at + 8 <= buf.length) {
    const id = buf.toString('latin1', at, at + 4), size = buf.readUInt32LE(at + 4)
    if (id === 'data') return new Int16Array(buf.buffer.slice(buf.byteOffset + at + 8, buf.byteOffset + at + 8 + Math.min(size, buf.length - at - 8)))
    at += 8 + size + (size % 2)
  }
  throw new Error('not a WAV')
}

/**
 * Most a checked window may differ from Remotion's mix: Chrome's AAC decoder and FFmpeg's round differently (on the
 * made-up voices one sample in a thousand by one step; on a pure 440 Hz tone one in eight, by up to 14 steps), so the
 * check allows an error of 2 steps RMS (-84 dBFS, under 16-bit sound's own noise) and 64 at most (-54 dBFS for a
 * sample). A wrong offset, level or source is thousands of steps.
 */
export const SOUND_CHECK = { rmsSteps: 2, maxDiff: 64 }

/**
 * The sound of a fast export: mixed here (soundPlan, mixSound), the cold-start frames and the check frames mixed by
 * Remotion (`remotion(range, out)` renders frames [a, b] of the sound alone to a WAV); a check that fails, or a sound
 * this cannot mix, and the whole sound is Remotion's (`whole(out)`). Returns which it was, for the log.
 */
export async function composeSound(o: {
  project: EditorProject; frames: number; fps: number; path: (file: string) => string; out: string; scratch: string
  probe: (file: string) => { codec?: string; sampleRate?: number; channels?: number } | null
  remotion: (range: [number, number], out: string) => Promise<void>; whole: (out: string) => Promise<void>; signal?: AbortSignal
  log?: (line: string) => void
}): Promise<string> {
  const t0 = Date.now(), secs = (t: number) => ((Date.now() - t) / 1000).toFixed(1)
  const { join } = await import('node:path')
  const plan = soundPlan(o.project, o.probe)
  if ('reason' in plan) { await o.whole(o.out); return `the sound mixed by Remotion (${plan.reason})` }
  await mixSound(plan.layers, o.frames, o.fps, o.path, o.out, o.signal)
  const t1 = Date.now()
  const { warm, check } = soundWindows(plan.layers, o.frames, o.fps)
  const files = [...warm, ...check].map((_, i) => join(o.scratch, `fast-sound-window-${i}.wav`))
  // One after another: they share one browser, and each is a handful of frames.
  for (const [i, r] of [...warm, ...check].entries()) await o.remotion(r, files[i]!)
  o.log?.(`Fast export: sound mixed in ${((t1 - t0) / 1000).toFixed(1)} s, ${warm.length + check.length} windows by Remotion in ${secs(t1)} s`)
  for (const [i, r] of check.entries()) {
    const c = await compareWindow(o.out, files[warm.length + i]!, r, o.fps)
    if (c.rms > SOUND_CHECK.rmsSteps || c.maxDiff > SOUND_CHECK.maxDiff) {
      await o.whole(o.out)
      return `the sound mixed by Remotion (frames ${r[0]}–${r[1]} differed from its mix: ${c.rms.toFixed(1)} steps RMS, up to ${c.maxDiff})`
    }
  }
  for (const [i, r] of warm.entries()) await spliceWindow(o.out, files[i]!, r, o.fps)
  return `the sound mixed by FFmpeg (${plan.layers.length} layers; ${warm.length} cold start${warm.length === 1 ? '' : 's'} and ${check.length} check${check.length === 1 ? '' : 's'} by Remotion)`
}
