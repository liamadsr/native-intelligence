/**
 * export: a video renders to MP4.
 *
 * The edit frozen in the job is checked against the engine's schema, every asset
 * it names is staged (downloaded once into the cache, checked against its
 * sha256). A video that is only a recording, its cuts and its camera bubble is composed by FFmpeg (fast-export.ts;
 * STUDIO_FAST_EXPORT); any other, or a fast export that fails or fails its check against Chrome, the engine's
 * composition renders in Chrome: H.264 (BT.709, CRF 18,
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
import { dirname, join } from 'node:path'
import { parseEditorProject } from '../engine.ts'
import { stageAssets } from '../assets.ts'
import { masterFile } from '../master.ts'
import { mediaTimeout, probe, run } from '../media.ts'
import { bt709WithSwscale, COMPOSITION_ID, EXPORT_ENCODING, inputPropsFor, unstagedNeeds } from '../render.ts'
import { stageFonts } from '../fonts.ts'
import { checkCodeScenes, stageScenes } from '../scenes.ts'
import { fastExportPlan, soundOnly } from '../fast-export.ts'
import { composeSound } from '../fast-sound.ts'
import { composeFast, joinWavs, soundRanges } from '../fast-export-run.ts'
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
      const { selectComposition, renderMedia, renderStill, openBrowser, makeCancelSignal } = await import('@remotion/renderer')
      const inputProps = { ...inputPropsFor(project), fonts: fonts.faces }
      let output = join(ctx.scratch, 'video.partial.mp4')
      let started = Date.now()
      type Composition = Awaited<ReturnType<typeof selectComposition>>
      let composition: Composition | null = null

      // The FFmpeg export for a video that is only a recording and its camera (fast-export.ts); anything else, a failure
      // or a failed check, and Chrome renders it below.
      const plan = ctx.config.fastExport ? fastExportPlan(project) : { reason: 'STUDIO_FAST_EXPORT is off' }
      if ('segments' in plan) {
        const { cancel, cancelSignal } = makeCancelSignal()
        const onAbort = () => cancel()
        ctx.signal.addEventListener('abort', onAbort, { once: true })
        // One browser for everything the fast export still asks Chrome for: the composition's size, the sound's cold starts
        // and checked frames, the checked pictures (a software Chrome on the server takes seconds to start).
        let browser: Awaited<ReturnType<typeof openBrowser>> | null = null
        const chromeStart = Date.now()
        try {
          const common = await ctx.renderer.common(ctx.log, project)
          browser = await openBrowser('chrome', { browserExecutable: common.browserExecutable, chromiumOptions: common.chromiumOptions, logLevel: common.logLevel })
          const shared = { ...common, puppeteerInstance: browser }
          const c = await selectComposition({ serveUrl, id: COMPOSITION_ID, inputProps, ...shared })
          if (c.durationInFrames !== plan.frames || c.width !== plan.width || c.height !== plan.height || c.fps !== plan.fps) throw new Error('the composition is not the plan\'s size or length')
          ctx.log(`Fast export: Chrome started and the composition read in ${((Date.now() - chromeStart) / 1000).toFixed(1)} s`)
          ctx.progress(0.25)
          ctx.log(`Composing ${plan.frames} frames at ${plan.width}×${plan.height}, ${plan.fps} fps with FFmpeg (the fast export, ${plan.segments.length} clip${plan.segments.length === 1 ? '' : 's'})`)
          started = Date.now()
          const sound = { ...inputProps, project: soundOnly(project) }, perFrame = 48000 / plan.fps
          output = await composeFast({
            plan, scratch: ctx.scratch, signal: ctx.signal, log: ctx.log, progress: stage(ctx, 0.25, 0.92),
            path: (file) => join(dirname(ctx.cache.dir), file),
            sound: async (out) => {
              // Mixed here as Remotion mixes it (fast-sound.ts), its cold starts and a few checked frames by Remotion in the shared
              // browser; any doubt, and Remotion's own mix, in consecutive stretches rendered at once, a browser each, and joined.
              const window = (frameRange: [number, number], o: string) => renderMedia({ serveUrl, composition: c, inputProps: sound, ...shared, codec: 'wav', frameRange, outputLocation: o, concurrency: 1, cancelSignal })
              const own = (frameRange: [number, number], o: string) => renderMedia({ serveUrl, composition: c, inputProps: sound, ...common, codec: 'wav', frameRange, outputLocation: o, concurrency: 1, cancelSignal })
              // A browser that crashes (seen once in a while with several started at once) gets one more go.
              const retried = (frameRange: [number, number], o: string) => own(frameRange, o).catch((err) => { if (ctx.signal.aborted) throw err; return own(frameRange, o) })
              const whole = async (o: string) => {
                const ranges = soundRanges(plan.frames, ctx.config.renderConcurrency)
                const parts = ranges.map((_, i) => join(ctx.scratch, `fast-sound-${i}.wav`))
                await Promise.all(ranges.map((r, i) => retried(r, parts[i]!)))
                await joinWavs(ranges.map(([from, to], i) => ({ file: parts[i]!, samples: (to - from + 1) * perFrame })), o)
              }
              const probes = new Map<string, { codec?: string; sampleRate?: number; channels?: number } | null>()
              for (const a of project.assets) {
                if (a.kind === 'image') continue
                const st = (await probe(join(dirname(ctx.cache.dir), a.file), { signal: ctx.signal })).streams.find((x) => x.codec_type === 'audio') as Record<string, unknown> | undefined
                probes.set(a.file, st ? { codec: st.codec_name as string, sampleRate: Number(st.sample_rate), channels: Number(st.channels) } : null)
              }
              ctx.log(`Fast export: ${await composeSound({ project, frames: plan.frames, fps: plan.fps, path: (file) => join(dirname(ctx.cache.dir), file), out, scratch: ctx.scratch,
                probe: (file) => probes.get(file) ?? null, remotion: async (r, o) => { await window(r, o) }, whole, signal: ctx.signal, log: ctx.log })}`)
            },
            stills: async (frames) => {
              const out = new Map<number, string>()
              for (const frame of frames) {
                const png = join(ctx.scratch, `fast-check-${frame}.png`)
                await renderStill({ serveUrl, composition: c, inputProps, ...shared, frame, output: png, imageFormat: 'png', cancelSignal })
                out.set(frame, png)
              }
              return out
            },
          })
          composition = c
          ctx.log(`Composed in ${((Date.now() - started) / 1000).toFixed(1)} s`)
        } catch (err) {
          checkAborted(ctx.signal)
          ctx.log(`The fast export did not hold (${String((err as Error)?.message ?? err).split('\n')[0]!.slice(0, 300)}): rendering in Chrome instead`)
          output = join(ctx.scratch, 'video.partial.mp4')
        } finally {
          ctx.signal.removeEventListener('abort', onAbort)
          await browser?.close({ silent: true }).catch(() => undefined)
        }
      } else ctx.log(`Rendering in Chrome: ${plan.reason}`)

      // Software compositing that fails before the first frame is tried once more with swangle (render.ts, withGlFallback).
      if (!composition) composition = await ctx.renderer.withGlFallback(ctx.log, project, () => ctx.signal.aborted, async (common, frameDrawn) => {
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
      if (!output.endsWith('.fast.mp4')) ctx.log(`Rendered in ${((Date.now() - started) / 1000).toFixed(1)} s`)
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
      const decodeStart = Date.now()
      await run('ffmpeg', ['-nostdin', '-v', 'error', '-xerror', '-i', final, '-f', 'null', '-'], { timeout: mediaTimeout(seconds, 2), maxBuffer: 2 * 1024 * 1024, signal: ctx.signal })
      ctx.log(`Decode check in ${((Date.now() - decodeStart) / 1000).toFixed(1)} s`)
      ctx.progress(0.97)
      checkAborted(ctx.signal)

      const key = exportKey(ctx.job)
      const bytes = (await stat(final)).size
      if (bytes <= 0) throw new JobError('The render produced an empty file')
      ctx.log(`Storing ${key} (${(bytes / 1024 / 1024).toFixed(1)} MB)`)
      const storeStart = Date.now()
      await ctx.client.writeBlob(ctx.job.id, key, final, 'video/mp4', { signal: ctx.signal })
      ctx.log(`Stored in ${((Date.now() - storeStart) / 1000).toFixed(1)} s`)
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
