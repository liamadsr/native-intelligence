import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppError } from '../src/app-client.ts'
import { exportKey } from '../src/jobs/export.ts'
import { JobRun, lostJob, TAKEN_BACK, type Handlers } from '../src/runner.ts'

/** A client that answers progress with `progress()` and records what else it was told. */
function fakeClient(progress: () => Promise<{ cancelRequested: boolean }>) {
  const told: string[] = []
  return {
    told,
    client: {
      progress: async () => (told.push('progress'), progress()),
      complete: async () => void told.push('complete'),
      fail: async (_id: string, message: string) => void told.push(`fail: ${message}`),
    },
  }
}

async function runWith(progress: () => Promise<{ cancelRequested: boolean }>, handler: Handlers['stills']) {
  const dir = await mkdtemp(join(tmpdir(), 'studio-runner-'))
  const { told, client } = fakeClient(progress)
  const job = { id: '0f0f0f0f-1111-4222-8333-444444444444', kind: 'stills' as const, workspaceId: 'w', videoId: null, input: { project: {}, times: [1], scale: 1 }, attempts: 2 }
  const run = new JobRun(job as never, {
    config: { workDir: dir } as never,
    client: client as never,
    cache: { trim: async () => undefined } as never,
    renderer: {} as never,
    handlers: { stills: handler } as never,
  })
  try {
    return { outcome: await run.run(), told }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('a job the app took back (409 NOT_HELD) is stopped, its work aborted, and nothing more is reported', async () => {
  let aborted = false
  const { outcome, told } = await runWith(
    async () => {
      throw new AppError('jobs/x/progress answered 409', 409, 'NOT_HELD')
    },
    // A long render: it ends only when its signal aborts (as FFmpeg and Remotion are killed by it).
    (ctx) =>
      new Promise((_, reject) => {
        const stop = () => {
          aborted = true
          reject(ctx.signal.reason)
        }
        if (ctx.signal.aborted) stop()
        else ctx.signal.addEventListener('abort', stop, { once: true })
      }),
  )
  assert.equal(outcome, 'failed')
  assert.ok(aborted, 'the job’s signal aborted')
  assert.ok(!told.includes('complete'))
  assert.ok(!told.some((t) => t.startsWith('fail')), `told ${told.join(', ')}`)
})

test('any other progress failure leaves the job running', async () => {
  const { outcome, told } = await runWith(
    async () => {
      throw new AppError('jobs/x/progress answered 503', 503, null)
    },
    async () => ({ stills: [] }),
  )
  assert.equal(outcome, 'completed')
  assert.ok(told.includes('complete'))
})

test('only a 409 NOT_HELD reads as a lost job; an export attempt stores under its own folder', () => {
  assert.equal(lostJob(new AppError('x', 409, 'NOT_HELD')), true)
  assert.equal(lostJob(new AppError('x', 409, 'CONFLICT')), false)
  assert.equal(lostJob(new AppError('x', 500, 'NOT_HELD')), false)
  assert.equal(lostJob(new Error('NOT_HELD')), false)
  assert.ok(TAKEN_BACK.includes('taken back'))
  assert.equal(exportKey({ id: 'j1', attempts: 3 }), 'exports/j1/3/video.mp4')
})

// ---- a paid job is completed once it has spent ---------------------------------------------------------------------

/** Run one job of `kind` with `handler`, the app answering progress with `progress` and completion with `complete`. */
async function runPaid(kind: 'shot' | 'narration' | 'stills', progress: () => Promise<{ cancelRequested: boolean }>, handler: (ctx: { signal: AbortSignal }) => Promise<unknown>, complete: () => Promise<void> = async () => undefined, stopWith?: string) {
  const dir = await mkdtemp(join(tmpdir(), 'studio-runner-paid-'))
  const told: string[] = []
  const client = {
    progress: async () => (told.push('progress'), progress()),
    complete: async () => (told.push('complete'), complete()),
    fail: async (_id: string, message: string) => void told.push(`fail: ${message}`),
  }
  const job = { id: '0f0f0f0f-1111-4222-8333-555555555555', kind, workspaceId: 'w', videoId: null, input: {}, attempts: 1 }
  const run = new JobRun(job as never, { config: { workDir: dir } as never, client: client as never, cache: { trim: async () => undefined } as never, renderer: {} as never, handlers: { [kind]: handler } as never })
  try {
    const outcome = run.run()
    if (stopWith) setTimeout(() => run.stop(stopWith), 20)
    return { outcome: await outcome, told }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const SPENT = { outcome: 'undelivered', error: 'paid, not delivered', quote: { model: 'nano_banana_pro', credits: 8 }, providerJobId: 'hf-job-made-up-1' }
/** A handler that spends, then waits for the stop and still answers what it spent. */
const spendThenStop = (answer: unknown) => (ctx: { signal: AbortSignal }) =>
  new Promise((done) => {
    if (ctx.signal.aborted) return done(answer)
    ctx.signal.addEventListener('abort', () => done(answer), { once: true })
  })

test('a shot that spent and was then cancelled is completed with its charge, not failed', async () => {
  const { outcome, told } = await runPaid('shot', async () => ({ cancelRequested: false }), spendThenStop(SPENT), undefined, 'Cancelled')
  assert.equal(outcome, 'completed')
  assert.ok(told.includes('complete'))
  assert.ok(!told.some((t) => t.startsWith('fail')), told.join(' | '))
})

test('a paid job the app took back still sends its completion once', async () => {
  const { outcome, told } = await runPaid('narration', async () => {
    throw new AppError('jobs/x/progress answered 409', 409, 'NOT_HELD')
  }, spendThenStop({ outcome: 'undelivered', characters: 12, charactersFrom: 'provider', error: 'stopped' }), async () => {
    throw new AppError('jobs/x/complete answered 409', 409, 'NOT_HELD')
  })
  assert.equal(outcome, 'failed')
  assert.equal(told.filter((t) => t === 'complete').length, 1)
  assert.ok(!told.some((t) => t.startsWith('fail')), 'nothing more after NOT_HELD')
})

test('a spend the app would not file fails with its charge, never asking to try again', async () => {
  const { outcome, told } = await runPaid('shot', async () => ({ cancelRequested: false }), async () => SPENT, async () => {
    throw new AppError('jobs/x/complete answered 400', 400, null)
  })
  assert.equal(outcome, 'failed')
  const fail = told.find((t) => t.startsWith('fail'))!
  assert.match(fail, /Higgsfield job hf-job-made-up-1 \(8 credits on nano_banana_pro\)/)
  assert.doesNotMatch(fail, /try again/i)
})

test('a spend that may have been charged says so even when the worker was stopping; nothing paid is never completed', async () => {
  const { SpendUnknown } = await import('../src/jobs/context.ts')
  const stopped = 'The studio worker was stopped (a restart or a deploy) before this job finished; try again.'
  const { told } = await runPaid('shot', async () => ({ cancelRequested: false }), (ctx) => new Promise((_, reject) => ctx.signal.addEventListener('abort', () => reject(new SpendUnknown('Higgsfield did not confirm the generation. It may have started and been charged: look for it in your Higgsfield account.')), { once: true })), undefined, stopped)
  const fail = told.find((t) => t.startsWith('fail'))!
  assert.match(fail, /may have started and been charged/)
  assert.doesNotMatch(fail, /try again/i)
  // A refusal spent nothing: a stopped job that answers one is failed as stopped, as before.
  const refused = await runPaid('shot', async () => ({ cancelRequested: false }), spendThenStop({ outcome: 'refused', error: 'The price changed' }), undefined, 'Cancelled')
  assert.equal(refused.outcome, 'failed')
  assert.ok(refused.told.includes('fail: Cancelled'))
})
