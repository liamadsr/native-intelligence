/**
 * The look-ahead's runs (src/lib/inngest/look-ahead.ts) hand the text to the
 * router: after the message is written, one `route` event (ids only, keyed on
 * the row) replaces the old `text` step, so the router decides whether he is
 * away, keeps quiet hours and claims it once per person, slot and date.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createStepMock } from '@/test/inngest-step-mock'

type Handler = (ctx: { event: { data: unknown }; step: ReturnType<typeof createStepMock> }) => Promise<unknown>

const hoisted = vi.hoisted(() => ({ handlers: {} as Record<string, Handler> }))

vi.mock('@/lib/inngest/client', () => ({
  inngest: {
    createFunction: (config: { id: string }, fn: Handler) => {
      hoisted.handlers[config.id] = fn
      return { id: config.id }
    },
  },
}))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({ db: true }) }))
vi.mock('@/lib/ai/auth', () => ({ logUsage: vi.fn() }))
vi.mock('@/lib/eve/utility/run-utility', () => ({ runUtilityTask: vi.fn() }))
vi.mock('../usage-guard', () => ({ guardBackgroundUsageOnPlan: vi.fn(async () => ({ chatgptPlan: false })) }))
vi.mock('@/lib/work/agent-paused', () => ({ readAgentPausedState: vi.fn(async () => 'active') }))

const run = vi.hoisted(() => ({
  deliverLookAhead: vi.fn(),
  lookAheadLive: vi.fn(() => true),
  readDepartureLine: vi.fn(),
  travelEvents: vi.fn(() => [] as unknown[]),
}))
vi.mock('@/lib/look-ahead/run', async () => {
  const actual = await vi.importActual<typeof import('@/lib/look-ahead/run')>('@/lib/look-ahead/run')
  return { ...actual, ...run }
})
const message = vi.hoisted(() => ({ writeLookAhead: vi.fn() }))
vi.mock('@/lib/look-ahead/message', async () => {
  const actual = await vi.importActual<typeof import('@/lib/look-ahead/message')>('@/lib/look-ahead/message')
  return { ...actual, ...message }
})

import '../look-ahead'

const BASE = {
  userId: '22222222-2222-4222-8222-222222222222',
  workspaceId: '33333333-3333-4333-8333-333333333333',
  memberId: 'm-1',
  conversationId: '11111111-1111-4111-8111-111111111111',
  timeZone: 'America/New_York',
}
const IDS = { userId: BASE.userId, workspaceId: BASE.workspaceId, conversationId: BASE.conversationId }

describe('look-ahead runs route their text', () => {
  beforeEach(() => {
    run.deliverLookAhead.mockReset()
    run.readDepartureLine.mockReset()
    message.writeLookAhead.mockReset()
    vi.spyOn(console, 'info').mockImplementation(() => {})
  })

  it('the evening run: deliver, then one route event for the row (no text step), then the departures', async () => {
    run.deliverLookAhead.mockResolvedValue({ status: 'sent', rowId: 'row-9', first: true, date: '2026-10-29', departures: [], lines: 2, candidates: 3, bookings: 0, extracted: true })
    const step = createStepMock()
    const out = await hoisted.handlers['look-ahead-run']({ event: { data: { ...BASE, date: '2026-10-28', slot: 'evening' } }, step })
    expect(step.run.mock.calls.map(([id]) => id)).toEqual(['guard', 'deliver'])
    expect(step.sendEvent.mock.calls).toEqual([['route', { name: 'reach/route.requested', data: IDS, id: 'reach-route:look-ahead:row-9' }]])
    expect(out).toEqual({ status: 'sent', lines: 2, routed: true, departures: 0 })
  })

  it('nothing written: nothing routed', async () => {
    run.deliverLookAhead.mockResolvedValue({ status: 'nothing', date: '2026-10-29' })
    const step = createStepMock()
    await hoisted.handlers['look-ahead-run']({ event: { data: { ...BASE, date: '2026-10-28', slot: 'evening' } }, step })
    expect(step.sendEvent).not.toHaveBeenCalled()
  })

  it('a departure’s heads-up: written, then routed (no text step)', async () => {
    run.readDepartureLine.mockResolvedValue({ when: '9:00 am', title: 'Flight', place: null, bring: [], confirmation: null, sortKey: '09:00' })
    message.writeLookAhead.mockResolvedValue({ rowId: 'row-t', first: true })
    const step = createStepMock()
    const out = await hoisted.handlers['look-ahead-travel']({ event: { data: { ...BASE, meetingKey: 'k1', startIso: '2026-10-29T13:00:00.000Z' } }, step })
    expect(step.run.mock.calls.map(([id]) => id)).toEqual(['read', 'write'])
    // The zone rides the write, so the message carries its shelf life (look_ahead_until).
    expect(message.writeLookAhead).toHaveBeenCalledWith({ db: true }, expect.objectContaining({ timeZone: 'America/New_York' }))
    expect(step.sendEvent.mock.calls).toEqual([['route', { name: 'reach/route.requested', data: IDS, id: 'reach-route:look-ahead:row-t' }]])
    expect(out).toEqual({ status: 'sent', first: true, routed: true })
  })
})
