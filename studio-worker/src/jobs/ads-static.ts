/**
 * ads-static: a batch of static ads from a Studio project's brand kit.
 *
 * Every ad of the batch in every size it asks for (square, portrait, story,
 * landscape) is drawn in Chromium from its playbook template, passed through
 * the face, legibility and brand checks (../ads/render.ts), and stored: each
 * PNG as a library image (provenance: the Studio project, the batch, the ad,
 * its template and size), the report (JSON and text) and the contact sheet as
 * files under ads/<job id>/. The app files the batch when the job completes.
 *
 * Progress: staging 0–15 %, drawing 15–85 %, storing the rest.
 *
 * The batch and the kit are checked against the contract's schemas again
 * before anything is drawn, and every page is fenced to the job's folder.
 */
import { copyFile, mkdir, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import type { EditorAsset } from '../../../web/src/lib/studio/engine/contracts.ts'
import type { AdsStaticResult, JobKit, SizeKey } from '../../../web/src/lib/studio/server/ads-contract.ts'
import { fileSha256 } from '../app-client.ts'
import { buildAsset, inspectFile, publishAsset, stageAssets } from '../assets.ts'
import { launchBrowser } from '../ads/browser.ts'
import { family } from '../ads/escape.ts'
import { fencedPage, pageUrl } from '../ads/fence.ts'
import { BrandKitSchema, StaticBatchSchema } from '../engine.ts'
import { buildKit, type AdsKit, type StagedFace } from '../ads/kit.ts'
import { shrinkPhoto } from '../ads/raster.ts'
import { renderBatch } from '../ads/render.ts'
import { SIZES } from '../ads/templates.ts'
import { checkAborted, JobError, stage, type JobContext, type JobHandler } from './context.ts'

/** A job input checked against its contract schema: the parsed value, or a sentence naming the first problem. */
export function checked<T>(what: string, schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } } }, value: unknown): T {
  const r = schema.safeParse(value)
  if (r.success) return r.data
  const issue = r.error.issues[0]
  throw new JobError(`The ${what} is not one the worker can draw: ${issue ? `${issue.path.map(String).join('.') || 'it'}: ${issue.message}` : 'it does not match the contract'}`.slice(0, 600))
}

/** The kit as a job carries it, checked again (the kit itself, the editor's family names). */
export function checkedJobKit(jobKit: JobKit): JobKit {
  const kit = checked('brand kit', BrandKitSchema, jobKit?.kit)
  try {
    return { ...jobKit, kit, editorFamilies: { serif: family(jobKit.editorFamilies?.serif), sans: family(jobKit.editorFamilies?.sans) } }
  } catch (err) {
    throw new JobError(`The brand kit is not one the worker can draw: ${(err as Error).message}`)
  }
}

/** A font file's extension as staged: one of the four the ads load, else .otf. Pure. */
export const fontExtension = (file: string) => {
  const ext = extname(String(file)).toLowerCase()
  return ['.otf', '.ttf', '.woff', '.woff2'].includes(ext) ? ext : '.otf'
}

/** The brand kit staged: logo masks from the cache, font files downloaded, the CSS built. */
export async function stageKit(ctx: JobContext, jobKitIn: JobKit): Promise<{ kit: AdsKit; release: () => void }> {
  const jobKit = checkedJobKit(jobKitIn)
  const { primary, mark } = jobKit.logos
  if (primary.kind !== 'image' || mark.kind !== 'image') throw new JobError('The brand kit\'s logo masks must be images (PNG with transparency)')
  const release = await stageAssets(ctx, [primary, mark], () => undefined)
  try {
    const fontsDir = join(ctx.scratch, 'fonts')
    await mkdir(fontsDir, { recursive: true })
    const faces: { serif: StagedFace[]; sans: StagedFace[] } = { serif: [], sans: [] }
    let n = 0
    for (const role of ['serif', 'sans'] as const) {
      if (!jobKit.fonts[role].length) throw new JobError(`The brand kit's ${role} has no font files: upload them, or name a free family as its stand-in`)
      for (const face of jobKit.fonts[role]) {
        const path = join(fontsDir, `${n++}${fontExtension(face.file)}`)
        await ctx.client.readBlob(ctx.job.id, face.file, path, { signal: ctx.signal })
        faces[role].push({ path, weight: String(face.weight), style: face.style === 'italic' ? 'italic' : 'normal' })
      }
    }
    const kit = await buildKit(jobKit.kit, { primary: ctx.cache.pathOf(primary.file), mark: ctx.cache.pathOf(mark.file) }, faces, (path) => pageUrl(ctx.scratch, path))
    return { kit, release }
  } catch (err) {
    release()
    throw err
  }
}

/** A finished local media file as a library asset (measured as an import is), stored. */
export async function publishMade(ctx: JobContext, file: string, name: string, provenance: Record<string, unknown>): Promise<EditorAsset> {
  const { measured, waveform } = await inspectFile(file, name, ctx.signal)
  const asset = buildAsset(measured, { sha256: await fileSha256(file), bytes: (await stat(file)).size }, { name, waveform, provenance })
  // The cache takes the file; a copy keeps the original for whatever else reads it in this job.
  const moved = `${file}.publish${extname(file)}`
  await copyFile(file, moved)
  await publishAsset(ctx, asset, moved)
  return asset
}

export const runAdsStatic: JobHandler<'ads-static'> = async (ctx) => {
  const { kit: jobKit, media, projectId } = ctx.job.input
  const batch = checked('batch', StaticBatchSchema, ctx.job.input.batch)
  ctx.log(`Batch ${batch.id}: ${batch.ads.length} ad(s)`)
  const staged = stage(ctx, 0, 0.15)
  const sources = new Set<string>()
  for (const ad of batch.ads) for (const img of [ad.image, ...(ad.images ?? []), ...Object.values(ad.bySize ?? {}).flatMap((o) => [o?.image, ...(o?.images ?? [])])]) if (img) sources.add(img.src)
  for (const p of Object.values(batch.people ?? {})) if (p.matte) sources.add(p.matte)
  const assets = [...sources].map((src) => {
    const a = media[src]
    if (!a) throw new JobError(`The batch names "${src}", which is not in the job's media`)
    if (a.kind !== 'image') throw new JobError(`"${a.name}" is not an image`)
    return a
  })
  const releaseMedia = await stageAssets(ctx, assets, (f) => staged(0.6 * f))
  const { kit, release: releaseKit } = await stageKit(ctx, jobKit)
  const browser = await launchBrowser(ctx)
  try {
    // Photos: a resized copy each (big originals make Chromium slow).
    const imagesDir = join(ctx.scratch, 'images')
    await mkdir(imagesDir, { recursive: true })
    const images = new Map<string, string>()
    let i = 0
    for (const src of sources) {
      const local = join(imagesDir, `${i++}.jpg`)
      await shrinkPhoto(ctx.cache.pathOf(media[src]!.file), local, 2400, ctx.signal)
      images.set(src, local)
    }
    const people = new Map(Object.entries(batch.people ?? {}).map(([src, p]) => [src, { ...p, ...(p.matte ? { mattePath: ctx.cache.pathOf(media[p.matte]!.file) } : {}) }]))
    staged(1)
    checkAborted(ctx.signal)
    const page = await fencedPage(browser, ctx.scratch, { deviceScaleFactor: 1 })
    const out = join(ctx.scratch, 'out')
    const names = new Map([...sources].map((s) => [s, media[s]!.name]))
    const drawn = await renderBatch({ kit, batch, images, names, people, root: ctx.scratch, out, cache: join(ctx.scratch, 'cache'), page, log: ctx.log, progress: stage(ctx, 0.15, 0.85), signal: ctx.signal })
    checkAborted(ctx.signal)

    const upload = stage(ctx, 0.85, 1)
    const totalImages = drawn.results.reduce((n, r) => n + Object.keys(r.files).length, 0) || 1
    let stored = 0
    const ads: AdsStaticResult['ads'] = []
    for (const r of drawn.results) {
      const imagesOut: AdsStaticResult['ads'][number]['images'] = []
      for (const [size, file] of Object.entries(r.files) as [SizeKey, string][]) {
        const { w, h } = SIZES[size]
        const asset = await publishMade(ctx, file, `${batch.title ?? batch.id} · ${r.id} · ${size} ${w}x${h}.png`.slice(0, 250), {
          studioAds: { kind: 'static', projectId, batchId: batch.id, adId: r.id, template: r.template, pattern: r.pattern, size, jobId: ctx.job.id },
        })
        imagesOut.push({ size, asset, findings: r.findings[size] ?? [] })
        upload(++stored / (totalImages + 3))
      }
      ads.push({ id: r.id, pattern: r.pattern, template: r.template, ...(r.title ? { title: r.title } : {}), ...(r.notes ? { notes: r.notes } : {}), flags: r.flags, photo: r.photo, images: imagesOut, people: r.people })
    }
    const key = (name: string) => `ads/${ctx.job.id}/${name}`
    await ctx.client.writeBlob(ctx.job.id, key('report.json'), drawn.reportJson, 'application/json', { signal: ctx.signal })
    await ctx.client.writeBlob(ctx.job.id, key('report.md'), drawn.reportMd, 'text/markdown; charset=utf-8', { signal: ctx.signal })
    await ctx.client.writeBlob(ctx.job.id, key('contact-sheet.jpg'), drawn.contactSheet, 'image/jpeg', { signal: ctx.signal })
    upload(1)
    const withoutPeople = drawn.results.filter((r) => !r.people).map((r) => r.id)
    const errors = drawn.results.reduce((n, r) => n + Object.values(r.findings).flat().filter((f) => f!.level === 'error').length, 0)
    ctx.log(`${drawn.results.length} ad(s) drawn; brand check: ${errors ? `${errors} error(s)` : 'no errors'}`)
    return {
      batchId: batch.id,
      ...(batch.title ? { title: batch.title } : {}),
      ads,
      files: { reportJson: key('report.json'), reportMd: key('report.md'), contactSheet: key('contact-sheet.jpg') },
      withoutPeople,
      notes: [
        ...jobKit.fontNotes,
        ...(withoutPeople.length ? [`No people data for the photos of ${withoutPeople.join(', ')}: the face-avoid and text-behind-the-head passes were skipped for them`] : []),
      ],
    }
  } finally {
    await browser.close().catch(() => undefined)
    releaseKit()
    releaseMedia()
  }
}
