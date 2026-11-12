/**
 * Product components on the Studio's in-memory tables (../products.ts): a job prepared for the person's Mac runs only
 * for that person in that folder; an onboarding report makes the product; a capture comes in through the library's
 * import with its provenance and is placed on the video as a layer that remembers what it shows; a new listing marks
 * the layer out of date; a refresh capture swaps its footage and keeps the layer. The worker's import is stood in for
 * (library.test.ts covers it). A made-up product.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const imported = vi.hoisted(() => ({ calls: [] as { name: string; contentType?: string | null; provenance: Record<string, unknown> }[], next: null as unknown }))
vi.mock('../library', async (load) => ({
  ...(await load<object>()),
  importBytes: async (_ctx: unknown, _bytes: Uint8Array, file: { name: string; contentType?: string | null; provenance: Record<string, unknown> }) => {
    imported.calls.push(file)
    return imported.next
  },
}))

import { registerAsset } from '../assets'
import { commitBlob, createBlobWrite } from '../blobs'
import { claimJob, completeJob, failJob, queueJob } from '../jobs'
import { createBlankVideo } from '../blank'
import type { StudioContext } from '../context'
import { acceptCapture, applyReport, captureImported, getProduct, getProductJob, jobForMac, prepareJob, videoComponents } from '../products'
import { openVideo } from '../videos'
import { AVA, fakeContext } from './fake'

const FOLDER = 'c3c3c3c3-1111-4222-8333-888888888888'
const OTHER_FOLDER = 'd4d4d4d4-1111-4222-8333-888888888888'
const SESSION = 'e5e5e5e5-1111-4222-8333-888888888888'
const SHA = 'ab'.repeat(32)
const KEY = '6407e050dd1da3926f837678f2dc2411'
const KIT = { slug: 'planner', title: 'fernhill-planner', framework: 'vite' as const, alias: { '@': 'src' }, css: 'src/index.css', tailwind: 4 as const, discover: ['src/components'], components: {} }
const CARD = { id: 'src-components-PricingCard--PricingCard', name: 'PricingCard', file: 'src/components/PricingCard.tsx', group: 'src/components', help: '', curated: false, width: 320, height: 268, status: 'ok', key: KEY }
const names = { folderLabel: 'planner', deviceName: 'Test Mac' }
const caller = { userId: AVA, sessionId: SESSION, folderId: FOLDER }

let ctx: StudioContext
let env: ReturnType<typeof fakeContext>
beforeEach(() => {
  env = fakeContext()
  ctx = env.ctx
  imported.calls = []
})

/** The made-up capture as the library holds it once imported. */
async function capturedAsset() {
  return registerAsset(ctx, { id: SHA, name: 'Planner · PricingCard.webm', kind: 'video', file: `assets/${SHA}.webm`, sha256: SHA, bytes: 29_122, width: 768, height: 664, sourceFps: 60, sourceFrames: 120, durationSeconds: 2, hasAudio: false, sourceCursorHidden: true })
}

/** Onboard the made-up product through a job, as the Mac would. */
async function onboarded() {
  const job = await prepareJob(ctx, { kind: 'onboard', folderId: FOLDER, slug: null, title: 'Planner' })
  const { job: running } = await jobForMac(ctx, job.id, caller)
  return applyReport(ctx, running, { job: job.id, ok: true, kit: KIT, notes: [], components: [CARD], commit: null }, names)
}

describe('a job for the Mac', () => {
  it('runs only for its person, in its folder, once', async () => {
    const job = await prepareJob(ctx, { kind: 'onboard', folderId: FOLDER, slug: null })
    await expect(jobForMac(ctx, job.id, { ...caller, folderId: OTHER_FOLDER })).rejects.toThrow(/another folder/)
    await expect(jobForMac(ctx, job.id, { ...caller, userId: 'f6f6f6f6-1111-4222-8333-888888888888' })).rejects.toThrow(/No such Studio product job/)
    const { job: running, product } = await jobForMac(ctx, job.id, caller)
    expect(running).toMatchObject({ status: 'running', sessionId: SESSION })
    expect(product).toBeNull()
    await applyReport(ctx, running, { job: job.id, ok: false, error: 'The product has no esbuild installed' }, names)
    expect(await getProductJob(ctx, job.id)).toMatchObject({ status: 'failed', error: 'The product has no esbuild installed' })
    await expect(jobForMac(ctx, job.id, caller)).rejects.toThrow(/already finished/)
  })

  it('an onboarding makes the product, with its listing and where it is', async () => {
    const done = await onboarded()
    expect(done).toMatchObject({ status: 'done', slug: 'planner', result: { product: 'planner', components: 1, renders: 1 } })
    expect(await getProduct(ctx, 'planner')).toMatchObject({ slug: 'planner', title: 'Planner', folderId: FOLDER, folderLabel: 'planner', deviceName: 'Test Mac', components: [CARD], captures: [] })
    // The same name from another folder is refused, never overwritten.
    const other = await prepareJob(ctx, { kind: 'onboard', folderId: OTHER_FOLDER, slug: null })
    const { job: running } = await jobForMac(ctx, other.id, { ...caller, folderId: OTHER_FOLDER })
    expect(await applyReport(ctx, running, { job: other.id, ok: true, kit: KIT, components: [] }, names)).toMatchObject({ status: 'failed', error: expect.stringMatching(/another folder/) })
  })
})

describe('a capture', () => {
  it('comes in through the import with its provenance, is placed, and is kept current', async () => {
    await onboarded()
    const video = await createBlankVideo(ctx, { title: 'Launch', seconds: 6, fps: 30 })
    const asset = await capturedAsset()
    imported.next = { asset }
    const job = await prepareJob(ctx, { kind: 'capture', folderId: FOLDER, slug: 'planner', capture: { component: CARD.id, options: { seconds: 2, props: { plan: 'Studio' } }, place: { videoId: video.id, at: 1 } } })
    const { job: running } = await jobForMac(ctx, job.id, caller)
    const meta = { job: job.id, component: CARD.id, name: 'Planner · PricingCard.webm', kind: 'video' as const, width: 384, height: 332, aspect: 1.1566, seconds: 2, key: KEY, commit: null }
    const answer = await acceptCapture(ctx, running, meta, new Uint8Array([1, 2, 3]))
    expect(answer).toMatchObject({ assetId: SHA, layerId: expect.any(String) })
    expect(imported.calls[0]).toMatchObject({ name: 'Planner · PricingCard.webm', contentType: 'video/webm', provenance: { productComponent: { product: 'planner', component: CARD.id, key: KEY, commit: null, job: job.id, from: 'Test Mac: planner' } } })
    expect(await getProductJob(ctx, job.id)).toMatchObject({ status: 'done', result: { assetId: SHA } })
    expect((await getProduct(ctx, 'planner'))!.captures[0]).toMatchObject({ assetId: SHA, component: CARD.id, key: KEY })

    const placed = (await openVideo(ctx, video.id)).project
    const layer = placed.layers!.find((l) => l.id === (answer as { layerId?: string }).layerId)!
    expect(layer).toMatchObject({ kind: 'image', assetId: SHA, style: { component: { kit: 'planner', id: CARD.id, props: { plan: 'Studio' }, seconds: 2, key: KEY } } })
    expect(placed.assets.some((a) => a.id === SHA)).toBe(true)
    expect(await videoComponents(ctx, video.id)).toEqual([{ layerId: layer.id, slug: 'planner', component: CARD.id, key: KEY, stale: null }])

    // A new listing on the Mac gives the component another key: the layer is out of date.
    const list = await prepareJob(ctx, { kind: 'list', folderId: FOLDER, slug: 'planner' })
    const { job: listing } = await jobForMac(ctx, list.id, caller)
    await applyReport(ctx, listing, { job: list.id, ok: true, components: [{ ...CARD, key: 'bbbb2222bbbb2222' }], commit: null }, names)
    expect((await videoComponents(ctx, video.id))[0]!.stale).toBe('changed')

    // The refresh capture swaps the footage and keeps the layer where it was.
    const NEW = 'cd'.repeat(32)
    imported.next = { asset: await registerAsset(ctx, { ...asset, id: NEW, sha256: NEW, file: `assets/${NEW}.webm`, name: 'Planner · PricingCard (new).webm' }) }
    const refresh = await prepareJob(ctx, { kind: 'refresh', folderId: FOLDER, slug: 'planner', refresh: { videoId: video.id, items: [{ layerId: layer.id, component: CARD.id, options: { seconds: 2, props: { plan: 'Studio' } }, key: KEY }] } })
    const { job: refreshing } = await jobForMac(ctx, refresh.id, caller)
    expect(await acceptCapture(ctx, refreshing, { ...meta, job: refresh.id, item: 0, key: 'bbbb2222bbbb2222' }, new Uint8Array([4]))).toMatchObject({ assetId: NEW, refreshed: layer.id })
    const after = (await openVideo(ctx, video.id)).project.layers!.find((l) => l.id === layer.id)!
    expect(after).toMatchObject({ assetId: NEW, startFrame: layer.startFrame, endFrame: layer.endFrame, style: { component: { key: 'bbbb2222bbbb2222' } } })
    expect((await videoComponents(ctx, video.id))[0]!.stale).toBeNull()
  })

  it('refuses a capture the job did not ask for', async () => {
    await onboarded()
    imported.next = { asset: await capturedAsset() }
    const job = await prepareJob(ctx, { kind: 'capture', folderId: FOLDER, slug: 'planner', capture: { component: CARD.id, options: {} } })
    const { job: running } = await jobForMac(ctx, job.id, caller)
    await expect(acceptCapture(ctx, running, { job: job.id, component: 'something-else', name: 'x.webm', kind: 'video', width: 1, height: 1, aspect: 1, seconds: 1, key: KEY, commit: null }, new Uint8Array([1]))).rejects.toThrow(/not one this job asked for/)
  })

  it('answers the import job while the worker still imports', async () => {
    await onboarded()
    imported.next = { job: { id: 'job-1', status: 'running' } }
    const job = await prepareJob(ctx, { kind: 'capture', folderId: FOLDER, slug: 'planner', capture: { component: CARD.id, options: {} } })
    const { job: running } = await jobForMac(ctx, job.id, caller)
    expect(await acceptCapture(ctx, running, { job: job.id, component: CARD.id, name: 'x.webm', kind: 'video', width: 1, height: 1, aspect: 1, seconds: 1, key: KEY, commit: null }, new Uint8Array([1]))).toEqual({ importing: 'job-1' })
    expect(await getProductJob(ctx, job.id)).toMatchObject({ status: 'running', result: { importJob: 'job-1' } })
  })
})

describe('a capture whose import outlasts the wait', () => {
  const worker = () => ({ supabase: ctx.supabase, storage: ctx.storage })
  /** The import job the capture route queued, taken by a worker, while the route has stopped waiting for it. */
  async function slowImport(jobId: string) {
    const row = await queueJob(ctx, 'import', { uploadKey: 'uploads/0e0e0e0e-1111-4222-8333-999999999999', name: 'Planner · PricingCard.webm', provenance: { productComponent: { product: 'planner', job: jobId } } })
    await claimJob(worker(), 'w-1', ['import'])
    imported.next = { job: { id: row.id, status: 'running' } }
    return row.id
  }
  const meta = (job: string) => ({ job, component: CARD.id, name: 'Planner · PricingCard.webm', kind: 'video' as const, width: 384, height: 332, aspect: 1.1566, seconds: 2, key: KEY, commit: null })

  it('is filed when its import completes: kept, placed as the job asked, the job done, and only once', async () => {
    await onboarded()
    const video = await createBlankVideo(ctx, { title: 'Launch', seconds: 6, fps: 30 })
    const job = await prepareJob(ctx, { kind: 'capture', folderId: FOLDER, slug: 'planner', capture: { component: CARD.id, options: { seconds: 2 }, place: { videoId: video.id, at: 1 } } })
    const { job: running } = await jobForMac(ctx, job.id, caller)
    const importId = await slowImport(job.id)
    expect(await acceptCapture(ctx, running, meta(job.id), new Uint8Array([1]))).toEqual({ importing: importId })
    expect(await getProductJob(ctx, job.id)).toMatchObject({ status: 'running' })
    // The worker finishes the import: the file is stored under its hash, then the result is filed.
    const write = await createBlobWrite(ctx, { key: `assets/${SHA}.webm`, bytes: 10, contentType: 'video/webm', sha256: SHA })
    for (const part of write.parts) env.storage.put(part.url.replace('fake://upload/', ''), new Uint8Array(part.bytes))
    await commitBlob(ctx, `assets/${SHA}.webm`)
    const asset = { id: SHA, name: 'Planner · PricingCard.webm', kind: 'video' as const, file: `assets/${SHA}.webm`, sha256: SHA, bytes: 10, width: 768, height: 664, sourceFps: 60, sourceFrames: 120, durationSeconds: 2, hasAudio: false, sourceCursorHidden: true }
    await completeJob(worker(), importId, 'w-1', { asset })
    const done = await getProductJob(ctx, job.id)
    expect(done).toMatchObject({ status: 'done', result: { assetId: SHA, layerId: expect.any(String) } })
    expect(done!.result).not.toHaveProperty('importing')
    expect((await openVideo(ctx, video.id)).project.layers!.filter((l) => l.assetId === SHA)).toHaveLength(1)
    // A second completion of the same import finds nothing waiting on it: no second layer.
    expect(await captureImported(ctx, job.id, importId, asset)).toBe(false)
    expect((await openVideo(ctx, video.id)).project.layers!.filter((l) => l.assetId === SHA)).toHaveLength(1)
  })

  it('ends a capture job failed when its import fails, instead of leaving it running until it expires', async () => {
    await onboarded()
    const job = await prepareJob(ctx, { kind: 'capture', folderId: FOLDER, slug: 'planner', capture: { component: CARD.id, options: {} } })
    const { job: running } = await jobForMac(ctx, job.id, caller)
    const importId = await slowImport(job.id)
    await acceptCapture(ctx, running, meta(job.id), new Uint8Array([1]))
    await failJob(worker(), importId, 'w-1', 'The file is not a video it can read')
    expect(await getProductJob(ctx, job.id)).toMatchObject({ status: 'failed', error: expect.stringMatching(/could not be imported: The file is not a video/) })
  })
})
