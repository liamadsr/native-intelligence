/**
 * Renders for the measured checks (./jobs/checks.ts), on the same bundle and
 * Chrome as exports (./render.ts), with the job's fonts staged (./fonts.ts):
 *
 *   renderPicture  a frame range of a video as an MP4, scaled (half size by
 *                  default), muted for the motion check or with its sound for
 *                  the review: what the analysis script watches.
 *   withStills     one browser for many frames of several versions of a video
 *                  (the look renders each frame with and without its overlays).
 */
import type { EditorProject } from '../../web/src/lib/studio/engine/contracts.ts'
import { stageAssets } from './assets.ts'
import { stageFonts, type FontFace } from './fonts.ts'
import { checkAborted, type JobContext } from './jobs/context.ts'
import { COMPOSITION_ID, inputPropsFor, unstagedNeeds } from './render.ts'
import { checkCodeScenes, stageScenes } from './scenes.ts'

/** A frame range inside a video of `durationInFrames`, from seconds (the whole video when left out). Pure. */
export function frameRange(durationInFrames: number, fps: number, from?: number, to?: number): [number, number] {
  const last = Math.max(0, durationInFrames - 1)
  const a = from === undefined ? 0 : Math.max(0, Math.min(last, Math.round(from * fps)))
  const b = to === undefined ? last : Math.max(a, Math.min(last, Math.round(to * fps)))
  return [a, b]
}

/**
 * Stage what every render of `project` needs (assets, the bundle, its code scenes, fonts) and run `work` with it;
 * all released after. A project with code scenes is refused where they are off (scenes.ts).
 */
async function staged<T>(
  ctx: JobContext,
  project: EditorProject,
  fontsInput: unknown,
  onProgress: (fraction: number) => void,
  work: (serveUrl: string, fonts: FontFace[]) => Promise<T>,
): Promise<T> {
  checkCodeScenes(project, ctx.config.codeScenes)
  const releaseAssets = await stageAssets(ctx, project.assets, onProgress)
  try {
    checkAborted(ctx.signal)
    const { serveUrl, release } = await ctx.renderer.bundle(ctx.log)
    await stageScenes(ctx, project, serveUrl).catch((err) => {
      release()
      throw err
    })
    const fonts = await stageFonts(ctx, fontsInput, serveUrl).catch((err) => {
      ctx.log(`Fonts could not be staged (${(err as Error).message}): text renders with the fallback stack`)
      return { faces: [] as FontFace[], release: async () => {} }
    })
    try {
      return await work(serveUrl, fonts.faces)
    } finally {
      await fonts.release()
      release()
    }
  } finally {
    releaseAssets()
  }
}

export type Picture = { file: string; fps: number; from: number; to: number; width: number; height: number; durationInFrames: number }

/**
 * The picture of `project` between `from` and `to` (seconds) as an H.264 MP4 at
 * `scale`: muted, or with its sound (AAC, a silent track when it has none, so a
 * silent video reads as silence). Progress: staging 0–10 %, rendering 10–100 %.
 */
export async function renderPicture(
  ctx: JobContext,
  project: EditorProject,
  output: string,
  opts: { scale: number; from?: number; to?: number; muted: boolean; fonts?: unknown },
  onProgress: (fraction: number) => void,
): Promise<Picture> {
  for (const line of unstagedNeeds(project)) if (!(opts.fonts && Array.isArray(opts.fonts) && opts.fonts.length && line.startsWith('Fonts '))) ctx.log(line)
  return staged(ctx, project, opts.fonts, (f) => onProgress(0.1 * f), async (serveUrl, fonts) => {
    const { selectComposition, renderMedia, makeCancelSignal } = await import('@remotion/renderer')
    const common = await ctx.renderer.common(ctx.log, project)
    const inputProps = { ...inputPropsFor(project), fonts }
    const composition = await selectComposition({ serveUrl, id: COMPOSITION_ID, inputProps, ...common })
    checkAborted(ctx.signal)
    const [from, to] = frameRange(composition.durationInFrames, composition.fps, opts.from, opts.to)
    ctx.log(`Rendering frames ${from}–${to} at ${Math.round(opts.scale * 100)} %${opts.muted ? ', no sound' : ', with sound'}`)
    const { cancel, cancelSignal } = makeCancelSignal()
    const onAbort = () => cancel()
    ctx.signal.addEventListener('abort', onAbort, { once: true })
    try {
      await renderMedia({
        serveUrl,
        composition,
        inputProps,
        ...common,
        codec: 'h264',
        pixelFormat: 'yuv420p',
        crf: 20,
        scale: opts.scale,
        frameRange: [from, to],
        outputLocation: output,
        concurrency: ctx.config.renderConcurrency,
        cancelSignal,
        ...(opts.muted ? { muted: true } : { audioCodec: 'aac' as const, enforceAudioTrack: true }),
        onProgress: ({ progress }) => onProgress(0.1 + 0.9 * progress),
      })
    } catch (err) {
      checkAborted(ctx.signal)
      throw err
    } finally {
      ctx.signal.removeEventListener('abort', onAbort)
    }
    return { file: output, fps: composition.fps, from, to, width: Math.round(composition.width * opts.scale), height: Math.round(composition.height * opts.scale), durationInFrames: composition.durationInFrames }
  })
}

/** What withStills hands its work: a video's size and length, and one frame of any version of it to a PNG. */
export type StillRenderer = {
  composition(project: EditorProject): Promise<{ fps: number; durationInFrames: number; width: number; height: number }>
  still(project: EditorProject, frame: number, output: string, scale: number): Promise<void>
}

/**
 * One browser for every frame `work` asks for, of `project` or any version of
 * it that uses no other assets (the look's versions only leave layers out).
 */
export async function withStills<T>(ctx: JobContext, project: EditorProject, fontsInput: unknown, onProgress: (fraction: number) => void, work: (render: StillRenderer) => Promise<T>): Promise<T> {
  for (const line of unstagedNeeds(project)) if (!(Array.isArray(fontsInput) && fontsInput.length && line.startsWith('Fonts '))) ctx.log(line)
  return staged(ctx, project, fontsInput, onProgress, async (serveUrl, fonts) => {
    const { openBrowser, renderStill, selectComposition, makeCancelSignal } = await import('@remotion/renderer')
    const common = await ctx.renderer.common(ctx.log, project)
    const browser = await openBrowser('chrome', { browserExecutable: common.browserExecutable, chromiumOptions: common.chromiumOptions, logLevel: common.logLevel })
    const { cancel, cancelSignal } = makeCancelSignal()
    const onAbort = () => cancel()
    ctx.signal.addEventListener('abort', onAbort, { once: true })
    const opened = new WeakMap<EditorProject, Awaited<ReturnType<typeof selectComposition>>>()
    const open = async (p: EditorProject) => {
      let c = opened.get(p)
      if (!c) {
        c = await selectComposition({ serveUrl, id: COMPOSITION_ID, inputProps: { ...inputPropsFor(p), fonts }, ...common, puppeteerInstance: browser })
        opened.set(p, c)
      }
      return c
    }
    try {
      return await work({
        composition: async (p) => {
          const c = await open(p)
          return { fps: c.fps, durationInFrames: c.durationInFrames, width: c.width, height: c.height }
        },
        still: async (p, frame, output, scale) => {
          checkAborted(ctx.signal)
          const composition = await open(p)
          await renderStill({
            serveUrl,
            composition,
            inputProps: { ...inputPropsFor(p), fonts },
            ...common,
            puppeteerInstance: browser,
            frame: Math.max(0, Math.min(composition.durationInFrames - 1, frame)),
            output,
            scale,
            imageFormat: 'png',
            cancelSignal,
          })
        },
      })
    } catch (err) {
      checkAborted(ctx.signal)
      throw err
    } finally {
      ctx.signal.removeEventListener('abort', onAbort)
      await browser.close({ silent: true }).catch(() => undefined)
    }
  })
}
