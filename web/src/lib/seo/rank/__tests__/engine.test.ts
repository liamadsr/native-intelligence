/**
 * The rank check engine, run whole against the in-memory store and a stubbed
 * data provider (no network). The step runner mimics Inngest: each step id
 * runs once and its output is memoized through JSON; a step can be made to
 * run twice (an attempt that crashed after doing its work), and a sleep moves
 * the clock by its duration.
 */
import type { RankCheckTasksPostInput } from '@/lib/seo/dataforseo'
import { SeoError } from '@/lib/seo/errors'
import { describe, expect, it, vi } from 'vitest'
import {
  bestPosition,
  describeUnchecked,
  mergeRead,
  needsAnotherRead,
  QUEUED_POLL_INTERVALS,
  runRankCheck,
  withoutGoogleTracking,
  type CollectOutcome,
  type RankDataPort,
  type RankEngineDeps,
  type RankStep,
  type ReadPair,
  type TrackerRecord,
} from '../engine'
import { postKey, snapshotRowId } from '../ids'
import {
  createMemoryRankStore,
  memoryRun,
  type MemorySnapshot,
} from './memory-store'

const WS = '00000000-0000-4000-8000-000000000001'
const TRACKER = '00000000-0000-4000-8000-000000000002'
const RUN = '00000000-0000-4000-8000-000000000003'
const PREV_RUN = '00000000-0000-4000-8000-000000000004'
const PERSON = '00000000-0000-4000-8000-0000000000aa'
const K1 = '00000000-0000-4000-8000-0000000000b1'
const K2 = '00000000-0000-4000-8000-0000000000b2'

const START = Date.parse('2026-11-12T10:00:00Z')

function tracker(overrides: Partial<TrackerRecord> = {}): TrackerRecord {
  return {
    id: TRACKER,
    workspace_id: WS,
    created_by: PERSON,
    domain: 'example.com',
    location_code: 2840,
    language_code: 'en',
    location_name: null,
    devices: 'mobile',
    serp_depth: 20,
    paused: false,
    ...overrides,
  }
}

const KEYWORDS = [
  { id: K1, keyword: 'plumber austin' },
  { id: K2, keyword: 'emergency plumber' },
]

const minutes = (d: string) => Number(d.replace('m', '')) * 60_000

function fakeStep(
  clock: { now: number },
  opts: {
    memo?: Map<string, unknown>
    rerun?: Set<string>
    after?: (id: string) => void
  } = {},
) {
  const memo = opts.memo ?? new Map<string, unknown>()
  const executed: string[] = []
  const sleeps: Array<[string, string]> = []
  const step: RankStep = {
    async run<T>(id: string, fn: () => Promise<T>): Promise<T> {
      if (memo.has(id)) return memo.get(id) as T
      // An attempt that did its work and crashed before its output was kept.
      if (opts.rerun?.has(id)) await fn()
      executed.push(id)
      const value = await fn()
      const out = value === undefined ? null : JSON.parse(JSON.stringify(value))
      memo.set(id, out)
      opts.after?.(id)
      return out as T
    },
    async sleep(id: string, duration: string) {
      if (memo.has(id)) return
      memo.set(id, null)
      sleeps.push([id, duration])
      clock.now += minutes(duration)
    },
  }
  return { step, memo, executed, sleeps }
}

type Answer = number | null | 'pending' | 'failed'

/** A provider: each post makes one task per pair; `answer(keywordId, device, read)` says what each task comes back with. */
function stubPort(
  answer: (keywordId: string, device: string, read: number) => Answer,
  opts: {
    post?: (input: RankCheckTasksPostInput, call: number) => void
    urls?: Record<string, string>
  } = {},
) {
  const posts: RankCheckTasksPostInput[] = []
  const reads = new Map<string, number>()
  const tasks = new Map<
    string,
    { keywordId: string; device: string; read: number }
  >()
  let n = 0
  const port: RankDataPort = {
    async post(input) {
      posts.push(input)
      opts.post?.(input, posts.length)
      const posted = input.tasks.map((t) => {
        const key = `${t.keywordId}:${t.device}`
        const read = (reads.get(key) ?? 0) + 1
        reads.set(key, read)
        const taskId = `task-${++n}`
        tasks.set(taskId, { keywordId: t.keywordId, device: t.device, read })
        return { ...t, taskId }
      })
      return { posted, costUsd: posted.length * 0.00105 }
    },
    async collect(input): Promise<CollectOutcome> {
      const task = tasks.get(input.taskId)!
      const a = answer(task.keywordId, task.device, task.read)
      if (a === 'pending') return { status: 'pending' }
      if (a === 'failed') return { status: 'failed', message: 'Task failed' }
      return {
        status: 'completed',
        result: {
          keywordId: input.keywordId,
          keyword: input.keyword,
          position: a,
          url:
            a === null
              ? null
              : (opts.urls?.[input.keywordId] ??
                `https://example.com/${input.keywordId.slice(-2)}`),
          serpFeatures: ['organic', 'people_also_ask'],
        },
      }
    },
    async resolveGoto(urls) {
      return new Map(
        urls.map((u) => [u, 'https://example.com/plumbing?srsltid=abc123']),
      )
    },
  }
  return { port, posts }
}

function setup(
  opts: {
    trigger?: 'manual' | 'scheduled'
    spent?: number
    trackerOverrides?: Partial<TrackerRecord>
    keywords?: typeof KEYWORDS
    snapshots?: MemorySnapshot[]
    previous?: boolean
  } = {},
) {
  const runs = [
    memoryRun({
      id: RUN,
      tracker_id: TRACKER,
      workspace_id: WS,
      trigger: opts.trigger ?? 'manual',
      started_by: opts.trigger === 'scheduled' ? null : PERSON,
    }),
  ]
  if (opts.previous)
    runs.push(
      memoryRun({
        id: PREV_RUN,
        tracker_id: TRACKER,
        workspace_id: WS,
        status: 'completed',
        completed_at: '2026-11-05T10:00:00Z',
      }),
    )
  const mem = createMemoryRankStore({
    tracker: tracker(opts.trackerOverrides),
    keywords: opts.keywords ?? KEYWORDS,
    runs,
    snapshots: opts.snapshots,
    spent: opts.spent,
  })
  const clock = { now: START }
  return { mem, clock }
}

function deps(
  mem: ReturnType<typeof createMemoryRankStore>,
  clock: { now: number },
  port: RankDataPort,
  gate: Partial<RankEngineDeps['gate']> = {},
) {
  const data = vi.fn(() => port)
  const d: RankEngineDeps = {
    store: mem.store,
    data,
    gate: {
      configured: () => true,
      memberRole: async () => 'member',
      onFreePlan: async () => false,
      ...gate,
    },
    now: () => clock.now,
    capDollars: 20,
    resetsOn: () => '2026-12-01',
  }
  return { d, data }
}

describe('the read maths (ported)', () => {
  const pair = (reads: Array<number | null>): ReadPair => ({
    keywordId: K1,
    keyword: 'k',
    device: 'mobile',
    reads,
    answered: true,
  })

  it('reads every pair at least three times, more while a read missed or the reads disagree', () => {
    expect(needsAnotherRead(pair([3, 3]))).toBe(true)
    expect(needsAnotherRead(pair([3, 4, 5]))).toBe(false)
    expect(needsAnotherRead(pair([3, 4, 6]))).toBe(true)
    expect(needsAnotherRead(pair([3, null, 3]))).toBe(true)
    expect(bestPosition(pair([7, null, 4]))).toBe(4)
    expect(bestPosition(pair([null, null]))).toBeNull()
  })

  it('a pair read without a result counts a miss; one not read this time is left alone', () => {
    const pairs: ReadPair[] = [
      {
        keywordId: K1,
        keyword: 'a',
        device: 'mobile',
        reads: [],
        answered: false,
      },
      {
        keywordId: K2,
        keyword: 'b',
        device: 'mobile',
        reads: [5],
        answered: true,
      },
    ]
    mergeRead(pairs, [pairs[0]], [[K2, 'mobile', 1]])
    expect(pairs[0]).toMatchObject({ reads: [null], answered: false })
    expect(pairs[1].reads).toEqual([5])
  })

  it('names the keywords a partial check missed, the device only when the other one got a result', () => {
    const text = describeUnchecked(
      KEYWORDS,
      ['desktop', 'mobile'],
      [{ keyword_id: K1, device: 'desktop' }],
    )
    expect(text).toBe(
      'Not checked: "plumber austin" (mobile), "emergency plumber".',
    )
    expect(
      describeUnchecked(
        KEYWORDS,
        ['mobile'],
        [
          { keyword_id: K1, device: 'mobile' },
          { keyword_id: K2, device: 'mobile' },
        ],
      ),
    ).toBe('')
  })

  it('drops Google’s srsltid tracking from a resolved page', () => {
    expect(withoutGoogleTracking('https://example.com/a?x=1&srsltid=abc')).toBe(
      'https://example.com/a?x=1',
    )
    expect(withoutGoogleTracking('not a url')).toBe('not a url')
  })
})

describe('runRankCheck', () => {
  it('posts each read once, collects on the backoff, keeps the best position and completes', async () => {
    const { mem, clock } = setup()
    const k1Reads = [5, 3, 4]
    const { port, posts } = stubPort(
      (kw, _d, read) => (kw === K1 ? (k1Reads[read - 1] ?? 3) : null),
      {
        urls: { [K1]: 'https://www.google.com/goto?url=abc' },
      },
    )
    const { d, data } = deps(mem, clock, port)
    const { step, sleeps } = fakeStep(clock)

    const out = await runRankCheck(step, d, { runId: RUN, workspaceId: WS })

    expect(out).toMatchObject({ status: 'completed', runId: RUN })
    // k1 agrees within two places after three reads; k2 is never found, so it gets all six.
    expect(posts.map((p) => p.tasks.length)).toEqual([2, 2, 2, 1, 1, 1])
    expect(posts[0]).toMatchObject({
      locationCode: 2840,
      languageCode: 'en',
      depth: 20,
    })
    // The first wait of each read is the source's four minutes.
    expect(
      sleeps.filter(([id]) => id.endsWith('-0')).map(([, d]) => d),
    ).toEqual(Array(6).fill(QUEUED_POLL_INTERVALS[0]))
    const k1 = mem.snapshots.get(snapshotRowId(RUN, K1, 'mobile'))!
    const k2 = mem.snapshots.get(snapshotRowId(RUN, K2, 'mobile'))!
    expect(k1.position).toBe(3)
    expect(k1.url).toBe('https://example.com/plumbing')
    expect(k2.position).toBeNull()
    const run = mem.runs.get(RUN)!
    expect(run).toMatchObject({
      status: 'completed',
      keywords_checked: 2,
      checks_collected: 2,
      error_detail: null,
      keywords_total: 2,
      checks_total: 2,
    })
    expect(run.cost_usd).toBeCloseTo(9 * 0.00105, 8)
    expect(run.estimate_usd).toBeGreaterThan(run.cost_usd)
    expect(mem.trackers.get(TRACKER)!.last_checked_at).not.toBeNull()
    // A manual check is metered in the person's name.
    expect(data).toHaveBeenCalledWith({ workspaceId: WS, userId: PERSON })
  })

  it('a replay of the whole function with its steps memoized posts nothing again', async () => {
    const { mem, clock } = setup()
    const { port, posts } = stubPort(() => 2)
    const { d } = deps(mem, clock, port)
    const first = fakeStep(clock)
    await runRankCheck(first.step, d, { runId: RUN, workspaceId: WS })
    const count = posts.length
    const replay = fakeStep(clock, { memo: first.memo })
    await runRankCheck(replay.step, d, { runId: RUN, workspaceId: WS })
    expect(posts.length).toBe(count)
    expect(replay.executed).toEqual([])
  })

  it('a paid step that ran twice posts once: the second attempt takes back the batch the first recorded', async () => {
    const { mem, clock } = setup()
    const { port, posts } = stubPort(() => 4)
    const { d } = deps(mem, clock, port)
    const { step } = fakeStep(clock, {
      rerun: new Set(['post-1-0', 'collect-1-0']),
    })
    await runRankCheck(step, d, { runId: RUN, workspaceId: WS })
    // Three reads of two pairs agree at 4: one post per read, the first not repeated.
    expect(posts.length).toBe(3)
    // The collect that ran twice wrote nothing new the second time.
    expect(mem.snapshots.get(snapshotRowId(RUN, K1, 'mobile'))!.writes).toBe(1)
    expect(mem.snapshots.size).toBe(2)
    expect(mem.runs.get(RUN)!.status).toBe('completed')
  })

  it('a paid step that crashed before recording its batch is never posted again', async () => {
    const { mem, clock } = setup()
    const { port, posts } = stubPort(() => 4)
    const { d } = deps(mem, clock, port)
    const realRecord = mem.store.recordPost
    let failOnce = true
    mem.store.recordPost = async (...args) => {
      if (failOnce) {
        failOnce = false
        throw new Error('connection reset')
      }
      return realRecord(...args)
    }
    const { step } = fakeStep(clock, { rerun: new Set(['post-1-0']) })
    await runRankCheck(step, d, { runId: RUN, workspaceId: WS })
    // Read 1 was posted once and its tasks lost with the crash (that read counts a
    // miss); reads 2-6 make up for it. Never a second post of read 1.
    expect(posts.length).toBe(6)
    expect(mem.posts.get(`${RUN}|read-1-batch-0`)!.tasks).toBeNull()
    expect(mem.runs.get(RUN)!.status).toBe('completed')
    expect(mem.snapshots.get(snapshotRowId(RUN, K1, 'mobile'))!.position).toBe(
      4,
    )
  })

  it('a search that never comes back is given up after the last wait: the pair reads as not checked, nothing spins', async () => {
    const { mem, clock } = setup()
    const { port } = stubPort((kw) => (kw === K2 ? 'pending' : 2))
    const { d } = deps(mem, clock, port)
    const { step, sleeps } = fakeStep(clock)
    const out = await runRankCheck(step, d, { runId: RUN, workspaceId: WS })
    expect(out).toMatchObject({ status: 'completed' })
    // Read 1 waits out the full cadence (an hour), and the read window closes behind it.
    expect(sleeps.length).toBe(QUEUED_POLL_INTERVALS.length)
    const run = mem.runs.get(RUN)!
    expect(run.error_code).toBe('PARTIAL')
    expect(run.error_detail).toContain('Not checked: "emergency plumber".')
    expect(run.keywords_checked).toBe(1)
  })

  it('a late search is collected on a later round of the same read', async () => {
    const { mem, clock } = setup({ keywords: [KEYWORDS[0]] })
    let polls = 0
    const { port } = stubPort(() => 6)
    const collect = port.collect
    port.collect = async (input) =>
      ++polls <= 3 ? { status: 'pending' } : collect(input)
    const { d } = deps(mem, clock, port)
    const { step, sleeps } = fakeStep(clock)
    await runRankCheck(step, d, { runId: RUN, workspaceId: WS })
    expect(sleeps.slice(0, 4).map(([id]) => id)).toEqual([
      'wait-1-0',
      'wait-1-1',
      'wait-1-2',
      'wait-1-3',
    ])
    expect(mem.snapshots.get(snapshotRowId(RUN, K1, 'mobile'))!.position).toBe(
      6,
    )
  })

  it('nothing collected at all fails the check in words', async () => {
    const { mem, clock } = setup()
    const { port } = stubPort(() => 'failed')
    const { d } = deps(mem, clock, port)
    const { step } = fakeStep(clock)
    const out = await runRankCheck(step, d, { runId: RUN, workspaceId: WS })
    expect(out).toMatchObject({ status: 'failed' })
    expect(mem.runs.get(RUN)).toMatchObject({
      status: 'failed',
      error_code: 'NOTHING_COLLECTED',
    })
    expect(mem.trackers.get(TRACKER)!.last_checked_at).toBeNull()
  })

  it('the monthly ceiling refusing a post stops every later post and fails the check with the ceiling’s words', async () => {
    const { mem, clock } = setup()
    const { port, posts } = stubPort(() => 2, {
      post: () => {
        throw new SeoError(
          'SPEND_LIMIT_REACHED',
          'This workspace has reached its search data limit for the month ($20). It starts over on 2026-12-01.',
        )
      },
    })
    const { d } = deps(mem, clock, port)
    const { step } = fakeStep(clock)
    await runRankCheck(step, d, { runId: RUN, workspaceId: WS })
    expect(posts.length).toBe(1)
    expect(mem.runs.get(RUN)).toMatchObject({
      status: 'failed',
      error_code: 'SPEND_LIMIT_REACHED',
      error_detail:
        'This workspace has reached its search data limit for the month ($20). It starts over on 2026-12-01.',
    })
  })

  it('a check that can’t fit what is left of the month is never posted', async () => {
    const { mem, clock } = setup({ spent: 19.999 })
    const { port, posts } = stubPort(() => 2)
    const { d } = deps(mem, clock, port)
    const { step } = fakeStep(clock)
    const out = await runRankCheck(step, d, { runId: RUN, workspaceId: WS })
    expect(out).toMatchObject({ status: 'failed', code: 'SPEND_LIMIT_REACHED' })
    expect(posts.length).toBe(0)
    expect(mem.runs.get(RUN)!.error_detail).toMatch(/starts over on 2026-12-01/)
  })

  it('a failed batch doesn’t throw (a retry would pay again) and the other batches still post', async () => {
    const many = Array.from({ length: 150 }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      keyword: `keyword ${i}`,
    }))
    const { mem, clock } = setup({ keywords: many })
    const { port, posts } = stubPort(() => 1, {
      post: (_input, call) => {
        if (call === 1)
          throw new SeoError('UPSTREAM_UNAVAILABLE', 'provider 500')
      },
    })
    const { d } = deps(mem, clock, port)
    const { step, executed } = fakeStep(clock)
    await runRankCheck(step, d, { runId: RUN, workspaceId: WS })
    expect(executed).toContain('post-1-0')
    expect(executed).toContain('post-1-1')
    expect(posts[0].tasks.length).toBe(100)
    expect(posts[1].tasks.length).toBe(50)
    // Later reads pick up the batch that failed.
    expect(mem.runs.get(RUN)).toMatchObject({
      status: 'completed',
      keywords_checked: 150,
    })
  })

  it('a canceled check posts nothing more and its decision stands', async () => {
    const { mem, clock } = setup()
    const { port, posts } = stubPort(() => 2)
    const { d } = deps(mem, clock, port)
    const { step } = fakeStep(clock, {
      after: (id) => {
        if (id === 'collect-1-0') mem.runs.get(RUN)!.status = 'canceled'
      },
    })
    const out = await runRankCheck(step, d, { runId: RUN, workspaceId: WS })
    expect(posts.length).toBe(1)
    expect(out).toMatchObject({ status: 'canceled' })
    expect(mem.runs.get(RUN)!.status).toBe('canceled')
  })

  it('a check already claimed by nobody (canceled before it started) does nothing', async () => {
    const { mem, clock } = setup()
    mem.runs.get(RUN)!.status = 'canceled'
    const { port, posts } = stubPort(() => 2)
    const { d } = deps(mem, clock, port)
    const { step } = fakeStep(clock)
    expect(
      await runRankCheck(step, d, { runId: RUN, workspaceId: WS }),
    ).toMatchObject({ skipped: 'not_claimable' })
    expect(posts.length).toBe(0)
  })

  it('a scheduled check asks the gate again and spends in nobody’s name', async () => {
    const { mem, clock } = setup({ trigger: 'scheduled' })
    const { port } = stubPort(() => 2)
    const { d, data } = deps(mem, clock, port)
    await runRankCheck(fakeStep(clock).step, d, { runId: RUN, workspaceId: WS })
    expect(data).toHaveBeenCalledWith({ workspaceId: WS, userId: null })
    expect(mem.runs.get(RUN)!.status).toBe('completed')
  })

  it('a scheduled check whose person moved to the free plan is failed before it spends', async () => {
    const { mem, clock } = setup({ trigger: 'scheduled' })
    const { port, posts } = stubPort(() => 2)
    const { d } = deps(mem, clock, port, { onFreePlan: async () => true })
    await runRankCheck(fakeStep(clock).step, d, { runId: RUN, workspaceId: WS })
    expect(posts.length).toBe(0)
    expect(mem.runs.get(RUN)).toMatchObject({
      status: 'failed',
      error_code: 'SKIPPED',
    })
    expect(mem.runs.get(RUN)!.error_detail).toMatch(/free plan/)
  })

  it('a scheduled check whose person moves to the free plan mid-check stops buying, ends in the gate’s words and keeps what it read', async () => {
    const { mem, clock } = setup({ trigger: 'scheduled' })
    // Every read misses k2, so without the gate the check would post six times.
    const { port, posts } = stubPort((kw) => (kw === K1 ? 3 : null))
    let free = false
    const { d } = deps(mem, clock, port, { onFreePlan: async () => free })
    const { step, executed } = fakeStep(clock, {
      after: (id) => {
        if (id === 'collect-1-0') free = true
      },
    })
    const out = await runRankCheck(step, d, { runId: RUN, workspaceId: WS })
    // The first read was bought and collected; nothing after it.
    expect(posts.length).toBe(1)
    expect(executed).toContain('post-2-0')
    expect(mem.posts.size).toBe(1)
    expect(out).toMatchObject({ status: 'completed' })
    expect(mem.runs.get(RUN)).toMatchObject({
      status: 'completed',
      keywords_checked: 2,
      error_code: 'SKIPPED',
    })
    expect(mem.runs.get(RUN)!.error_detail).toMatch(/free plan/)
    expect(mem.snapshots.get(snapshotRowId(RUN, K1, 'mobile'))!.position).toBe(
      3,
    )
  })

  it('a scheduled check paused before anything came back posts nothing more and fails in the gate’s words', async () => {
    const { mem, clock } = setup({
      trigger: 'scheduled',
      keywords: Array.from({ length: 150 }, (_, i) => ({
        id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        keyword: `keyword ${i}`,
      })),
    })
    const { port, posts } = stubPort(() => 2)
    const { d } = deps(mem, clock, port)
    const { step } = fakeStep(clock, {
      after: (id) => {
        // Paused between the first and the second paid batch of the first read.
        if (id === 'post-1-0') mem.trackers.get(TRACKER)!.paused = true
      },
    })
    await runRankCheck(step, d, { runId: RUN, workspaceId: WS })
    expect(posts.length).toBe(1)
    expect(mem.runs.get(RUN)).toMatchObject({ error_code: 'SKIPPED' })
    expect(mem.runs.get(RUN)!.error_detail ?? '').toMatch(/paused/)
  })

  it('a standing that can’t be read mid-check throws before the marker: the step is retried, nothing is bought blind', async () => {
    const { mem, clock } = setup({ trigger: 'scheduled' })
    const { port, posts } = stubPort((kw) => (kw === K1 ? 3 : null))
    let calls = 0
    const { d } = deps(mem, clock, port, {
      onFreePlan: async () => {
        calls++
        // prepare and the first post read it; the second post can't.
        if (calls === 3) throw new Error('plan service down')
        return false
      },
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { step } = fakeStep(clock)
    await expect(
      runRankCheck(step, d, { runId: RUN, workspaceId: WS }),
    ).rejects.toThrow(/Could not check the plan/)
    expect(posts.length).toBe(1)
    // No marker was claimed for the batch it couldn't clear, so a retry can still post it once.
    expect([...mem.posts.keys()]).toEqual([`${RUN}|${postKey(1, 0)}`])
  })

  it('a manual check never asks the schedule’s gate mid-check', async () => {
    const { mem, clock } = setup()
    const { port, posts } = stubPort((kw) => (kw === K1 ? 3 : null))
    const onFreePlan = vi.fn(async () => true)
    const { d } = deps(mem, clock, port, { onFreePlan })
    await runRankCheck(fakeStep(clock).step, d, { runId: RUN, workspaceId: WS })
    expect(onFreePlan).not.toHaveBeenCalled()
    expect(posts.length).toBe(6)
  })

  it('no new read starts once the hour is up', async () => {
    const { mem, clock } = setup({ keywords: [KEYWORDS[0]] })
    const { port, posts } = stubPort(() => 2)
    const { d } = deps(mem, clock, port)
    const { step } = fakeStep(clock, {
      after: (id) => {
        if (id === 'collect-1-0') clock.now += 61 * 60_000
      },
    })
    await runRankCheck(step, d, { runId: RUN, workspaceId: WS })
    expect(posts.length).toBe(1)
    expect(mem.runs.get(RUN)!.status).toBe('completed')
  })

  it('a miss of a keyword the previous check found reads as not checked', async () => {
    const prev: MemorySnapshot = {
      id: snapshotRowId(PREV_RUN, K1, 'mobile'),
      run_id: PREV_RUN,
      keyword_id: K1,
      keyword: 'plumber austin',
      device: 'mobile',
      position: 4,
      url: 'https://example.com/a',
      serp_features: [],
      writes: 1,
    }
    const { mem, clock } = setup({ previous: true, snapshots: [prev] })
    const { port } = stubPort((kw) => (kw === K1 ? null : 7))
    const { d } = deps(mem, clock, port)
    await runRankCheck(fakeStep(clock).step, d, { runId: RUN, workspaceId: WS })
    expect(mem.snapshots.has(snapshotRowId(RUN, K1, 'mobile'))).toBe(false)
    expect(mem.runs.get(RUN)).toMatchObject({
      status: 'completed',
      error_code: 'PARTIAL',
    })
    expect(mem.runs.get(RUN)!.error_detail).toContain('"plumber austin"')
  })

  it('both devices: one post carries both, and the snapshot ids differ per device', async () => {
    const { mem, clock } = setup({
      trackerOverrides: { devices: 'both' },
      keywords: [KEYWORDS[0]],
    })
    const { port, posts } = stubPort((_kw, device) =>
      device === 'desktop' ? 2 : 5,
    )
    const { d } = deps(mem, clock, port)
    await runRankCheck(fakeStep(clock).step, d, { runId: RUN, workspaceId: WS })
    expect(posts[0].tasks.map((t) => t.device)).toEqual(['desktop', 'mobile'])
    expect(mem.snapshots.get(snapshotRowId(RUN, K1, 'desktop'))!.position).toBe(
      2,
    )
    expect(mem.snapshots.get(snapshotRowId(RUN, K1, 'mobile'))!.position).toBe(
      5,
    )
  })
})
