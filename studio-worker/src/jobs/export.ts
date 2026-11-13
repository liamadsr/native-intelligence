/**
 * export: a video renders to MP4.
 *
 * The edit frozen in the job is checked against the engine's schema, every asset
 * it names is staged (downloaded once into the cache, checked against its
 * sha256), and the engine's composition renders it in Chrome: H.264 (BT.709, CRF 18,
 * x264 veryfast: render.ts, EXPORT_ENCODING), AAC, yuv420p, in as many tabs as the
 * worker's CPUs make worth it (config.ts, renderTabs), Chrome compositing in software on
 * Linux (render.ts, glFor). With a loudness target the soundtrack is mastered (two-pass
 * loudnorm). The whole file is then decoded once (`-xerror`): a broken MP4 never
 * reaches the library. Stored as `exports/<job id>/<attempt>/video.mp4`: a worker
 * that lost the job (it went quiet and the job was claimed again) can never
 * overwrite the next attempt's file, and the app takes only this attempt's.
 *
 * Progress: staging 0–15 %, bundling and opening the composition 15–25 %,
 * rendering 25–92 %, mastering and the decode check 92–97 %, the upload the rest.
 */
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { parseEditorProject } from '../engine.ts'
import { stageAssets } from '../assets.ts'
import { masterFile } from '../master.ts'
import { mediaTimeout, probe, run } from '../media.ts'
import { bt709WithSwscale, COMPOSITION_ID, EXPORT_ENCODING, inputPropsFor, unstagedNeeds } from '../render.ts'
import { stageFonts } from '../fonts.ts'
import { checkCodeScenes, stageScenes } from '../scenes.ts'
import { checkAborted, JobError, stage, type JobHandler } from './context.ts'

/** The project as the job froze it, checked (the engine's own migration and rules). */
export function frozenProject(value: unknown) {
  try {
    return structuredClone(parseEditorProject(value))
  } catch (err) {
    const issues = (err as { issues?: { path: (string | number)[]; message: string }[] }).issues
    const detail = issues ? issues.slice(0, 5).map((i) => `${i.path.join('.') || '(project)'}: ${i.message}`).join('; ') : (err as Error).message
    throw new JobError(`The project is not valid: ${detail}`.slice(0, 1000))
  }
}

/** Where an attempt of an export job stores its video (the app refuses any other key). Pure. */
export const exportKey = (job: { id: string; attempts: number }) => `exports/${job.id}/${job.attempts}/video.mp4`

export const runExport: JobHandler<'export'> = async (ctx) => {
  const project = frozenProject(ctx.job.input.project)
  // Code scenes run their code in the render's Chrome only where this worker allows it (scenes.ts).
  checkCodeScenes(project, ctx.config.codeScenes)
  // Fonts the job carries are staged below; the line about unstaged fonts is for jobs without them.
  for (const line of unstagedNeeds(project)) if (!(ctx.job.input.fonts?.length && line.startsWith('Fonts '))) ctx.log(line)
  ctx.log('Verifying frozen project assets')
  // A cached copy is hashed again: what renders is exactly what the project froze.
  const releaseAssets = await stageAssets(ctx, project.assets, stage(ctx, 0, 0.15), { rehash: true })
  try {
    checkAborted(ctx.signal)
    const { serveUrl, release } = await ctx.renderer.bundle(ctx.log)
    await stageScenes(ctx, project, serveUrl).catch((err) => {
      release()
      throw err
    })
    const fonts = await stageFonts(ctx, ctx.job.input.fonts, serveUrl).catch((err) => {
      ctx.log(`Fonts could not be staged (${(err as Error).message}): text renders with the fallback stack`)
      return { faces: [], release: async () => {} }
    })
    try {
      ctx.progress(0.2)
      const { selectComposition, renderMedia, makeCancelSignal } = await import('@remotion/renderer')
      const inputProps = { ...inputPropsFor(project), fonts: fonts.faces }
      const output = join(ctx.scratch, 'video.partial.mp4')
      let started = Date.now()
      // Software compositing that fails before the first frame is tried once more with swangle (render.ts, withGlFallback).
      const composition = await ctx.renderer.withGlFallback(ctx.log, project, () => ctx.signal.aborted, async (common, frameDrawn) => {
        const composition = await selectComposition({ serveUrl, id: COMPOSITION_ID, inputProps, ...common })
        checkAborted(ctx.signal)
        ctx.progress(0.25)
        ctx.log(`Rendering ${composition.durationInFrames} frames at ${composition.width}×${composition.height}, ${composition.fps} fps (${ctx.config.renderConcurrency} tabs)`)
        const { cancel, cancelSignal } = makeCancelSignal()
        const onAbort = () => cancel()
        ctx.signal.addEventListener('abort', onAbort, { once: true })
        started = Date.now()
        try {
          const renderProgress = stage(ctx, 0.25, 0.92)
          await renderMedia({
            serveUrl,
            composition,
            inputProps,
            ...common,
            ...EXPORT_ENCODING,
            ffmpegOverride: bt709WithSwscale,
            outputLocation: output,
            concurrency: ctx.config.renderConcurrency,
            cancelSignal,
            onProgress: ({ progress, renderedFrames }) => {
              if (renderedFrames > 0) frameDrawn()
              renderProgress(progress)
            },
          })
        } catch (err) {
          checkAborted(ctx.signal)
          throw err
        } finally {
          ctx.signal.removeEventListener('abort', onAbort)
        }
        return composition
      })
      ctx.log(`Rendered in ${((Date.now() - started) / 1000).toFixed(1)} s`)
      checkAborted(ctx.signal)

      const seconds = composition.durationInFrames / composition.fps
      let final = output
      const master = ctx.job.input.master ?? project.master
      if (master) {
        const hasAudio = (await probe(output, { signal: ctx.signal })).streams.some((s) => s.codec_type === 'audio')
        if (hasAudio) {
          ctx.log(`Mastering the soundtrack to ${master.lufs} LUFS`)
          const mastered = join(ctx.scratch, 'video.mastered.mp4')
          await masterFile(output, mastered, master, ctx.signal)
          final = mastered
        } else ctx.log('Nothing to master: the video has no sound')
      }
      ctx.progress(0.94)
      ctx.log('Checking complete MP4 decode')
      await run('ffmpeg', ['-nostdin', '-v', 'error', '-xerror', '-i', final, '-f', 'null', '-'], { timeout: mediaTimeout(seconds, 2), maxBuffer: 2 * 1024 * 1024, signal: ctx.signal })
      ctx.progress(0.97)
      checkAborted(ctx.signal)

      const key = exportKey(ctx.job)
      const bytes = (await stat(final)).size
      if (bytes <= 0) throw new JobError('The render produced an empty file')
      ctx.log(`Storing ${key} (${(bytes / 1024 / 1024).toFixed(1)} MB)`)
      await ctx.client.writeBlob(ctx.job.id, key, final, 'video/mp4', { signal: ctx.signal })
      ctx.progress(1)
      ctx.log('Export complete')
      return { key, bytes, width: composition.width, height: composition.height, fps: composition.fps, durationSeconds: seconds }
    } finally {
      await fonts.release()
      release()
    }
  } finally {
    releaseAssets()
  }
}
