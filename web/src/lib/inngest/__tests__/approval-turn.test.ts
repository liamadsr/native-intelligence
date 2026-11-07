/**
 * home/approval-turn.requested → the agent's turn once the person's yes ran
 * a call it held (445), via the createFunction-capture pattern. Pinned: a
 * debounce of seconds (the person is waiting), one run per conversation, and
 * the same steps as every home turn (runHomeTurn), for the approval reason
 * only.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest'
import { createStepMock } from '@/test/inngest-step-mock'

type Handler = (ctx: { event: { data: Record<string, unknown> }; step: ReturnType<typeof createStepMock> }) => Promise<unknown>

const hoisted = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  configs: new Map<string, Record<string, unknown>>(),
  runHomeTurn: vi.fn(async () => ({ status: 'done' })),
}))

vi.mock('@/lib/inngest/client', () => ({
  inngest: {
    createFunction: (config: Record<string, unknown>, fn: Handler) => {
      hoisted.handlers.set(String(config.id), fn)
      hoisted.configs.set(String(config.id), config)
      return { id: config.id }
    },
    send: vi.fn(),
  },
}))
vi.mock('../home-turn', () => ({ runHomeTurn: hoisted.runHomeTurn }))

import '../approval-turn'

const IDS = {
  conversationId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  workspaceId: '33333333-3333-4333-8333-333333333333',
}

describe('approvalTurn', () => {
  let info: MockInstance<typeof console.info>
  beforeEach(() => {
    hoisted.runHomeTurn.mockClear()
    info = vi.spyOn(console, 'info').mockImplementation(() => {})
  })
  afterEach(() => info.mockRestore())

  it('is debounced seconds per conversation (the person just approved), one run per conversation, on its own event', () => {
    expect(hoisted.configs.get('approval-turn')).toMatchObject({
      id: 'approval-turn',
      retries: 2,
      debounce: { key: 'event.data.conversationId', period: '5s', timeout: '30s' },
      concurrency: [{ limit: 1, key: 'event.data.conversationId' }],
      triggers: [{ event: 'home/approval-turn.requested' }],
    })
  })

  it('runs the home turn’s steps for the approval reason', async () => {
    const step = createStepMock()
    const event = { data: { ...IDS, workItemIds: [], reason: 'approval' } }
    expect(await hoisted.handlers.get('approval-turn')!({ event, step })).toEqual({ status: 'done' })
    expect(hoisted.runHomeTurn).toHaveBeenCalledWith({ event, step })
  })

  it('any other reason on its event stops before any step', async () => {
    const step = createStepMock()
    for (const reason of ['helper_report', 'event', 'text', undefined]) {
      const out = await hoisted.handlers.get('approval-turn')!({ event: { data: { ...IDS, workItemIds: [], reason } }, step })
      expect(out).toEqual({ status: 'skipped', reason: 'unsupported_reason' })
    }
    expect(hoisted.runHomeTurn).not.toHaveBeenCalled()
    expect(step.run).not.toHaveBeenCalled()
  })
})
