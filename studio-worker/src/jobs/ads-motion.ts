/**
 * ads-motion: a motion ad from a brief and a Studio project's brand kit.
 *
 * The background segments (library clips and photos), the sounds the brief
 * names (from the kit's sound library) and the kit itself are staged; the ad
 * is rendered (../ads/motion.ts); and everything it made is stored as library
 * assets: the 9:16 MP4, the 4:5 crop, the strip, and the editable parts (the
 * background, each sound, veils, logos). The parts come back with asset ids
 * for the app to turn into an editable video in the same Studio project. The
 * report and the brief are stored under ads/<job id>/.
 *
 * Progress: staging 0–10 %, the render 10–85 %, storing the rest.
 */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { EditorAsset } from '../../../web/src/lib/studio/engine/contracts.ts'
import type { MotionPart, MotionParts } from '../../../web/src/lib/studio/server/ads-contract.ts'
import { stageAssets } from '../assets.ts'
import { launchBrowser } from '../ads/browser.ts'
import { renderMotion, type MotionMedia } from '../ads/motion.ts'
import { MotionBriefSchema } from '../engine.ts'
import { checked, checkedJobKit, publishMade, stageKit } from './ads-static.ts'
import { checkAborted, JobError, stage, type JobHandler } from './context.ts'

export const runAdsMotion: JobHandler<'ads-motion'> = async (ctx) => {
  const { media, sounds, projectId } = ctx.job.input
  const brief = checked('brief', MotionBriefSchema, ctx.job.input.brief)
  const jobKit = checkedJobKit(ctx.job.input.kit)
  ctx.log(`Motion ad ${brief.id}: ${brief.template}, ${brief.seconds} s`)
  const staging = stage(ctx, 0, 0.1)
  const sources = [...new Set(brief.background.map((s) => (s.clip ?? s.still)!))]
  const backgrounds = sources.map((src) => {
    const a = media[src]
    if (!a) throw new JobError(`The brief names "${src}", which is not in the job's media`)
    return a
  })
  const soundAssets = Object.values(sounds)
  const releaseMedia = await stageAssets(ctx, [...backgrounds, ...soundAssets], (f) => staging(0.7 * f))
  const { kit, release: releaseKit } = await stageKit(ctx, jobKit)
  staging(1)
  const browser = await launchBrowser(ctx)
  try {
    checkAborted(ctx.signal)
    const staged = new Map<string, MotionMedia>(sources.map((src) => [src, { path: ctx.cache.pathOf(media[src]!.file), kind: media[src]!.kind === 'video' ? 'video' : 'image' }]))
    const out = join(ctx.scratch, 'out')
    await mkdir(out, { recursive: true })
    const made = await renderMotion({
      kit,
      brief,
      media: staged,
      sounds: new Map(Object.entries(sounds).map(([name, a]) => [name, ctx.cache.pathOf(a.file)])),
      editorFamilies: jobKit.editorFamilies,
      root: ctx.scratch,
      work: join(ctx.scratch, 'work'),
      out,
      browser,
      log: ctx.log,
      progress: stage(ctx, 0.1, 0.85),
      signal: ctx.signal,
    })
    checkAborted(ctx.signal)

    // Everything made becomes a library asset, named after the ad.
    const title = brief.title ?? brief.id
    const provenance = (part: string) => ({ studioAds: { kind: 'motion', projectId, briefId: brief.id, part, jobId: ctx.job.id } })
    const assets: EditorAsset[] = []
    const store = async (file: string, name: string, part: string) => {
      const asset = await publishMade(ctx, file, `${title} · ${name}`.slice(0, 250), provenance(part))
      if (!assets.some((a) => a.id === asset.id)) assets.push(asset)
      return asset
    }
    const upload = stage(ctx, 0.85, 1)
    const r916 = await store(made.files['9x16'], `${brief.id} 9x16.mp4`, '9x16')
    const r45 = made.files['4x5'] ? await store(made.files['4x5'], `${brief.id} 4x5.mp4`, '4x5') : undefined
    const strip = await store(made.strip, `${brief.id} strip.jpg`, 'strip')
    upload(0.4)
    const background = await store(made.parts.background, 'background.mp4', 'background')
    const audio: MotionParts['audio'] = []
    for (const a of made.parts.audio) audio.push({ name: a.name, role: a.role, assetId: (await store(a.file, `${a.name}.m4a`, 'sound')).id })
    const layers: MotionPart[] = []
    for (const l of made.parts.layers) {
      const { file, font, ...rest } = l as Record<string, unknown> & { file?: string; font?: string }
      void font
      if (l.kind === 'logo' || l.kind === 'veil') layers.push({ ...rest, assetId: (await store(String(file), `${l.name}.png`, l.kind)).id } as MotionPart)
      else layers.push(rest as MotionPart)
    }
    upload(0.8)
    const key = (name: string) => `ads/${ctx.job.id}/${name}`
    await ctx.client.writeBlob(ctx.job.id, key('report.md'), join(out, 'report.md'), 'text/markdown; charset=utf-8', { signal: ctx.signal })
    await ctx.client.writeBlob(ctx.job.id, key('brief.json'), join(out, 'brief.json'), 'application/json', { signal: ctx.signal })
    upload(1)
    const parts: MotionParts = {
      schemaVersion: 1,
      id: brief.id,
      title,
      width: 1080,
      height: 1920,
      fps: brief.fps ?? 24,
      seconds: brief.seconds,
      background: background.id,
      audio,
      fonts: [...new Set([jobKit.editorFamilies.serif, jobKit.editorFamilies.sans])],
      layers,
      baked: made.parts.baked,
      brand: { name: kit.name, colors: Object.entries(kit.palette).map(([name, hex]) => ({ name, hex })).slice(0, 24) },
    }
    ctx.log(`${brief.id}: ${made.errors ? `${made.errors} brand-check error(s)` : 'brand check: no errors'}`)
    return {
      briefId: brief.id,
      title,
      errors: made.errors,
      findings: made.findings,
      report: made.report,
      files: { report: key('report.md'), brief: key('brief.json') },
      renders: { '9x16': r916, ...(r45 ? { '4x5': r45 } : {}), strip },
      parts,
      assets,
      notes: [...jobKit.fontNotes, ...made.notes],
    }
  } finally {
    await browser.close().catch(() => undefined)
    releaseKit()
    releaseMedia()
  }
}
