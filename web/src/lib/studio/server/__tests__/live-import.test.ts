// A take prepared while it records (live-takes.ts followLive, liveWorkerPieces; recordings.ts reusing the live job):
// live-import jobs are queued only when a worker with live slots is there, one per video track at the rate the recorder
// reported; the worker reads only its own track and only pieces surely stored; at Stop the recording takes the running
// job as the track's import, an unused one is stopped, and a live job that fails gives way to the ordinary import. A
// take thrown away stops its live jobs. Made-up people and bytes.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { commitBlob, createBlobWrite } from '../blobs'
import { forgetWorkers, noteWorker } from '../capabilities'
import { workerLivePieces } from '../http'
import { cancelJob, claimJob, completeJob, failJob, jobRow, MAX_OPEN_JOBS, queueJob } from '../jobs'
import { discardLiveTake, livePiece, liveRate, liveWorkerPieces, MAX_LIVE_JOBS, QUIET_MS, sealLiveTrack, startLiveTake, TAKES, type TakeRecord } from '../live-takes'
import { advanceRecording, FALLBACK_GIVE_UP_MS, recoverTake, startRecording } from '../recordings'
import { AVA, fakeContext, WS } from './fake'

let env: ReturnType<typeof fakeContext>
beforeEach(() => {
  env = fakeContext({ member: [{ id: 'm-ava', workspace_id: WS, user_id: AVA, role: 'member' }] })
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  noteWorker('live-worker', ['liveImport'])
})
afterEach(() => forgetWorkers())
const deps = () => ({ supabase: env.ctx.supabase, storage: env.ctx.storage })

const webm = (bytes: number) => { const b = new Uint8Array(bytes).fill(9); b.set([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81]); return b }
const filler = (bytes: number) => new Uint8Array(bytes).fill(9)

async function newTake(tracks: { role: string; name: string; frameRate?: number }[] = [{ role: 'screen', name: 'Screen.webm', frameRate: 60 }, { role: 'camera', name: 'Camera.webm', frameRate: 30 }, { role: 'microphone', name: 'Mic.webm' }]) {
  return (await startLiveTake(env.ctx, { recorder: 'browser', tracks })).take
}
async function send(takeId: string, role: string, index: number, bytes: Uint8Array) {
  const link = (await livePiece(env.ctx, takeId, { role, index, bytes: bytes.byteLength, seconds: (index + 1) * 4 })) as { url?: string; headers?: Record<string, string> }
  if (link.url) env.storage.putLink({ url: link.url, headers: link.headers! }, bytes)
}
/** The live worker's own word on how far along a job is (the share of the declared pieces it has conformed). */
const along = (jobId: string, progress: number) => Object.assign(env.tables.studio_job!.find((j) => j.id === jobId)!, { progress })
const take = (id: string) => env.tables.studio_record!.find((r) => r.collection === TAKES && r.key === id)!.value as TakeRecord
const jobs = () => env.tables.studio_job ?? []
const asset = (n: string) => ({ id: n.repeat(64), name: 'Screen.mp4', kind: 'video', file: `assets/${n.repeat(64)}.mp4`, sha256: n.repeat(64), bytes: 100, width: 640, height: 360, sourceFps: 60, sourceFrames: 240, durationSeconds: 4, hasAudio: false, sourceCursorHidden: false, provenance: { rawBytes: 4000, rawSha256: 'e'.repeat(64) } })
async function store(made: ReturnType<typeof asset>) {
  const write = await createBlobWrite(env.ctx, { key: made.file, bytes: made.bytes, contentType: 'video/mp4', sha256: made.sha256 })
  for (const part of write.parts) env.storage.put(part.url.replace('fake://upload/', ''), filler(part.bytes))
  await commitBlob(env.ctx, made.file)
}

describe('following a take while it records', () => {
  it('queues a live-import job per video track at the rate the recorder reported, only with a live worker there', async () => {
    const t = await newTake()
    const live = take(t.id).liveJobs!
    expect(Object.keys(live).sort()).toEqual(['camera', 'screen'])
    const screenJob = jobs().find((j) => j.id === live.screen)!
    expect(screenJob).toMatchObject({ kind: 'live-import', status: 'queued' })
    expect(screenJob.input).toMatchObject({ uploadKey: t.keys.screen, conform: { fps: 60 }, provenance: { take: t.id, role: 'screen' } })
    expect((jobs().find((j) => j.id === live.camera)!.input as { conform: { fps: number } }).conform.fps).toBe(30)
    expect(liveRate('screen', 30)).toBe(30)
    expect(liveRate('screen', 59.94)).toBe(60)
    expect(liveRate('screen', undefined)).toBe(60)
    expect(liveRate('camera', 60)).toBe(30)
    forgetWorkers()
    const other = await newTake()
    expect(take(other.id).liveJobs).toBeUndefined()
  })

  it('is never taken by a slot asking for other kinds', async () => {
    await newTake()
    expect(await claimJob(deps(), 'media-slot', ['import', 'export'])).toBeNull()
    expect((await claimJob(deps(), 'live-slot', ['live-import']))?.kind).toBe('live-import')
  })
})

describe('what the live job reads', () => {
  it('only its own track, only pieces surely stored, and the seal once it comes', async () => {
    const t = await newTake()
    const job = (await claimJob(deps(), 'w', ['live-import']))!
    const row = await jobRow(env.ctx, job.id)
    const asJob = { id: job.id, kind: 'live-import', input: job.input as unknown as Record<string, unknown> }
    const role = (job.input as { uploadKey: string }).uploadKey.split('/')[2] as 'screen' | 'camera'
    void row
    await send(t.id, role, 0, webm(2000))
    await send(t.id, role, 1, filler(2000))
    // Piece 3 is declared, its upload not yet arrived: not listed.
    await livePiece(env.ctx, t.id, { role, index: 2, bytes: 2000 })
    let read = await liveWorkerPieces(env.ctx, asJob, 0)
    expect(read.pieces.map((p) => [p.index, p.bytes])).toEqual([[0, 2000], [1, 2000]])
    expect(read).toMatchObject({ sealed: null, state: 'recording' })
    // It arrives: listed. From where the job asks.
    env.storage.put(`${WS}/live/${t.id}/${role}/2`, filler(2000))
    read = await liveWorkerPieces(env.ctx, asJob, 2)
    expect(read.pieces.map((p) => p.index)).toEqual([2])
    // Sealed while the job reads: it learns the count, and that the take is finished with.
    await sealLiveTrack(env.ctx, `live/${t.id}/${role}`, 3)
    read = await liveWorkerPieces(env.ctx, asJob, 3)
    expect(read).toMatchObject({ pieces: [], sealed: { count: 3, complete: true } })
    // Another job, or another kind, reads nothing.
    await expect(liveWorkerPieces(env.ctx, { ...asJob, id: '00000000-0000-4000-8000-000000000001' }, 0)).rejects.toMatchObject({ code: 'NOT_YOURS' })
    await expect(liveWorkerPieces(env.ctx, { ...asJob, kind: 'import' }, 0)).rejects.toMatchObject({ code: 'NOT_YOURS' })
  })

  it('answers through the worker route only to the worker holding the job', async () => {
    const t = await newTake()
    const job = (await claimJob(deps(), 'w-1', ['live-import']))!
    void t
    const ask = (workerId: string) => workerLivePieces(new Request('http://localhost/x', { method: 'POST', headers: { authorization: 'Bearer dev-studio-worker', 'content-type': 'application/json' }, body: JSON.stringify({ jobId: job.id, workerId, after: 0 }) }), deps())
    expect((await ask('w-1')).status).toBe(200)
    expect((await ask('w-2')).status).toBe(409)
  })

  it('tells the job a take thrown away is gone, and stops its live jobs', async () => {
    const t = await newTake()
    const job = (await claimJob(deps(), 'w', ['live-import']))!
    await send(t.id, 'screen', 0, webm(2000))
    await discardLiveTake(env.ctx, t.id)
    expect(await liveWorkerPieces(env.ctx, { id: job.id, kind: 'live-import', input: job.input as unknown as Record<string, unknown> }, 0)).toMatchObject({ state: 'dropped', pieces: [] })
    expect(jobs().filter((j) => j.kind === 'live-import').every((j) => j.cancel_requested || j.status === 'cancelled')).toBe(true)
  })
})

async function recorded() {
  const t = await newTake([{ role: 'screen', name: 'Screen.webm', frameRate: 60 }, { role: 'camera', name: 'Camera.webm', frameRate: 30 }, { role: 'microphone', name: 'Mic.webm' }])
  for (const role of ['screen', 'camera', 'microphone']) await send(t.id, role, 0, webm(2000))
  return t
}
const body = (t: { keys: Record<string, string> }) => ({
  screen: { uploadKey: t.keys.screen, name: 'Screen.webm', pieces: 1, frameRate: 60 },
  camera: { uploadKey: t.keys.camera, name: 'Camera.webm', offsetSeconds: 0.2, pieces: 1 },
  microphone: { uploadKey: t.keys.microphone, name: 'Mic.webm', offsetSeconds: -0.1, pieces: 1 },
})

describe('at Stop', () => {

  it('takes a running live job as the track’s import, and stops one still waiting for a slot', async () => {
    const t = await recorded()
    const live = take(t.id).liveJobs!
    // The screen's job is running in a live slot; the camera's never found one.
    const running = (await claimJob(deps(), 'w', ['live-import']))!
    expect(running.id).toBe(live.screen)
    along(running.id, 0.9)
    const { recording } = await startRecording(env.ctx, body(t), 0)
    const record = env.tables.studio_record!.find((r) => r.collection === 'recordings' && r.key === recording.id)!.value as { jobs: Record<string, string>; live: { roles: string[] } }
    expect(record.jobs.screen).toBe(live.screen)
    expect(record.live.roles).toEqual(['screen'])
    expect(jobs().find((j) => j.id === live.screen)!.input).toMatchObject({ provenance: { recording: recording.id, take: t.id } })
    expect(jobs().find((j) => j.id === live.camera)!.status).toBe('cancelled')
    const camera = jobs().find((j) => j.id === record.jobs.camera)!
    expect(camera).toMatchObject({ kind: 'import', input: { uploadKey: t.keys.camera } })
    expect(jobs().filter((j) => j.kind === 'import')).toHaveLength(2)
    // The live job finishes: the recording is made with nobody waiting once the other imports are in.
    await store(asset('a'))
    // What it read is what was sealed: one piece of 2000 bytes.
    await completeJob(deps(), running.id, 'w', { asset: { ...asset('a'), provenance: { rawBytes: 2000, rawPieces: 1, rawSha256: 'e'.repeat(64) } } })
    for (const role of ['camera', 'microphone']) {
      const j = (await claimJob(deps(), 'w', ['import']))!
      await failJob(deps(), j.id, 'w', `No ${role} today`)
    }
    expect((await advanceRecording(env.ctx, recording.id, 0)).recording.status).toBe('done')
    expect(jobs().find((j) => j.id === running.id)!.result).toMatchObject({ rawBytes: 2000, rawSha256: 'e'.repeat(64) })
  })

  it('falls back to the ordinary import when the live job fails', async () => {
    const t = await recorded()
    const live = take(t.id).liveJobs!
    const screen = (await claimJob(deps(), 'w', ['live-import']))!
    const camera = (await claimJob(deps(), 'w', ['live-import']))!
    along(screen.id, 0.9)
    along(camera.id, 0.9)
    const { recording } = await startRecording(env.ctx, body(t), 0)
    await failJob(deps(), screen.id, 'w', 'The live worker stopped.')
    await advanceRecording(env.ctx, recording.id, 0)
    const record = env.tables.studio_record!.find((r) => r.collection === 'recordings' && r.key === recording.id)!.value as { jobs: Record<string, string>; live: { roles: string[] }; rev: number; status: string }
    expect(record.jobs.screen).not.toBe(live.screen)
    expect(jobs().find((j) => j.id === record.jobs.screen)).toMatchObject({ kind: 'import', input: { uploadKey: t.keys.screen, conform: { fps: 60, fit: true, ceiling: 60 } } })
    expect(record.live.roles).toEqual(['camera'])
    expect(record.rev).toBe(1)
    expect(record.status).toBe('importing')
    void camera
    // Asked again: no second fallback.
    await advanceRecording(env.ctx, recording.id, 0)
    expect(jobs().filter((j) => j.kind === 'import' && (j.input as { uploadKey: string }).uploadKey === t.keys.screen)).toHaveLength(1)
  })

  it('falls back when a live job is back in the queue after Stop, live workers or not', async () => {
    const t = await recorded()
    along((await claimJob(deps(), 'w', ['live-import']))!.id, 0.9)
    along((await claimJob(deps(), 'w', ['live-import']))!.id, 0.9)
    const { recording } = await startRecording(env.ctx, body(t), 0)
    // Its worker went quiet: the job is back in the queue (a live worker is still heard: it would wait for a slot).
    for (const j of jobs()) if (j.kind === 'live-import') Object.assign(j, { status: 'queued', worker_id: null })
    await advanceRecording(env.ctx, recording.id, 0)
    const record = env.tables.studio_record!.find((r) => r.collection === 'recordings' && r.key === recording.id)!.value as { jobs: Record<string, string>; live?: { roles: string[] } }
    expect(jobs().filter((j) => j.kind === 'live-import').every((j) => j.status === 'cancelled')).toBe(true)
    expect(jobs().find((j) => j.id === record.jobs.screen)!.kind).toBe('import')
    expect(jobs().find((j) => j.id === record.jobs.camera)!.kind).toBe('import')
  })
})

describe('a take brought back after a crash', () => {
  it('keeps its running live job, which learns the track ends where it stopped (partial)', async () => {
    const t = await newTake([{ role: 'screen', name: 'Screen.webm', frameRate: 60 }])
    await send(t.id, 'screen', 0, webm(2000))
    const job = (await claimJob(deps(), 'w', ['live-import']))!
    along(job.id, 0.9)
    await recoverTake(env.ctx, t.id, 0, Date.now() + QUIET_MS + 1000)
    const record = env.tables.studio_record!.find((r) => r.collection === 'recordings')!.value as { jobs: Record<string, string> }
    expect(record.jobs.screen).toBe(job.id)
    expect(await liveWorkerPieces(env.ctx, { id: job.id, kind: 'live-import', input: job.input as unknown as Record<string, unknown> }, 1)).toMatchObject({ sealed: { count: 1, complete: false }, state: 'finished' })
  })
})

describe('as the review asked', () => {
  it('keeps a running live job however far along: the worker weighs that at the seal, where its speed is known', async () => {
    const t = await newTake([{ role: 'screen', name: 'Screen.webm', frameRate: 60 }])
    await send(t.id, 'screen', 0, webm(2000))
    const job = (await claimJob(deps(), 'w', ['live-import']))!
    along(job.id, 0.05)
    const { recording } = await startRecording(env.ctx, { screen: { uploadKey: t.keys.screen, name: 'Screen.webm', pieces: 1, frameRate: 60 } }, 0)
    const record = env.tables.studio_record!.find((r) => r.collection === 'recordings' && r.key === recording.id)!.value as { jobs: Record<string, string> }
    expect(record.jobs.screen).toBe(job.id)
  })

  it('does not keep a live job asked for another rate ceiling than the import would be', async () => {
    // The take started saying 60; at Stop the recorder says the screen gave 30.
    const t = await newTake([{ role: 'screen', name: 'Screen.webm', frameRate: 60 }])
    await send(t.id, 'screen', 0, webm(2000))
    const job = (await claimJob(deps(), 'w', ['live-import']))!
    along(job.id, 0.9)
    const { recording } = await startRecording(env.ctx, { screen: { uploadKey: t.keys.screen, name: 'Screen.webm', pieces: 1, frameRate: 30 } }, 0)
    const record = env.tables.studio_record!.find((r) => r.collection === 'recordings' && r.key === recording.id)!.value as { jobs: Record<string, string> }
    expect(record.jobs.screen).not.toBe(job.id)
    expect(jobs().find((j) => j.id === record.jobs.screen)).toMatchObject({ kind: 'import', input: { conform: { fps: 60, fit: true, ceiling: 30 } } })
    expect(jobs().find((j) => j.id === job.id)!.cancel_requested).toBe(true)
  })

  it('does not keep a live job whose cursor flag is not the import’s', async () => {
    const t = await newTake([{ role: 'screen', name: 'Screen.webm', frameRate: 60 }])
    await send(t.id, 'screen', 0, webm(2000))
    const job = (await claimJob(deps(), 'w', ['live-import']))!
    along(job.id, 0.9)
    const { recording } = await startRecording(env.ctx, { screen: { uploadKey: t.keys.screen, name: 'Screen.webm', pieces: 1, frameRate: 60 }, sourceCursorHidden: true }, 0)
    const record = env.tables.studio_record!.find((r) => r.collection === 'recordings' && r.key === recording.id)!.value as { jobs: Record<string, string> }
    expect(record.jobs.screen).not.toBe(job.id)
  })

  it('stops unused live jobs before queueing the imports, so a workspace near its cap is not refused', async () => {
    const t = await recorded()
    // 16 other jobs waiting: with the take's two live jobs, 18 of the 20 a workspace may have.
    for (let i = 0; i < 16; i++) await queueJob(env.ctx, 'stills', { project: {}, times: [0], scale: 1 } as never)
    await expect(startRecording(env.ctx, body(t), 0)).resolves.toBeTruthy()
    expect(jobs().filter((j) => j.kind === 'import')).toHaveLength(3)
  })

  it('queues the screen with the import’s own rate rule, and follows no more than two takes a workspace', async () => {
    const t = await recorded()
    expect(jobs().find((j) => j.id === take(t.id).liveJobs!.screen)!.input).toMatchObject({ conform: { fps: 60, fit: true, ceiling: 60 } })
    await recorded()
    const third = await recorded()
    expect(take(third.id).liveJobs).toBeUndefined()
    expect(jobs().filter((j) => j.kind === 'live-import')).toHaveLength(MAX_LIVE_JOBS)
  })

  it('refuses a live result whose bytes or pieces are not the sealed track', async () => {
    const t = await newTake([{ role: 'screen', name: 'Screen.webm', frameRate: 60 }])
    await send(t.id, 'screen', 0, webm(2000))
    const job = (await claimJob(deps(), 'w', ['live-import']))!
    await sealLiveTrack(env.ctx, t.keys.screen!, 1)
    await store(asset('b'))
    const made = { ...asset('b'), provenance: { rawBytes: 1999, rawPieces: 1, rawSha256: 'e'.repeat(64) } }
    await expect(completeJob(deps(), job.id, 'w', { asset: made })).rejects.toMatchObject({ status: 422 })
    expect(jobs().find((j) => j.id === job.id)!.status).toBe('failed')
  })

  it('answers a resuming worker with the declared lengths below where it asks from', async () => {
    const t = await newTake([{ role: 'screen', name: 'Screen.webm', frameRate: 60 }])
    await send(t.id, 'screen', 0, webm(2000))
    await send(t.id, 'screen', 1, filler(3000))
    const job = (await claimJob(deps(), 'w', ['live-import']))!
    const read = await liveWorkerPieces(env.ctx, { id: job.id, kind: 'live-import', input: job.input as unknown as Record<string, unknown> }, 2, Date.now(), true)
    expect(read).toMatchObject({ lengths: [2000, 3000], declared: 2 })
  })

  it('cancels a job claimed between the read and the cancel', async () => {
    const queued = await queueJob(env.ctx, 'import', { uploadKey: 'uploads/0e0e0e0e-1111-4222-8333-999999999999', name: 'x.mp4' })
    // The worker claims it just as the cancel reads it queued.
    const from = env.ctx.supabase.from.bind(env.ctx.supabase)
    let raced = false
    env.ctx.supabase.from = ((table: string) => {
      const chain = from(table) as unknown as Record<string, (...a: unknown[]) => unknown>
      if (table === 'studio_job' && !raced) {
        const update = chain.update!.bind(chain)
        chain.update = (patch: unknown) => {
          if ((patch as { status?: string }).status === 'cancelled' && !raced) {
            raced = true
            Object.assign(env.tables.studio_job!.find((j) => j.id === queued.id)!, { status: 'running', worker_id: 'w' })
          }
          return update(patch)
        }
      }
      return chain
    }) as unknown as typeof env.ctx.supabase.from
    await cancelJob(env.ctx, queued.id)
    env.ctx.supabase.from = from
    expect(raced).toBe(true)
    expect(env.tables.studio_job!.find((j) => j.id === queued.id)).toMatchObject({ status: 'running', cancel_requested: true })
  })

  it('asks again for a fallback refused at the job cap, and gives up a day after the recording started', async () => {
    const t = await recorded()
    const screen = (await claimJob(deps(), 'w', ['live-import']))!
    along(screen.id, 0.9)
    along((await claimJob(deps(), 'w', ['live-import']))!.id, 0.9)
    const { recording } = await startRecording(env.ctx, body(t), 0)
    const recordOf = () => env.tables.studio_record!.find((r) => r.collection === 'recordings' && r.key === recording.id)!.value as { jobs: Record<string, string>; live: { roles: string[] }; createdAt: string; status: string }
    // The screen's live job failed (its worker's follow-up lost), and the workspace is at its cap.
    Object.assign(jobs().find((j) => j.id === screen.id)!, { status: 'failed', error: 'The live worker stopped.' })
    while (jobs().filter((j) => (j.status === 'queued' || j.status === 'running') && !j.cancel_requested).length < MAX_OPEN_JOBS) await queueJob(env.ctx, 'stills', { project: {}, times: [0], scale: 1 } as never)
    await expect(advanceRecording(env.ctx, recording.id, 0)).resolves.toBeTruthy()
    expect(recordOf().live.roles).toContain('screen')
    expect(recordOf().jobs.screen).toBe(screen.id)
    // Still refused a day on: the track ends as its live job did, and the recording is no longer kept waiting on it.
    recordOf().createdAt = new Date(Date.now() - FALLBACK_GIVE_UP_MS - 1000).toISOString()
    await advanceRecording(env.ctx, recording.id, 0)
    expect(recordOf().live.roles).not.toContain('screen')
    expect(jobs().filter((j) => j.kind === 'import' && (j.input as { uploadKey: string }).uploadKey === t.keys.screen)).toHaveLength(0)
  })

  it('queues the fallback on a later look once the cap has room', async () => {
    const t = await recorded()
    const screen = (await claimJob(deps(), 'w', ['live-import']))!
    along(screen.id, 0.9)
    along((await claimJob(deps(), 'w', ['live-import']))!.id, 0.9)
    const { recording } = await startRecording(env.ctx, body(t), 0)
    Object.assign(jobs().find((j) => j.id === screen.id)!, { status: 'failed', error: 'The live worker stopped.' })
    const fillers: string[] = []
    while (jobs().filter((j) => (j.status === 'queued' || j.status === 'running') && !j.cancel_requested).length < MAX_OPEN_JOBS) fillers.push((await queueJob(env.ctx, 'stills', { project: {}, times: [0], scale: 1 } as never)).id)
    await advanceRecording(env.ctx, recording.id, 0)
    expect(jobs().filter((j) => j.kind === 'import' && (j.input as { uploadKey: string }).uploadKey === t.keys.screen)).toHaveLength(0)
    for (const id of fillers) await cancelJob(env.ctx, id)
    await advanceRecording(env.ctx, recording.id, 0)
    const record = env.tables.studio_record!.find((r) => r.collection === 'recordings' && r.key === recording.id)!.value as { jobs: Record<string, string>; live: { roles: string[] } }
    expect(jobs().find((j) => j.id === record.jobs.screen)).toMatchObject({ kind: 'import', input: { uploadKey: t.keys.screen } })
    expect(record.live.roles).not.toContain('screen')
  })
})
