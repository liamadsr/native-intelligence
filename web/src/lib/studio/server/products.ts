// Product components: the person's own web app, rendered from its code on their Mac and brought into the Studio. Two
// kinds of Studio records (records.ts): `products` (a product's settings, the components its last listing reported, the
// captures made of them) and `product-jobs` (what the agent asked the Mac to do, and what came back).
//
// The flow: the agent prepares a job here (prepareJob) and starts a local agent in the product's folder with the job's
// words (start_local_agent, with its own checks and the person's approval); the Mac body's studio_product tool reads the
// job (jobForMac), renders inside the job's fence, and sends back a report (applyReport) or a capture (acceptCapture),
// which comes into the library through the same import every upload takes, with its provenance, and is placed on a
// video or swapped into a component layer when the job said so. Nothing here runs the product's code.
import { randomUUID } from 'node:crypto'
import type { EditorAsset } from '../engine/contracts'
import type { StudioContext } from './context'
import { conflictError, notFoundError, StudioError } from './errors'
import { importBytes } from './library'
import {
  CaptureMetaSchema,
  CAPTURES_KEPT,
  componentLayers,
  componentStyle,
  layerStaleness,
  placementBox,
  ProductJobSchema,
  type CaptureMeta,
  type CaptureOptions,
  type Placement,
  type ProductCapture,
  type ProductJob,
  type ProductRecord,
  type Report,
  type Staleness,
} from './product-contract'
import { getRecord, listRecords, putRecord } from './records'
import { runOps } from './ops'
import { namedLibraryAssets, openVideo, saveVideo } from './videos'
import { saveVersion } from './versions'

/** The collections this file keeps. */
export const PRODUCT_COLLECTIONS = { products: 'products', jobs: 'product-jobs' } as const

/** How long a job waits for the person's Mac before it counts as dropped (a local agent's queue lasts 6 hours). */
export const JOB_TTL_MS = 6 * 60 * 60_000

/** How long accepting a capture waits for its import before answering the import job instead. */
const CAPTURE_IMPORT_WAIT_MS = 60_000

/** Every product of the workspace, by title. */
export async function listProducts(ctx: StudioContext): Promise<ProductRecord[]> {
  const rows = await listRecords<ProductRecord>(ctx, PRODUCT_COLLECTIONS.products, 200)
  return rows.map((row) => row.value).sort((a, b) => a.title.localeCompare(b.title))
}

/** One product, or null. */
export async function getProduct(ctx: StudioContext, slug: string): Promise<ProductRecord | null> {
  return getRecord<ProductRecord>(ctx, PRODUCT_COLLECTIONS.products, slug)
}

/** One product, or a 404 naming the tool that lists them. */
export async function mustProduct(ctx: StudioContext, slug: string): Promise<ProductRecord> {
  const product = await getProduct(ctx, slug)
  if (!product) throw notFoundError('No such product in this workspace. list_studio_products lists them.')
  return product
}

/** One job, or null (a malformed record counts as none). */
export async function getProductJob(ctx: StudioContext, id: string): Promise<ProductJob | null> {
  const value = await getRecord<unknown>(ctx, PRODUCT_COLLECTIONS.jobs, id)
  const parsed = ProductJobSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

/** Save a job, stamped now. */
async function saveJob(ctx: StudioContext, job: ProductJob): Promise<ProductJob> {
  const next = ProductJobSchema.parse({ ...job, updatedAt: new Date().toISOString() })
  await putRecord(ctx, PRODUCT_COLLECTIONS.jobs, next.id, next)
  return next
}

/** What a new job asks for (the folder is the one the person shares, checked by the caller against their environment). */
export type JobInput = Pick<ProductJob, 'kind' | 'folderId' | 'slug' | 'title' | 'capture' | 'refresh'>

/** Write a new job, waiting for the person's Mac. */
export async function prepareJob(ctx: StudioContext, input: JobInput): Promise<ProductJob> {
  if (!ctx.userId) throw new StudioError('A product job needs the person it is for.')
  const now = new Date().toISOString()
  return saveJob(ctx, { id: randomUUID(), userId: ctx.userId, status: 'waiting', createdAt: now, updatedAt: now, ...input })
}

/** The Mac session asking for a job: who it runs for and in which folder. */
export type MacJobCaller = { userId: string; sessionId: string; folderId: string }

/**
 * The job a Mac session may run: the person's own, made for the folder the session runs in, not finished and not
 * expired. Marks it running for that session (a second session in the same folder may pick a job up again: from then
 * on only that session's results land, macHoldsJob). Throws a sentence the Mac body shows.
 */
export async function jobForMac(ctx: StudioContext, id: string, caller: MacJobCaller): Promise<{ job: ProductJob; product: ProductRecord | null }> {
  const job = await getProductJob(ctx, id)
  if (!job || job.userId !== caller.userId) throw notFoundError('No such Studio product job for you in this workspace.')
  if (job.folderId !== caller.folderId) throw conflictError("This Studio product job is for another folder: it only runs in the folder it was made for.", 'WRONG_FOLDER')
  if (job.status === 'done' || job.status === 'failed') throw conflictError('This Studio product job is already finished.', 'JOB_FINISHED')
  if (Date.now() - Date.parse(job.createdAt) > JOB_TTL_MS) throw conflictError('This Studio product job expired: ask for it again in the chat.', 'JOB_EXPIRED')
  const running = await saveJob(ctx, { ...job, status: 'running', sessionId: caller.sessionId })
  return { job: running, product: job.slug ? await getProduct(ctx, job.slug) : null }
}

/**
 * Whether this Mac session may still send what a job made (a report or a capture): the person's own job, made for
 * this folder, taken by this session (jobForMac), still running and not expired. A finished job takes nothing more,
 * so a report or a capture sent again cannot remake a product, place a second layer or swap a layer back. Pure.
 */
export function macHoldsJob(job: ProductJob | null, caller: MacJobCaller, now = Date.now()): job is ProductJob {
  return (
    !!job &&
    job.userId === caller.userId &&
    job.folderId === caller.folderId &&
    job.sessionId === caller.sessionId &&
    job.status === 'running' &&
    now - Date.parse(job.createdAt) <= JOB_TTL_MS
  )
}

/** Where the folder is, as the person sees it (the session's device and folder labels). */
export type FolderNames = { folderLabel: string; deviceName: string }

/**
 * The Mac's report for an onboarding, a listing or a refresh. An onboarding makes the product (or updates the one with
 * the same slug in the same folder; another folder's product of that name is refused); a listing keeps the components
 * and their code keys; a refresh keeps what happened to each item. The job is finished either way.
 */
export async function applyReport(ctx: StudioContext, job: ProductJob, report: Report, names: FolderNames): Promise<ProductJob> {
  if (!report.ok) return saveJob(ctx, { ...job, status: 'failed', error: (report.error ?? 'The Mac could not do it.').slice(0, 500) })
  const now = new Date().toISOString()
  if (job.kind === 'onboard') {
    if (!report.kit) throw new StudioError('An onboarding report needs the product settings.')
    const kit = { ...report.kit, ...(job.title ? { title: job.title } : {}) }
    const existing = await getProduct(ctx, kit.slug)
    if (existing && existing.folderId !== job.folderId) {
      return saveJob(ctx, { ...job, status: 'failed', error: `A product called ${kit.slug} already comes from another folder. Remove it or give this one another title.` })
    }
    const product: ProductRecord = {
      slug: kit.slug,
      title: kit.title,
      folderId: job.folderId,
      ...names,
      // The person's curated components stay through a new onboarding.
      kit: existing ? { ...kit, components: { ...kit.components, ...existing.kit.components } } : kit,
      notes: report.notes ?? [],
      components: report.components ?? existing?.components ?? [],
      commit: report.commit ?? null,
      listedAt: report.components ? now : (existing?.listedAt ?? null),
      captures: existing?.captures ?? [],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    await putRecord(ctx, PRODUCT_COLLECTIONS.products, product.slug, product)
    return saveJob(ctx, { ...job, slug: product.slug, status: 'done', result: { product: product.slug, components: product.components.length, renders: product.components.filter((c) => c.status === 'ok').length, ...(report.note ? { note: report.note } : {}) } })
  }
  const product = job.slug ? await getProduct(ctx, job.slug) : null
  if (!product) return saveJob(ctx, { ...job, status: 'failed', error: 'The product was removed while the Mac worked.' })
  if (report.components) {
    await putRecord(ctx, PRODUCT_COLLECTIONS.products, product.slug, { ...product, ...names, components: report.components, commit: report.commit ?? product.commit, listedAt: now, updatedAt: now })
  }
  const result = { ...(job.result ?? {}), ...(report.items ? { items: report.items } : {}), ...(report.components ? { components: report.components.length } : {}), ...(report.note ? { note: report.note } : {}) }
  // A capture finishes when its file arrives (acceptCapture); its report only says when it could not be made.
  if (job.kind === 'capture') return saveJob(ctx, { ...job, result })
  return saveJob(ctx, { ...job, status: 'done', result })
}

/** The capture a job asked for: its options (from the job, or the refresh item it answers). */
function askedOptions(job: ProductJob, meta: CaptureMeta): { options: CaptureOptions; layerId?: string } {
  if (job.kind === 'capture' && job.capture && job.capture.component === meta.component) return { options: job.capture.options }
  const item = job.kind === 'refresh' && meta.item !== undefined ? job.refresh?.items[meta.item] : undefined
  if (item && item.component === meta.component) return { options: item.options, layerId: item.layerId }
  throw new StudioError('That capture is not one this job asked for.', 409, 'NOT_ASKED')
}

/**
 * A capture the Mac made for a job: into the library through the import every upload takes (the worker checks the
 * file), with where it came from; kept on the product; then placed on the video or swapped into the component layer
 * the job named. Answers what was done, or the import job when it outlasts the wait: then the import's own
 * completion files it (captureImported, from jobs.ts), so the job never waits on it until it expires.
 */
export async function acceptCapture(ctx: StudioContext, job: ProductJob, meta: CaptureMeta, bytes: Uint8Array) {
  if (!job.slug) throw new StudioError('This job names no product.')
  const product = await mustProduct(ctx, job.slug)
  const { options } = askedOptions(job, meta)
  const provenance = { product: product.slug, component: meta.component, key: meta.key, commit: meta.commit, options, job: job.id, from: `${product.deviceName}: ${product.folderLabel}` }
  const contentType = meta.kind === 'video' ? 'video/webm' : 'image/png'
  const imported = await importBytes(ctx, bytes, { name: meta.name, contentType, provenance: { productComponent: provenance } }, { waitMs: CAPTURE_IMPORT_WAIT_MS })
  if (!('asset' in imported)) {
    // Still importing: the job keeps what to do with the file, and the import's completion (jobs.ts) files it.
    const waiting = await saveJob(ctx, { ...job, result: { ...(job.result ?? {}), importJob: imported.job.id, importing: { job: imported.job.id, meta } } })
    // The import may have ended between the wait and that save, before there was anything for its completion to find.
    const { jobRow } = await import('./jobs')
    const now = await jobRow(ctx, imported.job.id).catch(() => null)
    if (now?.status === 'completed' && now.result?.asset) await captureImported(ctx, waiting.id, now.id, now.result.asset as EditorAsset)
    else if (now?.status === 'failed' || now?.status === 'cancelled') await captureImportEnded(ctx, waiting.id, now.id, now.error)
    return { importing: imported.job.id }
  }
  return fileCapture(ctx, job, meta, imported.asset as EditorAsset)
}

/** What a still-importing capture waits with on its job: the import job, and the capture's description. */
function pendingImport(job: ProductJob | null, importJobId: string): CaptureMeta | null {
  const pending = job?.result?.importing as { job?: unknown; meta?: unknown } | undefined
  if (!job || pending?.job !== importJobId) return null
  const meta = CaptureMetaSchema.safeParse(pending.meta)
  return meta.success ? meta.data : null
}

/** The job without its pending import (filed now, or ended): a second completion finds nothing to do. */
const withoutPending = (job: ProductJob): ProductJob => {
  const { importing: _importing, ...rest } = job.result ?? {}
  return { ...job, result: rest }
}

/**
 * A capture's import that finished after acceptCapture stopped waiting (jobs.ts completeJob calls this for an import
 * whose provenance names a product job): filed as acceptCapture would have (kept, placed or swapped in, the job
 * finished). Only once: the job must still be waiting on that very import. Answers whether it filed anything.
 */
export async function captureImported(ctx: StudioContext, productJobId: string, importJobId: string, asset: EditorAsset): Promise<boolean> {
  const job = await getProductJob(ctx, productJobId)
  const meta = pendingImport(job, importJobId)
  if (!job || !meta) return false
  await fileCapture(ctx, withoutPending(job), meta, asset)
  return true
}

/** A capture's import that failed or was cancelled after acceptCapture stopped waiting: a capture job ends failed. */
export async function captureImportEnded(ctx: StudioContext, productJobId: string, importJobId: string, error: string | null): Promise<boolean> {
  const job = await getProductJob(ctx, productJobId)
  if (!job || !pendingImport(job, importJobId)) return false
  const why = `The capture could not be imported: ${error || 'the import ended'}`.slice(0, 500)
  // A refresh goes on with its other items; a capture job had only this one.
  await saveJob(ctx, job.kind === 'capture' ? { ...withoutPending(job), status: 'failed', error: why } : { ...withoutPending(job), result: { ...(withoutPending(job).result ?? {}), importError: why } })
  return true
}

/** The rest of a capture once its file is in the library: kept on the product, placed or swapped in, the job saved. */
async function fileCapture(ctx: StudioContext, job: ProductJob, meta: CaptureMeta, asset: EditorAsset) {
  if (!job.slug) throw new StudioError('This job names no product.')
  const product = await mustProduct(ctx, job.slug)
  const { options, layerId } = askedOptions(job, meta)
  const capture: ProductCapture = {
    assetId: asset.id,
    component: meta.component,
    name: meta.name,
    kind: meta.kind,
    options,
    width: meta.width,
    height: meta.height,
    aspect: meta.aspect,
    seconds: meta.seconds,
    key: meta.key,
    commit: meta.commit,
    jobId: job.id,
    capturedAt: new Date().toISOString(),
  }
  const fresh = (await getProduct(ctx, product.slug)) ?? product
  const captures = [capture, ...fresh.captures.filter((c) => c.assetId !== capture.assetId)].slice(0, CAPTURES_KEPT)
  await putRecord(ctx, PRODUCT_COLLECTIONS.products, product.slug, { ...fresh, captures, updatedAt: capture.capturedAt })
  let placed: string | null = null
  if (job.kind === 'capture' && job.capture?.place) placed = await placeCapture(ctx, product.slug, capture, job.capture.place)
  if (layerId && job.refresh) await swapLayer(ctx, job.refresh.videoId, layerId, product.slug, capture)
  const done = job.kind === 'capture'
  const refreshed = layerId ? [...((job.result?.refreshed as string[] | undefined) ?? []), layerId] : undefined
  await saveJob(ctx, { ...job, status: done ? 'done' : job.status, result: { ...(job.result ?? {}), assetId: asset.id, ...(placed ? { layerId: placed } : {}), ...(refreshed ? { refreshed } : {}) } })
  return { assetId: asset.id, ...(placed ? { layerId: placed } : {}), ...(layerId ? { refreshed: layerId } : {}) }
}

/**
 * Put a capture on a video as one undoable step (the version before is kept): an image layer showing the capture,
 * sized by its aspect, that remembers which component and code it shows (layer.style.component) so a refresh knows
 * what to make again. Answers the new layer's id.
 */
export async function placeCapture(ctx: StudioContext, slug: string, capture: ProductCapture, placement: Placement): Promise<string> {
  const opened = await openVideo(ctx, placement.videoId)
  const box = placementBox(capture, opened.project.output, placement)
  const args = {
    assetId: capture.assetId,
    at: placement.at,
    duration: placement.duration ?? (capture.seconds || 4),
    ...box,
    ...(placement.behind ? { behind: true } : {}),
    enter: { preset: 'zoom-blur', seconds: 0.5, ease: 'spring' },
    exit: { preset: 'blur', seconds: 0.3 },
    style: { component: componentStyle(slug, capture), float: 0.004 },
  }
  const { results } = await runOps(ctx, placement.videoId, [{ op: 'add_image', args }], opened.projectDigest)
  return String((results[0] as { id?: string } | undefined)?.id ?? '')
}

/** Swap a component layer's footage for a new capture of the same component, keeping everything else (one undoable step). */
export async function swapLayer(ctx: StudioContext, videoId: string, layerId: string, slug: string, capture: ProductCapture): Promise<void> {
  const opened = await openVideo(ctx, videoId)
  const layer = opened.project.layers?.find((l) => l.id === layerId)
  if (!layer?.style?.component) throw notFoundError('That component layer is no longer on the video.')
  const brought = await namedLibraryAssets(ctx, opened.project, capture.assetId)
  const next = {
    ...opened.project,
    assets: [...opened.project.assets, ...brought],
    layers: (opened.project.layers ?? []).map((l) => (l.id === layerId ? { ...l, assetId: capture.assetId, style: { ...l.style, component: componentStyle(slug, capture) } } : l)),
  }
  await saveVersion(ctx, videoId, 'project', 'Before the agent: refresh a product component', opened.project).catch(() => null)
  await saveVideo(ctx, next, opened.projectDigest)
}

/** A video's component layers with whether each is out of date as far as the latest listings say. */
export async function videoComponents(ctx: StudioContext, videoId: string): Promise<{ layerId: string; slug: string; component: string; key: string; stale: Staleness | null }[]> {
  const opened = await openVideo(ctx, videoId)
  const layers = componentLayers(opened.project)
  const products = new Map<string, ProductRecord | null>()
  for (const layer of layers) if (!products.has(layer.slug)) products.set(layer.slug, await getProduct(ctx, layer.slug))
  return layers.map((layer) => ({ layerId: layer.layerId, slug: layer.slug, component: layer.component, key: layer.key, stale: layerStaleness(layer, products.get(layer.slug) ?? null) }))
}

/** The newest capture of a component (optionally a given asset), or null. */
export function latestCapture(product: ProductRecord, component?: string, assetId?: string): ProductCapture | null {
  return product.captures.find((c) => (!assetId || c.assetId === assetId) && (!component || c.component === component)) ?? null
}
