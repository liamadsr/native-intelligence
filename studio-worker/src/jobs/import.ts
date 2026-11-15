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
 * already is one; with `conform.fit` the rate is the most, and a recording whose
 * frames came 45 a second or fewer on average is made 30 fps (no frame is made
 * up to fill 60). A recording already made so (the Mac app's recorder writes its
 * pictures that way) is kept, its frames copied, not encoded: only once
 * ffprobe shows it holds everything the editor and the fast export rely on
 * (recorder-files.ts readyProblem); any check that fails, and it is conformed.
 * A recording brought back after a crash (`input.partial`) may
 * end mid-frame: it is kept only when every check passes all the same (the
 * Mac app's pieces end on whole segments), else its conform reads past damage
 * at the end. A browser's WebM or
 * Matroska that does not say how long it is is copied into a fresh file first,
 * which writes its duration and index.
 *
 * A container with sound and no picture is audio whatever its name says (a
 * browser's microphone take: Opus in WebM, AAC in MP4): it is stored as the
 * editor's audio, AAC in .m4a (AAC copied, anything else encoded), which also
 * writes the duration a browser's WebM leaves out. A recording to conform must
 * have a picture. A fragmented M4A (the Mac app's microphone, written as it
 * records) is copied into a plain one, its index at the front.
 *
 * The asset is named by the sha256 of its final bytes (`assets/<sha256>.<ext>`),
 * stored as that blob, kept in the cache, and handed back for the app to register.
 */
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { aacCopyable, audioToM4a, buildAsset, conformVideo, inspectFile, missingDuration, publishAsset, remux, verifyDecodes } from '../assets.ts'
import { fileSha256 } from '../app-client.ts'
import { audioOnly, conformRate, fitRate, kindOfName, pictureStream, probe, TIMING_REFUSALS, UNSUPPORTED_TYPE, videoStamps } from '../media.ts'
import { fragmented, readyCheck, rewrap } from '../recorder-files.ts'
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
  // The recorder's hash of the file it wrote (the Mac app): only a refusal. Bytes that differ from the recording (a
  // piece lost or damaged on the way) are not imported; the take stays on the computer to be sent again.
  if (input.expectSha256 && read.sha256 !== input.expectSha256) {
    throw new JobError('The recording that reached the Studio is not the one on your computer (its bytes differ). It is kept on your computer: send it again.')
  }
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
      await audioToM4a(upload, out, { copy, seconds: Number(first.format.duration) || input.durationHint || 600, signal: ctx.signal })
      provenance.rawSha256 = read.sha256
      provenance.rawBytes = read.bytes
      file = out
      name = name.replace(/\.[^.]+$/, '') + '.m4a'
    } else if (!video) {
      throw new JobError(input.conform && audioOnly(first) ? 'The recording has sound but no picture' : 'Media does not match its file type')
    } else if (input.conform) {
      const seconds = Number(video.duration ?? first.format.duration) || input.durationHint || 600
      // One pass over the packets' times: the rate the take was recorded at, and whether it is on the grid already.
      const stamps = await videoStamps(upload, ctx.signal)
      const fps = input.conform.fit ? fitRate(stamps, input.conform.fps, input.conform.ceiling) : input.conform.fps
      // A take already what the conform would make (the Mac app's recorder writes it so) is kept, its frames copied.
      // Also one brought back after a crash: the Mac app's pieces are whole segments, so it ends on a whole frame;
      // one that does not (cut mid-segment) fails a check and is conformed, reading past the damage at its end.
      const kept = type.extension === 'mp4' ? await keepRecording(upload, join(ctx.scratch, 'kept.mp4'), fps, seconds, ctx) : null
      if (kept) {
        if (kept !== upload) {
          provenance.rawSha256 = read.sha256
          provenance.rawBytes = read.bytes
        }
        provenance.keptAtFps = fps
        file = kept
      } else {
        ctx.log(`Conforming the recording to a constant ${fps} fps (H.264/AAC)${input.partial ? ': it stopped before it was finished, so its end is read as far as it goes' : ''}`)
        const out = join(ctx.scratch, 'conformed.mp4')
        await conformVideo(upload, out, fps, { seconds, signal: ctx.signal, lenient: input.partial === true })
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
  } else if (type.kind === 'audio' && input.provenance?.recorder === 'desktop' && (await fragmentedMp4(upload, type.extension))) {
    // Only the Mac app's own sound (AAC in fragments, as its recorder writes it) is copied into a plain M4A, for quick
    // seeking. Anything else, or a copy that fails (a take cut mid-frame by a crash), is imported as it is, as always.
    const p = await probe(upload, { signal: ctx.signal }).catch(() => null)
    if (p?.streams.length === 1 && p.streams[0]!.codec_type === 'audio' && p.streams[0]!.codec_name === 'aac') {
      const out = join(ctx.scratch, 'rewrapped.m4a')
      try {
        await rewrap(upload, out, { audioOnly: true, seconds: input.durationHint || 600, signal: ctx.signal })
        ctx.log('The sound was written as it recorded (fragmented): copied into a plain M4A, untouched')
        provenance.rawSha256 = read.sha256
        provenance.rawBytes = read.bytes
        file = out
        name = name.replace(/\.[^.]+$/, '') + '.m4a'
      } catch (err) {
        checkAborted(ctx.signal)
        ctx.log(`The sound could not be copied into a plain M4A (${err instanceof Error ? err.message : String(err)}): imported as it is`)
      }
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

/** An MP4-family file (by its name) written in fragments. */
async function fragmentedMp4(path: string, extension: string): Promise<boolean> {
  return ['mp4', 'mov', 'm4a'].includes(extension) && (await fragmented(path).catch(() => false))
}

/**
 * The recording at `upload` kept as it is, when it already is what the conform would make at `fps`: checked
 * (readyCheck), copied into a plain MP4 at `out` (a fragmented one: rewrap), and the copy checked again. Null, with
 * the reason in the job's log, when any check fails: then it is conformed.
 */
async function keepRecording(upload: string, out: string, fps: 30 | 60, seconds: number, ctx: Parameters<JobHandler<'import'>>[0]): Promise<string | null> {
  const why = await readyCheck(upload, fps, ctx.signal).catch((err: unknown) => {
    checkAborted(ctx.signal)
    return `it could not be read (${err instanceof Error ? err.message : String(err)})`
  })
  if (why) {
    ctx.log(`The recording is not kept as it is: ${why}`)
    return null
  }
  if (!(await fragmented(upload).catch(() => false))) {
    ctx.log(`The recording is already a constant ${fps} fps H.264 MP4: kept as it is`)
    return upload
  }
  try {
    await rewrap(upload, out, { seconds, signal: ctx.signal })
  } catch (err) {
    checkAborted(ctx.signal)
    ctx.log(`The recording is not kept as it is: it could not be copied (${err instanceof Error ? err.message : String(err)})`)
    return null
  }
  const again = await readyCheck(out, fps, ctx.signal)
  if (again) {
    ctx.log(`The recording is not kept as it is: its copy failed a check (${again})`)
    return null
  }
  ctx.log(`The recording is already a constant ${fps} fps H.264 MP4: kept, its frames copied into a plain MP4, nothing encoded`)
  return out
}
