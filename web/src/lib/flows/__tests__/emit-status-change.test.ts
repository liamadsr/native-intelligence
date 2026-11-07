/**
 * Tests for src/lib/flows/emit-status-change.ts — the single emit point every
 * status writer funnels through (GEN-112), now carrying the ORIGIN the flow
 * dispatcher's loop guard reads (precondition A3,
 * docs/plans/agent-orchestration-investigation.md §2.2).
 *
 * Contract: a writer that says nothing about who it is emits a PERSON at depth
 * 0; an unattended run passes its own origin and it rides the event verbatim.
 * The existing guards (no team, unchanged status) still swallow the emit.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const hoisted = vi.hoisted(() => ({
  send: vi.fn(async (_event: unknown) => ({ ids: ['evt-1'] })),
}))

vi.mock('@/lib/inngest/client', () => ({
  inngest: { send: hoisted.send },
}))

const { emitStatusChange, USER_STATUS_CHANGE_ORIGIN } = await import('@/lib/flows/emit-status-change')

const BASE = {
  entityType: 'action' as const,
  entityId: 'act-1',
  workspaceId: 'ws-1',
  teamId: 'team-1',
  fromStatusId: 'todo',
  toStatusId: 'in_progress',
  actorUserId: 'user-1',
}

beforeEach(() => {
  hoisted.send.mockClear()
})

describe('emitStatusChange origin', () => {
  it('a writer with no origin emits a person at depth 0', () => {
    emitStatusChange(BASE)
    expect(hoisted.send).toHaveBeenCalledTimes(1)
    const evt = hoisted.send.mock.calls[0][0] as { name: string; data: Record<string, unknown> }
    expect(evt.name).toBe('flow/entity.status_changed')
    expect(evt.data.origin).toEqual({ actor: 'user', depth: 0 })
    expect(USER_STATUS_CHANGE_ORIGIN).toEqual({ actor: 'user', depth: 0 })
    expect(evt.data.actor_user_id).toBe('user-1')
  })

  it("an unattended run's origin rides the event verbatim", () => {
    emitStatusChange({ ...BASE, origin: { actor: 'agent', depth: 1, run_id: 'run-9' } })
    const evt = hoisted.send.mock.calls[0][0] as { data: Record<string, unknown> }
    expect(evt.data.origin).toEqual({ actor: 'agent', depth: 1, run_id: 'run-9' })
  })

  it('still guards: no team or an unchanged status never emits', () => {
    emitStatusChange({ ...BASE, teamId: null, origin: { actor: 'agent', depth: 1 } })
    emitStatusChange({ ...BASE, fromStatusId: 'in_progress', toStatusId: 'in_progress' })
    expect(hoisted.send).not.toHaveBeenCalled()
  })

  it('is fire-and-forget: a send failure never reaches the caller', async () => {
    hoisted.send.mockRejectedValueOnce(new Error('inngest down'))
    expect(() => emitStatusChange(BASE)).not.toThrow()
    await Promise.resolve()
  })
})
