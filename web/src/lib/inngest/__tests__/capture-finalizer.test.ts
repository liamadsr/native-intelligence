/**
 * The server's Stop for an abandoned recording (src/lib/inngest/capture-finalizer.ts).
 *
 * Pinned:
 *   - the sweep sends one finalize per abandoned capture, keyed by capture AND
 *     quiet spell, capped per tick; nothing to send, nothing sent;
 *   - the sweep retires the open captures quiet past the lookback in place: no
 *     event, no batch, no title, no index;
 *   - finalize closes first and does nothing else when the close does not take
 *     (the recorder came back, or Stop landed);
 *   - the batch runs through the real route as the OWNER: a device token for
 *     the owner pinned to the capture's workspace, the canonical batch body
 *     with auto-archive off, and the token deleted afterwards whatever happened;
 *   - after a batch: the title, then the index (not closing the record again —
 *     the batch's finalize already emitted capture.processed);
 *   - a record written live: no batch; the index closes it (captureProcessed);
 *   - a usage wall / refusal never retries, a server error does, and a batch
 *     still running past the wait is checked for its stamp after it settles;
 *   - a capture resumed after the close (Start on the same meeting moments
 *     after a declined recovery) gets no title, index or Triage: the live
 *     session owns it again and its own end runs the pass.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NonRetriableError } from 'inngest'
import { createStepMock } from '@/test/inngest-step-mock'
import { makeFakeSupabase, type FakeSupabase, type Row } from '@/lib/work/__tests__/fake-supabase'

type Handler = (ctx: { event: { data: Record<string, unknown> }; step: ReturnType<typeof createStepMock> }) => Promise<unknown>

const hoisted = vi.hoisted(() => ({
  handlers: {} as Record<string, Handler>,
  configs: {} as Record<string, Record<string, unknown>>,
  order: [] as string[],
  generateCaptureTitle: vi.fn(),
  indexCaptureFinished: vi.fn(),
}))

vi.mock('@/lib/inngest/client', () => ({
  inngest: {
    send: vi.fn(),
    createFunction: (config: Record<string, unknown>, fn: Handler) => {
      hoisted.configs[config.id as string] = config
      hoisted.handlers[config.id as string] = fn
      return { id: config.id }
    },
  },
}))
let fake: FakeSupabase
vi.mock('@/lib/admin', () => ({ getServiceClient: () => fake }))
vi.mock('@/lib/captures/generate-title', () => ({
  generateCaptureTitle: (...a: unknown[]) => {
    hoisted.order.push('title')
    return hoisted.generateCaptureTitle(...a)
  },
}))
vi.mock('@/lib/ai/index-capture-finished', () => ({
  indexCaptureFinished: (...a: unknown[]) => {
    hoisted.order.push('index')
    return hoisted.indexCaptureFinished(...a)
  },
}))

const { CAPTURE_ABANDONED_EVENT } = await import('@/lib/inngest/capture-finalizer')
const sweep = hoisted.handlers['abandoned-capture-sweep']
const finalize = hoisted.handlers['finalize-abandoned-capture']

const WS = 'f6000000-0000-4000-8000-000000000001'
const OWNER = 'a0000000-0000-4000-8000-000000000001'
const MIN = 60 * 1000
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
const MEETING = '[local_1] the SIT wave slips a week, UAT stays on the 14th\n'.repeat(10)

function capture(over: Row = {}): Row {
  return {
    id: 'cap-1',
    workspace_id: WS,
    user_id: OWNER,
    started_at: ago(120 * MIN),
    updated_at: ago(90 * MIN),
    ended_at: null,
    duration_seconds: null,
    live_mode: false,
    ai_summary: null,
    transcript: MEETING,
    metadata: { capture_mode: 'desktop_dual' },
    is_eval: false,
    status: 'active',
    batch_processed_at: null,
    ...over,
  }
}

const fetchMock = vi.fn()
const finalizeEvent = { data: { capture_id: 'cap-1', workspace_id: WS } }

beforeEach(() => {
  fake = makeFakeSupabase()
  fake.seed('member', [{ id: 'm-1', user_id: OWNER, workspace_id: WS }])
  fake.seed('workspace', [{ id: WS, settings: {} }])
  hoisted.order.length = 0
  hoisted.generateCaptureTitle.mockReset().mockResolvedValue({ status: 'ok', title: 'SIT wave and UAT dates' })
  hoisted.indexCaptureFinished.mockReset().mockResolvedValue({ chunksCreated: 3 })
  fetchMock.mockReset().mockImplementation(async () => {
    // What the route's finalize does, as far as this function can see: the stamp.
    const row = fake.rows('captures')[0]
    if (row) row.batch_processed_at = new Date().toISOString()
    return { ok: true, status: 200, text: async () => '', json: async () => ({ ok: true }) }
  })
  vi.stubGlobal('fetch', fetchMock)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('abandoned-capture-sweep', () => {
  it('runs every 15 minutes and sends one finalize per abandoned capture, keyed by its quiet spell', async () => {
    expect(hoisted.configs['abandoned-capture-sweep'].triggers).toEqual([{ cron: '*/15 * * * *' }])
    const quietSince = ago(90 * MIN)
    fake.seed('captures', [capture({ id: 'cap-1', updated_at: quietSince }), capture({ id: 'cap-live', updated_at: ago(MIN) })])
    const step = createStepMock()
    expect(await sweep({ event: { data: {} }, step })).toEqual({ found: 1, retired: 0 })
    expect(step.sendEvent).toHaveBeenCalledWith('finalize-abandoned', [
      { name: CAPTURE_ABANDONED_EVENT, id: `capture-abandoned:cap-1:${quietSince}`, data: { capture_id: 'cap-1', workspace_id: WS } },
    ])
  })

  it('caps a tick at five, and sends nothing when nothing is abandoned', async () => {
    fake.seed('captures', Array.from({ length: 7 }, (_, i) => capture({ id: `cap-${i}`, updated_at: ago((70 + i) * MIN) })))
    const step = createStepMock()
    await sweep({ event: { data: {} }, step })
    expect((step.sendEvent.mock.calls[0][1] as unknown[]).length).toBe(5)

    fake = makeFakeSupabase()
    const idle = createStepMock()
    expect(await sweep({ event: { data: {} }, step: idle })).toEqual({ found: 0, retired: 0 })
    expect(idle.sendEvent).not.toHaveBeenCalled()
  })

  it('retires an open capture quiet past the lookback in place: no event, no batch, no title, no index', async () => {
    const DAY = 24 * 60 * MIN
    const lastWrite = ago(30 * DAY)
    const blankLastWrite = ago(4 * DAY)
    const abandonedSince = ago(90 * MIN)
    fake.seed('captures', [
      capture({ id: 'stale-meeting', started_at: ago(31 * DAY), updated_at: lastWrite }),
      capture({ id: 'stale-blank', transcript: null, started_at: ago(5 * DAY), updated_at: blankLastWrite }),
      capture({ id: 'abandoned', updated_at: abandonedSince }),
    ])
    const step = createStepMock()
    expect(await sweep({ event: { data: {} }, step })).toEqual({ found: 1, retired: 2 })
    // The one inside the lookback is the finish's: its event, and only its.
    expect(step.sendEvent).toHaveBeenCalledWith('finalize-abandoned', [
      { name: CAPTURE_ABANDONED_EVENT, id: `capture-abandoned:abandoned:${abandonedSince}`, data: { capture_id: 'abandoned', workspace_id: WS } },
    ])
    expect(fetchMock).not.toHaveBeenCalled()
    expect(hoisted.order).toEqual([])
    const [meeting, blank, abandoned] = fake.rows('captures')
    expect(meeting).toMatchObject({ ended_at: lastWrite, duration_seconds: null, metadata: { finalized: { reason: 'stale' } } })
    expect(blank.ended_at).toBe(blankLastWrite)
    expect(abandoned.ended_at).toBeNull()
  })
})

describe('finalize-abandoned-capture', () => {
  it('one finalize at a time per capture, with retries', () => {
    expect(hoisted.configs['finalize-abandoned-capture']).toMatchObject({
      retries: 2,
      concurrency: [{ limit: 1, key: 'event.data.capture_id' }],
      triggers: [{ event: CAPTURE_ABANDONED_EVENT }],
    })
  })

  it('live mode off: closes it, runs the canonical batch as the owner, then title → index', async () => {
    const quietSince = ago(90 * MIN)
    fake.seed('captures', [capture({ updated_at: quietSince })])
    const out = await finalize({ event: finalizeEvent, step: createStepMock() })
    expect(out).toEqual({ status: 'finalized', batch: 'completed' })

    // Closed BEFORE the batch ran, at the last write.
    const [row] = fake.rows('captures')
    expect(row).toMatchObject({ ended_at: quietSince, ai_processed: true, metadata: { finalized: { by: 'server', reason: 'recorder_quiet' } } })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }]
    expect(url).toMatch(/\/api\/ai\/live-agent$/)
    expect(JSON.parse(init.body as string)).toEqual({ capture_id: 'cap-1', mode: 'batch', allow_auto_archive: false })
    expect(init.headers.Authorization).toMatch(/^Bearer d8d_/)

    // The token was the owner's, pinned to the capture's workspace — and is gone.
    const minted = fake.calls.find((c) => c.table === 'device_token' && c.op === 'insert')
    expect(minted).toBeTruthy()
    expect(fake.rows('device_token')).toEqual([])

    expect(hoisted.order).toEqual(['title', 'index'])
    expect(hoisted.generateCaptureTitle).toHaveBeenCalledWith(fake, { captureId: 'cap-1', workspaceId: WS, userId: OWNER })
    expect(hoisted.indexCaptureFinished.mock.calls[0][0]).toMatchObject({
      captureId: 'cap-1',
      userId: OWNER,
      workspaceId: WS,
      captureProcessed: false,
    })
  })

  it('the minted token acts as the owner in the capture’s workspace', async () => {
    fake.seed('captures', [capture()])
    let seen: Row | undefined
    fetchMock.mockImplementationOnce(async () => {
      expect(fake.rows('captures')[0].ended_at).not.toBeNull()
      seen = { ...fake.rows('device_token')[0] }
      return { ok: true, status: 200, text: async () => '' }
    })
    await finalize({ event: finalizeEvent, step: createStepMock() })
    expect(seen).toMatchObject({ user_id: OWNER, active_workspace_id: WS })
    expect(Date.parse(seen!.expires_at as string)).toBeGreaterThan(Date.now())
  })

  it('a record written live: no batch; the index closes the record (captureProcessed)', async () => {
    fake.seed('captures', [capture({ live_mode: true, ai_summary: '## Summary\nUAT stays on the 14th.' })])
    const out = await finalize({ event: finalizeEvent, step: createStepMock() })
    expect(out).toEqual({ status: 'finalized', batch: 'none' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(hoisted.order).toEqual(['title', 'index'])
    expect(hoisted.indexCaptureFinished.mock.calls[0][0]).toMatchObject({ captureProcessed: true })
  })

  it('an edition that names a batch persona runs the batch even over a live record, as Stop does', async () => {
    fake = makeFakeSupabase()
    fake.seed('member', [{ id: 'm-1', user_id: OWNER, workspace_id: WS }])
    fake.seed('workspace', [{ id: WS, settings: { edition: 'sales' } }])
    fake.seed('captures', [capture({ live_mode: true, ai_summary: '## Summary\nPricing agreed.' })])
    expect(await finalize({ event: finalizeEvent, step: createStepMock() })).toEqual({ status: 'finalized', batch: 'completed' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does nothing past the close when the close does not take (the recorder came back)', async () => {
    fake.seed('captures', [capture({ updated_at: ago(2 * MIN) })])
    const step = createStepMock()
    expect(await finalize({ event: finalizeEvent, step })).toEqual({ status: 'skipped' })
    expect(fake.rows('captures')[0].ended_at).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(fake.rows('device_token')).toEqual([])
    expect(hoisted.order).toEqual([])
  })

  it('a usage wall or refusal never retries, and the token is still deleted', async () => {
    fake.seed('captures', [capture()])
    fetchMock.mockResolvedValue({ ok: false, status: 429, text: async () => 'Usage limit reached' })
    await expect(finalize({ event: finalizeEvent, step: createStepMock() })).rejects.toBeInstanceOf(NonRetriableError)
    expect(fake.rows('device_token')).toEqual([])
    expect(hoisted.order).toEqual([])
  })

  it('a server error throws for a retry (never a NonRetriableError), token deleted', async () => {
    fake.seed('captures', [capture()])
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => 'Live agent processing failed' })
    const err = await finalize({ event: finalizeEvent, step: createStepMock() }).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(NonRetriableError)
    expect(fake.rows('device_token')).toEqual([])
  })

  it('a batch still running past the wait: waits for it to settle, then post-work only once it stamped', async () => {
    fake.seed('captures', [capture()])
    fetchMock.mockRejectedValue(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
    const step = createStepMock({
      sleep: async () => {
        fake.rows('captures')[0].batch_processed_at = new Date().toISOString()
      },
    })
    expect(await finalize({ event: finalizeEvent, step })).toEqual({ status: 'finalized', batch: 'in_flight' })
    expect(step.sleep).toHaveBeenCalledWith('let-batch-settle', '11m')
    expect(hoisted.order).toEqual(['title', 'index'])
    expect(fake.rows('device_token')).toEqual([])
  })

  it('a batch that never stamped leaves the capture closed for Reprocess, with no post-work', async () => {
    fake.seed('captures', [capture()])
    fetchMock.mockRejectedValue(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
    expect(await finalize({ event: finalizeEvent, step: createStepMock() })).toEqual({ status: 'closed', batch: 'in_flight' })
    expect(hoisted.order).toEqual([])
  })

  it('a title failure never skips the index', async () => {
    fake.seed('captures', [capture()])
    hoisted.generateCaptureTitle.mockRejectedValue(new Error('[utility] generate_title session failed'))
    await finalize({ event: finalizeEvent, step: createStepMock() })
    expect(hoisted.order).toEqual(['title', 'index'])
  })

  it('an index failure never fails the step (a retry would emit capture.processed again)', async () => {
    fake.seed('captures', [capture({ live_mode: true, ai_summary: '## Summary\nUAT stays on the 14th.' })])
    hoisted.indexCaptureFinished.mockRejectedValue(new Error('embedding provider unavailable'))
    const step = createStepMock()
    expect(await finalize({ event: finalizeEvent, step })).toEqual({ status: 'finalized', batch: 'none' })
    expect(hoisted.indexCaptureFinished).toHaveBeenCalledTimes(1)
  })
})

describe('finalize-abandoned-capture — a capture its owner declined to resume', () => {
  const declinedEvent = { data: { capture_id: 'cap-1', workspace_id: WS, reason: 'recovery_declined' } }
  const declined = (over: Row = {}) =>
    capture({
      // Declined two minutes after it died: never quiet for an hour.
      updated_at: ago(2 * MIN),
      ended_at: ago(2 * MIN),
      ai_processed: true,
      metadata: { capture_mode: 'desktop_dual', finalized: { by: 'owner', reason: 'recovery_declined', at: ago(MIN) } },
      ...over,
    })

  it('skips the close (the decline route closed it) and runs the batch as the owner', async () => {
    const endedAt = ago(2 * MIN)
    fake.seed('captures', [declined({ ended_at: endedAt })])
    const step = createStepMock()
    expect(await finalize({ event: declinedEvent, step })).toEqual({ status: 'finalized', batch: 'completed' })
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ capture_id: 'cap-1', mode: 'batch', allow_auto_archive: false })
    const [row] = fake.rows('captures')
    expect(row.ended_at).toBe(endedAt)
    expect(hoisted.order).toEqual(['title', 'index'])
    expect(fake.rows('device_token')).toEqual([])
  })

  it('a declined live record is closed through the index, no batch', async () => {
    fake.seed('captures', [declined({ live_mode: true, ai_summary: '## Summary\nUAT stays on the 14th.' })])
    const step = createStepMock()
    expect(await finalize({ event: declinedEvent, step })).toEqual({ status: 'finalized', batch: 'none' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(hoisted.indexCaptureFinished.mock.calls[0][0]).toMatchObject({ captureProcessed: true })
  })

  it('does nothing for a capture Stop or the sweep closed, one already processed, or one still open', async () => {
    for (const row of [
      declined({ metadata: { capture_mode: 'desktop_dual' } }),
      declined({ metadata: { finalized: { by: 'server', reason: 'recorder_quiet' } } }),
      declined({ batch_processed_at: ago(MIN) }),
      declined({ ended_at: null }),
    ]) {
      fake = makeFakeSupabase()
      fake.seed('member', [{ id: 'm-1', user_id: OWNER, workspace_id: WS }])
      fake.seed('captures', [row])
      const step = createStepMock()
      expect(await finalize({ event: declinedEvent, step })).toEqual({ status: 'skipped' })
    }
    expect(fetchMock).not.toHaveBeenCalled()
    expect(hoisted.order).toEqual([])
  })

  it('resumed while the batch ran: no title, no index, no Triage on half the meeting', async () => {
    fake.seed('captures', [declined()])
    // The batch finishes after the owner pressed Start on the same meeting,
    // which resumed (reopened) the capture.
    fetchMock.mockImplementation(async () => {
      const row = fake.rows('captures')[0]
      row.batch_processed_at = new Date().toISOString()
      row.ended_at = null
      return { ok: true, status: 200, text: async () => '', json: async () => ({ ok: true }) }
    })
    const step = createStepMock()
    expect(await finalize({ event: declinedEvent, step })).toEqual({ status: 'reopened', batch: 'completed' })
    expect(hoisted.order).toEqual([])
  })

  it('a declined live record resumed before its close-out is left to the live session', async () => {
    fake.seed('captures', [declined({ live_mode: true, ai_summary: '## Summary\nUAT stays on the 14th.' })])
    const step = createStepMock({
      run: async (id: string, fn: () => unknown) => {
        // Resumed between the close step and the close-out.
        if (id === 'check-reopened') fake.rows('captures')[0].ended_at = null
        return fn()
      },
    })
    expect(await finalize({ event: declinedEvent, step })).toEqual({ status: 'reopened' })
    expect(hoisted.indexCaptureFinished).not.toHaveBeenCalled()
  })

  it('an event with no reason is the sweep’s: a two-minute-quiet capture is never closed by it', async () => {
    fake.seed('captures', [capture({ updated_at: ago(2 * MIN) })])
    const step = createStepMock()
    expect(await finalize({ event: finalizeEvent, step })).toEqual({ status: 'skipped' })
    expect(fake.rows('captures')[0].ended_at).toBeNull()
  })
})
