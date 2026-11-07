/**
 * The route's side of the merge job (migration 417): it reads the job row
 * until the runner records an outcome, retries a failed read (the job runs on
 * whatever happens to the request), and stops waiting before its deadline; a
 * lost enqueue answer finds the job it may have queued.
 */
import { describe, it, expect, vi } from 'vitest'
import { findRecentMergeJob, hasQueuedMergeJob, waitForMergeJob, JOB_POLL_MS } from '@/lib/workspace-merge/job'

type Read = { data: unknown; error: unknown }

/** A service whose job-row reads answer in order; every chained filter is recorded. */
function fakeService(reads: Read[]) {
  const calls: Array<{ table: string; select: string; filters: unknown[][] }> = []
  let i = 0
  const service = {
    from: (table: string) => ({
      select: (select: string) => {
        const call = { table, select, filters: [] as unknown[][] }
        calls.push(call)
        const chain: Record<string, unknown> = {}
        for (const op of ['eq', 'gte', 'order', 'limit']) {
          chain[op] = (...args: unknown[]) => {
            call.filters.push([op, ...args])
            return chain
          }
        }
        chain.maybeSingle = async () => reads[Math.min(i++, reads.length - 1)]
        return chain
      },
    }),
  }
  return { service: service as never, calls }
}

/** A clock that moves only when the code sleeps. */
function clock(start = 1_000_000) {
  let t = start
  return { now: () => t, sleep: vi.fn(async (ms: number) => { t += ms }) }
}

const QUEUED = { data: { status: 'queued', result: null, error_code: null, error_message: null }, error: null }

describe('waitForMergeJob', () => {
  it('reads the job row by id until it is done, and returns the merge result', async () => {
    const { service, calls } = fakeService([QUEUED, QUEUED, { data: { status: 'done', result: { merge_id: 'm-1' }, error_code: null, error_message: null }, error: null }])
    const c = clock()
    const out = await waitForMergeJob(service, 'job-1', c.now() + 60_000, { now: c.now, sleep: c.sleep })
    expect(out).toEqual({ status: 'done', result: { merge_id: 'm-1' } })
    expect(calls).toHaveLength(3)
    expect(calls[0]).toEqual({ table: 'workspace_merge_job', select: 'status, result, error_code, error_message', filters: [['eq', 'id', 'job-1']] })
    expect(c.sleep).toHaveBeenCalledTimes(2)
    expect(c.sleep).toHaveBeenCalledWith(JOB_POLL_MS)
  })

  it('a failed job answers with its errcode and message, for the route’s error map', async () => {
    const { service } = fakeService([{ data: { status: 'failed', result: null, error_code: 'P0007', error_message: 'the source workspace is busy' }, error: null }])
    const c = clock()
    expect(await waitForMergeJob(service, 'job-1', c.now() + 60_000, { now: c.now, sleep: c.sleep })).toEqual({
      status: 'failed',
      error: { code: 'P0007', message: 'the source workspace is busy' },
    })
  })

  it('a failed read is retried, not taken for an outcome', async () => {
    const { service, calls } = fakeService([
      { data: null, error: { message: 'fetch failed' } },
      { data: { status: 'done', result: { merge_id: 'm-2' }, error_code: null, error_message: null }, error: null },
    ])
    const c = clock()
    expect(await waitForMergeJob(service, 'job-1', c.now() + 60_000, { now: c.now, sleep: c.sleep })).toEqual({ status: 'done', result: { merge_id: 'm-2' } })
    expect(calls).toHaveLength(2)
  })

  it('stops before the deadline with the job still queued: pending, without sleeping past it', async () => {
    const { service, calls } = fakeService([QUEUED])
    const c = clock()
    const deadline = c.now() + 10 * JOB_POLL_MS + 100
    expect(await waitForMergeJob(service, 'job-1', deadline, { now: c.now, sleep: c.sleep })).toEqual({ status: 'pending' })
    expect(c.now()).toBeLessThanOrEqual(deadline)
    expect(calls).toHaveLength(11)
  })
})

describe('findRecentMergeJob', () => {
  it('the job carrying this request’s snapshot, for the pair and the actor, in the last ten minutes', async () => {
    const { service, calls } = fakeService([{ data: { id: 'job-7' }, error: null }])
    const now = () => Date.parse('2026-10-21T20:00:00Z')
    expect(await findRecentMergeJob(service, 'src', 'dst', 'user', 'snap-1', now)).toBe('job-7')
    expect(calls[0]).toEqual({
      table: 'workspace_merge_job',
      select: 'id',
      filters: [
        ['eq', 'source_workspace_id', 'src'],
        ['eq', 'destination_workspace_id', 'dst'],
        ['eq', 'actor_user_id', 'user'],
        ['eq', 'plan->snapshot->>snapshot_id', 'snap-1'],
        ['gte', 'created_at', '2026-10-21T19:50:00.000Z'],
        ['order', 'created_at', { ascending: false }],
        ['limit', 1],
      ],
    })
  })

  it('none, or a failed read: null', async () => {
    expect(await findRecentMergeJob(fakeService([{ data: null, error: null }]).service, 's', 'd', 'u', 'snap')).toBeNull()
    expect(await findRecentMergeJob(fakeService([{ data: null, error: { message: 'x' } }]).service, 's', 'd', 'u', 'snap')).toBeNull()
  })
})

describe('hasQueuedMergeJob', () => {
  it('a queued job for the source', async () => {
    const { service, calls } = fakeService([{ data: { id: 'job-1' }, error: null }])
    expect(await hasQueuedMergeJob(service, 'src')).toBe(true)
    expect(calls[0].filters).toEqual([['eq', 'source_workspace_id', 'src'], ['eq', 'status', 'queued'], ['limit', 1]])
  })

  it('none, or a failed read (the enqueue still refuses a duplicate with P0010)', async () => {
    expect(await hasQueuedMergeJob(fakeService([{ data: null, error: null }]).service, 'src')).toBe(false)
    expect(await hasQueuedMergeJob(fakeService([{ data: null, error: { message: 'x' } }]).service, 'src')).toBe(false)
  })
})
