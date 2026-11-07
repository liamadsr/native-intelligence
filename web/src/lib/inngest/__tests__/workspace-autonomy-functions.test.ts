/**
 * workspaceAutonomyOff — the kill switch's Inngest function: a durable step
 * that sweeps the workspace's in-flight work runs through
 * cancelInFlightWorkRuns, then (A5 slice 5) one that stops what else the
 * switch covers: loop sessions and pending approvals.
 */
import { describe, it, expect, vi } from 'vitest'

const h = vi.hoisted(() => ({
  handlers: {} as Record<string, unknown>,
  cancelInFlightWorkRuns: vi.fn(async () => ({ requested: ['r-1'], skipped: [] })),
  serviceClient: { from: vi.fn() },
  stopPausedWorkspaceExtras: vi.fn(async () => ({ loopSessions: 'refused_at_next_tool_call', approvals: 'expired' })),
}))

vi.mock('@/lib/inngest/client', () => ({
  inngest: {
    createFunction: (config: { id: string; triggers: Array<{ event: string }> }, handler: unknown) => {
      h.handlers[config.id] = handler
      return { id: config.id, triggers: config.triggers }
    },
  },
}))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => h.serviceClient }))
vi.mock('@/lib/agent-run/cancel-workspace-runs', () => ({
  cancelInFlightWorkRuns: h.cancelInFlightWorkRuns,
  WORKSPACE_AUTONOMY_OFF_EVENT: 'workspace/autonomy.off',
}))

vi.mock('@/lib/work/agent-paused', () => ({ stopPausedWorkspaceExtras: h.stopPausedWorkspaceExtras }))

const { workspaceAutonomyOff } = await import('../workspace-autonomy-functions')

describe('workspaceAutonomyOff', () => {
  it('listens on workspace/autonomy.off, sweeps work runs, then stops loops and approvals', async () => {
    expect((workspaceAutonomyOff as unknown as { triggers: Array<{ event: string }> }).triggers).toEqual([
      { event: 'workspace/autonomy.off' },
    ])
    const step = { run: vi.fn(async (_id: string, fn: () => Promise<unknown>) => fn()) }
    const handler = h.handlers['workspace-autonomy-off'] as (arg: { event: unknown; step: unknown }) => Promise<unknown>
    const out = await handler({
      event: { name: 'workspace/autonomy.off', data: { workspace_id: 'ws-1', reason: 'off', origins: ['attempt'] } },
      step,
    })
    expect(step.run.mock.calls[0][0]).toBe('cancel-in-flight-work-runs')
    expect(h.cancelInFlightWorkRuns).toHaveBeenCalledWith(h.serviceClient, {
      workspaceId: 'ws-1',
      reason: 'off',
      origins: ['attempt'],
    })
    expect(step.run.mock.calls[1][0]).toBe('stop-loops-and-approvals')
    expect(h.stopPausedWorkspaceExtras).toHaveBeenCalledWith(h.serviceClient, 'ws-1')
    expect(out).toEqual({ requested: ['r-1'], skipped: [], loopSessions: 'refused_at_next_tool_call', approvals: 'expired' })
  })
})
