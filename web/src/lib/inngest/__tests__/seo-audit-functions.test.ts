/**
 * The SEO site audit's lane (../seo-audit-functions.ts): claim the audit
 * (queued -> running), discover, crawl chunk after chunk until the engine
 * says done (sleeping through any pause a 429 asked for), finalize. A failure
 * the engine names (AuditFailure) is written to the row once and never
 * retried; anything else is rethrown for Inngest to retry, and onFailure
 * writes the row with a plain sentence once retries are spent.
 *
 * The engine, the store and the database are mocked: this file tests the
 * order of steps and what happens on each kind of failure.
 */
import { AuditFailure } from '@/lib/seo/audit/engine'
import { createStepMock } from '@/test/inngest-step-mock'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (ctx: {
  event: { data: unknown }
  step: ReturnType<typeof createStepMock>
}) => Promise<unknown>

const hoisted = vi.hoisted(() => {
  const claim = {
    rows: [{ id: 'audit-1' }] as Array<{ id: string }> | null,
    error: null as { message: string } | null,
    updates: [] as Array<Record<string, unknown>>,
    filters: [] as Array<[string, string, unknown]>,
  }
  const chain: Record<string, unknown> = {}
  chain.update = (row: Record<string, unknown>) => {
    claim.updates.push(row)
    return chain
  }
  chain.eq = (column: string, value: unknown) => {
    claim.filters.push(['eq', column, value])
    return chain
  }
  chain.in = (column: string, value: unknown) => {
    claim.filters.push(['in', column, value])
    return chain
  }
  chain.select = async () => ({ data: claim.rows, error: claim.error })
  return {
    handlers: {} as Record<string, Handler>,
    configs: {} as Record<string, Record<string, unknown>>,
    claim,
    db: { from: vi.fn(() => chain) },
    store: { kind: 'audit-store' },
    createAuditStore: vi.fn(),
    engine: {
      runDiscovery: vi.fn(),
      runCrawlChunk: vi.fn(),
      finalizeAudit: vi.fn(),
      failAudit: vi.fn(async () => {}),
      stopCrawl: vi.fn(async () => {}),
    },
  }
})

vi.mock('../client', () => ({
  SEO_AUDIT_REQUESTED: 'seo/audit.requested',
  SEO_AUDIT_CANCEL: 'seo/audit.cancel',
  inngest: {
    createFunction: (config: Record<string, unknown>, fn: Handler) => {
      hoisted.handlers[config.id as string] = fn
      hoisted.configs[config.id as string] = config
      return { id: config.id }
    },
  },
}))
// The real AuditFailure, so `instanceof` in the lane sees the engine's own class.
vi.mock('@/lib/seo/audit/engine', async (orig) => ({
  AuditFailure: (await orig<typeof import('@/lib/seo/audit/engine')>())
    .AuditFailure,
  ...hoisted.engine,
}))
vi.mock('@/lib/seo/audit/store', () => ({
  createAuditStore: hoisted.createAuditStore,
}))
vi.mock('@/lib/supabase/service', () => ({
  getServiceClient: () => hoisted.db,
}))

const { seoAuditOnFailure } = await import('../seo-audit-functions')

const AUDIT = 'audit-1'
const EVENT = { data: { auditId: AUDIT, workspaceId: 'ws-1' } }
const run = (event: { data: unknown } = EVENT) => {
  const step = createStepMock()
  return { step, out: hoisted.handlers['seo-audit-run']({ event, step }) }
}
const stepIds = (step: ReturnType<typeof createStepMock>) =>
  step.run.mock.calls.map((call) => call[0])

const notDone = { done: false, resumeAt: null, crawled: 1, pending: 1 }
const done = { done: true, resumeAt: null, crawled: 2, pending: 0 }

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.claim.rows = [{ id: AUDIT }]
  hoisted.claim.error = null
  hoisted.claim.updates = []
  hoisted.claim.filters = []
  hoisted.createAuditStore.mockReturnValue(hoisted.store)
  hoisted.engine.runDiscovery.mockResolvedValue({ seeded: 3 })
  hoisted.engine.runCrawlChunk.mockResolvedValue(done)
  hoisted.engine.finalizeAudit.mockResolvedValue({ issues: 4 })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('registration', () => {
  it('one audit per workspace at a time, a few at once, canceled by its own cancel event, retried twice', () => {
    const config = hoisted.configs['seo-audit-run']
    expect(config).toMatchObject({
      retries: 2,
      concurrency: [{ limit: 1, key: 'event.data.workspaceId' }, { limit: 4 }],
      cancelOn: [{ event: 'seo/audit.cancel', match: 'data.auditId' }],
      triggers: [{ event: 'seo/audit.requested' }],
    })
    expect(config.onFailure).toEqual(expect.any(Function))
  })
})

describe('seo-audit-run', () => {
  it.each([[{}], [null], [{ auditId: AUDIT }], [{ workspaceId: 'ws-1' }]])(
    'skips an event without both ids: %j',
    async (data) => {
      const { step, out } = run({ data })
      expect(await out).toEqual({ skipped: 'missing_ids' })
      expect(step.run).not.toHaveBeenCalled()
      expect(hoisted.db.from).not.toHaveBeenCalled()
    },
  )

  it('claims the audit with a compare-and-set on its id, workspace and live status', async () => {
    await run().out
    expect(hoisted.db.from).toHaveBeenCalledWith('seo_audit')
    expect(hoisted.claim.updates[0]).toMatchObject({ status: 'running' })
    expect(hoisted.claim.filters).toEqual([
      ['eq', 'id', AUDIT],
      ['eq', 'workspace_id', 'ws-1'],
      ['in', 'status', ['queued', 'running']],
    ])
  })

  it('stops at once when the claim matches no row (canceled, finished, or another workspace’s)', async () => {
    hoisted.claim.rows = []
    const { step, out } = run()
    expect(await out).toEqual({ skipped: 'not_claimable', auditId: AUDIT })
    expect(stepIds(step)).toEqual(['claim'])
    for (const fn of Object.values(hoisted.engine)) {
      expect(fn).not.toHaveBeenCalled()
    }
  })

  it('throws when the claim itself fails, so Inngest retries it', async () => {
    hoisted.claim.error = { message: 'connection reset' }
    await expect(run().out).rejects.toThrow('connection reset')
    expect(hoisted.engine.runDiscovery).not.toHaveBeenCalled()
  })

  it('runs discover, then crawl-0..N until a chunk is done, then finalize, sleeping only when a chunk asks', async () => {
    const resumeAt = Date.parse('2026-11-12T10:00:00Z')
    hoisted.engine.runCrawlChunk
      .mockResolvedValueOnce(notDone)
      .mockResolvedValueOnce({ ...notDone, resumeAt })
      .mockResolvedValueOnce(notDone)
      .mockResolvedValueOnce(done)
    const { step, out } = run()

    expect(await out).toEqual({
      status: 'completed',
      auditId: AUDIT,
      issues: 4,
    })
    expect(stepIds(step)).toEqual([
      'claim',
      'discover',
      'crawl-0',
      'crawl-1',
      'crawl-2',
      'crawl-3',
      'finalize',
    ])
    expect(hoisted.engine.runDiscovery).toHaveBeenCalledWith(
      hoisted.store,
      AUDIT,
    )
    expect(
      hoisted.engine.runCrawlChunk.mock.calls.map((call) => call.slice(0, 3)),
    ).toEqual([0, 1, 2, 3].map((n) => [hoisted.store, AUDIT, n]))
    expect(hoisted.engine.finalizeAudit).toHaveBeenCalledWith(
      hoisted.store,
      AUDIT,
    )
    expect(step.sleepUntil).toHaveBeenCalledTimes(1)
    expect(step.sleepUntil).toHaveBeenCalledWith('pause-1', new Date(resumeAt))
    expect(hoisted.engine.failAudit).not.toHaveBeenCalled()
  })

  it('sleeps before the chunk that follows the pause, not after it', async () => {
    const resumeAt = Date.parse('2026-11-12T10:00:00Z')
    const order: string[] = []
    hoisted.engine.runCrawlChunk.mockImplementation(
      async (_s: unknown, _a: unknown, n: number) => {
        order.push(`crawl-${n}`)
        return n === 0 ? { ...notDone, resumeAt } : done
      },
    )
    const step = createStepMock({
      sleepUntil: async (id: string) => {
        order.push(id)
      },
    })
    await hoisted.handlers['seo-audit-run']({ event: EVENT, step })
    expect(order).toEqual(['crawl-0', 'pause-0', 'crawl-1'])
  })

  it('stops crawling after 400 chunks, names the reason, and finalizes what there is', async () => {
    hoisted.engine.runCrawlChunk.mockResolvedValue(notDone)
    const { step, out } = run()
    expect(await out).toMatchObject({ status: 'completed' })
    expect(hoisted.engine.runCrawlChunk).toHaveBeenCalledTimes(400)
    // The report must not blame the page budget for what the ceiling left unvisited.
    expect(hoisted.engine.stopCrawl).toHaveBeenCalledWith(
      expect.anything(),
      AUDIT,
      'crawl-time-limit',
    )
    expect(stepIds(step).slice(-2)).toEqual(['crawl-ceiling', 'finalize'])
  })

  it('a crawl that ends by itself never records the ceiling', async () => {
    const { step, out } = run()
    await out
    expect(hoisted.engine.stopCrawl).not.toHaveBeenCalled()
    expect(stepIds(step)).not.toContain('crawl-ceiling')
  })

  describe('a failure the engine names', () => {
    const failure = new AuditFailure(
      'SITE_UNREACHABLE',
      'The site did not answer any request.',
    )

    it.each([
      [
        'discover',
        () => hoisted.engine.runDiscovery.mockRejectedValue(failure),
        ['claim', 'discover', 'record-failure'],
      ],
      [
        'a crawl chunk',
        () =>
          hoisted.engine.runCrawlChunk
            .mockResolvedValueOnce(notDone)
            .mockRejectedValueOnce(failure),
        ['claim', 'discover', 'crawl-0', 'crawl-1', 'record-failure'],
      ],
      [
        'finalize',
        () => hoisted.engine.finalizeAudit.mockRejectedValue(failure),
        ['claim', 'discover', 'crawl-0', 'finalize', 'record-failure'],
      ],
    ])(
      'from %s is recorded once through failAudit and not rethrown',
      async (_stage, arrange, steps) => {
        arrange()
        const { step, out } = run()
        expect(await out).toEqual({
          status: 'failed',
          code: 'SITE_UNREACHABLE',
          auditId: AUDIT,
        })
        expect(stepIds(step)).toEqual(steps)
        expect(hoisted.engine.failAudit).toHaveBeenCalledTimes(1)
        expect(hoisted.engine.failAudit).toHaveBeenCalledWith(
          hoisted.store,
          AUDIT,
          'SITE_UNREACHABLE',
          'The site did not answer any request.',
        )
      },
    )
  })

  describe('any other error', () => {
    const boom = new Error('database timeout')

    it.each([
      ['discover', () => hoisted.engine.runDiscovery.mockRejectedValue(boom)],
      [
        'a crawl chunk',
        () => hoisted.engine.runCrawlChunk.mockRejectedValue(boom),
      ],
      ['finalize', () => hoisted.engine.finalizeAudit.mockRejectedValue(boom)],
    ])(
      'from %s is rethrown for Inngest to retry, and nothing is recorded',
      async (_stage, arrange) => {
        arrange()
        await expect(run().out).rejects.toThrow('database timeout')
        expect(hoisted.engine.failAudit).not.toHaveBeenCalled()
      },
    )
  })
})

describe('seoAuditOnFailure', () => {
  it('writes the audit failed with a plain sentence, never the raw error', async () => {
    const raw = 'TypeError: Cannot read properties of undefined (reading x)'
    expect(
      await seoAuditOnFailure({
        event: { data: { event: { data: EVENT.data } } },
        error: { message: raw },
      }),
    ).toEqual({ auditId: AUDIT })
    expect(hoisted.engine.failAudit).toHaveBeenCalledTimes(1)
    const [store, auditId, code, detail] = hoisted.engine.failAudit.mock
      .calls[0] as unknown as [unknown, string, string, string]
    expect(store).toBe(hoisted.store)
    expect(auditId).toBe(AUDIT)
    expect(code).toBe('CRAWL_FAILED')
    expect(detail).toBe('The audit stopped unexpectedly. Run it again.')
    expect(detail).not.toContain('TypeError')
  })

  it('is what the function registers as its onFailure hook', async () => {
    const onFailure = hoisted.configs['seo-audit-run'].onFailure as (
      ctx: unknown,
    ) => Promise<unknown>
    await onFailure({
      event: { data: { event: { data: EVENT.data } } },
      error: { message: 'x' },
    })
    expect(hoisted.engine.failAudit).toHaveBeenCalledWith(
      hoisted.store,
      AUDIT,
      'CRAWL_FAILED',
      expect.any(String),
    )
  })

  it.each([
    [{ data: { event: { data: {} } } }],
    [{ data: { event: null } }],
    [{ data: null }],
  ])('tolerates an original event without an audit id: %j', async (event) => {
    expect(await seoAuditOnFailure({ event, error: { message: 'x' } })).toEqual(
      { skipped: 'missing_ids' },
    )
    expect(hoisted.engine.failAudit).not.toHaveBeenCalled()
  })
})
