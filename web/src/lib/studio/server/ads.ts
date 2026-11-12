// Ads made from a Studio project's brand kit, by the Studio worker:
//
//   static ads   a batch (ads by template id with their copy and images, in square, portrait, story, landscape) →
//                one PNG per ad per size, each a library image; the brand check's report and a contact sheet. Filed
//                as a batch record (studio_record, collection `ad-batches`, key <project>/<batch id>).
//   reels        a reel spec (shots of the brand's own footage, type beats, an end card) → a 9:16 MP4 and a strip,
//                library assets, filed as a record (collection `ad-reels`, key <project>/<reel id>).
//   motion ads   a brief (template, seconds, background, sound, copy) → the 9:16 MP4, the 4:5 crop, a strip, a
//                report, and an editable video in the same Studio project (motion-import.ts). Filed as a record
//                (collection `motion-ads`, key <project>/<brief id>) beside the video.
//
// Starting one checks the batch or brief, finds every image, clip and sound it names in the library (by asset id or
// by its name there), and queues the job; the worker's result is filed when it completes (fileAdsResult, called
// from jobs.ts). Rendering the same batch or brief id again replaces its record (the old images stay in the library).
import { randomUUID } from 'node:crypto'
import type { EditorAsset } from '../engine/contracts'
import type { EditorJob } from '../engine/api'
import {
  MotionBriefSchema, ReelSpecSchema, StaticBatchSchema, adsFileKey, batchImages, briefMedia, briefSounds, colourToken, missingRoles, reelMedia,
  type AdsMotionInput, type AdsMotionResult, type AdsReelInput, type AdsReelResult, type AdsStaticInput, type AdsStaticResult, type Finding, type MotionBrief, type ReelSpec, type StaticBatch,
} from './ads-contract'
import { getAssets, listAssets, registerAsset } from './assets'
import { jobKit } from './brand-kit'
import { must, type StudioContext } from './context'
import { asStudioError, StudioError } from './errors'
import { requireWorker } from './capabilities'
import { BlobKey } from './job-contract'
import { fileUrl, ownAsset, ownBlob, queueJob, toEditorJob, type JobRow } from './jobs'
import { motionProject, partAssetIds } from './motion-import'
import { SINGLE, realProject } from './projects'
import { putRecord } from './records'
import { createVideo } from './videos'

export const AD_BATCHES = 'ad-batches'
export const MOTION_ADS = 'motion-ads'
export const AD_REELS = 'ad-reels'
export const ADS_JOB_KINDS = ['ads-static', 'ads-motion', 'ads-reel'] as const

/** The library assets named by sources (an asset id, or an asset's name; the newest of that name wins), or a sentence listing those not found. */
export async function findMedia(ctx: StudioContext, sources: string[]): Promise<Record<string, EditorAsset>> {
  const byId = await getAssets(ctx, sources.filter((s) => /^[a-zA-Z0-9_-]{1,100}$/.test(s)))
  const out: Record<string, EditorAsset> = {}
  const left: string[] = []
  for (const s of sources) {
    const a = byId.get(s)
    if (a) out[s] = a
    else left.push(s)
  }
  if (left.length) {
    const library = await listAssets(ctx)
    for (const s of left) {
      const named = library.filter((a) => a.name === s || a.name.replace(/\.[^.]+$/, '') === s).at(-1)
      if (named) out[s] = named
    }
  }
  const missing = sources.filter((s) => !out[s])
  if (missing.length) throw new StudioError(`Not in the media library: ${missing.join(', ')}. Upload them first, or name them by their library id.`, 400, 'MEDIA_NOT_FOUND')
  return out
}

/** Queue a batch of static ads for a Studio project. */
export async function startStaticAds(ctx: StudioContext, projectId: string, value: unknown): Promise<{ job: EditorJob; batch: StaticBatch }> {
  requireWorker('Rendering ads')
  let batch: StaticBatch
  try {
    batch = StaticBatchSchema.parse(value)
  } catch (error) {
    throw asStudioError(error, 'The batch')
  }
  const id = await realProject(ctx, projectId)
  const kit = await jobKit(ctx, id)
  const roles = missingRoles(kit.kit)
  if (roles.length) throw new StudioError(`The brand kit doesn't map these template roles to palette colours yet: ${roles.join(', ')}.`, 400, 'BRAND_KIT_INCOMPLETE')
  for (const ad of batch.ads) {
    for (const name of [ad.ground, ad.ink, ...Object.values(ad.bySize ?? {}).flatMap((o) => [o?.ground, o?.ink])]) {
      if (name && !colourToken(kit.kit, name)) throw new StudioError(`${ad.id}: "${name}" is neither a palette colour nor a template role of the brand kit.`)
    }
  }
  const media = await findMedia(ctx, batchImages(batch))
  for (const [src, a] of Object.entries(media)) if (a.kind !== 'image') throw new StudioError(`"${src}" is a ${a.kind}, not an image.`)
  const input: AdsStaticInput = { projectId: id, batch, kit, media }
  const row = await queueJob(ctx, 'ads-static' as never, input as never)
  return { job: toEditorJob(row), batch }
}

/** Queue a motion ad for a Studio project. */
export async function startMotionAd(ctx: StudioContext, projectId: string, value: unknown): Promise<{ job: EditorJob; brief: MotionBrief }> {
  requireWorker('Rendering a motion ad')
  let brief: MotionBrief
  try {
    brief = MotionBriefSchema.parse(value)
  } catch (error) {
    throw asStudioError(error, 'The brief')
  }
  const id = await realProject(ctx, projectId)
  const kit = await jobKit(ctx, id)
  const copy = brief.copy as Record<string, unknown>
  for (const field of ['ink', 'panel', 'hookInk']) {
    const name = copy[field]
    if (typeof name === 'string' && !colourToken(kit.kit, name)) throw new StudioError(`copy.${field}: "${name}" is neither a palette colour nor a template role of the brand kit.`)
  }
  const grades = new Set(['forest', 'sand', 'mint', ...Object.keys(kit.kit.motion.grades ?? {})])
  for (const s of brief.background) if (s.grade && !grades.has(s.grade)) throw new StudioError(`Unknown grade "${s.grade}" (have: ${[...grades].join(', ')}).`)
  const media = await findMedia(ctx, briefMedia(brief))
  for (const s of brief.background) {
    const a = media[(s.clip ?? s.still)!]!
    if (s.clip && a.kind !== 'video') throw new StudioError(`"${s.clip}" is not a video clip.`)
    if (s.still && a.kind !== 'image') throw new StudioError(`"${s.still}" is not an image.`)
  }
  const names = briefSounds(brief)
  const library = kit.kit.sounds.sounds
  const unknown = names.filter((n) => !library[n])
  if (unknown.length) throw new StudioError(`Not in the brand kit's sound library: ${unknown.join(', ')} (have: ${Object.keys(library).join(', ') || 'none'}).`)
  const refs = Object.fromEntries(names.map((n) => [n, library[n]!.asset ?? library[n]!.src!]))
  const found = await findMedia(ctx, [...new Set(Object.values(refs))])
  const sounds: Record<string, EditorAsset> = {}
  for (const n of names) {
    const a = found[refs[n]!]!
    if (a.kind !== 'audio' && !(a.kind === 'video' && a.hasAudio)) throw new StudioError(`The sound "${n}" (${a.name}) has no audio.`)
    sounds[n] = a
  }
  const input: AdsMotionInput = { projectId: id, brief, kit, media, sounds }
  const row = await queueJob(ctx, 'ads-motion' as never, input as never)
  return { job: toEditorJob(row), brief }
}

/**
 * A recording's face samples (boxes as fractions of the recording, on its own clock) as a reel shot sees them: in
 * seconds into the shot (on the recording's clock; the renderer applies `slow`), as fractions of the 1080×1920 frame the shot is cropped to (its band, then cover).
 */
export function reelFaces(
  samples: { t: number; faces: { x: number; y: number; w: number; h: number }[] }[],
  asset: Pick<EditorAsset, 'width' | 'height'>,
  shot: ReelSpec['shots'][number],
): { t: number; faces: { x: number; y: number; w: number; h: number }[] }[] {
  const W = 1080, H = 1920, sw = asset.width ?? W, sh = asset.height ?? H, [b0, b1] = shot.band ?? [0, 1]
  const bandH = sh * (b1 - b0), k = Math.max(W / sw, H / bandH), ox = (sw * k - W) / 2, oy = (bandH * k - H) / 2
  return samples
    .filter((s) => s.t >= shot.in && s.t <= shot.out)
    .map((s) => ({
      t: s.t - shot.in,
      faces: s.faces.map((f) => {
        const x = (f.x * sw * k - ox) / W, y = ((f.y - b0) * sh * k - oy) / H
        return { x, y, w: (f.w * sw * k) / W, h: (f.h * sh * k) / H }
      }),
    }))
}

/** Queue a reel from the brand's own footage for a Studio project. */
export async function startReel(ctx: StudioContext, projectId: string, value: unknown): Promise<{ job: EditorJob; spec: ReelSpec }> {
  requireWorker('Rendering a reel')
  let spec: ReelSpec
  try {
    spec = ReelSpecSchema.parse(value)
  } catch (error) {
    throw asStudioError(error, 'The reel')
  }
  const id = await realProject(ctx, projectId)
  const kit = await jobKit(ctx, id)
  const roles = missingRoles(kit.kit)
  if (roles.length) throw new StudioError(`The brand kit doesn't map these template roles to palette colours yet: ${roles.join(', ')}.`, 400, 'BRAND_KIT_INCOMPLETE')
  for (const name of [spec.end?.ground, spec.split?.ground]) if (name && !colourToken(kit.kit, name)) throw new StudioError(`"${name}" is neither a palette colour nor a template role of the brand kit.`)
  const media = await findMedia(ctx, reelMedia(spec))
  for (const [src, a] of Object.entries(media)) if (a.kind !== 'video') throw new StudioError(`"${src}" is not a video.`)
  for (const s of spec.shots) {
    const d = media[s.src]!.durationSeconds ?? 0
    if (s.out > d + 0.05) throw new StudioError(`A shot of "${s.src}" ends at ${s.out}s, after the clip does (${d.toFixed(2)}s).`)
  }
  // Faces the Studio already found in these recordings (a Mac worker's faces job, cached by their bytes) keep each
  // beat's type clear of them, unless the spec gives its own.
  const { cachedFaces } = await import('./vision')
  const shots = spec.shots.filter((s) => !spec.people?.[s.src]?.faces)
  if (!spec.split && shots.length) {
    const { tracks } = await cachedFaces(ctx, [...new Set(shots.map((s) => media[s.src]!))])
    for (const shot of shots) {
      const asset = media[shot.src]!, samples = tracks[asset.id]
      if (!samples?.length) continue
      spec.people = { ...spec.people, [shot.src]: { ...spec.people?.[shot.src], faces: reelFaces(samples, asset, shot) } }
    }
  }
  const input: AdsReelInput = { projectId: id, spec, kit, media }
  const row = await queueJob(ctx, 'ads-reel' as never, input as never)
  return { job: toEditorJob(row), spec }
}

// ---- filing what the worker made ----------------------------------------------------------------------------

/** A static batch as it is filed and listed. */
export type AdBatchRecord = {
  projectId: string
  batchId: string
  title?: string
  jobId: string
  createdAt: string
  ads: { id: string; pattern: string; template: string; title?: string; notes?: string; flags: string[]; photo: Finding[]; people: boolean; images: { size: string; assetId: string; file: string; width: number; height: number; findings: Finding[] }[] }[]
  files: AdsStaticResult['files']
  withoutPeople: string[]
  notes: string[]
}
export type ReelRecord = {
  projectId: string
  reelId: string
  title: string
  jobId: string
  createdAt: string
  seconds: number
  render: { assetId: string; file: string }
  strip: { assetId: string; file: string }
  notes: string[]
  files: AdsReelResult['files']
}
export type MotionAdRecord = {
  projectId: string
  briefId: string
  title: string
  jobId: string
  videoId: string
  createdAt: string
  errors: number
  findings: Finding[]
  renders: Record<string, { assetId: string; file: string }>
  files: AdsMotionResult['files']
  baked: string[]
  notes: string[]
}

/** A worker's asset checked against what the job stored (jobs.ts ownAsset), then registered: check first, register after. */
const registered = async (ctx: StudioContext, value: unknown, what: string): Promise<EditorAsset> => registerAsset(ctx, await ownAsset(ctx, value, what))

/**
 * The files a result names (reports, a contact sheet, notes), each checked: a file key under this job's own folder
 * (`ads/<job id>/`) that the job stored. Answers them as given, or the sentence that refuses the result.
 */
async function ownFiles<T extends Record<string, string>>(ctx: StudioContext, jobId: string, files: unknown, names: (keyof T)[]): Promise<T> {
  if (!files || typeof files !== 'object' || Array.isArray(files)) throw new StudioError('The ads result names no files.')
  const given = files as Record<string, unknown>
  const out: Record<string, string> = {}
  for (const name of names) {
    const key = given[name as string]
    if (typeof key !== 'string' || !BlobKey.safeParse(key).success) throw new StudioError("The worker stored the ads' files outside this job's files.")
    out[name as string] = (await ownBlob(ctx, key, adsFileKey(jobId, ''), 'ads file')).key
  }
  return out as T
}

/** The id a result names, refused unless it is the one the job was given (a result never files over another record). */
function sameId(given: unknown, asked: string, what: string): string {
  if (given !== asked) throw new StudioError(`The worker answered for another ${what} than this job made.`)
  return asked
}

/** File a finished ads job: register its images and media, record the batch, make the editable video. Answers the result to keep on the job. */
export async function fileAdsResult(ctx: StudioContext, row: Pick<JobRow, 'id' | 'kind' | 'input'>, raw: unknown): Promise<Record<string, unknown>> {
  if (!raw || typeof raw !== 'object') throw new StudioError('The ads result is not an object.')
  const projectId = String((row.input as { projectId?: unknown }).projectId ?? '')
  if (row.kind === ('ads-static' as JobRow['kind'])) {
    const result = raw as AdsStaticResult
    const batchId = sameId(result.batchId, (row.input as unknown as AdsStaticInput).batch?.id, 'batch')
    if (!Array.isArray(result.ads) || !result.ads.length) throw new StudioError('A batch has at least one ad.')
    const files = await ownFiles<AdsStaticResult['files']>(ctx, row.id, result.files, ['reportJson', 'reportMd', 'contactSheet'])
    // Every image checked against what the job stored before any is registered.
    for (const ad of result.ads) for (const img of Array.isArray(ad.images) ? ad.images : []) await ownAsset(ctx, img.asset, 'ad image')
    const ads: AdBatchRecord['ads'] = []
    for (const ad of result.ads) {
      const images: AdBatchRecord['ads'][number]['images'] = []
      for (const img of ad.images ?? []) {
        const a = await registered(ctx, img.asset, 'ad image')
        images.push({ size: img.size, assetId: a.id, file: a.file, width: a.width ?? 0, height: a.height ?? 0, findings: img.findings ?? [] })
      }
      ads.push({ id: ad.id, pattern: ad.pattern, template: ad.template, ...(ad.title ? { title: ad.title } : {}), ...(ad.notes ? { notes: ad.notes } : {}), flags: ad.flags ?? [], photo: ad.photo ?? [], people: !!ad.people, images })
    }
    const recordKey = `${projectId}/${batchId}`
    const record: AdBatchRecord = {
      projectId, batchId, ...(result.title ? { title: result.title } : {}), jobId: row.id, createdAt: new Date().toISOString(),
      ads, files, withoutPeople: result.withoutPeople ?? [], notes: result.notes ?? [],
    }
    await putRecord(ctx, AD_BATCHES, recordKey, record)
    // The job keeps a light result: what was made, by id (the record holds the findings).
    return { batchId, recordKey, images: ads.flatMap((a) => a.images.map((i) => ({ ad: a.id, size: i.size, assetId: i.assetId }))), files, withoutPeople: record.withoutPeople, notes: record.notes, errors: countErrors(ads) }
  }
  if (row.kind === ('ads-motion' as JobRow['kind'])) {
    const result = raw as AdsMotionResult
    const briefId = sameId(result.briefId, (row.input as unknown as AdsMotionInput).brief?.id, 'brief')
    if (!result.parts || !result.renders?.['9x16']) throw new StudioError('A motion ad has its 9:16 render and its parts.')
    const files = await ownFiles<AdsMotionResult['files']>(ctx, row.id, result.files, ['report', 'brief'])
    const made = Array.isArray(result.assets) ? result.assets : []
    const checked: EditorAsset[] = []
    for (const a of made) checked.push(await ownAsset(ctx, a, 'motion ad file'))
    // The renders are among the files the job stored and described.
    const renders: MotionAdRecord['renders'] = {}
    for (const [k, a] of Object.entries(result.renders)) {
      if (!a) continue
      const own = checked.find((c) => c.id === (a as { id?: unknown }).id)
      if (!own) throw new StudioError("The motion ad's renders are not among the files the worker stored.")
      renders[k] = { assetId: own.id, file: own.file }
    }
    const assets = new Map<string, EditorAsset>()
    for (const a of checked) {
      const r = await registerAsset(ctx, a)
      assets.set(r.id, r)
    }
    for (const id of partAssetIds(result.parts)) if (!assets.has(id)) throw new StudioError('The motion ad\'s parts name media the worker did not store.')
    const project = motionProject(result.parts, { asset: (id) => assets.get(id)!, id: randomUUID() })
    const video = (await createVideo(ctx, project as never, { studioProjectId: projectId.startsWith(SINGLE) ? null : projectId })).project
    const record: MotionAdRecord = {
      projectId, briefId, title: result.title, jobId: row.id, videoId: video.id, createdAt: new Date().toISOString(),
      errors: result.errors, findings: result.findings ?? [], renders, files, baked: result.parts.baked ?? [], notes: result.notes ?? [],
    }
    await putRecord(ctx, MOTION_ADS, `${projectId}/${briefId}`, record)
    return { briefId, videoId: video.id, title: result.title, errors: result.errors, renders, files, report: result.report, notes: record.notes }
  }
  if (row.kind === ('ads-reel' as JobRow['kind'])) {
    const result = raw as AdsReelResult
    const reelId = sameId(result.reelId, (row.input as unknown as AdsReelInput).spec?.id, 'reel')
    const files = await ownFiles<AdsReelResult['files']>(ctx, row.id, result.files, ['notes'])
    await ownAsset(ctx, result.render, 'reel')
    await ownAsset(ctx, result.strip, 'reel strip')
    const render = await registered(ctx, result.render, 'reel'), strip = await registered(ctx, result.strip, 'reel strip')
    const record: ReelRecord = {
      projectId, reelId, title: result.title, jobId: row.id, createdAt: new Date().toISOString(), seconds: result.seconds,
      render: { assetId: render.id, file: render.file }, strip: { assetId: strip.id, file: strip.file }, notes: result.notes ?? [], files,
    }
    await putRecord(ctx, AD_REELS, `${projectId}/${reelId}`, record)
    return { reelId, title: result.title, seconds: result.seconds, render: record.render, strip: record.strip, notes: record.notes }
  }
  return raw as Record<string, unknown>
}

const countErrors = (ads: AdBatchRecord['ads']) => ads.reduce((n, a) => n + a.images.reduce((m, i) => m + i.findings.filter((f) => f.level === 'error').length, 0), 0)

// ---- listing ---------------------------------------------------------------------------------------------------

async function recordsOf<T>(ctx: StudioContext, collection: string, projectId: string): Promise<T[]> {
  const rows = must(
    await ctx.supabase.from('studio_record').select('value, updated_at').eq('workspace_id', ctx.workspaceId).eq('collection', collection).eq('value->>projectId', projectId).order('updated_at', { ascending: false }).limit(200),
    'read the ads',
  ) as { value: T }[] | null
  return (rows ?? []).map((r) => r.value)
}

/** A Studio project's ads: static batches newest first (each ad's images by size, its findings errors first, the report and contact sheet), and motion ads (as videos). */
export async function listAds(ctx: StudioContext, projectId: string) {
  if (projectId.startsWith(SINGLE)) return { batches: [], motion: [], reels: [] }
  const level = { error: 0, warn: 1, info: 2 } as const
  // Only a file key becomes a link (a record filed before its keys were checked links nowhere else).
  const url = (key: string) => (BlobKey.safeParse(key).success ? fileUrl(ctx.workspaceId, key) : '')
  const batches = (await recordsOf<AdBatchRecord>(ctx, AD_BATCHES, projectId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((b) => ({
    ...b,
    errors: countErrors(b.ads),
    ads: b.ads.map((ad) => ({
      ...ad,
      images: ad.images.map((i) => ({ ...i, url: url(i.file), findings: [...i.findings].sort((x, y) => level[x.level] - level[y.level]) })),
      errors: ad.images.reduce((n, i) => n + i.findings.filter((f) => f.level === 'error').length, 0),
    })),
    links: { report: url(b.files.reportMd), reportJson: url(b.files.reportJson), contactSheet: url(b.files.contactSheet) },
  }))
  const motion = (await recordsOf<MotionAdRecord>(ctx, MOTION_ADS, projectId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((m) => ({
    ...m,
    links: { report: url(m.files.report), ...Object.fromEntries(Object.entries(m.renders).map(([k, r]) => [k, url(r.file)])) },
  }))
  const reels = (await recordsOf<ReelRecord>(ctx, AD_REELS, projectId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((r) => ({
    ...r,
    links: { reel: url(r.render.file), strip: url(r.strip.file), notes: url(r.files.notes) },
  }))
  return { batches, motion, reels }
}
