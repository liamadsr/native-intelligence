import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createStepMock, type StepMock } from '@/test/inngest-step-mock'

/**
 * Tests for src/lib/inngest/jira-ensure-webhook.ts — the thin Inngest wrapper
 * around the convergence lib. What matters here is the WIRING, since all the
 * logic is tested against ensureJiraWebhook directly:
 *  - debounce coalesces the settings PATCH and the cron tick into one attempt.
 *    It matters more than it does for Asana: Atlassian allows only FIVE webhooks
 *    per app per user per site, so two racing creates burn two of them;
 *  - concurrency 1 per sync state, for the same reason;
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
  ensureJiraWebhook: vi.fn(),
  retireJiraWebhook: vi.fn(),
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
vi.mock('@/lib/tasks/jira-webhook', () => ({
  ensureJiraWebhook: hoisted.ensureJiraWebhook,
  retireJiraWebhook: hoisted.retireJiraWebhook,
}))

await import('@/lib/inngest/jira-ensure-webhook')

/**
 * Shared Inngest step mock — a vi.fn per method plus the house-rule tripwire
 * (step tooling inside a step.run callback throws; it deadlocks in production).
 */
function makeStep(): StepMock {
  return createStepMock()
}

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.ensureJiraWebhook.mockResolvedValue({ status: 'created', webhookId: '6000' })
  hoisted.retireJiraWebhook.mockResolvedValue({ status: 'retired' })
})

describe('jira-ensure-webhook', () => {
  it('debounces and serializes per sync state', () => {
    expect(hoisted.config.id).toBe('jira-ensure-webhook')
    expect(hoisted.config.triggers).toEqual([{ event: 'tasks/jira-ensure-webhook' }])
    expect(hoisted.config.debounce).toEqual({ key: 'event.data.syncStateId', period: '60s' })
    expect(hoisted.config.concurrency).toEqual([
      { limit: 1, key: 'event.data.syncStateId' },
    ])
  })

  it('runs the convergence lib inside a step and returns its status', async () => {
    const step = makeStep()
    const out = await hoisted.handler({ event: { data: { syncStateId: 'tss-1' } }, step })

    expect(hoisted.ensureJiraWebhook).toHaveBeenCalledWith({ syncStateId: 'tss-1' })
    expect(step.run).toHaveBeenCalledTimes(1)
    expect(out).toEqual({ status: 'created', webhookId: '6000', retired: null })
    // No retirement was asked for, so none was attempted.
    expect(hoisted.retireJiraWebhook).not.toHaveBeenCalled()
  })

  /**
   * REGRESSION (review finding: "changing the Jira site is accepted as a no-op —
   * webhook left on the old site"). A registration can only be deleted through
   * the site it lives on, so once the config's cloudId has moved, the
   * convergence pass cannot clean up after itself: it would issue the DELETE
   * against the NEW tenant and leave the old site delivering — and holding one
   * of its five per-app/user/site slots — for up to 30 days.
   */
  it('retires the OLD site\u2019s registration in a SECOND step, after converging', async () => {
    const step = makeStep()
    const out = await hoisted.handler({
      event: {
        data: {
          syncStateId: 'tss-1',
          retireWebhook: { webhookId: '5000', cloudId: 'cafe0002' },
        },
      },
      step,
    })

    expect(hoisted.retireJiraWebhook).toHaveBeenCalledWith({
      syncStateId: 'tss-1',
      webhookId: '5000',
      cloudId: 'cafe0002',
    })
    // Create-before-delete: two flat steps, convergence first.
    expect(step.run).toHaveBeenCalledTimes(2)
    expect((step.run.mock.calls[0] as unknown as [string])[0]).toBe('ensure-webhook')
    expect((step.run.mock.calls[1] as unknown as [string])[0]).toBe(
      'retire-previous-site-webhook',
    )
    expect(out).toEqual({ status: 'created', webhookId: '6000', retired: 'retired' })
  })

  it('ignores a half-specified retirement (an id with no site cannot be deleted)', async () => {
    await hoisted.handler({
      event: { data: { syncStateId: 'tss-1', retireWebhook: { webhookId: '5000' } } },
      step: makeStep(),
    })
    expect(hoisted.retireJiraWebhook).not.toHaveBeenCalled()
  })

  it('no-ops on a malformed event rather than calling the lib', async () => {
    const out = await hoisted.handler({ event: { data: {} }, step: makeStep() })
    expect(out).toMatchObject({ status: 'skipped', reason: 'no_sync_state_id' })
    expect(hoisted.ensureJiraWebhook).not.toHaveBeenCalled()
  })

  it('surfaces a non-creating outcome unchanged (nothing to chain)', async () => {
    hoisted.ensureJiraWebhook.mockResolvedValue({ status: 'refreshed', webhookId: '5000' })
    const step = makeStep()
    const out = await hoisted.handler({ event: { data: { syncStateId: 'tss-1' } }, step })
    expect(out).toEqual({ status: 'refreshed', webhookId: '5000', retired: null })
    expect(step.sendEvent).not.toHaveBeenCalled()
  })

  it('reports a null id for the outcomes that have none', async () => {
    hoisted.ensureJiraWebhook.mockResolvedValue({ status: 'no_token' })
    const out = await hoisted.handler({ event: { data: { syncStateId: 'tss-1' } }, step: makeStep() })
    expect(out).toEqual({ status: 'no_token', webhookId: null, retired: null })
  })
})
