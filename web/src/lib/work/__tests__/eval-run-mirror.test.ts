/**
 * eval_run → the work ledger (Sequence row 6, plan §1.1). The settle reads the
 * run AS STORED and mirrors that, so every terminal write site (the lane's
 * settle, failRun, cancelEvalRun) projects the same way and a write that lost
 * a race is never what the ledger shows.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { makeFakeSupabase } from './fake-supabase'

const hoisted = vi.hoisted(() => ({ createNotification: vi.fn(async () => {}) }))
vi.mock('@/lib/notifications', () => ({ createNotification: hoisted.createNotification }))
// The recorder wakes the agent router (and the home turn) through Inngest: mocked,
// so no test sends a real event (src/test/setup.ts fails any that slip through).
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn(async () => ({ ids: [] })) } }))
import { resetAgentRunMirrorCaches } from '../agent-run-mirror'
import { evalSummary, mirrorEvalRunQueued, settleEvalWorkFromRow, stepEvalWork } from '../eval-run-mirror'

const RUN = { id: 'er-1', workspace_id: 'w1', suite_id: 's-1', mode: 'batch', started_by: 'u1' }

function seeded(run: Record<string, unknown> = {}) {
  const fake = makeFakeSupabase({ unique: { tracked_job: ['kind,run_key'] } })
  fake.seed('member', [{ id: 'm1', workspace_id: 'w1', user_id: 'u1' }])
  fake.seed('eval_suite', [{ id: 's-1', workspace_id: 'w1', name: 'Discovery calls' }])
  fake.seed('eval_run', [
    { id: 'er-1', status: 'running', outcome: null, error_code: null, error_message: null, progress: { trials_done: 4, trials_total: 4 }, ...run },
  ])
  return fake
}
const row = (fake: ReturnType<typeof seeded>) => fake.rows('tracked_job')[0]

beforeEach(() => {
  resetAgentRunMirrorCaches()
  hoisted.createNotification.mockClear()
})

describe('mirrorEvalRunQueued + stepEvalWork', () => {
  it('queues one eval row keyed by the run, titled from the suite; a step flips it running', async () => {
    const fake = seeded()
    await mirrorEvalRunQueued(fake as never, RUN)
    await mirrorEvalRunQueued(fake as never, RUN)
    expect(fake.rows('tracked_job')).toHaveLength(1)
    expect(row(fake)).toMatchObject({
      kind: 'eval',
      status: 'queued',
      member_id: 'm1',
      run_key: 'er-1',
      title: 'Evaluating Discovery calls (batch)',
      source: { eval_run_id: 'er-1', suite_id: 's-1', entity_type: 'eval_suite', entity_id: 's-1' },
    })
    await stepEvalWork(fake as never, 'er-1', 'Trial 1 of 4 done', { done: 1, total: 4 })
    expect(row(fake)).toMatchObject({ status: 'running', current_step: 'Trial 1 of 4 done' })
  })
})

describe('settleEvalWorkFromRow', () => {
  async function settledAs(run: Record<string, unknown>, trials: Record<string, unknown>[] = []) {
    const fake = seeded(run)
    fake.seed('eval_trial', trials)
    await mirrorEvalRunQueued(fake as never, RUN)
    await settleEvalWorkFromRow(fake as never, 'er-1')
    return row(fake)
  }

  it('a clean run is done', async () => {
    const r = await settledAs({ status: 'completed', outcome: 'passed' })
    expect(r).toMatchObject({ status: 'done', result_summary: '4 trials, all passed' })
  })

  it('a run with failing trials lands in Needs you with the count', async () => {
    const r = await settledAs({ status: 'completed', outcome: 'failed' }, [
      { id: 't1', run_id: 'er-1', outcome: 'failed' },
      { id: 't2', run_id: 'er-1', outcome: 'errored' },
      { id: 't3', run_id: 'er-1', outcome: 'passed' },
      { id: 'tx', run_id: 'other', outcome: 'failed' },
    ])
    expect(r).toMatchObject({ status: 'needs_review', result_summary: '2 of 4 trials failed', needs: { kind: 'review', verb: 'check' } })
  })

  it('a budget stop keeps its results (done); a user cancel is canceled', async () => {
    expect((await settledAs({ status: 'cancelled', error_code: 'budget', outcome: 'scored' })).status).toBe('done')
    expect((await settledAs({ status: 'cancelled', error_code: 'cancelled' })).status).toBe('canceled')
  })

  it('a failure carries its message; the usage wall reads as a usage limit', async () => {
    expect(await settledAs({ status: 'failed', error_code: 'harness_error', error_message: 'trial exploded' })).toMatchObject({
      status: 'failed',
      error_message: 'trial exploded',
    })
    expect((await settledAs({ status: 'failed', error_code: 'usage_limit', error_message: '429' })).error_message).toBe(
      'AI usage limit reached: 429',
    )
  })

  it('a live run is not settled; a run with no ledger row is a silent no-op', async () => {
    expect((await settledAs({ status: 'running' })).status).toBe('queued')
    const fake = seeded({ status: 'completed', outcome: 'passed' })
    await expect(settleEvalWorkFromRow(fake as never, 'er-1')).resolves.toBeUndefined()
    expect(fake.rows('tracked_job')).toHaveLength(0)
  })

  it('mirrors the STORED status: a cancel that won the race stays canceled even if the settle said completed', async () => {
    const fake = seeded({ status: 'cancelled', error_code: 'cancelled' })
    await mirrorEvalRunQueued(fake as never, RUN)
    await settleEvalWorkFromRow(fake as never, 'er-1') // cancelEvalRun's mirror
    // The lane's settle then overwrote the run (the pre-existing race); the
    // ledger row is terminal and refuses the finish.
    fake.rows('eval_run')[0].status = 'completed'
    fake.rows('eval_run')[0].outcome = 'passed'
    await settleEvalWorkFromRow(fake as never, 'er-1')
    expect(row(fake).status).toBe('canceled')
  })
})

describe('evalSummary', () => {
  it('reads a partial run as done of total', () => {
    expect(evalSummary({ status: 'cancelled', outcome: null, error_code: 'budget', error_message: null, progress: { trials_done: 2, trials_total: 6 } }, 0)).toBe('2 of 6 trials')
  })
})
