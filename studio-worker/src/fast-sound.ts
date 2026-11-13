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
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import type { EditorProject } from '../../web/src/lib/studio/engine/contracts.ts'
import { fenceInputs } from './media.ts'
import { toolPath } from './platform.ts'

const require = createRequire(import.meta.url)
const { soundLayers } = require('../../web/src/lib/studio/engine/sound-layers.ts') as typeof import('../../web/src/lib/studio/engine/sound-layers.ts')
type Layer = ReturnType<typeof soundLayers>[number]

export const SAMPLE_RATE = 48000

/** What soundPlan needs to know of a file's first audio stream (ffprobe): null when it has none. */
export type AudioProbe = { codec?: string; sampleRate?: number; channels?: number; startTime?: number } | null

/**
 * The sound's layers, or why the sound must be Remotion's. `probe`: each file's first audio stream. A stream must
 * start at 0: the mix numbers samples by their timestamps from 0, and Remotion places them by timestamp, so a stream
 * that starts later (an upload kept as it came) is not proven here. Pure.
 */
export function soundPlan(project: EditorProject, probe: (file: string) => AudioProbe): { layers: (Layer & { file: string; channels: number })[] } | { reason: string } {
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
    if (p.startTime !== 0) return { reason: `a sound starts at ${p.startTime} s in its file, not 0` }
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
 * Samples [first, last) of a file's first audio stream as 16-bit stereo (toS16, mono doubled), decoded by one FFmpeg
 * run from a quarter of a second before `first` (the decoder's state is then the whole decode's; the sample numbers are
 * the stream's own timestamps, which soundPlan requires to start at 0) and read as the mix goes: what is held is what
 * lies between the oldest sample still wanted (`release`) and the newest asked for, never the file.
 */
export class SourceReader {
  private child: ChildProcessByStdio<null, Readable, Readable> | null = null
  private chunks: AsyncIterator<Buffer> | null = null
  private pending = Buffer.alloc(0)
  private stderr = ''
  /** Decoded stereo samples from `start` on: `len` of them used, room for more. */
  private buf = new Int16Array(1 << 16)
  private len = 0
  private start: number
  private ended = false
  constructor(private file: string, private channels: number, private first: number, private last: number, private signal?: AbortSignal) {
    this.start = first
  }

  private open() {
    // Whole milliseconds, so the seek point is exact in FFmpeg's microseconds; timestamps kept (-copyts), so atrim cuts by sample number.
    const seek = Math.max(0, Math.floor((this.first - SAMPLE_RATE / 4) / 48) * 48)
    const args = ['-nostdin', '-v', 'error', ...(seek ? ['-ss', String(seek / SAMPLE_RATE)] : []), '-copyts', '-i', this.file, '-map', '0:a:0',
      '-af', `atrim=start_pts=${this.first}:end_pts=${this.last}`, '-f', 'f32le', '-acodec', 'pcm_f32le', '-']
    const child = spawn(toolPath('ffmpeg'), fenceInputs('ffmpeg', args), { stdio: ['ignore', 'pipe', 'pipe'], signal: this.signal, windowsHide: true })
    child.on('error', () => {})
    child.stderr.on('data', (d: Buffer) => { this.stderr = (this.stderr + d.toString()).slice(-2000) })
    this.child = child
    this.chunks = child.stdout[Symbol.asyncIterator]()
  }

  /** Stereo samples [a, b) (fewer where the file ends). `a` never goes below what was released. */
  async take(a: number, b: number): Promise<Int16Array> {
    if (a < this.start) throw new Error(`the sound was read past sample ${a}`)
    b = Math.min(b, this.last)
    if (!this.child) this.open()
    while (!this.ended && this.start + this.len / 2 < b) {
      if (this.signal?.aborted) throw new Error('Cancelled')
      const next = await this.chunks!.next()
      if (next.done) { await this.finish(); break }
      const bytes = Buffer.concat([this.pending, next.value]), frame = 4 * this.channels, whole = bytes.length - (bytes.length % frame)
      this.pending = bytes.subarray(whole)
      const f32 = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + whole))
      const n = f32.length / this.channels
      if (this.len + n * 2 > this.buf.length) {
        const grown = new Int16Array(Math.max(this.buf.length * 2, this.len + n * 2))
        grown.set(this.buf.subarray(0, this.len))
        this.buf = grown
      }
      for (let i = 0, o = this.len; i < n; i++, o += 2) {
        const l = toS16(f32[i * this.channels]!)
        this.buf[o] = l
        this.buf[o + 1] = this.channels === 2 ? toS16(f32[i * this.channels + 1]!) : l
      }
      this.len += n * 2
    }
    const from = (a - this.start) * 2, to = Math.min(this.len, (b - this.start) * 2)
    return to > from ? this.buf.subarray(from, to) : new Int16Array(0)
  }

  /** Nothing before sample `upTo` is asked for again. */
  release(upTo: number) {
    const drop = Math.min(this.len / 2, Math.max(0, upTo - this.start))
    if (drop <= 0) return
    this.buf.copyWithin(0, drop * 2, this.len)
    this.len -= drop * 2
    this.start += drop
  }

  private async finish() {
    this.ended = true
    const child = this.child!
    const code = child.exitCode ?? await new Promise<number | null>((r) => child.once('close', (c) => r(c)))
    if (this.signal?.aborted) throw new Error('Cancelled')
    if (code !== 0) throw new Error(`ffmpeg failed reading ${this.file}: ${this.stderr.trim().split('\n').slice(-2).join(' | ')}`)
  }

  close() {
    if (this.child && this.child.exitCode === null) this.child.kill('SIGKILL')
    this.buf = new Int16Array(0)
    this.len = 0
  }
}

/** The loudest frame of each layer (its piece's energy as mixed), for choosing where to check the mix. */
export type Loudness = Map<string, { frame: number; energy: number }>

/**
 * Mix `layers` (soundPlan) for a video of `frames` frames into a 16-bit stereo 48 kHz WAV at `out`. `path` makes a
 * project file a path on disk. Goes through the video ten seconds at a time; each layer's file is read only over the
 * stretch the layer plays (SourceReader), so what is held is a block and a few readers' buffers, whatever the files'
 * lengths. Returns each layer's loudest frame.
 */
export async function mixSound(layers: (Layer & { file: string; channels: number })[], frames: number, fps: number, path: (file: string) => string, out: string, signal?: AbortSignal): Promise<Loudness> {
  const perFrame = SAMPLE_RATE / fps
  const playing = (layer: Layer, k: number) => k >= layer.from && k < layer.from + layer.duration && k < frames
  const loudness: Loudness = new Map(layers.map((l) => [l.key, { frame: -1, energy: -1 }]))
  // Each layer's stretch of its file: from its first audible frame's first sample to its last one's end.
  const readers = new Map<string, SourceReader>()
  const reader = (layer: Layer & { file: string; channels: number }) => {
    let r = readers.get(layer.key)
    if (!r) {
      let lo = Infinity, hi = -Infinity
      for (let f = 0; f < layer.duration && layer.from + f < frames; f++) if (layer.volume(f) > 0) { const [a, b] = frameSamples(layer, f, fps); lo = Math.min(lo, a); hi = Math.max(hi, b) }
      r = new SourceReader(path(layer.file), layer.channels, Math.max(0, lo), Math.max(0, hi), signal)
      readers.set(layer.key, r)
    }
    return r
  }
  const fh = await open(out, 'w')
  let total = frames * perFrame
  try {
    const blockFrames = fps * 10
    for (let first = 0; first < frames; first += blockFrames) {
      if (signal?.aborted) throw new Error('Cancelled')
      const last = Math.min(frames, first + blockFrames), from = framePosition(first, fps)
      // The last block has room for a piece that runs past the video's end (Remotion keeps it).
      const to = last === frames ? framePosition(frames, fps) + perFrame : framePosition(last, fps)
      const mix = new Int32Array((to - from) * 2)
      const layerBuf = new Int16Array((to - from) * 2)
      let reach = 0
      for (const layer of layers) {
        const k0 = Math.max(layer.from, first - 2), k1 = Math.min(layer.from + layer.duration, last, frames)
        if (k0 >= k1) continue
        const r = reader(layer)
        // Two frames before the block too: a piece can run a sample past its frame, and a later frame overwrites it.
        r.release(Math.max(0, frameSamples(layer, k0 - layer.from, fps)[0]))
        layerBuf.fill(0)
        let wrote = false
        for (let k = k0; k < k1; k++) {
          const f = k - layer.from, v = layer.volume(f)
          if (!(v > 0)) continue
          const [s0, s1] = frameSamples(layer, f, fps)
          const a = Math.max(0, s0), piece = await r.take(a, s1)
          if (!piece.length) continue
          const at = framePosition(k, fps) + (a - s0) - from
          let energy = 0
          for (let i = 0; i < piece.length / 2; i++) {
            const o = at + i
            if (o < 0 || o >= to - from) continue
            let l = piece[i * 2]!, rr = piece[i * 2 + 1]!
            if (v !== 1) { l = Math.trunc(Math.max(-32768, Math.min(32767, l * v))); rr = Math.trunc(Math.max(-32768, Math.min(32767, rr * v))) }
            layerBuf[o * 2] = l
            layerBuf[o * 2 + 1] = rr
            energy += l * l + rr * rr
            reach = Math.max(reach, o + 1)
            wrote = true
          }
          const loud = loudness.get(layer.key)!
          if (k >= first && energy > loud.energy) { loud.energy = energy; loud.frame = k }
        }
        // Done with it once no later block goes back to its frames (each goes two frames back).
        if (last === frames || Math.min(layer.from + layer.duration, frames) <= last - 2) { readers.get(layer.key)?.close(); readers.delete(layer.key) }
        if (wrote) for (let i = 0; i < mix.length; i++) mix[i]! += layerBuf[i]!
      }
      const n = last === frames ? Math.max(framePosition(frames, fps) - from, reach) : to - from
      if (last === frames) total = from + n
      const pcm = Buffer.alloc(n * 4)
      for (let i = 0; i < n * 2; i++) pcm.writeInt16LE(Math.max(-32768, Math.min(32767, mix[i]!)), i * 2)
      await fh.write(pcm, 0, pcm.length, 44 + from * 4)
    }
    const header = Buffer.alloc(44)
    header.write('RIFF', 0, 'latin1'); header.writeUInt32LE(36 + total * 4, 4); header.write('WAVE', 8, 'latin1'); header.write('fmt ', 12, 'latin1')
    header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(2, 22); header.writeUInt32LE(SAMPLE_RATE, 24); header.writeUInt32LE(SAMPLE_RATE * 4, 28)
    header.writeUInt16LE(4, 32); header.writeUInt16LE(16, 34); header.write('data', 36, 'latin1'); header.writeUInt32LE(total * 4, 40)
    await fh.write(header, 0, 44, 0)
  } finally {
    for (const r of readers.values()) r.close()
    await fh.close()
  }
  return loudness
}

/** At most this many checked windows (each is one short render by Remotion, a couple of seconds on a server). */
export const MAX_CHECKS = 6

/**
 * Remotion's sound differs from the file's own decoding only where Chrome's AAC decoder starts cold: the first ~100 ms
 * of a file played from its start (Chrome gives 448 samples of silence, then its ramp; FFmpeg the encoder delay
 * already removed). Those frames are mixed by Remotion and spliced in (`warm`). Ten frames around each layer's
 * loudest frame (`loudness`, from mixSound) are mixed by Remotion too and compared (`check`): every layer at least once
 * where it is loud, up to MAX_CHECKS windows (with more layers than that, layers spread through the video; a window
 * covers every layer playing there). A layer silent throughout is checked in its middle: Remotion must hear nothing
 * there either. Pure.
 */
export function soundWindows(layers: Pick<Layer, 'key' | 'from' | 'duration' | 'trimBefore' | 'playbackRate'>[], frames: number, fps: number, loudness: Loudness = new Map()): { warm: [number, number][]; check: [number, number][] } {
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
  const live = layers.filter((l) => l.from < frames).sort((a, b) => a.from - b.from)
  const chosen = live.length <= MAX_CHECKS ? live : Array.from({ length: MAX_CHECKS }, (_, i) => live[Math.round((i * (live.length - 1)) / (MAX_CHECKS - 1))]!)
  const check = new Set<number>()
  for (const layer of chosen) {
    const end = Math.min(frames, layer.from + layer.duration), loud = loudness.get(layer.key)
    const centre = loud && loud.energy > 0 ? loud.frame : Math.floor((layer.from + end) / 2)
    // Ten frames inside the layer, around the centre, none of them a cold start (those are Remotion's already).
    const a = Math.max(layer.from, Math.min(centre - 4, end - 10))
    for (let k = a; k < Math.min(end, a + 10); k++) if (!cold.has(k)) check.add(k)
  }
  return { warm: ranges(cold), check: ranges(check) }
}

/** A window of Remotion's sound (frames [a, b], its WAV starting at frame a) against the mix: samples that differ and by how much. Reads the mix only there. */
export async function compareWindow(mix: string, window: string, [a, b]: [number, number], fps: number): Promise<{ samples: number; differing: number; maxDiff: number; rms: number; level: number }> {
  const { readFile } = await import('node:fs/promises')
  const w = pcmOf(await readFile(window))
  const from = framePosition(a, fps), n = (framePosition(b + 1, fps) - from) * 2
  const bytes = Buffer.alloc(n * 2), fh = await open(mix, 'r')
  try { await fh.read(bytes, 0, bytes.length, 44 + from * 4) } finally { await fh.close() }
  const m = new Int16Array(bytes.buffer, bytes.byteOffset, n)
  let differing = 0, maxDiff = 0, sq = 0, level = 0
  for (let i = 0; i < n; i++) {
    const d = Math.abs(m[i]! - (w[i] ?? 0))
    level += (w[i] ?? 0) ** 2
    if (d) { differing++; maxDiff = Math.max(maxDiff, d); sq += d * d }
  }
  return { samples: n / 2, differing, maxDiff, rms: n ? Math.sqrt(sq / n) : 0, level: n ? Math.sqrt(level / n) : 0 }
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
  probe: (file: string) => AudioProbe
  remotion: (range: [number, number], out: string) => Promise<void>; whole: (out: string) => Promise<void>; signal?: AbortSignal
  log?: (line: string) => void
}): Promise<string> {
  const t0 = Date.now(), secs = (t: number) => ((Date.now() - t) / 1000).toFixed(1)
  const { join } = await import('node:path')
  const plan = soundPlan(o.project, o.probe)
  if ('reason' in plan) { await o.whole(o.out); return `the sound mixed by Remotion (${plan.reason})` }
  const loudness = await mixSound(plan.layers, o.frames, o.fps, o.path, o.out, o.signal)
  const t1 = Date.now()
  const { warm, check } = soundWindows(plan.layers, o.frames, o.fps, loudness)
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
