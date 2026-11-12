/**
 * The AI visibility check, driven end to end through the lane's body
 * (runAiVisibilityCheck) with a recording step (memoized like Inngest's), an
 * in-memory store over migration 596's rules, and a stubbed data client.
 *
 *   - Each paid call is made once: a batch is posted once, a live answer
 *     asked once, and a replayed or retried step pays nothing again.
 *   - Queued answers are read on the backoff, saved and matched as they come.
 *   - What never arrives is marked not arrived, read again late, and filled
 *     in (marked late) when it comes.
 *   - The monthly ceiling ends the check failed with its own words; the
 *     schedule gate refuses before anything is bought; a cancel stops it.
 *   - Near the ceiling, live answers are asked one by one (an overshoot of
 *     one answer at most), not all at once.
 *   - A scheduled check asks its gate again before every paid step: paused
 *     partway (or its owner gone or on the free plan), it buys nothing more,
 *     keeps what was answered, and ends in the gate's words.
 *   - A manual check is held to the estimate it started with: answers that
 *     would cost more end it ESTIMATE_CHANGED before anything is bought.
 *   - An answer that was sent and charged but could not be recorded ends
 *     NOT_TRACKED with its cost, never "not sent", even when the database
 *     refused every write of its step; a check with no answers says what it
 *     was charged.
 */
import { runAiVisibilityCheck } from '@/lib/inngest/seo-ai-visibility-functions'
import { DataforseoChargedTaskError, SeoError } from '@/lib/seo/errors'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  askModelBatch,
  collectRound,
  finalizeRun,
  planBatches,
  postQueueBatch,
  type EngineDeps,
} from '../engine'
import { createMemoryStore } from './memory-store'

const RUN = '00000000-0000-4000-8000-000000000101'
const WS = '00000000-0000-4000-8000-000000000001'
const TRACKER = '00000000-0000-4000-8000-000000000002'
const PERSON = '00000000-0000-4000-8000-0000000000aa'

const brands = [
  {
    name: 'Fernhill Studio',
    domain: 'fernhillstudio.example',
    own: true,
    aliases: ['Fernhill'],
  },
  { name: 'Oakline', domain: 'oakline.example', own: false, aliases: [] },
]

function seed(
  opts: {
    trigger?: 'manual' | 'scheduled'
    engines?: Array<'chatgpt' | 'claude' | 'google_ai_overview'>
    estimate_usd?: number
  } = {},
) {
  const engines = opts.engines ?? ['chatgpt', 'claude']
  const prompts = [
    { id: 'p1', text: 'best design studio for small brands' },
    { id: 'p2', text: 'who makes good brand identities' },
  ]
  return createMemoryStore({
    run: {
      id: RUN,
      workspace_id: WS,
      tracker_id: TRACKER,
      trigger: opts.trigger ?? 'manual',
      status: 'queued',
      started_by: opts.trigger === 'scheduled' ? null : PERSON,
      engines,
      location_code: 2840,
      language_code: 'en',
      brands,
      estimate_usd: opts.estimate_usd,
    },
    answers: prompts.flatMap((p) =>
      engines.map((engine) => ({
        id: `${p.id}-${engine}`,
        prompt_id: p.id,
        prompt_text: p.text,
        engine,
      })),
    ),
  })
}

const chatgptResult = (text: string) => ({
  datetime: '2026-11-10 09:00:00 +00:00',
  markdown: text,
  sources: [
    {
      url: 'https://oakline.example/work?utm_source=chatgpt.com',
      title: 'Oakline work',
    },
  ],
})

function recordingStep() {
  const memo = new Map<string, unknown>()
  const ran: string[] = []
  const sleeps: Array<[string, string]> = []
  return {
    memo,
    ran,
    sleeps,
    step: {
      run: async <T>(id: string, fn: () => Promise<T>): Promise<T> => {
        if (memo.has(id)) return memo.get(id) as T
        ran.push(id)
        const value = await fn()
        memo.set(id, JSON.parse(JSON.stringify(value ?? null)))
        return memo.get(id) as T
      },
      sleep: async (id: string, duration: string) => {
        sleeps.push([id, duration])
      },
    },
  }
}

function makeDeps(script: { results?: Record<string, Array<unknown>> } = {}) {
  const trackingTaskPost = vi.fn(
    async (input: { tasks: Array<{ tag: string }> }) =>
      input.tasks.map((t) => ({
        tag: t.tag,
        taskId: `task-${t.tag}`,
        costUsd: 0.0012,
      })),
  )
  const llmResponse = vi.fn(async () => ({
    model_name: 'claude-test',
    items: [
      {
        type: 'message',
        sections: [
          {
            text: 'Fernhill Studio is a fine pick, and Oakline too.',
            annotations: [
              { url: 'https://fernhillstudio.example/about', title: 'About' },
            ],
          },
        ],
      },
    ],
  }))
  const queues = new Map(Object.entries(script.results ?? {}))
  const fetchTaskResult = vi.fn(async ({ taskId }: { taskId: string }) => {
    const queue = queues.get(taskId)
    const next = queue && queue.length > 1 ? queue.shift() : queue?.[0]
    return (next ?? { status: 'pending' }) as never
  })
  const deps: EngineDeps = {
    client: () => ({ aiSearch: { trackingTaskPost, llmResponse } }) as never,
    fetchTaskResult,
    resolveModelName: async () => 'claude-test',
    checkAccess: vi.fn(async () => ({ ok: true as const })),
    scheduledGate: vi.fn(async () => ({ ok: true as const })),
    remainingBudgetUsd: vi.fn(async () => 20),
    now: () => new Date('2026-11-12T10:00:00Z'),
  }
  return { deps, trackingTaskPost, llmResponse, fetchTaskResult }
}

const completed = (result: unknown) => ({ status: 'completed', result })

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('planBatches', () => {
  it('posts queued engines 100 at a time and asks model engines 6 at a time, per engine', () => {
    const answers = [
      ...Array.from({ length: 250 }, (_, i) => ({
        id: `c${i}`,
        engine: 'chatgpt' as const,
      })),
      ...Array.from({ length: 7 }, (_, i) => ({
        id: `k${i}`,
        engine: 'claude' as const,
      })),
    ]
    const plan = planBatches(answers)
    expect(plan.queue.map((b) => b.ids.length)).toEqual([100, 100, 50])
    expect(plan.model.map((b) => b.ids.length)).toEqual([6, 1])
    expect(plan.model.every((b) => b.engine === 'claude')).toBe(true)
  })
})

describe('a check, start to finish', () => {
  it('posts once, asks live once, reads on the backoff, matches the brands, completes', async () => {
    const mem = seed()
    const { deps, trackingTaskPost, llmResponse } = makeDeps({
      results: {
        'task-p1-chatgpt': [
          { status: 'pending' },
          completed(
            chatgptResult(
              'Try **Oakline** for this. [oakline.example](https://oakline.example/work)',
            ),
          ),
        ],
        'task-p2-chatgpt': [
          completed(
            chatgptResult('Fernhill makes good identities; Oakline as well.'),
          ),
        ],
      },
    })
    const rec = recordingStep()
    const out = await runAiVisibilityCheck(RUN, rec.step, mem.store, deps)

    expect(out.status).toBe('completed')
    expect(trackingTaskPost).toHaveBeenCalledTimes(1)
    expect(trackingTaskPost.mock.calls[0][0]).toMatchObject({
      engine: 'chatgpt',
      locationCode: 2840,
      languageCode: 'en',
    })
    expect(llmResponse).toHaveBeenCalledTimes(2)
    expect(llmResponse.mock.calls[0]).toEqual([
      expect.objectContaining({
        modelSlug: 'claude',
        modelName: 'claude-test',
        webSearch: true,
        webSearchCountryCode: 'US',
      }),
    ])
    expect(rec.sleeps).toEqual([
      ['wait-0', '2m'],
      ['wait-1', '2m'],
    ])

    const p1 = mem.answers.get('p1-chatgpt')!
    expect(p1.status).toBe('collected')
    expect(p1.collected).toMatchObject({
      has_answer: true,
      brand_mentioned: false,
      brand_cited: false,
    })
    expect(
      p1.collected?.matches.find((m) => m.domain === 'oakline.example'),
    ).toMatchObject({ mentioned: true, cited: true, position: 1 })
    expect(p1.collected?.sources).toEqual([
      expect.objectContaining({
        url: 'https://oakline.example/work',
        domain: 'oakline.example',
        position: 1,
      }),
    ])

    // An other name ("Fernhill") counts as the brand.
    expect(mem.answers.get('p2-chatgpt')?.collected).toMatchObject({
      brand_mentioned: true,
      brand_position: 1,
    })
    const live = mem.answers.get('p1-claude')!
    expect(live.collected).toMatchObject({
      brand_mentioned: true,
      brand_cited: true,
      brand_position: 1,
      model_name: 'claude-test',
    })
    expect(live.cost_usd).toBeGreaterThan(0.1)

    expect(mem.run.status).toBe('completed')
    expect(mem.run.counts).toMatchObject({
      answers_total: 4,
      answers_collected: 4,
      answers_failed: 0,
      answers_open: 0,
    })
    expect(mem.tracker_touches).toEqual([TRACKER])
  })

  it('a replay of the whole function (Inngest re-running it from the top) pays nothing again', async () => {
    const mem = seed()
    const { deps, trackingTaskPost, llmResponse } = makeDeps({
      results: {
        'task-p1-chatgpt': [completed(chatgptResult('Oakline.'))],
        'task-p2-chatgpt': [completed(chatgptResult('Oakline.'))],
      },
    })
    const rec = recordingStep()
    await runAiVisibilityCheck(RUN, rec.step, mem.store, deps)
    const ranBefore = rec.ran.length
    await runAiVisibilityCheck(RUN, rec.step, mem.store, deps)
    expect(rec.ran.length).toBe(ranBefore)
    expect(trackingTaskPost).toHaveBeenCalledTimes(1)
    expect(llmResponse).toHaveBeenCalledTimes(2)
  })

  it('a post step that runs twice finds its answers claimed and posts nothing', async () => {
    const mem = seed({ engines: ['chatgpt'] })
    const { deps, trackingTaskPost } = makeDeps()
    await mem.store.claimRun(RUN)
    const batch = {
      engine: 'chatgpt' as const,
      ids: ['p1-chatgpt', 'p2-chatgpt'],
    }
    expect(await postQueueBatch(mem.store, RUN, batch, deps)).toMatchObject({
      sent: 2,
    })
    expect(await postQueueBatch(mem.store, RUN, batch, deps)).toMatchObject({
      sent: 0,
    })
    expect(trackingTaskPost).toHaveBeenCalledTimes(1)
    expect(mem.answers.get('p1-chatgpt')).toMatchObject({
      status: 'posted',
      task_id: 'task-p1-chatgpt',
      cost_usd: 0.0012,
    })
  })

  it('a step that failed after claiming but before posting is never posted on its retry: the answers end not sent', async () => {
    const mem = seed({ engines: ['chatgpt'] })
    const { deps, trackingTaskPost } = makeDeps()
    await mem.store.claimRun(RUN)
    const listAnswers = mem.store.listAnswers
    mem.store.listAnswers = vi
      .fn()
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockImplementation(listAnswers)
    const batch = {
      engine: 'chatgpt' as const,
      ids: ['p1-chatgpt', 'p2-chatgpt'],
    }
    await expect(postQueueBatch(mem.store, RUN, batch, deps)).rejects.toThrow(
      'connection reset',
    )
    expect(await postQueueBatch(mem.store, RUN, batch, deps)).toMatchObject({
      sent: 0,
    })
    expect(trackingTaskPost).not.toHaveBeenCalled()
    await finalizeRun(mem.store, RUN, { spendLimit: null })
    expect(mem.answers.get('p1-chatgpt')).toMatchObject({
      status: 'failed',
      error_code: 'NOT_SENT',
    })
    expect(mem.run).toMatchObject({
      status: 'failed',
      error_code: 'NO_ANSWERS',
      error_detail: expect.stringContaining('nothing was charged'),
    })
  })

  it('answers the provider refused at the post fail as not accepted', async () => {
    const mem = seed({ engines: ['chatgpt'] })
    const { deps, trackingTaskPost } = makeDeps()
    trackingTaskPost.mockImplementationOnce(async (input) => [
      { tag: input.tasks[0].tag, taskId: 'task-only', costUsd: 0.0012 },
    ])
    await mem.store.claimRun(RUN)
    const out = await postQueueBatch(
      mem.store,
      RUN,
      { engine: 'chatgpt', ids: ['p1-chatgpt', 'p2-chatgpt'] },
      deps,
    )
    expect(out).toMatchObject({ sent: 1, failed: 1 })
    expect(mem.answers.get('p2-chatgpt')).toMatchObject({
      status: 'failed',
      error_code: 'NOT_ACCEPTED',
    })
  })

  it('a task the provider failed fails that answer; an AI Overview Google didn’t show is collected as no answer', async () => {
    const mem = seed({ engines: ['google_ai_overview'] })
    const { deps } = makeDeps({
      results: {
        'task-p1-google_ai_overview': [
          {
            status: 'failed',
            message: 'Internal Error.',
            code: 'UPSTREAM_UNAVAILABLE',
            retryable: true,
          },
        ],
        'task-p2-google_ai_overview': [
          completed({
            items: [{ type: 'organic', url: 'https://oakline.example/' }],
          }),
        ],
      },
    })
    const out = await runAiVisibilityCheck(
      RUN,
      recordingStep().step,
      mem.store,
      deps,
    )
    expect(out.status).toBe('completed')
    expect(mem.answers.get('p1-google_ai_overview')).toMatchObject({
      status: 'failed',
      error_code: 'UPSTREAM_UNAVAILABLE',
    })
    expect(mem.answers.get('p2-google_ai_overview')?.collected).toMatchObject({
      has_answer: false,
      answer_markdown: null,
    })
    expect(mem.run.counts).toMatchObject({
      answers_collected: 0,
      answers_no_answer: 1,
      answers_failed: 1,
    })
  })
})

describe('answers that are late or never come', () => {
  it('marks them not arrived after the last read, then fills one in late', async () => {
    const mem = seed({ engines: ['chatgpt'] })
    const pendingFor = (n: number) =>
      Array.from({ length: n }, () => ({ status: 'pending' }))
    const { deps, fetchTaskResult } = makeDeps({
      results: {
        'task-p1-chatgpt': [completed(chatgptResult('Oakline.'))],
        // 9 backoff reads and the first late read find it pending; the second late read finds it.
        'task-p2-chatgpt': [
          ...pendingFor(10),
          completed(chatgptResult('Fernhill Studio.')),
        ],
      },
    })
    const rec = recordingStep()
    const out = await runAiVisibilityCheck(RUN, rec.step, mem.store, deps)
    expect(
      rec.sleeps.filter(([id]) => id.startsWith('wait-')).map(([, d]) => d),
    ).toEqual(['2m', '2m', '3m', '3m', '4m', '4m', '4m', '4m', '4m'])
    expect(rec.sleeps.filter(([id]) => id.startsWith('late-wait-'))).toEqual([
      ['late-wait-1', '30m'],
      ['late-wait-2', '30m'],
    ])
    expect(out.status).toBe('completed')
    expect(mem.answers.get('p2-chatgpt')).toMatchObject({
      status: 'collected',
      late: true,
    })
    expect(mem.run.counts).toMatchObject({
      answers_collected: 2,
      answers_late: 1,
      answers_failed: 0,
    })
    // Every read was free and none ran after the answer came.
    expect(
      fetchTaskResult.mock.calls.filter(
        ([i]) => i.taskId === 'task-p2-chatgpt',
      ),
    ).toHaveLength(11)
  })

  it('a check whose answers all fail to arrive ends failed, and no late reads run', async () => {
    const mem = seed({ engines: ['chatgpt'] })
    const { deps } = makeDeps()
    const rec = recordingStep()
    const out = await runAiVisibilityCheck(RUN, rec.step, mem.store, deps)
    expect(out.status).toBe('failed')
    expect(mem.run).toMatchObject({
      status: 'failed',
      error_code: 'NO_ANSWERS',
    })
    expect(
      [...mem.answers.values()].every((a) => a.error_code === 'NOT_ARRIVED'),
    ).toBe(true)
    expect(rec.sleeps.some(([id]) => id.startsWith('late-'))).toBe(false)
  })
})

describe('who pays, and stopping', () => {
  it('a monthly ceiling refusal fails the check with the ceiling’s own words and asks nothing more', async () => {
    const mem = seed()
    const { deps, trackingTaskPost, llmResponse } = makeDeps()
    const words =
      'This workspace has reached its $25 search data limit for November. It resets on December 1.'
    trackingTaskPost.mockRejectedValueOnce(
      new SeoError('SPEND_LIMIT_REACHED', words),
    )
    const out = await runAiVisibilityCheck(
      RUN,
      recordingStep().step,
      mem.store,
      deps,
    )
    expect(out.status).toBe('failed')
    expect(llmResponse).not.toHaveBeenCalled()
    expect(mem.run).toMatchObject({
      status: 'failed',
      error_code: 'SPEND_LIMIT_REACHED',
      error_detail: words,
    })
    expect(mem.answers.get('p1-chatgpt')).toMatchObject({
      status: 'failed',
      error_code: 'SPEND_LIMIT_REACHED',
    })
    expect(mem.answers.get('p1-claude')).toMatchObject({
      status: 'failed',
      error_code: 'NOT_SENT',
    })
  })

  it('a scheduled check the gate refuses fails before anything is bought', async () => {
    const mem = seed({ trigger: 'scheduled' })
    const { deps, trackingTaskPost, llmResponse } = makeDeps()
    deps.scheduledGate = vi.fn(async () => ({
      ok: false as const,
      reason: 'free_plan',
      message: 'The person who set up this schedule is on the free plan.',
    }))
    const out = await runAiVisibilityCheck(
      RUN,
      recordingStep().step,
      mem.store,
      deps,
    )
    expect(out.status).toBe('refused')
    expect(trackingTaskPost).not.toHaveBeenCalled()
    expect(llmResponse).not.toHaveBeenCalled()
    expect(mem.run).toMatchObject({ status: 'failed', error_code: 'FREE_PLAN' })
    expect(
      [...mem.answers.values()].every((a) => a.error_code === 'NOT_SENT'),
    ).toBe(true)
  })

  it('a manual check refused by the access check buys nothing', async () => {
    const mem = seed()
    const { deps, trackingTaskPost } = makeDeps()
    deps.checkAccess = vi.fn(async () => ({
      ok: false as const,
      code: 'FREE_PLAN',
      message: 'Keyword, ranking and backlink data is part of the paid plan.',
    }))
    await runAiVisibilityCheck(RUN, recordingStep().step, mem.store, deps)
    expect(deps.checkAccess).toHaveBeenCalledWith({
      userId: PERSON,
      workspaceId: WS,
    })
    expect(trackingTaskPost).not.toHaveBeenCalled()
    expect(mem.run.status).toBe('failed')
  })

  it('a canceled check posts nothing more, reads nothing, and stays canceled', async () => {
    const mem = seed({ engines: ['chatgpt'] })
    const { deps, trackingTaskPost, fetchTaskResult } = makeDeps()
    await mem.store.claimRun(RUN)
    // cancelRun: the status first, then every open answer.
    mem.run.status = 'canceled'
    await mem.store.failAnswers(RUN, null, 'CANCELED', [
      'pending',
      'asking',
      'posted',
    ])
    expect(
      await postQueueBatch(
        mem.store,
        RUN,
        { engine: 'chatgpt', ids: ['p1-chatgpt'] },
        deps,
      ),
    ).toMatchObject({ sent: 0 })
    expect(await collectRound(mem.store, RUN, deps)).toEqual({
      pending: 0,
      collected: 0,
      failed: 0,
    })
    const fin = await finalizeRun(mem.store, RUN, { spendLimit: null })
    expect(fin.status).toBe('canceled')
    expect(trackingTaskPost).not.toHaveBeenCalled()
    expect(fetchTaskResult).not.toHaveBeenCalled()
    expect(mem.answers.get('p1-chatgpt')).toMatchObject({
      status: 'failed',
      error_code: 'CANCELED',
    })
  })
})

describe('live answers near the ceiling', () => {
  const sixClaude = () =>
    createMemoryStore({
      run: {
        id: RUN,
        workspace_id: WS,
        tracker_id: TRACKER,
        trigger: 'manual',
        status: 'running',
        started_by: PERSON,
        engines: ['claude'],
        location_code: 2840,
        language_code: 'en',
        brands,
      },
      answers: Array.from({ length: 6 }, (_, i) => ({
        id: `k${i}`,
        prompt_text: `question ${i}`,
        engine: 'claude' as const,
      })),
    })
  const batch = {
    engine: 'claude' as const,
    ids: ['k0', 'k1', 'k2', 'k3', 'k4', 'k5'],
  }

  /** llmResponse that records how many calls were in flight at once. */
  function trackConcurrency(llmResponse: ReturnType<typeof makeDeps>['llmResponse']) {
    const seen = { inFlight: 0, most: 0 }
    const answer = llmResponse.getMockImplementation()!
    llmResponse.mockImplementation(async () => {
      seen.inFlight++
      seen.most = Math.max(seen.most, seen.inFlight)
      await new Promise((r) => setTimeout(r, 5))
      seen.inFlight--
      return answer()
    })
    return seen
  }

  it('with plenty left in the month, asks the batch at once', async () => {
    const mem = sixClaude()
    const { deps, llmResponse } = makeDeps()
    const seen = trackConcurrency(llmResponse)
    const out = await askModelBatch(mem.store, RUN, batch, deps)
    expect(out).toMatchObject({ sent: 6, collected: 6, failed: 0 })
    expect(seen.most).toBe(6)
  })

  it('with less than twice the batch left, asks one at a time', async () => {
    const mem = sixClaude()
    const { deps, llmResponse } = makeDeps()
    // 6 answers at about $0.18 is about $1.08: $2 left is under twice that.
    deps.remainingBudgetUsd = vi.fn(async () => 2)
    const seen = trackConcurrency(llmResponse)
    const out = await askModelBatch(mem.store, RUN, batch, deps)
    expect(out).toMatchObject({ sent: 6, collected: 6, failed: 0 })
    expect(seen.most).toBe(1)
    expect(llmResponse).toHaveBeenCalledTimes(6)
  })

  it('a month total that can’t be read asks one at a time too', async () => {
    const mem = sixClaude()
    const { deps, llmResponse } = makeDeps()
    deps.remainingBudgetUsd = vi.fn(async () => {
      throw new Error('ledger down')
    })
    const seen = trackConcurrency(llmResponse)
    await askModelBatch(mem.store, RUN, batch, deps)
    expect(seen.most).toBe(1)
  })

  it('one by one, the ceiling’s refusal stops the rest from being asked', async () => {
    const mem = sixClaude()
    const { deps, llmResponse } = makeDeps()
    deps.remainingBudgetUsd = vi.fn(async () => 0.3)
    const words = 'This workspace has reached its search data limit for the month ($20).'
    const answer = llmResponse.getMockImplementation()!
    llmResponse
      .mockImplementationOnce(answer)
      .mockRejectedValueOnce(new SeoError('SPEND_LIMIT_REACHED', words))
    const out = await askModelBatch(mem.store, RUN, batch, deps)
    expect(llmResponse).toHaveBeenCalledTimes(2)
    expect(out).toMatchObject({ collected: 1, failed: 5, spend_limit: words })
    for (const id of ['k1', 'k2', 'k3', 'k4', 'k5'])
      expect(mem.answers.get(id)).toMatchObject({
        status: 'failed',
        error_code: 'SPEND_LIMIT_REACHED',
      })
  })
})

describe('sent and charged, but not recorded', () => {
  it('a post whose record write keeps failing ends NOT_TRACKED with its cost, and the check says what was charged', async () => {
    const mem = seed({ engines: ['chatgpt'] })
    const { deps, trackingTaskPost } = makeDeps()
    mem.store.markPosted = vi.fn(async () => {
      throw new Error('connection reset')
    })
    const out = await runAiVisibilityCheck(
      RUN,
      recordingStep().step,
      mem.store,
      deps,
    )
    expect(trackingTaskPost).toHaveBeenCalledTimes(1)
    expect(mem.store.markPosted).toHaveBeenCalledTimes(3)
    expect(out.status).toBe('failed')
    for (const id of ['p1-chatgpt', 'p2-chatgpt'])
      expect(mem.answers.get(id)).toMatchObject({
        status: 'failed',
        error_code: 'NOT_TRACKED',
        cost_usd: 0.0012,
      })
    expect(mem.run).toMatchObject({
      status: 'failed',
      error_code: 'NO_ANSWERS',
      error_detail: expect.stringContaining('charged about $0.0024'),
    })
    expect(mem.run.error_detail).not.toContain('nothing was charged')
  })

  it('when the step can write nothing at all, finalize still ends them NOT_TRACKED, never not sent', async () => {
    const mem = seed({ engines: ['chatgpt'] })
    const { deps } = makeDeps()
    mem.store.markPosted = vi.fn(async () => {
      throw new Error('connection reset')
    })
    // The step's own NOT_TRACKED write fails too; finalize's works.
    const failAnswers = mem.store.failAnswers
    let refused = 0
    mem.store.failAnswers = vi.fn(async (...args: Parameters<typeof failAnswers>) => {
      if (args[2] === 'NOT_TRACKED' && refused < 3) {
        refused++
        throw new Error('connection reset')
      }
      return failAnswers(...args)
    })
    const rec = recordingStep()
    await runAiVisibilityCheck(RUN, rec.step, mem.store, deps)
    expect(refused).toBe(3)
    expect(rec.memo.get('post-0')).toMatchObject({
      untracked: [
        { id: 'p1-chatgpt', cost_usd: 0.0012 },
        { id: 'p2-chatgpt', cost_usd: 0.0012 },
      ],
    })
    for (const id of ['p1-chatgpt', 'p2-chatgpt'])
      expect(mem.answers.get(id)).toMatchObject({
        status: 'failed',
        error_code: 'NOT_TRACKED',
        cost_usd: 0.0012,
      })
  })

  it('a live answer whose save keeps failing ends NOT_TRACKED with its cost', async () => {
    const mem = seed({ engines: ['claude'] })
    const { deps } = makeDeps()
    mem.store.saveAnswer = vi.fn(async () => {
      throw new Error('connection reset')
    })
    await runAiVisibilityCheck(RUN, recordingStep().step, mem.store, deps)
    const live = mem.answers.get('p1-claude')!
    expect(live).toMatchObject({ status: 'failed', error_code: 'NOT_TRACKED' })
    expect(live.cost_usd).toBeGreaterThan(0.1)
    expect(mem.run.error_detail).toContain('were charged about')
  })

  it('a live answer the provider failed but billed keeps its cost, and the check says it was charged', async () => {
    const mem = seed({ engines: ['claude'] })
    const { deps, llmResponse } = makeDeps()
    llmResponse.mockRejectedValue(
      new DataforseoChargedTaskError(
        'task failed',
        { path: ['ai_optimization', 'claude'], costUsd: 0.05 },
        false,
        'UPSTREAM_UNAVAILABLE',
      ),
    )
    await runAiVisibilityCheck(RUN, recordingStep().step, mem.store, deps)
    expect(mem.answers.get('p1-claude')).toMatchObject({
      status: 'failed',
      error_code: 'UPSTREAM_UNAVAILABLE',
      cost_usd: 0.05,
    })
    expect(mem.run).toMatchObject({
      status: 'failed',
      error_code: 'NO_ANSWERS',
      error_detail: expect.stringContaining('charged about $0.10'),
    })
  })
})

describe('a scheduled check stopped partway', () => {
  /** The gate as ./gate.ts answers it about the tracker's state. */
  const gateOn = (deps: EngineDeps) => {
    deps.scheduledGate = vi.fn(async (t: { paused: boolean }) =>
      t.paused
        ? {
            ok: false as const,
            reason: 'paused',
            message: 'The tracker is paused.',
          }
        : { ok: true as const },
    )
    return deps.scheduledGate
  }

  it('paused after the post, it asks nothing live, keeps what was answered, and ends in the gate’s words', async () => {
    const mem = seed({ trigger: 'scheduled' })
    const { deps, trackingTaskPost, llmResponse } = makeDeps({
      results: {
        'task-p1-chatgpt': [completed(chatgptResult('Oakline.'))],
        'task-p2-chatgpt': [completed(chatgptResult('Fernhill Studio.'))],
      },
    })
    const gate = gateOn(deps)
    const post = trackingTaskPost.getMockImplementation()!
    trackingTaskPost.mockImplementation(async (input) => {
      // The person pauses the tracker while the check is buying.
      mem.tracker.paused = true
      return post(input)
    })
    const rec = recordingStep()
    const out = await runAiVisibilityCheck(RUN, rec.step, mem.store, deps)
    expect(trackingTaskPost).toHaveBeenCalledTimes(1)
    expect(llmResponse).not.toHaveBeenCalled()
    // prepare, post-0 and model-0 each asked.
    expect(gate).toHaveBeenCalledTimes(3)
    expect(rec.memo.get('model-0')).toMatchObject({
      sent: 0,
      stopped: { code: 'PAUSED', message: 'The tracker is paused.' },
    })
    expect(rec.ran.filter((id) => id.startsWith('model-'))).toEqual([
      'model-0',
    ])
    expect(out.status).toBe('failed')
    expect(mem.run).toMatchObject({
      status: 'failed',
      error_code: 'PAUSED',
      error_detail: 'The tracker is paused.',
    })
    expect(mem.answers.get('p1-chatgpt')?.status).toBe('collected')
    expect(mem.answers.get('p2-chatgpt')?.status).toBe('collected')
    expect(mem.answers.get('p1-claude')).toMatchObject({
      status: 'failed',
      error_code: 'NOT_SENT',
    })
  })

  it('an owner who moved to the free plan stops the next post', async () => {
    const mem = seed({ trigger: 'scheduled', engines: ['chatgpt'] })
    const { deps, trackingTaskPost } = makeDeps()
    // prepare passed; the owner moved to the free plan before this post.
    deps.scheduledGate = vi.fn().mockResolvedValue({
      ok: false,
      reason: 'free_plan',
      message: 'The schedule’s owner is on the free plan.',
    })
    await mem.store.claimRun(RUN)
    const out = await postQueueBatch(
      mem.store,
      RUN,
      { engine: 'chatgpt', ids: ['p1-chatgpt', 'p2-chatgpt'] },
      deps,
    )
    expect(out).toMatchObject({ sent: 0, stopped: { code: 'FREE_PLAN' } })
    expect(trackingTaskPost).not.toHaveBeenCalled()
    expect(mem.answers.get('p1-chatgpt')?.status).toBe('pending')
  })

  it('a manual check does not ask the schedule’s gate at its steps', async () => {
    const mem = seed()
    const { deps } = makeDeps({
      results: {
        'task-p1-chatgpt': [completed(chatgptResult('Oakline.'))],
        'task-p2-chatgpt': [completed(chatgptResult('Oakline.'))],
      },
    })
    await runAiVisibilityCheck(RUN, recordingStep().step, mem.store, deps)
    expect(deps.scheduledGate).not.toHaveBeenCalled()
  })
})

describe('a manual check is held to its start estimate', () => {
  it('answers that cost more than the check was started at end it ESTIMATE_CHANGED, nothing bought', async () => {
    // Two prompts on ChatGPT and Claude cost about $0.3624; it was started at $0.1812.
    const mem = seed({ estimate_usd: 0.1812 })
    const { deps, trackingTaskPost, llmResponse } = makeDeps()
    const out = await runAiVisibilityCheck(
      RUN,
      recordingStep().step,
      mem.store,
      deps,
    )
    expect(out.status).toBe('refused')
    expect(trackingTaskPost).not.toHaveBeenCalled()
    expect(llmResponse).not.toHaveBeenCalled()
    expect(mem.run).toMatchObject({
      status: 'failed',
      error_code: 'ESTIMATE_CHANGED',
      error_detail:
        'The tracker changed after this check was started, so it was not run. Start it again.',
    })
    expect(
      [...mem.answers.values()].every((a) => a.error_code === 'NOT_SENT'),
    ).toBe(true)
  })

  it('answers that cost exactly the estimate run', async () => {
    const mem = seed({ estimate_usd: 0.3624 })
    const { deps, trackingTaskPost } = makeDeps()
    await runAiVisibilityCheck(RUN, recordingStep().step, mem.store, deps)
    expect(trackingTaskPost).toHaveBeenCalledTimes(1)
  })
})
