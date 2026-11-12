/**
 * Files and jobs over the in-memory tables and bucket: an upload is committed only when every part is there at
 * its size; an import job is claimed, reported on and completed by the worker, and its result filed (the asset
 * registered, the upload removed); the editor reads jobs in its own shape; a worker only touches jobs (and so
 * workspaces) it holds; a stored file is served joined, with byte ranges that cross parts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { commitBlob, createBlobWrite, deleteBlob, getBlob, readBlob } from '../blobs'
import { cancelJob, claimJob, completeJob, failJob, getJob, queueJob, reportProgress, waitForJob } from '../jobs'
import { importPresenter, importSlides, importUpload, listSlideDecks, startExport, startUpload } from '../media'
import { requestTranscription } from '../transcription'
import { serveBlob, type PartFetch } from '../files'
import { createBlankVideo } from '../blank'
import { attachTranscript, getAsset, registerAsset } from '../assets'
import { fakeContext, WS } from './fake'
import type { StudioContext } from '../context'

let env: ReturnType<typeof fakeContext>
beforeEach(() => {
  env = fakeContext()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})
const deps = () => ({ supabase: env.ctx.supabase, storage: env.ctx.storage })
const SHA = 'c'.repeat(64)
const clipAsset = (sha = SHA, extra = {}) => ({ id: sha, name: 'Walkthrough.mov', kind: 'video', file: `assets/${sha}.mp4`, sha256: sha, bytes: 1000, width: 1920, height: 1080, sourceFps: 60, sourceFrames: 600, durationSeconds: 10, hasAudio: true, sourceCursorHidden: false, ...extra })

/** The browser's part: PUT every part of an upload ticket. */
function putAll(ticket: { parts: { index: number; bytes: number; url: string }[] }, fill = 7) {
  for (const part of ticket.parts) env.storage.put(part.url.replace('fake://upload/', ''), new Uint8Array(part.bytes).fill(fill))
}

describe('blobs', () => {
  it('commits an upload only when every part is there at its size, then reads and deletes it', async () => {
    const write = await createBlobWrite(env.ctx, { key: 'uploads/x', bytes: 25, contentType: 'video/mp4', partBytes: 10 })
    expect(write.parts.map((p) => p.bytes)).toEqual([10, 10, 5])
    expect(write.parts[0]!.headers['content-type']).toBe('application/octet-stream')
    env.storage.put(`${WS}/uploads/x/0`, new Uint8Array(10))
    await expect(commitBlob(env.ctx, 'uploads/x')).rejects.toThrow('The upload is not complete: part 2 of 3 is missing.')
    env.storage.put(`${WS}/uploads/x/1`, new Uint8Array(10))
    env.storage.put(`${WS}/uploads/x/2`, new Uint8Array(4))
    await expect(commitBlob(env.ctx, 'uploads/x')).rejects.toThrow('part 3 of 3 has 4 bytes, not 5')
    env.storage.put(`${WS}/uploads/x/2`, new Uint8Array(5))
    expect(await commitBlob(env.ctx, 'uploads/x')).toMatchObject({ bytes: 25, parts: 3, partBytes: 10, contentType: 'video/mp4' })
    expect(await commitBlob(env.ctx, 'uploads/x')).toMatchObject({ bytes: 25 })
    expect((await readBlob(env.ctx, 'uploads/x')).parts.map((p) => p.url)).toEqual([0, 1, 2].map((i) => `fake://read/${WS}/uploads/x/${i}`))
    await deleteBlob(env.ctx, 'uploads/x')
    expect(await getBlob(env.ctx, 'uploads/x')).toBeNull()
    expect(env.storage.objects.size).toBe(0)
    await expect(createBlobWrite(env.ctx, { key: '../escape', bytes: 1, contentType: 'x' })).rejects.toThrow('That is not a file key.')
  })
})

describe('jobs', () => {
  it('imports an upload: queued, claimed, reported, completed and filed', async () => {
    const ticket = await startUpload(env.ctx, { name: 'Walkthrough.mov', bytes: 12, contentType: 'video/quicktime' })
    putAll(ticket)
    const queued = (await importUpload(env.ctx, { uploadKey: ticket.uploadKey, name: 'Walkthrough.mov' })) as { job: { id: string; status: string; logs: string[] } }
    expect(queued.job).toMatchObject({ status: 'running', logs: ['Waiting for the Studio worker…'] })
    const claimed = await claimJob(deps(), 'worker-1', ['import'])
    expect(claimed).toMatchObject({ id: queued.job.id, kind: 'import', workspaceId: WS, input: { uploadKey: ticket.uploadKey, name: 'Walkthrough.mov' }, attempts: 1 })
    expect(await claimJob(deps(), 'worker-2', ['import'])).toBeNull()
    expect(await reportProgress(deps(), claimed!.id, { workerId: 'worker-1', progress: 0.5, log: 'Probing' })).toEqual({ cancelRequested: false })
    await expect(reportProgress(deps(), claimed!.id, { workerId: 'worker-2', progress: 0.6 })).rejects.toMatchObject({ status: 409 })
    // Completing before the asset's file is stored is refused, and fails the job with the reason.
    const asset = clipAsset()
    const early = await queueJob(env.ctx, 'import', { uploadKey: ticket.uploadKey, name: 'Again.mov' })
    await claimJob(deps(), 'worker-3', ['import'])
    await expect(completeJob(deps(), early.id, 'worker-3', { asset })).rejects.toMatchObject({ status: 422 })
    expect((await getJob(env.ctx, early.id)).error).toBe('The worker did not store the imported file.')
    // The worker stores the file, then completes.
    const write = await createBlobWrite(env.ctx, { key: asset.file, bytes: 1000, contentType: 'video/mp4', sha256: asset.sha256 })
    putAll(write)
    await commitBlob(env.ctx, asset.file)
    await completeJob(deps(), claimed!.id, 'worker-1', { asset })
    const done = await getJob(env.ctx, claimed!.id)
    expect(done).toMatchObject({ status: 'completed', progress: 1, logs: ['Probing'], asset: { id: SHA } })
    expect(await getAsset(env.ctx, SHA)).toMatchObject({ name: 'Walkthrough.mov' })
    expect(await getBlob(env.ctx, ticket.uploadKey)).toBeNull()
    // Waiting answers the finished row.
    expect((await waitForJob(env.ctx, claimed!.id, { timeoutMs: 10 })).status).toBe('completed')
  })

  it('answers the editor’s one-call shapes when waiting, and refuses what can’t be imported', async () => {
    await expect(importUpload(env.ctx, { uploadKey: 'assets/x', name: 'a.mp4' })).rejects.toThrow('Upload the file first.')
    await expect(importPresenter(env.ctx, { uploadKey: 'uploads/x', name: 'cam.avi' })).rejects.toThrow('Presenter source must be WebM, MP4, MOV, or MKV')
    await expect(importSlides(env.ctx, { uploadKey: 'uploads/x', name: 'deck.key' })).rejects.toThrow(/Keynote/)
    await expect(startUpload(env.ctx, { name: 'big.mov', bytes: 3 * 1024 ** 3 })).rejects.toThrow('Import exceeds 2 GB')
    const ticket = await startUpload(env.ctx, { name: 'cam.webm', bytes: 9 })
    putAll(ticket)
    const pending = importPresenter(env.ctx, { uploadKey: ticket.uploadKey, name: 'cam.webm' }, { wait: true })
    // The worker does the job while the request waits.
    await new Promise((r) => setTimeout(r, 20))
    const job = await claimJob(deps(), 'w', ['import'])
    expect(job?.input).toMatchObject({ name: 'cam — presenter.mp4', conform: { fps: 30 } })
    const asset = clipAsset('d'.repeat(64))
    putAll(await createBlobWrite(env.ctx, { key: asset.file, bytes: 1000, contentType: 'video/mp4', sha256: asset.sha256 }))
    await commitBlob(env.ctx, asset.file)
    await completeJob(deps(), job!.id, 'w', { asset })
    expect(await pending).toMatchObject({ asset: { id: asset.id }, rawBytes: 9 })
  }, 10_000)

  it('files a slide deck and a transcription, and marks a cancelled job', async () => {
    const ticket = await startUpload(env.ctx, { name: 'Pitch.pdf', bytes: 5 })
    putAll(ticket)
    await importSlides(env.ctx, { uploadKey: ticket.uploadKey, name: 'Pitch.pdf' })
    const slides = await claimJob(deps(), 'w', ['slides'])
    const page = { ...clipAsset('e'.repeat(64)), kind: 'image', file: `assets/${'e'.repeat(64)}.png`, hasAudio: false, sourceFps: undefined, sourceFrames: undefined, durationSeconds: undefined }
    putAll(await createBlobWrite(env.ctx, { key: page.file, bytes: 1000, contentType: 'image/png', sha256: page.sha256 }))
    await commitBlob(env.ctx, page.file)
    await completeJob(deps(), slides!.id, 'w', { deck: { id: 'f'.repeat(64), name: 'Pitch', width: 1920, height: 1080 }, pages: [page] })
    const [deck] = (await listSlideDecks(env.ctx)) as unknown as { pageAssetIds: string[] }[]
    expect(deck).toMatchObject({ schemaVersion: 1, id: 'f'.repeat(64), name: 'Pitch', pageAssetIds: [page.id] })
    expect(((await getJob(env.ctx, slides!.id)).result as { deck: unknown }).deck).toEqual(deck)

    const audio = await registerAsset(env.ctx, clipAsset())
    const { job } = (await requestTranscription(env.ctx, audio.id)) as { job: unknown }
    expect(job).toMatchObject({ kind: 'transcribe', status: 'running', assetId: audio.id, sourceSha256: audio.sha256 })
    const t = await claimJob(deps(), 'w', ['transcribe'])
    const transcript = { id: 'tr-1', assetId: audio.id, sourceSha256: audio.sha256, label: 'Walkthrough transcript', origin: 'local-whisper', alignmentSha256: 'a'.repeat(64), text: 'Hello there', words: [{ id: 'w1', text: 'Hello', startMs: 0, endMs: 300 }, { id: 'w2', text: 'there', startMs: 320, endMs: 700 }] }
    await completeJob(deps(), t!.id, 'w', { outcome: 'transcribed', transcript })
    expect(await getJob(env.ctx, t!.id)).toMatchObject({ status: 'completed', outcome: 'transcribed', transcript: { id: 'tr-1' } })
    expect((await attachTranscript(env.ctx, audio.id))?.id).toBe('tr-1')
    // Asking again answers at once from the registered transcript.
    expect(await requestTranscription(env.ctx, audio.id)).toMatchObject({ transcript: { id: 'tr-1' } })

    const queued = await queueJob(env.ctx, 'stills', { project: {} as never, times: [1], scale: 1 })
    expect((await cancelJob(env.ctx, queued.id)).status).toBe('cancelled')
    const running = await queueJob(env.ctx, 'stills', { project: {} as never, times: [1], scale: 1 })
    await claimJob(deps(), 'w', ['stills'])
    await cancelJob(env.ctx, running.id)
    expect(await reportProgress(deps(), running.id, { workerId: 'w', progress: 0.2 })).toEqual({ cancelRequested: true })
    await failJob(deps(), running.id, 'w', 'Stopped')
    expect(await getJob(env.ctx, running.id)).toMatchObject({ status: 'cancelled', error: 'Cancelled.' })
  })

  it('queues an export of a checked edit and gives a download link when done', async () => {
    const video = await createBlankVideo(env.ctx, { title: 'Spring / launch', seconds: 2, fps: 30 })
    const { job } = await startExport(env.ctx, video)
    const claimed = await claimJob(deps(), 'w', ['export'])
    expect(claimed).toMatchObject({ id: job.id, videoId: video.id, input: { title: 'Spring / launch' } })
    const key = `exports/${job.id}/${claimed!.attempts}/video.mp4`
    putAll(await createBlobWrite(env.ctx, { key, bytes: 30, contentType: 'video/mp4' }))
    await commitBlob(env.ctx, key)
    await completeJob(deps(), job.id, 'w', { key, bytes: 30, width: 1920, height: 1080, fps: 30, durationSeconds: 2 })
    expect((await getJob(env.ctx, job.id)).downloadUrl).toBe(`/api/account/studio/file/${WS}/${key}?download=Spring%20launch.mp4`)
    await expect(startExport(env.ctx, { ...video, assets: [] })).rejects.toThrow(/not valid/)
  })
})

describe('serving a stored file', () => {
  const bytes = Uint8Array.from({ length: 25 }, (_, i) => i)
  const fetchPart: PartFetch = async (url, from, to) => {
    const index = Number(url.split('/').at(-1))
    const part = bytes.subarray(index * 10, index * 10 + 10).subarray(from, to + 1)
    return new ReadableStream({ start: (c) => (c.enqueue(part), c.close()) })
  }
  const blob = { key: 'exports/j/video.mp4', bytes: 25, parts: 3, partBytes: 10, contentType: 'video/mp4', sha256: null }
  const get = (range?: string, method = 'GET') => new Request('http://localhost/x', { method, headers: range ? { range } : {} })
  const ctx = () => env.ctx as StudioContext

  it('joins the parts for the whole file', async () => {
    const res = await serveBlob(ctx(), blob, get(), { fetchPart, download: 'Spring launch.mp4' })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-length')).toBe('25')
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    expect(res.headers.get('content-type')).toBe('video/mp4')
    expect(res.headers.get('cache-control')).toBe('private, no-cache')
    expect(res.headers.get('content-disposition')).toContain('attachment; filename="Spring launch.mp4"')
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([...bytes])
  })

  it('serves a range that starts in one part and ends in another', async () => {
    const res = await serveBlob(ctx(), blob, get('bytes=8-21'), { fetchPart })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 8-21/25')
    expect(res.headers.get('content-length')).toBe('14')
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([...bytes.subarray(8, 22)])
  })

  it('serves open-ended and suffix ranges, refuses one past the end, answers HEAD bare', async () => {
    const open = await serveBlob(ctx(), blob, get('bytes=20-'), { fetchPart })
    expect([...new Uint8Array(await open.arrayBuffer())]).toEqual([20, 21, 22, 23, 24])
    const suffix = await serveBlob(ctx(), blob, get('bytes=-3'), { fetchPart })
    expect(suffix.headers.get('content-range')).toBe('bytes 22-24/25')
    expect([...new Uint8Array(await suffix.arrayBuffer())]).toEqual([22, 23, 24])
    const past = await serveBlob(ctx(), blob, get('bytes=25-'), { fetchPart })
    expect(past.status).toBe(416)
    expect(past.headers.get('content-range')).toBe('bytes */25')
    const head = await serveBlob(ctx(), blob, get('bytes=0-1', 'HEAD'), { fetchPart })
    expect(head.status).toBe(206)
    expect(head.headers.get('content-length')).toBe('2')
    expect(head.body).toBeNull()
  })
})
