/**
 * Library assets: measuring a file the way the editor needs it (an
 * EditorAsset, checked against the engine's schema), conforming recordings to a
 * constant frame rate, and moving assets between the app's blobs and the cache.
 */
import { rename, stat } from 'node:fs/promises'
import type { EditorAsset } from '../../web/src/lib/studio/engine/contracts.ts'
import { EditorAssetSchema } from './engine.ts'
import { fileSha256 } from './app-client.ts'
import { checkAborted, JobError, type JobContext } from './jobs/context.ts'
import {
  constantFrameTiming,
  kindOfName,
  mediaTimeout,
  parseRate,
  pictureStream,
  probe,
  run,
  INVALID_TIMING,
  UNSUPPORTED_TYPE,
  UNVERIFIED_TIMING,
  VARIABLE_RATE,
  videoStamps,
  waveform,
  type Probe,
} from './media.ts'

/** The longest media the editor takes. */
export const MAX_SECONDS = 7200

export interface Measured {
  kind: 'video' | 'image' | 'audio'
  extension: string
  width?: number
  height?: number
  sourceFps?: number
  sourceFrames?: number
  durationSeconds?: number
  hasAudio: boolean
}

/**
 * What a probe says about a file of this kind, with the editor's rules: the
 * streams must match the kind, a duration must be positive and at most two
 * hours, a video's rate and frame count must be real. Pure (the packet
 * timestamps are given).
 */
export function measure(p: Probe, kind: Measured['kind'], extension: string, stamps: number[] | null): Measured {
  const video = pictureStream(p)
  const audio = p.streams.some((s) => s.codec_type === 'audio')
  if ((kind !== 'audio' && !video) || (kind === 'audio' && !audio)) throw new JobError('Media does not match its file type')
  const out: Measured = { kind, extension, hasAudio: audio && kind !== 'image' }
  if (video && kind !== 'audio') {
    out.width = video.width
    out.height = video.height
  }
  if (kind !== 'image') {
    const durationSeconds = Number(video?.duration ?? p.format.duration)
    if (!(durationSeconds > 0 && durationSeconds <= MAX_SECONDS)) throw new JobError('Media duration must be positive and at most two hours')
    out.durationSeconds = durationSeconds
  }
  if (kind === 'video') {
    const fps = parseRate(video!.avg_frame_rate)
    const frames = Number(video!.nb_read_packets)
    if (!Number.isFinite(fps) || fps <= 0 || !Number.isInteger(frames) || frames <= 0) throw new JobError(INVALID_TIMING)
    out.sourceFps = fps
    out.sourceFrames = frames
    if (stamps) {
      if (!constantFrameTiming(stamps, fps, extension)) throw new JobError(VARIABLE_RATE)
      if (stamps.length !== frames) throw new JobError(UNVERIFIED_TIMING)
    }
  }
  return out
}

/** The asset the editor keeps for these measurements, checked against the engine's schema. Pure. */
export function buildAsset(
  m: Measured,
  file: { sha256: string; bytes: number },
  meta: { name: string; waveform?: number[]; sourceCursorHidden?: boolean; trace?: unknown; provenance?: Record<string, unknown> },
): EditorAsset {
  const asset: Record<string, unknown> = {
    id: file.sha256,
    name: meta.name.trim().slice(0, 250) || 'Untitled',
    kind: m.kind,
    file: `assets/${file.sha256}.${m.extension}`,
    sha256: file.sha256,
    bytes: file.bytes,
    hasAudio: m.hasAudio,
    sourceCursorHidden: meta.sourceCursorHidden === true,
  }
  if (m.width !== undefined) asset.width = m.width
  if (m.height !== undefined) asset.height = m.height
  if (m.durationSeconds !== undefined) asset.durationSeconds = m.durationSeconds
  if (m.sourceFps !== undefined) asset.sourceFps = m.sourceFps
  if (m.sourceFrames !== undefined) asset.sourceFrames = m.sourceFrames
  if (m.hasAudio && meta.waveform && meta.waveform.length > 0) asset.waveform = meta.waveform.slice(0, 2000)
  if (meta.trace !== undefined && meta.trace !== null) asset.trace = meta.trace
  if (meta.provenance && Object.keys(meta.provenance).length > 0) asset.provenance = meta.provenance
  const parsed = EditorAssetSchema.safeParse(asset)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(asset)'}: ${i.message}`).slice(0, 5).join('; ')
    throw new JobError(`The imported file does not make a valid asset (${issues})`)
  }
  return parsed.data
}

/** Measure a local file as the editor imports one named `name`: its kind from the name, the rest from ffprobe. */
export async function inspectFile(path: string, name: string, signal?: AbortSignal): Promise<{ measured: Measured; waveform?: number[] }> {
  const type = kindOfName(name)
  if (!type) throw new JobError(UNSUPPORTED_TYPE)
  const p = await probe(path, { countPackets: type.kind === 'video', signal })
  const stamps = type.kind === 'video' ? await videoStamps(path, signal) : null
  const measured = measure(p, type.kind, type.extension === 'jpeg' ? 'jpeg' : type.extension, stamps)
  const peaks = measured.hasAudio ? await waveform(path, signal) : undefined
  return { measured, waveform: peaks }
}

/** H.264 for the editor, in software (any machine): fast x264 at a high quality. */
export function x264Args(): string[] {
  return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16']
}

/**
 * A recording at a steady `fps` as H.264/AAC MP4, whatever it came as (a
 * browser's WebM with a variable rate and no duration, a phone's MOV): every
 * frame on the grid, the sound resampled onto the picture's clock. Sizes are
 * made even (H.264 in 4:2:0 needs it).
 */
export async function conformVideo(input: string, out: string, fps: 30 | 60, opts: { seconds?: number; signal?: AbortSignal } = {}): Promise<void> {
  await run(
    'ffmpeg',
    [
      '-nostdin', '-v', 'error', '-xerror', '-fflags', '+genpts', '-y', '-i', input,
      '-map', '0:v:0', '-map', '0:a:0?',
      '-vf', `fps=${fps},scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p`, '-fps_mode', 'cfr',
      ...x264Args(), '-g', String(fps),
      '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2', '-af', 'aresample=async=1:first_pts=0',
      '-movflags', '+faststart', out,
    ],
    { timeout: mediaTimeout(opts.seconds ?? 600, 6), maxBuffer: 4 * 1024 * 1024, signal: opts.signal },
  )
}

/**
 * A browser's WebM or Matroska often says nothing of its duration (it was
 * written as it was recorded). Copying it into a fresh file of the same kind
 * writes the duration and the index, and changes no frame.
 */
export async function remux(input: string, out: string, signal?: AbortSignal): Promise<void> {
  await run('ffmpeg', ['-nostdin', '-v', 'error', '-fflags', '+genpts', '-y', '-i', input, '-map', '0', '-c', 'copy', out], {
    timeout: 600_000,
    maxBuffer: 4 * 1024 * 1024,
    signal,
  })
}

/** Whether a sound-only container's sound can go into an .m4a as it is: AAC already in an MP4-family file. Pure. */
export function aacCopyable(p: Probe, extension: string): boolean {
  return ['mp4', 'mov'].includes(extension) && p.streams.find((s) => s.codec_type === 'audio')?.codec_name === 'aac'
}

/**
 * A sound-only container (a browser's microphone take) as the editor's audio,
 * AAC in .m4a: AAC is copied as it is, anything else (Opus) is encoded at
 * 160 kb/s with its gaps filled with silence, so it keeps time with the take.
 * Either way the file is written afresh, which also writes the duration and
 * index a browser's WebM leaves out.
 */
export async function audioToM4a(input: string, out: string, opts: { copy: boolean; seconds?: number; signal?: AbortSignal }): Promise<void> {
  await run(
    'ffmpeg',
    [
      '-nostdin', '-v', 'error', '-fflags', '+genpts', '-y', '-i', input,
      '-map', '0:a:0', '-vn',
      ...(opts.copy ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '160k', '-af', 'aresample=async=1:first_pts=0']),
      '-movflags', '+faststart', out,
    ],
    { timeout: mediaTimeout(opts.seconds ?? 600, 2), maxBuffer: 4 * 1024 * 1024, signal: opts.signal },
  )
}

/** True when a probe gives no usable duration for the picture (or, without one, the file). */
export function missingDuration(p: Probe): boolean {
  const video = pictureStream(p)
  const d = Number(video?.duration ?? p.format.duration)
  return !(d > 0) || !Number.isFinite(d)
}

/**
 * Decode the opening and the closing seconds: a truncated or damaged file fails
 * there, and the cost stays flat however long the take.
 */
export async function verifyDecodes(file: string, durationSeconds: number, signal?: AbortSignal): Promise<void> {
  const edge = ['-nostdin', '-v', 'error', '-xerror']
  await run('ffmpeg', [...edge, '-t', '1.5', '-i', file, '-map', '0', '-f', 'null', '-'], { timeout: 120_000, signal })
  if (durationSeconds > 3) await run('ffmpeg', [...edge, '-ss', String(Math.max(0, durationSeconds - 1.5)), '-i', file, '-map', '0', '-f', 'null', '-'], { timeout: 120_000, signal })
}

export const CONTENT_TYPES: Record<string, string> = {
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', ogg: 'audio/ogg',
}
export const contentTypeOf = (file: string) => CONTENT_TYPES[(/\.([^./]+)$/.exec(file)?.[1] ?? '').toLowerCase()] ?? 'application/octet-stream'

/**
 * Put a finished local file into the cache under its asset name and store it as
 * the asset's blob. The file is moved, not copied.
 */
export async function publishAsset(ctx: JobContext, asset: EditorAsset, local: string): Promise<void> {
  const cached = ctx.cache.pathOf(asset.file)
  await rename(local, cached)
  const release = ctx.cache.pin([asset.file])
  try {
    await ctx.client.writeBlob(ctx.job.id, asset.file, cached, contentTypeOf(asset.file), { sha256: asset.sha256, signal: ctx.signal })
  } finally {
    release()
  }
}

/**
 * Every asset a project names, in the cache and checked against its sha256 (a
 * download is checked as it arrives; a cached copy by its size, and by its
 * digest when `rehash`). Returns a function that lets the cache evict them again.
 */
export async function stageAssets(ctx: JobContext, assets: readonly EditorAsset[], onProgress: (fraction: number) => void, opts: { rehash?: boolean } = {}): Promise<() => void> {
  const release = ctx.cache.pin(assets.map((a) => a.file))
  try {
    const total = assets.reduce((n, a) => n + a.bytes, 0) || 1
    let done = 0
    let fetched = 0
    for (const asset of assets) {
      checkAborted(ctx.signal)
      let path = await ctx.cache.lookup(asset.file, asset.bytes)
      if (path && opts.rehash && (await fileSha256(path)) !== asset.sha256) path = null
      if (!path) {
        path = ctx.cache.pathOf(asset.file)
        await ctx.client.readBlob(ctx.job.id, asset.file, path, { expectSha256: asset.sha256, signal: ctx.signal })
        fetched++
      }
      if ((await stat(path)).size !== asset.bytes) throw new JobError(`Asset ${asset.name} changed while staging (its size differs)`)
      done += asset.bytes
      onProgress(done / total)
    }
    ctx.log(`Assets ready: ${assets.length} (${fetched} downloaded, ${assets.length - fetched} from the cache)`)
    return release
  } catch (err) {
    release()
    throw err
  }
}
