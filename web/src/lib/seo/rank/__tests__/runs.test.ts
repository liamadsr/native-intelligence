/**
 * Starting and stopping a manual check: the access check before anything,
 * the month's spend before a run is written, the person's yes above the
 * confirmation line (held here, not only by the page or the tool), the
 * one-live-check answer, a stuck check replaced, and a send that fails never
 * leaving a run queued.
 * Supabase is a stub whose answer depends on the query chain it was asked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cancelRankCheck, isStuckRun, startRankCheck } from '../runs'

const WS = '00000000-0000-4000-8000-000000000001'
const TRACKER = '00000000-0000-4000-8000-000000000002'
const RUN = '00000000-0000-4000-8000-000000000003'
const PERSON = '00000000-0000-4000-8000-0000000000aa'

type Chain = Array<[string, unknown[]]>
type Answer = {
  data?: unknown
  error?: { code?: string; message: string } | null
  count?: number
}

function stub(answer: (table: string, chain: Chain) => Answer) {
  const log: Array<{ table: string; chain: Chain }> = []
  const builder = (table: string, chain: Chain): unknown =>
    new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === 'then') {
            log.push({ table, chain })
            return (resolve: (v: unknown) => void) =>
              resolve({ data: null, error: null, ...answer(table, chain) })
          }
          return (...args: unknown[]) =>
            builder(table, [...chain, [prop, args]])
        },
      },
    )
  return { client: { from: (t: string) => builder(t, []) } as never, log }
}

const has = (chain: Chain, method: string) => chain.some(([m]) => m === method)

const trackerRow = {
  id: TRACKER,
  workspace_id: WS,
  devices: 'mobile',
  serp_depth: 20,
  language_code: 'en',
}
const runRow = (overrides: Record<string, unknown> = {}) => ({
  id: RUN,
  tracker_id: TRACKER,
  workspace_id: WS,
  trigger: 'manual',
  status: 'queued',
  scheduled_for: null,
  keywords_total: 1,
  keywords_checked: 0,
  checks_total: 1,
  checks_collected: 0,
  estimate_usd: '0.0063',
  cost_usd: '0',
  error_code: null,
  error_detail: null,
  started_by: PERSON,
  created_at: '2026-11-12T10:00:00.000Z',
  started_at: null,
  completed_at: null,
  ...overrides,
})

const ok = async () => ({ ok: true as const })

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-12T10:00:00.000Z'))
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function db(
  opts: {
    insert?: Answer
    live?: unknown[]
    tracker?: Record<string, unknown>
    keywords?: Array<{ id: string; keyword: string }>
  } = {},
) {
  return stub((table, chain) => {
    if (table === 'seo_rank_tracker')
      return { data: { ...trackerRow, ...opts.tracker } }
    if (table === 'seo_rank_keyword')
      return {
        data: opts.keywords ?? [{ id: 'k1', keyword: 'plumber austin' }],
      }
    if (table === 'seo_rank_run' && has(chain, 'insert'))
      return opts.insert ?? { data: runRow() }
    if (table === 'seo_rank_run' && has(chain, 'update'))
      return { data: [{ id: RUN }] }
    if (table === 'seo_rank_run' && has(chain, 'in'))
      return { data: opts.live ?? [] }
    return { data: null }
  })
}

describe('startRankCheck', () => {
  it('asks the access check before anything, and returns its refusal as one', async () => {
    const { client, log } = db()
    const access = vi.fn(async () => ({
      ok: false as const,
      code: 'UNATTENDED' as const,
      message: 'Only when asked.',
    }))
    const out = await startRankCheck(
      client,
      { workspaceId: WS, userId: PERSON },
      TRACKER,
      { unattended: true },
      { access },
    )
    expect(out).toEqual({
      ok: false,
      code: 'UNATTENDED',
      message: 'Only when asked.',
      refusal: true,
    })
    expect(access).toHaveBeenCalledWith({
      userId: PERSON,
      workspaceId: WS,
      unattended: true,
    })
    expect(log).toEqual([])
  })

  it('a guest, or a plan that can’t be read, is refused with the access check’s own code', async () => {
    for (const code of ['NOT_A_MEMBER', 'CHECK_FAILED'] as const) {
      const { client, log } = db()
      const out = await startRankCheck(
        client,
        { workspaceId: WS, userId: PERSON },
        TRACKER,
        { confirmed: true },
        { access: async () => ({ ok: false, code, message: 'No.' }) },
      )
      expect(out).toEqual({ ok: false, code, message: 'No.', refusal: true })
      expect(log).toEqual([])
    }
  })

  it('a check above the confirmation line needs the yes: refused with its estimate, no run written', async () => {
    const many = Array.from({ length: 100 }, (_, i) => ({
      id: `k${i}`,
      keyword: `keyword ${i}`,
    }))
    const dear = {
      tracker: { devices: 'both', serp_depth: 100 },
      keywords: many,
    }
    const { client, log } = db(dear)
    const send = vi.fn(async () => undefined)
    const out = await startRankCheck(
      client,
      { workspaceId: WS, userId: PERSON },
      TRACKER,
      {},
      { access: ok, monthlySpend: async () => 0, send },
    )
    expect(out).toMatchObject({
      ok: false,
      code: 'NEEDS_GO_AHEAD',
      estimate: { keyword_count: 100, devices: 'both', schedule: 'manual' },
    })
    expect(
      out.ok === false && 'estimate' in out && out.estimate.per_check_usd,
    ).toBeGreaterThan(0.25)
    expect(log.some((q) => q.table === 'seo_rank_run')).toBe(false)
    expect(send).not.toHaveBeenCalled()

    const yes = db(dear)
    const started = await startRankCheck(
      yes.client,
      { workspaceId: WS, userId: PERSON },
      TRACKER,
      { confirmed: true },
      { access: ok, monthlySpend: async () => 0, send },
    )
    expect(started).toMatchObject({ ok: true })
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('a check under the line starts without the yes', async () => {
    const { client } = db()
    const out = await startRankCheck(
      client,
      { workspaceId: WS, userId: PERSON },
      TRACKER,
      {},
      { access: ok, monthlySpend: async () => 0, send: async () => undefined },
    )
    expect(out).toMatchObject({ ok: true })
  })

  it('refuses a check that can’t fit the month before writing a run', async () => {
    const { client, log } = db()
    const out = await startRankCheck(
      client,
      { workspaceId: WS, userId: PERSON },
      TRACKER,
      {},
      { access: ok, monthlySpend: async () => 19.999 },
    )
    expect(out).toMatchObject({ ok: false, code: 'SPEND_LIMIT_REACHED' })
    expect(out.ok === false && out.message).toMatch(/starts over on 2026-12-01/)
    expect(log.some((q) => q.table === 'seo_rank_run')).toBe(false)
  })

  it('writes the run and sends it to the lane', async () => {
    const { client, log } = db()
    const send = vi.fn(async () => undefined)
    const out = await startRankCheck(
      client,
      { workspaceId: WS, userId: PERSON },
      TRACKER,
      {},
      { access: ok, monthlySpend: async () => 0, send },
    )
    expect(out).toMatchObject({
      ok: true,
      run: { id: RUN, status: 'queued', estimate_usd: 0.0063 },
    })
    expect(send).toHaveBeenCalledWith({
      name: 'seo/rank-check.requested',
      data: { runId: RUN, workspaceId: WS, trackerId: TRACKER },
    })
    const insert = log.find(
      (q) => q.table === 'seo_rank_run' && has(q.chain, 'insert'),
    )!
    expect(insert.chain[0][1][0]).toMatchObject({
      tracker_id: TRACKER,
      workspace_id: WS,
      trigger: 'manual',
      started_by: PERSON,
      scheduled_for: null,
      keywords_total: 1,
      checks_total: 1,
    })
  })

  it('one live check per tracker: a second start is told so and nothing is charged', async () => {
    const { client } = db({
      insert: {
        error: {
          code: '23505',
          message:
            'duplicate key value violates unique constraint "seo_rank_run_one_live_per_tracker"',
        },
      },
      live: [
        runRow({ status: 'running', started_at: '2026-11-12T09:30:00.000Z' }),
      ],
    })
    const send = vi.fn()
    const out = await startRankCheck(
      client,
      { workspaceId: WS, userId: PERSON },
      TRACKER,
      {},
      { access: ok, monthlySpend: async () => 0, send },
    )
    expect(out).toMatchObject({
      ok: false,
      code: 'ALREADY_RUNNING',
      run: { id: RUN, status: 'running' },
    })
    expect(send).not.toHaveBeenCalled()
  })

  it('a stuck live check is failed and told to stop, and the start tries again', async () => {
    const { client, log } = db({
      insert: { error: { code: '23505', message: 'duplicate key' } },
      live: [
        runRow({ status: 'running', started_at: '2026-11-12T01:00:00.000Z' }),
      ],
    })
    const send = vi.fn(async () => undefined)
    await startRankCheck(
      client,
      { workspaceId: WS, userId: PERSON },
      TRACKER,
      {},
      { access: ok, monthlySpend: async () => 0, send },
    )
    expect(send).toHaveBeenCalledWith({
      name: 'seo/rank-check.cancel',
      data: { runId: RUN },
    })
    const failed = log.find(
      (q) => q.table === 'seo_rank_run' && has(q.chain, 'update'),
    )!
    expect(failed.chain[0][1][0]).toMatchObject({
      status: 'failed',
      error_code: 'STUCK',
    })
    expect(
      log.filter((q) => q.table === 'seo_rank_run' && has(q.chain, 'insert')),
    ).toHaveLength(2)
  })

  it('a send that fails writes the run failed so it never sits queued', async () => {
    const { client, log } = db()
    const out = await startRankCheck(
      client,
      { workspaceId: WS, userId: PERSON },
      TRACKER,
      {},
      {
        access: ok,
        monthlySpend: async () => 0,
        send: async () => {
          throw new Error('inngest down')
        },
      },
    )
    expect(out).toMatchObject({ ok: false, code: 'START_FAILED' })
    const failed = log.find(
      (q) => q.table === 'seo_rank_run' && has(q.chain, 'update'),
    )!
    expect(failed.chain[0][1][0]).toMatchObject({
      status: 'failed',
      error_code: 'START_FAILED',
    })
  })
})

describe('isStuckRun', () => {
  const now = new Date('2026-11-12T10:00:00.000Z')
  it('running past six hours, or queued past a day', () => {
    expect(
      isStuckRun(
        {
          status: 'running',
          created_at: '2026-11-12T03:00:00Z',
          started_at: '2026-11-12T03:59:00Z',
        },
        now,
      ),
    ).toBe(true)
    expect(
      isStuckRun(
        {
          status: 'running',
          created_at: '2026-11-12T08:00:00Z',
          started_at: '2026-11-12T08:00:00Z',
        },
        now,
      ),
    ).toBe(false)
    expect(
      isStuckRun(
        {
          status: 'queued',
          created_at: '2026-11-11T09:00:00Z',
          started_at: null,
        },
        now,
      ),
    ).toBe(true)
    expect(
      isStuckRun(
        {
          status: 'completed',
          created_at: '2026-01-01T00:00:00Z',
          started_at: null,
        },
        now,
      ),
    ).toBe(false)
  })
})

describe('cancelRankCheck', () => {
  it('a check that already ended can’t be stopped', async () => {
    const { client } = stub((table) =>
      table === 'seo_rank_run' ? { data: runRow({ status: 'completed' }) } : {},
    )
    expect(
      await cancelRankCheck(client, { workspaceId: WS }, RUN, {
        send: vi.fn(),
      }),
    ).toMatchObject({ ok: false, code: 'NOT_RUNNING' })
  })

  it('writes the status first, then tells the lane', async () => {
    const order: string[] = []
    const { client } = stub((table, chain) => {
      if (has(chain, 'update')) order.push('status')
      return table === 'seo_rank_run'
        ? {
            data: runRow({
              status: has(chain, 'update') ? 'canceled' : 'running',
            }),
          }
        : {}
    })
    const send = vi.fn(async () => {
      order.push('event')
    })
    const out = await cancelRankCheck(client, { workspaceId: WS }, RUN, {
      send,
    })
    expect(out).toMatchObject({ ok: true })
    expect(order).toEqual(['status', 'event'])
    expect(send).toHaveBeenCalledWith({
      name: 'seo/rank-check.cancel',
      data: { runId: RUN },
    })
  })
})
