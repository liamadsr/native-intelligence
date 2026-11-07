/**
 * reach/route.requested → the router's run (src/lib/inngest/reach-route.ts),
 * via the createFunction-capture pattern. Pinned: the config (debounced 2 min
 * per conversation with a 5 min cap, one run per person, a newer request for
 * the thread cancels a sleeping run, two retries); the loop (a banner sleeps
 * 10 min and looks again, at most 12 times; quiet hours sleep until the
 * release; a send plans again; a round that claimed nothing stops); the kill
 * switch reaches the plan; step outputs and the log line carry ids only.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { createStepMock } from '@/test/inngest-step-mock'

type Handler = (ctx: { event: { data: unknown }; step: ReturnType<typeof createStepMock> }) => Promise<unknown>

const hoisted = vi.hoisted(() => ({
  handler: null as unknown as Handler,
  config: null as unknown as Record<string, unknown>,
}))

vi.mock('@/lib/inngest/client', () => ({
  inngest: {
    createFunction: (config: Record<string, unknown>, fn: Handler) => {
      hoisted.handler = fn
      hoisted.config = config
      return { id: config.id }
    },
    send: vi.fn(),
  },
}))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({ db: true }) }))

const route = vi.hoisted(() => ({ planRoute: vi.fn() }))
vi.mock('@/lib/reach/route', async () => {
  const actual = await vi.importActual<typeof import('@/lib/reach/route')>('@/lib/reach/route')
  return { ...actual, planRoute: route.planRoute, liveRouteDeps: () => ({ live: true }) }
})

import { REACH_ROUTE_MAX_ROUNDS } from '../reach-route'

const DATA = {
  userId: '22222222-2222-4222-8222-222222222222',
  workspaceId: '33333333-3333-4333-8333-333333333333',
  conversationId: '11111111-1111-4111-8111-111111111111',
}

describe('reachRoute', () => {
  let info: MockInstance<typeof console.info>
  const lines = () => info.mock.calls.map(([l]) => String(l))
  beforeEach(() => {
    route.planRoute.mockReset()
    info = vi.spyOn(console, 'info').mockImplementation(() => {})
    delete process.env.REACH_ROUTE_LIVE
  })
  afterEach(() => {
    info.mockRestore()
    delete process.env.REACH_ROUTE_LIVE
  })

  it('debounced 2 min per conversation (capped at 5), one run per person, cancelled by a newer request for the thread, two retries', () => {
    expect(hoisted.config).toMatchObject({
      id: 'reach-route',
      retries: 2,
      debounce: { key: 'event.data.conversationId', period: '2m', timeout: '5m' },
      concurrency: [{ limit: 1, key: 'event.data.userId' }],
      cancelOn: [{ event: 'reach/route.requested', match: 'data.conversationId' }],
      triggers: [{ event: 'reach/route.requested' }],
    })
  })

  it('a malformed event stops before any step', async () => {
    const step = createStepMock()
    expect(await hoisted.handler({ event: { data: { userId: 'x' } }, step })).toEqual({ status: 'skipped', reason: 'bad_event' })
    expect(step.run).not.toHaveBeenCalled()
    expect(lines()).toEqual([expect.stringContaining('outcome=bad_event')])
  })

  it('sent, then planned again until nothing is left', async () => {
    route.planRoute
      .mockResolvedValueOnce({ kind: 'sent', channel: 'sms', sent: 2, failed: 0, skipped: 0, urgent: false, rowIds: ['a', 'b'] })
      .mockResolvedValueOnce({ kind: 'done', outcome: 'nothing', rows: 0 })
    const step = createStepMock()
    expect(await hoisted.handler({ event: { data: DATA }, step })).toEqual({ status: 'done', outcome: 'nothing', sent: 2, rounds: 2, channel: 'sms' })
    expect(step.run.mock.calls.map(([id]) => id)).toEqual(['plan-0', 'plan-1'])
    expect(route.planRoute).toHaveBeenCalledWith(DATA, { live: true }, { live: true, settle: false })
    expect(step.sleep).not.toHaveBeenCalled()
    expect(lines()).toEqual([`[reach-route] user=${DATA.userId} conversation=${DATA.conversationId} rounds=2 outcome=nothing sent=2 channel=sms`])
  })

  it('present: a banner, then a recheck every 10 minutes; seen meanwhile stops it', async () => {
    route.planRoute
      .mockResolvedValueOnce({ kind: 'banner', rows: 1, bannered: true })
      .mockResolvedValueOnce({ kind: 'banner', rows: 1, bannered: false })
      .mockResolvedValueOnce({ kind: 'done', outcome: 'nothing', rows: 0 })
    const step = createStepMock()
    await hoisted.handler({ event: { data: DATA }, step })
    expect(step.run.mock.calls.map(([id]) => id)).toEqual(['plan-0', 'plan-1', 'plan-2'])
    expect(step.sleep.mock.calls).toEqual([
      ['recheck-1', '10m'],
      ['recheck-2', '10m'],
    ])
  })

  it('present but never opened: after 2 hours of rechecks the last look settles (done for good)', async () => {
    route.planRoute.mockImplementation(async (_d: unknown, _deps: unknown, opts: { settle?: boolean }) =>
      opts.settle ? { kind: 'done', outcome: 'present_unread', rows: 1 } : { kind: 'banner', rows: 1, bannered: false },
    )
    const step = createStepMock()
    expect(await hoisted.handler({ event: { data: DATA }, step })).toMatchObject({ outcome: 'present_unread', sent: 0 })
    expect(step.sleep).toHaveBeenCalledTimes(12)
    expect(step.run).toHaveBeenCalledTimes(13)
    // Only the thirteenth look (after 12 sleeps of 10 minutes) settles.
    expect(route.planRoute.mock.calls.map((c) => (c[2] as { settle: boolean }).settle)).toEqual([...Array(12).fill(false), true])
  })

  it('he leaves during the rechecks: the next round texts him', async () => {
    route.planRoute
      .mockResolvedValueOnce({ kind: 'banner', rows: 1, bannered: true })
      .mockResolvedValueOnce({ kind: 'sent', channel: 'sms', sent: 1, failed: 0, skipped: 0, urgent: false, rowIds: ['a'] })
      .mockResolvedValueOnce({ kind: 'done', outcome: 'nothing', rows: 0 })
    expect(await hoisted.handler({ event: { data: DATA }, step: createStepMock() })).toMatchObject({ sent: 1, channel: 'sms' })
  })

  it('quiet hours: sleeps until the release, then sends', async () => {
    const until = Date.parse('2026-10-29T12:05:00.000Z')
    route.planRoute
      .mockResolvedValueOnce({ kind: 'wait', untilMs: until, rows: 2, channel: 'sms' })
      .mockResolvedValueOnce({ kind: 'sent', channel: 'sms', sent: 2, failed: 0, skipped: 0, urgent: false, rowIds: ['a', 'b'] })
      .mockResolvedValueOnce({ kind: 'done', outcome: 'nothing', rows: 0 })
    const step = createStepMock()
    expect(await hoisted.handler({ event: { data: DATA }, step })).toMatchObject({ sent: 2 })
    expect(step.sleepUntil.mock.calls).toEqual([['quiet-1', new Date(until)]])
  })

  it('a round that claimed nothing stops (a ledger that can’t be written never loops), and the rounds are bounded', async () => {
    route.planRoute.mockResolvedValue({ kind: 'sent', channel: 'sms', sent: 0, failed: 0, skipped: 3, urgent: false, rowIds: [] })
    expect(await hoisted.handler({ event: { data: DATA }, step: createStepMock() })).toMatchObject({ outcome: 'stalled', rounds: 1 })
    route.planRoute.mockReset()
    route.planRoute.mockResolvedValue({ kind: 'sent', channel: 'sms', sent: 1, failed: 0, skipped: 0, urgent: false, rowIds: ['a'] })
    expect(await hoisted.handler({ event: { data: DATA }, step: createStepMock() })).toMatchObject({ outcome: 'max_rounds', rounds: REACH_ROUTE_MAX_ROUNDS })
  })

  it('the kill switch reaches the plan, and its log line says what it would have done', async () => {
    process.env.REACH_ROUTE_LIVE = 'off'
    route.planRoute.mockResolvedValueOnce({ kind: 'done', outcome: 'off', rows: 1, would: { action: 'send', channel: 'sms', rows: 1 } })
    await hoisted.handler({ event: { data: DATA }, step: createStepMock() })
    expect(route.planRoute).toHaveBeenCalledWith(DATA, expect.anything(), { live: false, settle: false })
    expect(lines()).toEqual([expect.stringContaining('outcome=off sent=0 channel=- would=send:sms:1')])
  })
})
