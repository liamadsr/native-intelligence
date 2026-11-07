import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createStepMock, type StepMock } from '@/test/inngest-step-mock'

/**
 * Tests for src/lib/inngest/asana-ensure-webhook.ts — the thin Inngest wrapper
 * around the convergence lib. What matters here is the WIRING, since all the
 * logic is tested against ensureAsanaWebhook directly:
 *  - debounce coalesces the settings PATCH and the cron tick into one attempt;
 *  - concurrency 1 per sync state, so two runs can't both "see no gid" and each
 *    create a webhook;
 *  - the lib call happens inside a step (replayable) and the handler makes no
 *    step.* call from within it (house rule).
 */

type Handler = (ctx: {
  event: { data: Record<string, unknown> }
  step: StepMock
}) => Promise<unknown>

const hoisted = vi.hoisted(() => ({
  handler: null as unknown as Handler,
  config: null as unknown as Record<string, unknown>,
  ensureAsanaWebhook: vi.fn(),
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
vi.mock('@/lib/tasks/asana-webhook', () => ({
  ensureAsanaWebhook: hoisted.ensureAsanaWebhook,
}))

await import('@/lib/inngest/asana-ensure-webhook')

/**
 * Shared Inngest step mock — a vi.fn per method plus the house-rule tripwire
 * (step tooling inside a step.run callback throws; it deadlocks in production).
 */
function makeStep(): StepMock {
  return createStepMock()
}

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.ensureAsanaWebhook.mockResolvedValue({ status: 'created', webhookGid: 'wh-1' })
})

describe('asana-ensure-webhook', () => {
  it('debounces and serializes per sync state', () => {
    expect(hoisted.config.id).toBe('asana-ensure-webhook')
    expect(hoisted.config.triggers).toEqual([{ event: 'tasks/asana-ensure-webhook' }])
    expect(hoisted.config.debounce).toEqual({ key: 'event.data.syncStateId', period: '60s' })
    expect(hoisted.config.concurrency).toEqual([
      { limit: 1, key: 'event.data.syncStateId' },
    ])
  })

  it('runs the convergence lib inside a step and returns its status', async () => {
    const step = makeStep()
    const out = await hoisted.handler({ event: { data: { syncStateId: 'tss-1' } }, step })

    expect(hoisted.ensureAsanaWebhook).toHaveBeenCalledWith({ syncStateId: 'tss-1' })
    expect(step.run).toHaveBeenCalledTimes(1)
    expect(out).toEqual({ status: 'created', webhookGid: 'wh-1' })
  })

  it('no-ops on a malformed event rather than calling the lib', async () => {
    const out = await hoisted.handler({ event: { data: {} }, step: makeStep() })
    expect(out).toMatchObject({ status: 'skipped', reason: 'no_sync_state_id' })
    expect(hoisted.ensureAsanaWebhook).not.toHaveBeenCalled()
  })

  it('surfaces a non-creating outcome unchanged (nothing to chain)', async () => {
    hoisted.ensureAsanaWebhook.mockResolvedValue({ status: 'healthy', webhookGid: 'wh-1' })
    const step = makeStep()
    const out = await hoisted.handler({ event: { data: { syncStateId: 'tss-1' } }, step })
    expect(out).toEqual({ status: 'healthy', webhookGid: 'wh-1' })
    expect(step.sendEvent).not.toHaveBeenCalled()
  })
})
