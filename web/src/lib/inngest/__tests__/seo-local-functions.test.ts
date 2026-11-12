/**
 * The local rank scan's lane (../seo-local-functions.ts): claim, one post per
 * keyword, then sleeps between free reads until nothing is pending (or the
 * waits run out), then finalize. A refusal the engine names is written once
 * and never retried; onFailure writes the scan failed once retries are spent.
 *
 * The engine, the store and the database are mocked: this file tests the
 * order of steps and what happens on each outcome.
 */
import { createStepMock } from '@/test/inngest-step-mock'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (ctx: {
  event: { data: unknown }
  step: ReturnType<typeof createStepMock>
}) => Promise<unknown>

const hoisted = vi.hoisted(() => ({
  handlers: {} as Record<string, Handler>,
  configs: {} as Record<string, Record<string, unknown>>,
  store: { kind: 'local-scan-store' },
  engine: {
    claimScan: vi.fn(),
    postKeyword: vi.fn(),
    collectRound: vi.fn(),
    finalizeScan: vi.fn(),
    failScan: vi.fn(async () => {}),
  },
  dataClient: vi.fn(() => ({ kind: 'metered-client' })),
}))

vi.mock('../client', () => ({
  inngest: {
    createFunction: (config: Record<string, unknown>, fn: Handler) => {
      hoisted.handlers[config.id as string] = fn
      hoisted.configs[config.id as string] = config
      return { id: config.id }
    },
  },
  SEO_LOCAL_SCAN_REQUESTED: 'seo/local-scan.requested',
  SEO_LOCAL_SCAN_CANCEL: 'seo/local-scan.cancel',
}))
vi.mock('@/lib/seo/local/scan-engine', async (orig) => ({
  isScanFailure: (await orig<typeof import('@/lib/seo/local/scan-engine')>())
    .isScanFailure,
  ...hoisted.engine,
}))
vi.mock('@/lib/seo/local/scan-store', () => ({
  createLocalScanStore: () => hoisted.store,
}))
vi.mock('@/lib/seo/local/scan-client', () => ({
  localScanClient: hoisted.dataClient,
}))
vi.mock('@/lib/seo/dataforseo', () => ({ fetchLocalSerpTaskResult: vi.fn() }))
vi.mock('@/lib/supabase/service', () => ({
  getServiceClient: () => ({ kind: 'db' }),
}))

const {
  seoLocalScanOnFailure,
  SEO_LOCAL_SCAN_CANCEL,
  SEO_LOCAL_SCAN_REQUESTED,
  seoLocalFunctions,
} = await import('../seo-local-functions')
const run = () => hoisted.handlers['seo-local-scan-run']
const EVENT = { data: { scanId: 'scan-1', workspaceId: 'ws-1' } }

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.engine.claimScan.mockResolvedValue({
    workspaceId: 'ws-1',
    keywords: ['dentist', 'emergency dentist'],
    startedBy: 'user-1',
  })
  hoisted.engine.postKeyword.mockResolvedValue({
    posted: 9,
    refused: 0,
    reused: false,
  })
  hoisted.engine.finalizeScan.mockResolvedValue({
    status: 'completed',
    summary: { points_total: 18 },
  })
})

describe('the lane’s configuration', () => {
  it('runs one scan per workspace at a time, stops on its cancel event, and has no schedule', () => {
    const config = hoisted.configs['seo-local-scan-run']
    expect(config.concurrency).toEqual([
      { limit: 1, key: 'event.data.workspaceId' },
      { limit: 4 },
    ])
    expect(config.cancelOn).toEqual([
      { event: SEO_LOCAL_SCAN_CANCEL, match: 'data.scanId' },
    ])
    expect(config.triggers).toEqual([{ event: SEO_LOCAL_SCAN_REQUESTED }])
    expect(typeof config.onFailure).toBe('function')
    expect(seoLocalFunctions).toHaveLength(1)
  })
})

describe('seo-local-scan-run', () => {
  it('claims, posts each keyword once in the person’s name, reads until nothing is pending, then finalizes', async () => {
    hoisted.engine.collectRound
      .mockResolvedValueOnce({ pending: 10, settled: 8 })
      .mockResolvedValueOnce({ pending: 0, settled: 10 })
    const step = createStepMock()
    const out = await run()({ event: EVENT, step })

    expect(step.run.mock.calls.map((call: unknown[]) => call[0])).toEqual([
      'claim',
      'post-0',
      'post-1',
      'collect-0',
      'collect-1',
      'finalize',
    ])
    expect(step.sleep.mock.calls.map((call: unknown[]) => call[0])).toEqual([
      'wait-0',
      'wait-1',
    ])
    expect(hoisted.engine.postKeyword).toHaveBeenNthCalledWith(
      1,
      hoisted.store,
      'scan-1',
      0,
      { kind: 'metered-client' },
    )
    expect(hoisted.dataClient).toHaveBeenCalledWith(
      { kind: 'db' },
      { workspaceId: 'ws-1', userId: 'user-1' },
    )
    expect(out).toMatchObject({ status: 'completed', scanId: 'scan-1' })
  })

  it('stops reading after the last wait and finalizes what it has (nothing spins)', async () => {
    hoisted.engine.collectRound.mockResolvedValue({ pending: 3, settled: 0 })
    const step = createStepMock()
    await run()({ event: EVENT, step })
    expect(step.sleep).toHaveBeenCalledTimes(10)
    expect(hoisted.engine.collectRound).toHaveBeenCalledTimes(10)
    expect(hoisted.engine.finalizeScan).toHaveBeenCalledTimes(1)
  })

  it('writes a named refusal once and stops', async () => {
    hoisted.engine.postKeyword.mockResolvedValueOnce({
      failure: {
        code: 'SPEND_LIMIT_REACHED',
        message: 'The monthly limit is reached.',
      },
    })
    const step = createStepMock()
    const out = await run()({ event: EVENT, step })
    expect(hoisted.engine.failScan).toHaveBeenCalledWith(
      hoisted.store,
      'scan-1',
      'SPEND_LIMIT_REACHED',
      'The monthly limit is reached.',
    )
    expect(hoisted.engine.postKeyword).toHaveBeenCalledTimes(1)
    expect(hoisted.engine.collectRound).not.toHaveBeenCalled()
    expect(out).toMatchObject({ status: 'failed', code: 'SPEND_LIMIT_REACHED' })
  })

  it('stops when the scan was canceled or cannot be claimed', async () => {
    hoisted.engine.collectRound.mockResolvedValueOnce({ inactive: true })
    expect(await run()({ event: EVENT, step: createStepMock() })).toMatchObject(
      { skipped: 'inactive' },
    )
    expect(hoisted.engine.finalizeScan).not.toHaveBeenCalled()

    hoisted.engine.claimScan.mockResolvedValueOnce(null)
    expect(await run()({ event: EVENT, step: createStepMock() })).toMatchObject(
      { skipped: 'not_claimable' },
    )
    // A scan of another workspace is never run under this event's.
    hoisted.engine.claimScan.mockResolvedValueOnce({
      workspaceId: 'ws-2',
      keywords: ['x'],
      startedBy: null,
    })
    expect(await run()({ event: EVENT, step: createStepMock() })).toMatchObject(
      { skipped: 'not_claimable' },
    )
    expect(
      await run()({ event: { data: {} }, step: createStepMock() }),
    ).toEqual({ skipped: 'missing_ids' })
  })
})

describe('seoLocalScanOnFailure', () => {
  it('writes the scan failed with a plain sentence', async () => {
    const out = await seoLocalScanOnFailure({
      event: { data: { event: { data: EVENT.data } } },
      error: { message: 'boom' },
    })
    expect(out).toEqual({ scanId: 'scan-1' })
    expect(hoisted.engine.failScan).toHaveBeenCalledWith(
      hoisted.store,
      'scan-1',
      'SCAN_FAILED',
      expect.stringContaining('stopped unexpectedly'),
    )
  })

  it('does nothing without a scan id', async () => {
    expect(
      await seoLocalScanOnFailure({ event: { data: null }, error: null }),
    ).toEqual({ skipped: 'missing_ids' })
  })
})
