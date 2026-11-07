/**
 * PATCH /api/account/actions/[id] refuses a work bot as the assignee (bots-v3
 * Phase 3): a bot made for a loop (`ai_team_member.fronts_only`) speaks for
 * work and takes none, exactly as a system teammate. A full teammate still
 * assigns.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { buildRequest } from '@/test/integration'

const hoisted = vi.hoisted(() => ({
  requireWorkspaceMember: vi.fn(),
  actionsUpdate: vi.fn(),
  seatInserts: [] as unknown[],
  held: [] as Array<{ member_id: string }>,
  teammates: [] as Array<{ id: string; workspace_id: string; is_system: boolean; fronts_only: boolean; team_id?: string }>,
}))

vi.mock('@/lib/posthog', () => ({ trackServerEvent: vi.fn() }))
vi.mock('@/lib/api-auth', () => ({
  requireWorkspace: vi.fn(),
  requireWorkspaceMember: hoisted.requireWorkspaceMember,
}))
vi.mock('@/lib/notifications', () => ({ createNotification: vi.fn() }))
vi.mock('@/lib/flows/emit-status-change', () => ({ emitStatusChange: vi.fn() }))

function chainProxy(result: unknown) {
  const proxy: Record<string, unknown> = {
    then: (cb: (v: unknown) => unknown) => Promise.resolve(result).then(cb),
  }
  return new Proxy(proxy, {
    get(target, prop: string) {
      if (prop in target) return target[prop]
      if (prop === 'single' || prop === 'maybeSingle') return () => Promise.resolve(result)
      return () => new Proxy(proxy, this)
    },
  }) as unknown
}

function makeActionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'action-1',
    identifier: 'GEN-42',
    title: 'Original title',
    description: null,
    status_id: 'state-1',
    team_id: 'team-1',
    confirmation: 'confirmed',
    ai_confidence: null,
    auto_accepted: false,
    priority: 'none',
    due_at: null,
    all_day: true,
    links: null,
    assignee_id: null,
    parent_id: null,
    estimate: null,
    project_id: null,
    milestone_id: null,
    cycle_id: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    workflow_state: { id: 'state-1', name: 'Todo', category: 'unstarted', color: '#888' },
    labels: [],
    assignee: null,
    assignees: [],
    project: null,
    milestone: null,
    cycle: null,
    ...overrides,
  }
}

function makeFakeSupabase(actionRowOverride: Record<string, unknown> = {}) {
  const actionRow = makeActionRow(actionRowOverride)
  let actionsCallIndex = 0

  return {
    from: (table: string) => {
      if (table === 'member') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                single: async () => ({
                  data: { id: 'member-1', display_name: 'Alice' },
                  error: null,
                }),
              }),
              // Assignee fence: members of this workspace among the ids asked for.
              in: async (_col: string, ids: string[]) => ({
                data: ids.filter((mid) => ['member-1', 'member-2', 'member-3'].includes(mid)).map((id) => ({ id })),
                error: null,
              }),
            }),
          }),
        }
      }

      if (table === 'ai_team_member') {
        const eqs: Record<string, unknown> = {}
        const b: Record<string, unknown> = {
          select: () => b,
          eq: (col: string, val: unknown) => ((eqs[col] = val), b),
          maybeSingle: async () => {
            const row = hoisted.teammates.find(
              (t) => t.id === eqs.id && t.workspace_id === eqs.workspace_id && (eqs.is_system === undefined || t.is_system === eqs.is_system),
            )
            return { data: row ? { ...row, team_id: row.team_id ?? 'team-1' } : null, error: null }
          },
        }
        return b
      }

      // The agent's team, for the private-team rule (callerCanReachTeammate).
      if (table === 'team') {
        const eqs: Record<string, unknown> = {}
        const b: Record<string, unknown> = {
          select: () => b,
          eq: (col: string, val: unknown) => ((eqs[col] = val), b),
          maybeSingle: async () => ({ data: { is_private: eqs.id === 'team-private' }, error: null }),
        }
        return b
      }
      if (table === 'team_member') {
        const b: Record<string, unknown> = {
          select: () => b,
          eq: () => b,
          maybeSingle: async () => ({ data: null, error: null }),
        }
        return b
      }

      if (table === 'action_assignee') {
        return {
          select: () => ({
            eq: () => Promise.resolve({ data: hoisted.held, error: null }),
          }),
          delete: () => ({ eq: () => ({ in: () => Promise.resolve({ error: null }) }) }),
          insert: (rows: unknown) => {
            hoisted.seatInserts.push(rows)
            return Promise.resolve({ error: null })
          },
        }
      }

      if (table === 'actions') {
        actionsCallIndex++

        // Call 1: previousData fetch inside Promise.all
        if (actionsCallIndex === 1) {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  single: async () => ({
                    data: { assignee_id: null, status_id: 'state-1', priority: 'none' },
                    error: null,
                  }),
                }),
              }),
            }),
          }
        }

        // Call 2: the update itself
        if (actionsCallIndex === 2) {
          return {
            update: (payload: unknown) => {
              hoisted.actionsUpdate(payload)
              return {
                eq: () => ({
                  eq: () => ({
                    select: () => ({
                      single: async () => ({ data: actionRow, error: null }),
                    }),
                  }),
                }),
              }
            },
          }
        }

        // Call 3: re-fetch after update
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                single: async () => ({ data: actionRow, error: null }),
              }),
            }),
          }),
        }
      }

      // Default: empty success
      return chainProxy({ data: null, error: null })
    },
  }
}

const { PATCH } = await import('@/app/api/account/actions/[id]/route')

function patchReq(body: unknown): NextRequest {
  return buildRequest({ url: 'https://dial8.ai/api/account/actions/action-1', method: 'PATCH', body }) as unknown as NextRequest
}

beforeEach(() => {
  hoisted.actionsUpdate.mockReset()
  hoisted.seatInserts = []
  hoisted.held = []
  hoisted.teammates = [
    { id: 'writer', workspace_id: 'workspace-1', is_system: false, fronts_only: false },
    { id: 'ember-bot', workspace_id: 'workspace-1', is_system: false, fronts_only: true },
    { id: 'triage', workspace_id: 'workspace-1', is_system: true, fronts_only: false },
    { id: 'secret', workspace_id: 'workspace-1', is_system: false, fronts_only: false, team_id: 'team-private' },
  ]
  hoisted.requireWorkspaceMember.mockReset().mockImplementation(async () => ({
    supabase: makeFakeSupabase(),
    user: { id: 'user-1' },
    workspaceId: 'workspace-1',
    member: { id: 'member-1', display_name: 'Alice' },
  }))
})

describe('PATCH /actions/[id] assignee_ai_member_id', () => {
  it('refuses a work bot (fronts_only) and writes nothing', async () => {
    const res = await PATCH(patchReq({ assignee_ai_member_id: 'ember-bot' }), { params: Promise.resolve({ id: 'action-1' }) })
    expect(res.status).toBe(400)
    expect(hoisted.actionsUpdate).not.toHaveBeenCalled()
  })

  it('refuses a system teammate too', async () => {
    const res = await PATCH(patchReq({ assignee_ai_member_id: 'triage' }), { params: Promise.resolve({ id: 'action-1' }) })
    expect(res.status).toBe(400)
  })

  it('refuses a private team’s agent the caller is not on (403), writing nothing', async () => {
    const res = await PATCH(patchReq({ assignee_ai_member_id: 'secret' }), { params: Promise.resolve({ id: 'action-1' }) })
    expect(res.status).toBe(403)
    expect(hoisted.actionsUpdate).not.toHaveBeenCalled()
  })

  it('still assigns a full teammate', async () => {
    const res = await PATCH(patchReq({ assignee_ai_member_id: 'writer' }), { params: Promise.resolve({ id: 'action-1' }) })
    expect(res.status).toBe(200)
    expect(hoisted.actionsUpdate).toHaveBeenCalledWith(expect.objectContaining({ assignee_ai_member_id: 'writer' }))
  })
})

describe('PATCH /actions/[id] — the delegate model (decision 9)', () => {
  const params = { params: Promise.resolve({ id: 'action-1' }) }

  it('delegating an action nobody holds makes the delegator the person responsible', async () => {
    const res = await PATCH(patchReq({ assignee_ai_member_id: 'writer' }), params)
    expect(res.status).toBe(200)
    expect(hoisted.actionsUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ assignee_ai_member_id: 'writer', assignee_id: 'member-1' }),
    )
    expect(hoisted.seatInserts).toEqual([[{ action_id: 'action-1', member_id: 'member-1' }]])
  })

  it('delegating an action a person holds keeps that person', async () => {
    hoisted.held = [{ member_id: 'member-2' }]
    await PATCH(patchReq({ assignee_ai_member_id: 'writer' }), params)
    const payload = hoisted.actionsUpdate.mock.calls[0][0] as Record<string, unknown>
    expect(payload.assignee_ai_member_id).toBe('writer')
    expect(payload).not.toHaveProperty('assignee_id')
    expect(hoisted.seatInserts).toEqual([])
  })

  it('delegating with people named keeps exactly those people beside the agent', async () => {
    await PATCH(patchReq({ assignee_ai_member_id: 'writer', assignee_ids: ['member-3'] }), params)
    expect(hoisted.actionsUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ assignee_ai_member_id: 'writer', assignee_id: 'member-3' }),
    )
  })

  it('refuses an assignee who is not a member of this workspace (400), writing nothing', async () => {
    const res = await PATCH(patchReq({ assignee_ids: ['member-other-ws'] }), params)
    expect(res.status).toBe(400)
    expect(hoisted.actionsUpdate).not.toHaveBeenCalled()
  })

  it('assigning a person never clears the delegate agent', async () => {
    await PATCH(patchReq({ assignee_id: 'member-2' }), params)
    const payload = hoisted.actionsUpdate.mock.calls[0][0] as Record<string, unknown>
    expect(payload.assignee_id).toBe('member-2')
    expect(payload).not.toHaveProperty('assignee_ai_member_id')
  })
})
