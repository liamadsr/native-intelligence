/**
 * FFmpeg, ffprobe and the other command-line tools, and the pure parts of
 * reading what they say: a probe, a file's frame timing, a waveform.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

export interface RunOptions {
  timeout?: number
  maxBuffer?: number
  signal?: AbortSignal
  env?: NodeJS.ProcessEnv
  /** The folder it runs in (a filter graph names its files relative to it). */
  cwd?: string
}

/** A tool's run that did not succeed: the tool, why, and the end of what it said. */
export class ToolError extends Error {
  readonly code: string | number | null
  constructor(message: string, code: string | number | null) {
    super(message)
    this.name = 'ToolError'
    this.code = code
  }
}

/**
 * The only ways FFmpeg and ffprobe may open an input: local files and pipes. An upload is a stranger's file: a
 * playlist or a concat list dressed as a video would otherwise make FFmpeg fetch URLs (from inside our network).
 */
export const PROTOCOL_WHITELIST = 'file,pipe'

/**
 * A tool's arguments with every input fenced to PROTOCOL_WHITELIST: for ffmpeg the option goes before each `-i`
 * (it is an input option), for ffprobe before everything (its one input). Other tools are untouched. Pure.
 */
export function fenceInputs(file: string, args: readonly string[]): string[] {
  const tool = file.replace(/^.*[\\/]/, '')
  const fence = ['-protocol_whitelist', PROTOCOL_WHITELIST]
  if (tool === 'ffprobe') return args.includes('-protocol_whitelist') ? [...args] : [...fence, ...args]
  if (tool !== 'ffmpeg') return [...args]
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-i' && args[i - 2] !== '-protocol_whitelist') out.push(...fence)
    out.push(args[i]!)
  }
  return out
}

/** Run a tool and collect its output. The signal kills it (a cancelled job), as does the timeout. */
export function run(file: string, args: string[], opts: RunOptions = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, fenceInputs(file, args), { timeout: opts.timeout ?? 180_000, maxBuffer: opts.maxBuffer ?? 8 * 1024 * 1024, signal: opts.signal, env: opts.env, cwd: opts.cwd, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (!err) return resolve({ stdout, stderr })
      const e = err as NodeJS.ErrnoException & { killed?: boolean }
      if (opts.signal?.aborted) return reject(new ToolError(`${file} stopped: the job was cancelled`, 'ABORT_ERR'))
      if (e.code === 'ENOENT') return reject(new ToolError(`${file} is not installed`, 'ENOENT'))
      const tail = String(stderr || '').trim().split('\n').slice(-4).join(' | ').slice(0, 600)
      reject(new ToolError(`${file.replace(/^.*\//, '')} failed${e.killed ? ' (timed out)' : ''}${tail ? `: ${tail}` : ''}`, e.code ?? null))
    })
  })
}

/** Run a tool whose standard output is binary (raw samples). */
export function runBuffer(file: string, args: string[], opts: RunOptions = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(file, fenceInputs(file, args), { timeout: opts.timeout ?? 180_000, maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024, signal: opts.signal, encoding: 'buffer' }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout)
      if (opts.signal?.aborted) return reject(new ToolError(`${file} stopped: the job was cancelled`, 'ABORT_ERR'))
      const tail = String(stderr ?? '').trim().split('\n').slice(-4).join(' | ').slice(0, 600)
      reject(new ToolError(`${file.replace(/^.*\//, '')} failed${tail ? `: ${tail}` : ''}`, (err as NodeJS.ErrnoException).code ?? null))
    })
  })
}

/** Time limits grow with the media: a long recording must never fail just for being long. */
export const mediaTimeout = (seconds: number, perSecond = 3) => Math.max(180_000, Math.ceil(seconds * perSecond * 1000) + 60_000)

/**
 * Where a tool is: on PATH, else the usual places Homebrew and Debian put it.
 * Null when it is nowhere.
 */
export function findBinary(name: string, extra: string[] = [], env: NodeJS.ProcessEnv = process.env): string | null {
  const dirs = [...(env.PATH ?? '').split(delimiter).filter(Boolean), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']
  for (const candidate of [...extra, ...dirs.map((d) => join(d, name))]) if (existsSync(candidate)) return candidate
  return null
}

// ---- probes ----------------------------------------------------------------------------------------------

export interface ProbeStream {
  codec_type: string
  codec_name?: string
  width?: number
  height?: number
  avg_frame_rate?: string
  r_frame_rate?: string
  nb_read_packets?: string
  nb_frames?: string
  duration?: string
  /** attached_pic 1: cover art in a sound file, not a picture. */
  disposition?: { attached_pic?: number }
}
export interface Probe {
  streams: ProbeStream[]
  format: { duration?: string; format_name?: string }
}

/** The picture of a probe: its first video stream that is not cover art. */
export function pictureStream(p: Probe): ProbeStream | undefined {
  return p.streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1)
}

/**
 * True when a container holds sound and no picture, whatever its name says: a
 * browser's microphone take arrives as an audio-only WebM (Opus) or MP4 (AAC).
 */
export function audioOnly(p: Probe): boolean {
  return !pictureStream(p) && p.streams.some((s) => s.codec_type === 'audio')
}

export async function probe(path: string, opts: { countPackets?: boolean; signal?: AbortSignal; extraArgs?: string[] } = {}): Promise<Probe> {
  const { stdout } = await run('ffprobe', ['-v', 'error', ...(opts.extraArgs ?? []), ...(opts.countPackets ? ['-count_packets'] : []), '-show_streams', '-show_format', '-of', 'json', path], {
    timeout: 300_000,
    maxBuffer: 4 * 1024 * 1024,
    signal: opts.signal,
  })
  return parseProbe(stdout)
}

/** ffprobe's JSON, checked for the shape the rest relies on. */
export function parseProbe(text: string): Probe {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('ffprobe did not describe the file')
  }
  const obj = (raw ?? {}) as { streams?: unknown; format?: unknown }
  const streams = Array.isArray(obj.streams) ? (obj.streams.filter((s) => s && typeof s === 'object' && typeof (s as ProbeStream).codec_type === 'string') as ProbeStream[]) : []
  const format = obj.format && typeof obj.format === 'object' ? (obj.format as Probe['format']) : {}
  return { streams, format }
}

/** A frame rate written as ffprobe writes it ("30000/1001", "30/1", "0/0"), or NaN. */
export function parseRate(rate: string | undefined): number {
  if (!rate) return Number.NaN
  const [n, d] = rate.split('/').map(Number)
  if (d === undefined) return Number.isFinite(n) ? n! : Number.NaN
  return d > 0 && Number.isFinite(n) ? n! / d : Number.NaN
}

/** The kind of media a file name says it is, as the editor imports it (null: a kind it does not take). */
export function kindOfName(name: string): { kind: 'video' | 'image' | 'audio'; extension: string } | null {
  const named = (/\.([^./]+)$/.exec(name)?.[1] ?? '').toLowerCase()
  // An .m4v is an MP4 by another name (Apple's): read and stored as .mp4, so the library serves it as video/mp4.
  const extension = named === 'm4v' ? 'mp4' : named
  const kind = ['png', 'jpg', 'jpeg', 'webp'].includes(extension)
    ? 'image'
    : ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg'].includes(extension)
      ? 'audio'
      : ['mp4', 'mov', 'webm', 'mkv'].includes(extension)
        ? 'video'
        : null
  return kind ? { kind, extension } : null
}

export const UNSUPPORTED_TYPE = 'Import MP4/MOV/WebM, PNG/JPEG/WebP, or WAV/MP3/M4A/FLAC audio'
export const VARIABLE_RATE =
  'Variable frame rate video is not supported in V1. Convert to constant frame rate before import; original file is unchanged.'
export const INVALID_TIMING = 'Video has invalid frame timing'
export const UNVERIFIED_TIMING = 'Unable to verify constant frame timing'
/**
 * The refusals a plain import answers by conforming the video (its frames do not keep a steady time) instead of
 * refusing it: a phone video or a browser's screen recording very often varies its frame rate.
 */
export const TIMING_REFUSALS: readonly string[] = [VARIABLE_RATE, INVALID_TIMING, UNVERIFIED_TIMING]

/**
 * The constant rate a video whose timing varies is conformed to: 60 fps when its average rate is above 45, else 30.
 * The average is the probe's, else its packets over its duration (a count from `countPackets`). Pure.
 */
export function conformRate(p: Probe): 30 | 60 {
  const picture = pictureStream(p)
  let average = parseRate(picture?.avg_frame_rate)
  if (!(average > 0)) average = Number(picture?.nb_read_packets) / Number(picture?.duration ?? p.format.duration)
  return Number.isFinite(average) && average > 45 ? 60 : 30
}

/** A gap between frames shorter than this is the picture moving (a still screen sends a frame now and then). */
export const MOVING_GAP = 0.1

/**
 * The rate a recording is conformed to when its rate is at most (`conform.fit`), read from its packets' times (any
 * container, also a browser's WebM that does not say how long it is). A browser's screen capture sends frames only
 * when the screen changes, so the average says little: a mostly still screen whose scrolling ran at 60 averages far
 * below 45. The rate is judged while the picture moved: from the gaps shorter than MOVING_GAP, their median. Above
 * 45 frames a second, `most` (60); else 30. `ceiling` (the rate the recorder asked for, or the device said it gives)
 * caps it: at 45 or less, 30. Fewer than ten moving gaps (a picture that hardly moved): 30, unless the ceiling says
 * more and there are too few frames at all to tell (then `most`). Pure.
 */
export function fitRate(stamps: number[], most: 30 | 60, ceiling?: number): 30 | 60 {
  if (most === 30) return 30
  if (ceiling !== undefined && Number.isFinite(ceiling) && ceiling <= 45) return 30
  if (stamps.length < 2) return most
  const moving: number[] = []
  for (let i = 1; i < stamps.length; i++) {
    const gap = stamps[i]! - stamps[i - 1]!
    if (gap > 0 && gap < MOVING_GAP) moving.push(gap)
  }
  if (moving.length < 10) return stamps.length < 10 ? most : 30
  moving.sort((a, b) => a - b)
  const median = moving[Math.floor(moving.length / 2)]!
  return 1 / median > 45 ? 60 : 30
}

/** Packet timestamps (seconds, one per line, any order) into presentation order. */
export function parseStamps(text: string): number[] {
  return text
    .split('\n')
    .map((line) => Number.parseFloat(line.split(',')[0]!))
    .filter(Number.isFinite)
    .sort((a, b) => a - b)
}

/**
 * Whether every frame sits one frame after the one before. WebM stores
 * millisecond timestamps, so constant-rate frames still land up to 1 ms off
 * the ideal grid there.
 */
export function constantFrameTiming(stamps: number[], fps: number, extension: string): boolean {
  const tolerance = Math.max(extension === 'webm' ? 0.0011 : 0.0001, 0.02 / fps)
  for (let i = 1; i < stamps.length; i++) if (Math.abs(stamps[i]! - stamps[i - 1]! - 1 / fps) > tolerance) return false
  return true
}

/** True when every frame sits on an exact 1/30 or 1/60 s grid (a take already at the rate it is conformed to). */
export function onFrameGrid(stamps: number[], fps: 30 | 60): boolean {
  if (stamps.length < 2) return false
  return stamps.every((t, i) => !i || Math.abs(t - stamps[i - 1]! - 1 / fps) < 0.25 / fps)
}

export async function videoStamps(path: string, signal?: AbortSignal): Promise<number[]> {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', path], {
    timeout: 300_000,
    maxBuffer: 128 * 1024 * 1024,
    signal,
  })
  return parseStamps(stdout)
}

// ---- waveform --------------------------------------------------------------------------------------------

/** The editor's waveform: the peak of each of up to `bins` equal stretches of mono float samples, 0 to 1. */
export function waveformPeaks(samples: Buffer, bins = 600): number[] {
  const count = Math.floor(samples.length / 4)
  const n = Math.min(bins, count)
  const out: number[] = []
  for (let bin = 0; bin < n; bin++) {
    let peak = 0
    const from = Math.floor((bin * count) / n)
    const to = Math.floor(((bin + 1) * count) / n)
    for (let i = from; i < to; i++) {
      const v = Math.abs(samples.readFloatLE(i * 4))
      if (v > peak) peak = v
    }
    out.push(Number.isFinite(peak) ? Math.min(1, peak) : 0)
  }
  return out
}

/** The first audio stream at 1000 samples a second, mono, as 32-bit floats (two hours at most). */
export async function waveform(path: string, signal?: AbortSignal): Promise<number[]> {
  const pcm = await runBuffer('ffmpeg', ['-nostdin', '-v', 'error', '-i', path, '-map', '0:a:0', '-t', '7200', '-ac', '1', '-ar', '1000', '-f', 'f32le', 'pipe:1'], {
    timeout: 300_000,
    maxBuffer: 40 * 1024 * 1024,
    signal,
  })
  return waveformPeaks(pcm)
}
