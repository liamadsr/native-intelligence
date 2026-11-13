/**
 * stills: frames of a video at given times, as PNGs (the agent's eyes, a
 * moment's thumbnail). One browser for every frame, the same bundle as exports.
 * Stored as `stills/<job id>/<n>.png`, in the order the times were given.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { EditorProject } from '../../../web/src/lib/studio/engine/contracts.ts'
import { stageAssets } from '../assets.ts'
import { COMPOSITION_ID, inputPropsFor, pngSize, unstagedNeeds } from '../render.ts'
import { frozenProject } from './export.ts'
import { checkCodeScenes, stageScenes } from '../scenes.ts'
import { checkAborted, JobError, stage, type JobContext, type JobHandler } from './context.ts'

export const MAX_STILLS = 60

/** The frame shown at `seconds`, inside the video. Pure. */
export function frameAt(seconds: number, fps: number, durationInFrames: number): number {
  const t = Number.isFinite(seconds) ? seconds : 0
  return Math.max(0, Math.min(durationInFrames - 1, Math.round(t * fps)))
}

export interface StillRequest {
  seconds: number
  output: string
}

/**
 * Render frames of `project` to image files: assets staged, the composition
 * opened once, each frame drawn at `scale`. Progress runs 0..1 through `onProgress`.
 */
export async function renderFrames(
  ctx: JobContext,
  project: EditorProject,
  requests: StillRequest[],
  opts: { scale: number; imageFormat: 'png' | 'jpeg'; jpegQuality?: number; codeScenes?: 'run' | 'placeholder' },
  onProgress: (fraction: number) => void,
): Promise<{ width: number; height: number; fps: number; durationInFrames: number }> {
  for (const line of unstagedNeeds(project)) ctx.log(line)
  // A scene's code runs only where this worker allows it; a placeholder render (a thumbnail) never loads it.
  const codeScenes = opts.codeScenes ?? 'run'
  if (codeScenes === 'run') checkCodeScenes(project, ctx.config.codeScenes)
  const releaseAssets = await stageAssets(ctx, project.assets, (f) => onProgress(0.3 * f))
  try {
    const { serveUrl, release } = await ctx.renderer.bundle(ctx.log)
    try {
      if (codeScenes === 'run') await stageScenes(ctx, project, serveUrl)
      const { openBrowser, renderStill, selectComposition, makeCancelSignal } = await import('@remotion/renderer')
      const common = await ctx.renderer.common(ctx.log, project)
      const browser = await openBrowser('chrome', { browserExecutable: common.browserExecutable, chromiumOptions: common.chromiumOptions, logLevel: common.logLevel })
      const { cancel, cancelSignal } = makeCancelSignal()
      const onAbort = () => cancel()
      ctx.signal.addEventListener('abort', onAbort, { once: true })
      try {
        const inputProps = inputPropsFor(project, codeScenes)
        const composition = await selectComposition({ serveUrl, id: COMPOSITION_ID, inputProps, ...common, puppeteerInstance: browser })
        onProgress(0.4)
        for (const [i, req] of requests.entries()) {
          checkAborted(ctx.signal)
          await renderStill({
            serveUrl,
            composition,
            inputProps,
            ...common,
            puppeteerInstance: browser,
            frame: frameAt(req.seconds, composition.fps, composition.durationInFrames),
            output: req.output,
            scale: opts.scale,
            imageFormat: opts.imageFormat,
            ...(opts.imageFormat === 'jpeg' ? { jpegQuality: opts.jpegQuality ?? 80 } : {}),
            cancelSignal,
          })
          onProgress(0.4 + (0.6 * (i + 1)) / requests.length)
        }
        return { width: composition.width, height: composition.height, fps: composition.fps, durationInFrames: composition.durationInFrames }
      } catch (err) {
        checkAborted(ctx.signal)
        throw err
      } finally {
        ctx.signal.removeEventListener('abort', onAbort)
        await browser.close({ silent: true }).catch(() => undefined)
      }
    } finally {
      release()
    }
  } finally {
    releaseAssets()
  }
}

export const runStills: JobHandler<'stills'> = async (ctx) => {
  const { times, scale } = ctx.job.input
  if (!Array.isArray(times) || times.length === 0) throw new JobError('Name at least one time')
  if (times.length > MAX_STILLS) throw new JobError(`At most ${MAX_STILLS} stills at once`)
  if (!(scale > 0 && scale <= 2)) throw new JobError('Scale must be above 0 and at most 2')
  const project = frozenProject(ctx.job.input.project)
  const requests = times.map((seconds, i) => ({ seconds, output: join(ctx.scratch, `${i}.png`) }))
  await renderFrames(ctx, project, requests, { scale, imageFormat: 'png' }, stage(ctx, 0, 0.85))
  const stills: { time: number; key: string; width: number; height: number }[] = []
  const upload = stage(ctx, 0.85, 1)
  for (const [i, req] of requests.entries()) {
    checkAborted(ctx.signal)
    const size = pngSize(await readFile(req.output))
    const key = `stills/${ctx.job.id}/${i}.png`
    await ctx.client.writeBlob(ctx.job.id, key, req.output, 'image/png', { signal: ctx.signal })
    stills.push({ time: req.seconds, key, ...size })
    upload((i + 1) / requests.length)
  }
  ctx.log(`${stills.length} still(s) stored`)
  return { stills }
}
