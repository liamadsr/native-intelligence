/**
 * import: an uploaded file becomes a library asset.
 *
 * The upload is measured as the editor imports media: a video must keep a
 * constant frame rate (every frame one frame after the last) and its packets
 * must all be counted; images and audio are taken as they are. A plain video
 * whose frames do not keep time (a phone video, a screen recording) is
 * conformed as a recording is, to 60 fps when its average rate is above 45,
 * else 30, and the job log says so. A recording
 * (`input.conform`) is first made a steady 30 or 60 fps H.264/AAC MP4, unless it
 * already is one. A browser's WebM or Matroska that does not say how long it is
 * is copied into a fresh file first, which writes its duration and index.
 *
 * A container with sound and no picture is audio whatever its name says (a
 * browser's microphone take: Opus in WebM, AAC in MP4): it is stored as the
 * editor's audio, AAC in .m4a (AAC copied, anything else encoded), which also
 * writes the duration a browser's WebM leaves out. A recording to conform must
 * have a picture.
 *
 * The asset is named by the sha256 of its final bytes (`assets/<sha256>.<ext>`),
 * stored as that blob, kept in the cache, and handed back for the app to register.
 */
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { aacCopyable, audioToM4a, buildAsset, conformVideo, inspectFile, missingDuration, publishAsset, remux, verifyDecodes } from '../assets.ts'
import { fileSha256 } from '../app-client.ts'
import { audioOnly, conformRate, kindOfName, onFrameGrid, pictureStream, probe, TIMING_REFUSALS, UNSUPPORTED_TYPE, videoStamps } from '../media.ts'
import { checkAborted, JobError, type JobHandler } from './context.ts'

/** The longest upload taken, as the editor's own presenter import (2 GB). */
export const MAX_UPLOAD_BYTES = 2 * 1024 ** 3

export const runImport: JobHandler<'import'> = async (ctx) => {
  const input = ctx.job.input
  const type = kindOfName(input.name)
  if (!type) throw new JobError(UNSUPPORTED_TYPE)
  const upload = join(ctx.scratch, `upload.${type.extension}`)
  ctx.log(`Downloading ${input.name}`)
  const read = await ctx.client.readBlob(ctx.job.id, input.uploadKey, upload, { signal: ctx.signal })
  if (read.bytes <= 0 || read.bytes > MAX_UPLOAD_BYTES) throw new JobError('Uploads must be nonempty and at most 2 GB')
  ctx.progress(0.15)
  checkAborted(ctx.signal)

  let file = upload
  let name = input.name
  const provenance: Record<string, unknown> = { ...(input.provenance ?? {}) }

  if (type.kind === 'video') {
    const first = await probe(upload, { signal: ctx.signal })
    const video = pictureStream(first)
    if (!video && audioOnly(first) && !input.conform) {
      const copy = aacCopyable(first, type.extension)
      ctx.log(`${input.name} has sound and no picture: importing it as audio, ${copy ? 'its AAC copied' : 'encoded as AAC'} into an .m4a`)
      const out = join(ctx.scratch, 'audio.m4a')
      await audioToM4a(upload, out, { copy, seconds: Number(first.format.duration) || 600, signal: ctx.signal })
      provenance.rawSha256 = read.sha256
      provenance.rawBytes = read.bytes
      file = out
      name = name.replace(/\.[^.]+$/, '') + '.m4a'
    } else if (!video) {
      throw new JobError(input.conform && audioOnly(first) ? 'The recording has sound but no picture' : 'Media does not match its file type')
    } else if (input.conform) {
      const seconds = Number(video.duration ?? first.format.duration) || 600
      const fps = input.conform.fps
      // A take already on the grid, in H.264 inside MP4, is kept byte for byte.
      const keep = type.extension === 'mp4' && video.codec_name === 'h264' && onFrameGrid(await videoStamps(upload, ctx.signal), fps)
      if (!keep) {
        ctx.log(`Conforming the recording to a constant ${fps} fps (H.264/AAC)`)
        const out = join(ctx.scratch, 'conformed.mp4')
        await conformVideo(upload, out, fps, { seconds, signal: ctx.signal })
        provenance.rawSha256 = read.sha256
        provenance.rawBytes = read.bytes
        provenance.normalizedCfrFps = fps
        file = out
        name = name.replace(/\.[^.]+$/, '') + '.mp4'
      }
    } else if ((type.extension === 'webm' || type.extension === 'mkv') && missingDuration(first)) {
      ctx.log('The file does not say how long it is (a browser recording): writing its duration and index')
      const out = join(ctx.scratch, `remuxed.${type.extension}`)
      await remux(upload, out, ctx.signal)
      file = out
    }
  }
  ctx.progress(0.6)
  checkAborted(ctx.signal)

  let inspected: Awaited<ReturnType<typeof inspectFile>>
  /** Conformed here because its frame rate varied (a recording to conform is checked the same way below). */
  let conformed = false
  try {
    inspected = await inspectFile(file, name, ctx.signal)
  } catch (err) {
    // A plain video whose frames do not keep time is conformed, as a recording is; a file that can't be refuses as it did.
    if (type.kind !== 'video' || input.conform || !(err instanceof JobError) || !TIMING_REFUSALS.includes(err.message)) throw err
    const p = await probe(file, { countPackets: true, signal: ctx.signal })
    const fps = conformRate(p)
    const out = join(ctx.scratch, 'conformed.mp4')
    try {
      await conformVideo(file, out, fps, { seconds: Number(pictureStream(p)?.duration ?? p.format.duration) || 600, signal: ctx.signal })
    } catch {
      checkAborted(ctx.signal)
      throw err
    }
    ctx.log(`This file's frame rate varied, so it was converted to a constant ${fps} frames a second.`)
    provenance.rawSha256 = read.sha256
    provenance.rawBytes = read.bytes
    provenance.normalizedCfrFps = fps
    file = out
    name = name.replace(/\.[^.]+$/, '') + '.mp4'
    conformed = true
    inspected = await inspectFile(file, name, ctx.signal)
  }
  const { measured, waveform } = inspected
  if (measured.kind === 'video' && (input.conform || conformed)) await verifyDecodes(file, measured.durationSeconds ?? 0, ctx.signal)
  ctx.progress(0.75)
  const sha256 = await fileSha256(file)
  const bytes = (await stat(file)).size
  const asset = buildAsset(measured, { sha256, bytes }, {
    // A conformed recording or a sound-only container is named for what it now is (an MP4, an M4A).
    name,
    waveform,
    sourceCursorHidden: input.sourceCursorHidden,
    trace: input.trace,
    provenance,
  })
  ctx.log(`Storing ${asset.file} (${(bytes / 1024 / 1024).toFixed(1)} MB)`)
  await publishAsset(ctx, asset, file)
  ctx.progress(1)
  return { asset }
}
