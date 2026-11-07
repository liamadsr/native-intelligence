/**
 * Outreach's background functions (roadmap D2/D3): the review request
 * follows the job-done event (one constant to point at "job paid" later),
 * and the rolling campaigns' weekly pass skips a paused workspace.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createStepMock } from '@/test/inngest-step-mock'

const hoisted = vi.hoisted(() => ({
  fns: new Map<string, { config: Record<string, unknown>; handler: (ctx: unknown) => Promise<unknown> }>(),
  sendReviewRequest: vi.fn(),
  refreshRollingCampaign: vi.fn(),
  isAgentPaused: vi.fn(),
  campaigns: [] as Array<Record<string, unknown>>,
}))

vi.mock('../client', () => ({
  inngest: {
    createFunction: (config: Record<string, unknown>, handler: (ctx: unknown) => Promise<unknown>) => {
      hoisted.fns.set(config.id as string, { config, handler })
      return { config }
    },
  },
}))
vi.mock('@/lib/admin', () => ({
  getServiceClient: () => ({
    from: () => {
      const chain: Record<string, unknown> = {}
      Object.assign(chain, {
        select: () => chain,
        eq: () => chain,
        not: () => chain,
        order: () => chain,
        range: async () => ({ data: hoisted.campaigns, error: null }),
      })
      return chain
    },
  }),
}))
vi.mock('@/lib/reviews/request', () => ({ sendReviewRequest: hoisted.sendReviewRequest }))
vi.mock('@/lib/campaigns/launch', () => ({ CAMPAIGN_LAUNCH_COLUMNS: '*', refreshRollingCampaign: hoisted.refreshRollingCampaign }))
vi.mock('@/lib/work/agent-paused', () => ({ isAgentPaused: hoisted.isAgentPaused }))

const { REVIEW_REQUEST_TRIGGER } = await import('../outreach-functions')
const { JOB_COMPLETED_EVENT } = await import('@/lib/jobs/events')

beforeEach(() => {
  hoisted.sendReviewRequest.mockReset().mockResolvedValue({ outcome: 'sent', channel: 'email', recipient: 'ana@example.com' })
  hoisted.refreshRollingCampaign.mockReset().mockResolvedValue({ outcome: 'card' })
  hoisted.isAgentPaused.mockReset().mockResolvedValue(false)
})

describe('review-request-on-job', () => {
  const fn = () => hoisted.fns.get('review-request-on-job')!

  it('follows the job-done event (point REVIEW_REQUEST_TRIGGER at job/paid to switch)', () => {
    expect(REVIEW_REQUEST_TRIGGER).toBe(JOB_COMPLETED_EVENT)
    expect(fn().config.triggers).toEqual([{ event: 'job/completed' }])
  })

  it('sends the review request for the job in one step', async () => {
    const step = createStepMock()
    const data = { workspaceId: 'ws-1', contactId: 'c-ana', jobRef: { type: 'booking', id: 'b-7' }, completedAt: '2026-11-04T18:00:00Z', reason: 'done' }
    expect(await fn().handler({ event: { data }, step })).toMatchObject({ outcome: 'sent' })
    expect(hoisted.sendReviewRequest).toHaveBeenCalledWith(expect.anything(), { workspaceId: 'ws-1', contactId: 'c-ana', jobRef: { type: 'booking', id: 'b-7' } })
  })

  it("takes track C's paid payment link as sent (reason paid, its own fields), and an early sender's `job`", async () => {
    const step = createStepMock()
    const paid = { workspaceId: 'ws-1', contactId: 'c-ana', jobRef: { type: 'quote', id: 'q-3' }, completedAt: '2026-11-05T10:00:00Z', reason: 'paid', paymentRequestId: 'pr-1' }
    await fn().handler({ event: { data: paid }, step })
    expect(hoisted.sendReviewRequest).toHaveBeenLastCalledWith(expect.anything(), { workspaceId: 'ws-1', contactId: 'c-ana', jobRef: { type: 'quote', id: 'q-3' } })
    await fn().handler({ event: { data: { workspaceId: 'ws-1', contactId: 'c-ana', job: { type: 'action', id: 'a-1' } } }, step })
    expect(hoisted.sendReviewRequest).toHaveBeenLastCalledWith(expect.anything(), { workspaceId: 'ws-1', contactId: 'c-ana', jobRef: { type: 'action', id: 'a-1' } })
  })

  it('asks nobody for a payment with no customer', async () => {
    const step = createStepMock()
    const data = { workspaceId: 'ws-1', contactId: null, jobRef: { type: 'payment_request', id: 'pr-2' }, completedAt: '2026-11-05T10:00:00Z', reason: 'paid' }
    expect(await fn().handler({ event: { data }, step })).toEqual({ outcome: 'no_contact' })
    expect(hoisted.sendReviewRequest).not.toHaveBeenCalled()
  })

  it('ignores an event missing its job', async () => {
    const step = createStepMock()
    expect(await fn().handler({ event: { data: { workspaceId: 'ws-1', contactId: 'c-ana' } }, step })).toEqual({ outcome: 'invalid_event' })
    expect(await fn().handler({ event: { data: { workspaceId: 'ws-1', contactId: 'c-ana', jobRef: { type: 'invoice', id: 'x' } } }, step })).toEqual({ outcome: 'invalid_event' })
    expect(hoisted.sendReviewRequest).not.toHaveBeenCalled()
  })
})

describe('campaign-rolling-pass', () => {
  const fn = () => hoisted.fns.get('campaign-rolling-pass')!

  it('runs Monday mornings, Pacific', () => {
    expect(fn().config.triggers).toEqual([{ cron: 'TZ=America/Los_Angeles 0 9 * * 1' }])
  })

  it('refreshes each rolling campaign, skipping a workspace whose agent is paused', async () => {
    hoisted.campaigns = [
      { id: 'camp-1', workspace_id: 'ws-1' },
      { id: 'camp-2', workspace_id: 'ws-paused' },
    ]
    hoisted.isAgentPaused.mockImplementation(async (_s: unknown, ws: string) => ws === 'ws-paused')
    const out = await fn().handler({ step: createStepMock() })
    expect(out).toEqual({ campaigns: 2, outcomes: { card: 1, paused: 1 } })
    expect(hoisted.refreshRollingCampaign).toHaveBeenCalledTimes(1)
    expect((hoisted.refreshRollingCampaign.mock.calls[0] as unknown[])[1]).toMatchObject({ id: 'camp-1' })
  })
})
