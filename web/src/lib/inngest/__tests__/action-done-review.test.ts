import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createStepMock } from '@/test/inngest-step-mock'

/**
 * actionDoneSettlesReview: a PERSON marking an action Done by hand (PATCH
 * toggle_complete / status_id, or complete_action / update_action on their
 * word) settles the review of every job that worked it. It rides the shared
 * `flow/entity.status_changed` event, the one place both paths pass through.
 */

type Handler = (ctx: { event: { data: Record<string, unknown> }; step: ReturnType<typeof createStepMock> }) => Promise<unknown>

const hoisted = vi.hoisted(() => ({
  handler: null as unknown as Handler,
  config: null as unknown as Record<string, unknown>,
  resolve: vi.fn(async (..._a: unknown[]) => ['job-1']),
  category: 'completed' as string | null,
}))

vi.mock('@/lib/inngest/client', () => ({
  inngest: {
    createFunction: (config: Record<string, unknown>, fn: Handler) => {
      hoisted.config = config
      hoisted.handler = fn
      return { id: config.id }
    },
  },
}))
vi.mock('@/lib/admin', () => ({
  getServiceClient: () => ({
    from: () => {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.maybeSingle = async () => ({ data: hoisted.category ? { category: hoisted.category } : null, error: null })
      return b
    },
  }),
}))
vi.mock('@/lib/work/resolve', () => ({ resolveWorkForAction: hoisted.resolve }))

await import('../action-done-review')

const event = (over: Record<string, unknown> = {}) => ({
  data: { entity_type: 'action', entity_id: 'act-1', workspace_id: 'ws-1', to_status_id: 'st-done', origin: { actor: 'user', depth: 0 }, ...over },
})

beforeEach(() => {
  hoisted.resolve.mockClear()
  hoisted.category = 'completed'
})

describe('actionDoneSettlesReview', () => {
  it('rides the shared status-change event', () => {
    expect(hoisted.config.triggers).toEqual([{ event: 'flow/entity.status_changed' }])
  })

  it('a person moving the action into Done settles its jobs’ reviews', async () => {
    const out = await hoisted.handler({ event: event(), step: createStepMock() })
    expect(out).toEqual({ status: 'done', settled: ['job-1'] })
    expect(hoisted.resolve).toHaveBeenCalledWith(expect.anything(), { actionId: 'act-1', workspaceId: 'ws-1' })
  })

  it('an event from before the loop guard (no origin) is a person’s', async () => {
    await hoisted.handler({ event: event({ origin: undefined }), step: createStepMock() })
    expect(hoisted.resolve).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['an agent’s move', { origin: { actor: 'agent', depth: 1 } }, 'not_a_person'],
    ['a loop’s move', { origin: { actor: 'loop', depth: 1 } }, 'not_a_person'],
    ['a project', { entity_type: 'project' }, 'not_an_action'],
  ])('skips %s', async (_label, over, reason) => {
    const out = await hoisted.handler({ event: event(over), step: createStepMock() })
    expect(out).toEqual({ status: 'skipped', reason })
    expect(hoisted.resolve).not.toHaveBeenCalled()
  })

  it('skips a move into a state that is not Done', async () => {
    hoisted.category = 'started'
    const out = await hoisted.handler({ event: event(), step: createStepMock() })
    expect(out).toEqual({ status: 'skipped', reason: 'not_done' })
    expect(hoisted.resolve).not.toHaveBeenCalled()
  })
})
