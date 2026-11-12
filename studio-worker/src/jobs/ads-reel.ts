/**
 * ads-reel: a 9:16 reel from a Studio project's own footage and brand kit
 * (../ads/reel.ts): shots cut together with a slow push, type beats in the
 * static ads' styles, an end card. The reel and its strip are stored as
 * library assets; its notes under ads/<job id>/notes.md.
 *
 * Progress: staging 0–10 %, the render 10–90 %, storing the rest.
 */
import { join } from 'node:path'
import { stageAssets } from '../assets.ts'
import { launchBrowser } from '../ads/browser.ts'
import { renderReel } from '../ads/reel.ts'
import { ReelSpecSchema } from '../engine.ts'
import { checked, publishMade, stageKit } from './ads-static.ts'
import { checkAborted, JobError, stage, type JobHandler } from './context.ts'

export const runAdsReel: JobHandler<'ads-reel'> = async (ctx) => {
  const { kit: jobKit, media, projectId } = ctx.job.input
  const spec = checked('reel', ReelSpecSchema, ctx.job.input.spec)
  ctx.log(`Reel ${spec.id}: ${spec.shots.length} shot(s), ${spec.beats.length} beat(s)`)
  const sources = [...new Set([...spec.shots.map((s) => s.src), ...Object.values(spec.people ?? {}).flatMap((p) => (p.matte ? [p.matte] : []))])]
  const assets = sources.map((src) => {
    const a = media[src]
    if (!a) throw new JobError(`The reel names "${src}", which is not in the job's media`)
    if (a.kind !== 'video') throw new JobError(`"${a.name}" is not a video`)
    return a
  })
  const releaseMedia = await stageAssets(ctx, assets, stage(ctx, 0, 0.08))
  const { kit, release: releaseKit } = await stageKit(ctx, jobKit)
  const browser = await launchBrowser(ctx)
  try {
    checkAborted(ctx.signal)
    const out = join(ctx.scratch, 'out')
    const made = await renderReel({
      kit, spec, media: new Map(sources.map((s) => [s, ctx.cache.pathOf(media[s]!.file)])),
      root: ctx.scratch, work: join(ctx.scratch, 'work'), out, browser, log: ctx.log, progress: stage(ctx, 0.1, 0.9), signal: ctx.signal,
    })
    const title = spec.title ?? spec.id
    const provenance = (part: string) => ({ studioAds: { kind: 'reel', projectId, reelId: spec.id, part, jobId: ctx.job.id } })
    const render = await publishMade(ctx, made.file, `${title} · ${spec.id} reel.mp4`.slice(0, 250), provenance('reel'))
    const strip = await publishMade(ctx, made.strip, `${title} · ${spec.id} strip.jpg`.slice(0, 250), provenance('strip'))
    const notesKey = `ads/${ctx.job.id}/notes.md`
    await ctx.client.writeBlob(ctx.job.id, notesKey, join(out, 'notes.md'), 'text/markdown; charset=utf-8', { signal: ctx.signal })
    ctx.progress(1)
    return { reelId: spec.id, title, seconds: made.seconds, render, strip, notes: [...jobKit.fontNotes, ...made.notes], files: { notes: notesKey } }
  } finally {
    await browser.close().catch(() => undefined)
    releaseKit()
    releaseMedia()
  }
}
