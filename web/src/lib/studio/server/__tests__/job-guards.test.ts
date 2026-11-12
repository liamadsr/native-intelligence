/**
 * What keeps one workspace, or one worker, from spoiling the Studio for the others: fair turns at the worker (the
 * workspace with the fewest jobs running first) and cancels that stay cancelled (studio_claim_job as migration 625
 * has it, through the in-memory fake), caps on open jobs (429), a byte quota per workspace (413), and a worker's
 * result held to what it was given and what it stored (an import named by its bytes, keys under the job's own
 * folder, an export under its attempt's). Over the in-memory tables; made-up workspaces.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { commitBlob, createBlobWrite, DEFAULT_WORKSPACE_BYTES, putBlobBytes, workspaceByteLimit } from '../blobs'
import { claimJob, completeJob, getJob, MAX_OPEN_EXPORTS, MAX_OPEN_JOBS, queueJob } from '../jobs'
import { fakeContext, OTHER_WS, WS } from './fake'

let env: ReturnType<typeof fakeContext>
beforeEach(() => {
  env = fakeContext()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})
afterEach(() => vi.unstubAllEnvs())
const deps = () => ({ supabase: env.ctx.supabase, storage: env.ctx.storage })
const other = () => ({ ...env.ctx, workspaceId: OTHER_WS })
const stills = (ctx = env.ctx) => queueJob(ctx, 'stills', { project: {} as never, times: [1], scale: 1 })
const row = (id: string) => env.tables.studio_job!.find((j) => j.id === id)!

/** Store `bytes` under `key` as the worker would (write, PUT, commit). */
async function store(key: string, bytes = 30, sha256?: string) {
  const write = await createBlobWrite(env.ctx, { key, bytes, contentType: 'video/mp4', ...(sha256 ? { sha256 } : {}) })
  for (const part of write.parts) env.storage.put(part.url.replace('fake://upload/', ''), new Uint8Array(part.bytes))
  return commitBlob(env.ctx, key)
}

describe('claiming fairly', () => {
  it('takes the queued job of the workspace with the fewest jobs running, then the oldest', async () => {
    const busy = [await stills(), await stills(), await stills()]
    const quiet = await stills(other())
    expect((await claimJob(deps(), 'w1', ['stills']))?.id).toBe(busy[0]!.id)
    // WS now has one running, OTHER_WS none: the quiet workspace's newer job goes first.
    expect((await claimJob(deps(), 'w2', ['stills']))?.id).toBe(quiet.id)
    expect((await claimJob(deps(), 'w3', ['stills']))?.id).toBe(busy[1]!.id)
  })

  it('cancels a stale running job that was asked to stop, rather than queuing it again, and a queued one asked to stop', async () => {
    const asked = await stills()
    await claimJob(deps(), 'w', ['stills'])
    Object.assign(row(asked.id), { cancel_requested: true, heartbeat_at: '2020-01-01T00:00:00Z' })
    const quiet = await stills()
    await claimJob(deps(), 'w', ['stills'])
    Object.assign(row(quiet.id), { heartbeat_at: '2020-01-01T00:00:00Z' })
    const queuedAsked = await stills()
    row(queuedAsked.id).cancel_requested = true
    // The next claim: the asked ones end cancelled, the merely quiet one goes back in the queue and is taken again.
    expect((await claimJob(deps(), 'w2', ['stills']))?.id).toBe(quiet.id)
    expect(row(asked.id)).toMatchObject({ status: 'cancelled', error: 'Cancelled.' })
    expect(row(queuedAsked.id)).toMatchObject({ status: 'cancelled' })
    expect(row(quiet.id)).toMatchObject({ status: 'running', worker_id: 'w2', attempts: 2 })
  })
})

describe('open job caps', () => {
  it(`refuses a ${MAX_OPEN_JOBS + 1}th open job, and a ${MAX_OPEN_EXPORTS + 1}th open export, with a sentence (429)`, async () => {
    for (let i = 0; i < MAX_OPEN_EXPORTS; i++) await queueJob(env.ctx, 'export', { project: {} as never, title: `Cut ${i}` })
    await expect(queueJob(env.ctx, 'export', { project: {} as never, title: 'One more' })).rejects.toMatchObject({ status: 429, message: expect.stringMatching(/already has 5 exports waiting or running/) })
    for (let i = MAX_OPEN_EXPORTS; i < MAX_OPEN_JOBS; i++) await stills()
    await expect(stills()).rejects.toMatchObject({ status: 429, code: 'TOO_MANY_JOBS', message: expect.stringMatching(/already has 20 Studio jobs/) })
    // Another workspace is not held up, and a finished job frees a place.
    await expect(stills(other())).resolves.toMatchObject({ status: 'queued' })
    env.tables.studio_job!.find((j) => j.workspace_id === WS && j.kind === 'stills')!.status = 'completed'
    await expect(stills()).resolves.toMatchObject({ status: 'queued' })
  })
})

describe('the byte quota', () => {
  it('defaults to 50 GB, reads STUDIO_WORKSPACE_BYTES, and refuses a write past it with what is used (413)', async () => {
    expect(workspaceByteLimit({})).toBe(DEFAULT_WORKSPACE_BYTES)
    expect(workspaceByteLimit({ STUDIO_WORKSPACE_BYTES: 'lots' })).toBe(DEFAULT_WORKSPACE_BYTES)
    vi.stubEnv('STUDIO_WORKSPACE_BYTES', String(3 * 1024 ** 2))
    await putBlobBytes(env.ctx, 'thumbs/a.jpg', new Uint8Array(1024 ** 2), 'image/jpeg')
    // A pending write counts too.
    await createBlobWrite(env.ctx, { key: 'uploads/0a0a0a0a-1111-4222-8333-000000000001', bytes: 1024 ** 2, contentType: 'video/mp4' })
    const refused = createBlobWrite(env.ctx, { key: 'uploads/0a0a0a0a-1111-4222-8333-000000000002', bytes: 2 * 1024 ** 2, contentType: 'video/mp4' })
    await expect(refused).rejects.toMatchObject({ status: 413, code: 'QUOTA' })
    await expect(refused).rejects.toThrow("This workspace's Studio holds 2 MB of its 3 MB, and this file needs 2 MB more.")
    await expect(putBlobBytes(env.ctx, 'thumbs/b.jpg', new Uint8Array(2 * 1024 ** 2), 'image/jpeg')).rejects.toMatchObject({ status: 413 })
    // Another workspace has its own.
    await expect(createBlobWrite(other(), { key: 'thumbs/c.jpg', bytes: 2 * 1024 ** 2, contentType: 'image/jpeg' })).resolves.toBeTruthy()
  })
})

describe('a worker’s result', () => {
  const SHA = 'c'.repeat(64)
  const asset = (extra = {}) => ({ id: SHA, name: 'Walkthrough.mov', kind: 'video', file: `assets/${SHA}.mp4`, sha256: SHA, bytes: 30, width: 1920, height: 1080, sourceFps: 60, sourceFrames: 600, durationSeconds: 10, hasAudio: true, sourceCursorHidden: false, ...extra })
  /** A claimed import job. */
  async function importJob() {
    await queueJob(env.ctx, 'import', { uploadKey: 'uploads/0a0a0a0a-1111-4222-8333-000000000009', name: 'Walkthrough.mov' })
    return (await claimJob(deps(), 'w', ['import']))!
  }

  it('refuses an import not named by its bytes, stored elsewhere, or of another size or hash', async () => {
    await store(`assets/${SHA}.mp4`, 30, SHA)
    await store(`assets/${'d'.repeat(64)}.mp4`, 30)
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ id: 'e'.repeat(64) }, /not named by its contents/],
      [{ file: `assets/${'d'.repeat(64)}.mp4` }, /not stored under its contents/],
      [{ bytes: 31 }, /not the file the worker described/],
    ]
    for (const [extra, reason] of cases) {
      const job = await importJob()
      await expect(completeJob(deps(), job.id, 'w', { asset: asset(extra) })).rejects.toMatchObject({ status: 422 })
      expect((await getJob(env.ctx, job.id)).error).toMatch(reason)
    }
    // Same size, another hash recorded for the stored bytes.
    env.tables.studio_blob!.find((b) => b.key === `assets/${SHA}.mp4`)!.sha256 = 'f'.repeat(64)
    const job = await importJob()
    await expect(completeJob(deps(), job.id, 'w', { asset: asset() })).rejects.toMatchObject({ status: 422 })
    env.tables.studio_blob!.find((b) => b.key === `assets/${SHA}.mp4`)!.sha256 = SHA
    const good = await importJob()
    await completeJob(deps(), good.id, 'w', { asset: asset() })
    expect((await getJob(env.ctx, good.id)).status).toBe('completed')
  })

  it('takes stills and an export only under the job’s own folder, the export under its attempt', async () => {
    await queueJob(env.ctx, 'stills', { project: {} as never, times: [1], scale: 1 })
    const frames = (await claimJob(deps(), 'w', ['stills']))!
    await store('stills/someone-else/0.png')
    await expect(completeJob(deps(), frames.id, 'w', { stills: [{ time: 1, key: 'stills/someone-else/0.png', width: 2, height: 2 }] })).rejects.toMatchObject({ status: 422 })
    expect((await getJob(env.ctx, frames.id)).error).toMatch(/outside this job's files/)
    row(frames.id).status = 'running'
    await expect(completeJob(deps(), frames.id, 'w', { stills: [{ time: 1, key: `stills/${frames.id}/0.png`, width: 2, height: 2 }] })).rejects.toThrow()
    expect((await getJob(env.ctx, frames.id)).error).toMatch(/did not store the frame/)
    row(frames.id).status = 'running'
    await store(`stills/${frames.id}/0.png`)
    await completeJob(deps(), frames.id, 'w', { stills: [{ time: 1, key: `stills/${frames.id}/0.png`, width: 2, height: 2 }] })
    expect((await getJob(env.ctx, frames.id)).status).toBe('completed')

    await queueJob(env.ctx, 'export', { project: {} as never, title: 'Spring launch' })
    const first = (await claimJob(deps(), 'w1', ['export']))!
    // The first worker went quiet; the job is taken back and claimed again.
    Object.assign(row(first.id), { heartbeat_at: '2020-01-01T00:00:00Z' })
    const second = (await claimJob(deps(), 'w2', ['export']))!
    expect(second).toMatchObject({ id: first.id, attempts: 2 })
    await store(`exports/${first.id}/1/video.mp4`)
    const result = (key: string) => ({ key, bytes: 30, width: 1920, height: 1080, fps: 30, durationSeconds: 2 })
    // The first attempt's file is not the second's, and the first worker no longer holds the job at all.
    await expect(completeJob(deps(), first.id, 'w1', result(`exports/${first.id}/1/video.mp4`))).rejects.toMatchObject({ status: 409 })
    await expect(completeJob(deps(), first.id, 'w2', result(`exports/${first.id}/1/video.mp4`))).rejects.toMatchObject({ status: 422 })
    row(first.id).status = 'running'
    await store(`exports/${first.id}/2/video.mp4`)
    await completeJob(deps(), first.id, 'w2', result(`exports/${first.id}/2/video.mp4`))
    expect((await getJob(env.ctx, first.id)).downloadUrl).toBe(`/api/account/studio/file/${WS}/exports/${first.id}/2/video.mp4?download=Spring%20launch.mp4`)
  })

  it('removes the consumed upload only once the job is recorded as done', async () => {
    const upload = 'uploads/0a0a0a0a-1111-4222-8333-000000000009'
    await store(upload, 9)
    await store(`assets/${SHA}.mp4`, 30, SHA)
    const job = await importJob()
    // The job was taken back between filing and finishing: the completion is refused and the upload stays.
    const update = env.ctx.supabase.from
    let calls = 0
    vi.spyOn(env.ctx.supabase, 'from').mockImplementation((table: string) => {
      const chain = update.call(env.ctx.supabase, table) as unknown as Record<string, (...a: unknown[]) => unknown>
      if (table !== 'studio_job') return chain as never
      const original = chain.update!
      chain.update = (patch: unknown) => {
        if ((patch as { status?: string }).status === 'completed' && calls++ === 0) row(job.id).worker_id = 'someone-else'
        return original(patch)
      }
      return chain as never
    })
    await expect(completeJob(deps(), job.id, 'w', { asset: asset() })).rejects.toMatchObject({ status: 409 })
    expect(env.tables.studio_blob!.some((b) => b.key === upload)).toBe(true)
  })
})
