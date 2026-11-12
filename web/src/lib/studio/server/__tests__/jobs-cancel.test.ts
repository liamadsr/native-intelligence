/**
 * A cancelled job ends cancelled. When the person asks a running job to stop, its worker is told on its next report,
 * stops, and fails it with 'Cancelled' (studio-worker's runner): the app records that as cancelled, not failed, and
 * so does any failure of a job the person asked to stop. A job that fails on its own stays failed with its reason.
 * A job that was asked to stop and then went back in the queue (its worker went quiet) reads as cancelled, not as
 * running for good. Over the in-memory tables; a made-up workspace.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { cancelJob, claimJob, failJob, getJob, jobRow, queueJob, reportProgress, toEditorJob, waitForJob } from '../jobs'
import { fakeContext } from './fake'

let env: ReturnType<typeof fakeContext>
beforeEach(() => {
  env = fakeContext()
})
const deps = () => ({ supabase: env.ctx.supabase, storage: env.ctx.storage })

/** A stills job claimed by worker `w`. */
async function runningJob() {
  const queued = await queueJob(env.ctx, 'stills', { project: {} as never, times: [1], scale: 1 })
  expect((await claimJob(deps(), 'w', ['stills']))?.id).toBe(queued.id)
  return queued.id
}

/** The job's row in the in-memory table. */
const stored = (id: string) => env.tables.studio_job!.find((r) => r.id === id)!

describe('cancelled jobs', () => {
  it('records the worker’s Cancelled as cancelled, and the editor reads it so', async () => {
    const id = await runningJob()
    await cancelJob(env.ctx, id)
    expect(await reportProgress(deps(), id, { workerId: 'w', progress: 0.3 })).toEqual({ cancelRequested: true })
    expect(await failJob(deps(), id, 'w', 'Cancelled')).toEqual({ ok: true })
    expect(stored(id)).toMatchObject({ status: 'cancelled', error: 'Cancelled.' })
    expect(toEditorJob(await jobRow(env.ctx, id))).toMatchObject({ status: 'cancelled', error: 'Cancelled.' })
    expect(await getJob(env.ctx, id)).toMatchObject({ status: 'cancelled' })
  })

  it('records any failure of a job the person asked to stop as cancelled, whatever the worker says', async () => {
    const id = await runningJob()
    await cancelJob(env.ctx, id)
    await failJob(deps(), id, 'w', 'FFmpeg exited with code 255')
    expect(stored(id)).toMatchObject({ status: 'cancelled', error: 'Cancelled.' })
  })

  it('keeps a job that failed on its own failed, with its reason, even when the worker said Cancelled', async () => {
    const id = await runningJob()
    await failJob(deps(), id, 'w', 'The source file could not be read.')
    expect(await getJob(env.ctx, id)).toMatchObject({ status: 'failed', error: 'The source file could not be read.' })
    // The worker's own stop (its SIGTERM) without the person asking is a failure, not a cancel.
    const other = await runningJob()
    await failJob(deps(), other, 'w', 'Cancelled')
    expect(await getJob(env.ctx, other)).toMatchObject({ status: 'failed', error: 'Cancelled' })
  })

  it('leaves a job alone once the worker no longer holds it', async () => {
    const id = await runningJob()
    await expect(failJob(deps(), id, 'other-worker', 'Cancelled')).rejects.toThrow('This worker does not hold that job any more.')
    expect(stored(id)).toMatchObject({ status: 'running' })
  })

  it('reads a job asked to stop that went back in the queue as cancelled, and stops waiting on it', async () => {
    const id = await runningJob()
    await cancelJob(env.ctx, id)
    // Its worker went quiet: studio_claim_job puts it back in the queue, where no worker takes a cancelled job.
    Object.assign(stored(id), { status: 'queued', worker_id: null })
    expect(await claimJob(deps(), 'w2', ['stills'])).toBeNull()
    expect(await getJob(env.ctx, id)).toMatchObject({ status: 'cancelled', error: 'Cancelled.' })
    const waited = await waitForJob(env.ctx, id, { timeoutMs: 5_000, everyMs: 1_000 })
    expect(waited.status).toBe('cancelled')
  })
})
