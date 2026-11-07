/**
 * POST /api/account/actions — `assignee_ai_member_id` is fenced to the
 * workspace (Sequence step 1). The FK only proves the teammate exists;
 * PATCH /actions/[id] has always checked it belongs HERE, and now the create
 * path does too: a foreign id is a 400 and no action row is inserted.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { buildRequest, readJson } from '@/test/integration'
import { FOREIGN_AI_MEMBER_ERROR } from '@/lib/workspace-fences'

const hoisted = vi.hoisted(() => ({
  requireWorkspace: vi.fn(),
  actionsInsert: vi.fn(),
  aiMemberLookups: [] as Array<Record<string, unknown>>,
  teammates: [] as string[],
  privateTeam: false,
}))

/** Any chain resolves to `result`; `.single()/.maybeSingle()` too. */
function proxyTo(result: unknown) {
  const chain: Record<string, unknown> = {
    then: (cb: (v: unknown) => unknown) => Promise.resolve(result).then(cb),
  }
  const proxy: unknown = new Proxy(chain, {
    get(target, prop: string) {
      if (prop in target) return target[prop]
      if (prop === 'single' || prop === 'maybeSingle') return () => Promise.resolve(result)
      return () => proxy
    },
  })
  return proxy
}

function fakeSupabase() {
  const created = {
    id: 'action-1', identifier: 'GEN-1', title: 'T', description: null, status_id: 'state-1', team_id: 'team-1',
    confirmation: 'confirmed', priority: 'none', due_at: null, all_day: true, assignee_id: null,
    assignee_ai_member_id: 'ai-here', parent_id: null, estimate: null, project_id: null, milestone_id: null, cycle_id: null,
    created_at: '2026-01-01T00:00:00Z', workflow_state: null, project: null, milestone: null, cycle: null,
  }
  return {
    from: (table: string) => {
      if (table === 'team') return proxyTo({ data: { id: 'team-1', is_private: hoisted.privateTeam }, error: null })
      if (table === 'team_member') return proxyTo({ data: null, error: null })
      if (table === 'workflow_state') return proxyTo({ data: { id: 'state-1' }, error: null })
      if (table === 'ai_team_member') {
        const eqs: Record<string, unknown> = {}
        const b: Record<string, unknown> = {
          select: () => b,
          eq: (col: string, val: unknown) => ((eqs[col] = val), b),
          maybeSingle: async () => {
            hoisted.aiMemberLookups.push({ ...eqs })
            const ok = eqs.workspace_id === 'workspace-1' && hoisted.teammates.includes(eqs.id as string)
            return { data: ok ? { id: eqs.id, team_id: 'team-1', is_system: false, fronts_only: false } : null, error: null }
          },
        }
        return b
      }
      if (table === 'member') {
        const b: Record<string, unknown> = {
          select: () => b,
          eq: () => b,
          in: async () => ({ data: [], error: null }),
          single: async () => ({ data: { id: 'member-1', display_name: 'Alice', avatar_url: null }, error: null }),
        }
        return b
      }
      if (table === 'actions') {
        return {
          insert: (payload: unknown) => {
            hoisted.actionsInsert(payload)
            return { select: () => ({ single: async () => ({ data: created, error: null }) }) }
          },
          select: () => proxyTo({ data: null, error: null }),
        }
      }
      return proxyTo({ data: null, error: null })
    },
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'user-1' } } })) },
    rpc: vi.fn(),
  }
}
vi.mock('@/lib/api-auth', () => ({
  requireWorkspace: hoisted.requireWorkspace,
  requireWorkspaceMember: hoisted.requireWorkspace,
}))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => fakeSupabase() }))
vi.mock('@/lib/posthog', () => ({ trackServerEvent: vi.fn() }))

const { POST } = await import('@/app/api/account/actions/route')

const req = (body: unknown) =>
  buildRequest({ url: 'https://dial8.ai/api/account/actions', body }) as unknown as NextRequest

beforeEach(() => {
  hoisted.requireWorkspace.mockReset()
  hoisted.actionsInsert.mockReset()
  hoisted.aiMemberLookups.length = 0
  hoisted.teammates = ['ai-here']
  hoisted.privateTeam = false
  hoisted.requireWorkspace.mockResolvedValue({ supabase: fakeSupabase(), user: { id: 'user-1' }, workspaceId: 'workspace-1' })
})

describe('POST /api/account/actions — assignee_ai_member_id fence', () => {
  it('a teammate from another workspace is a 400 and nothing is inserted', async () => {
    const res = await POST(req({ title: 'Foreign', assignee_ai_member_id: 'ai-foreign' }))
    expect(res.status).toBe(400)
    expect(await readJson<{ error: string }>(res)).toMatchObject({ error: FOREIGN_AI_MEMBER_ERROR })
    expect(hoisted.actionsInsert).not.toHaveBeenCalled()
    // The lookup was scoped to THIS workspace, not just by id.
    expect(hoisted.aiMemberLookups).toEqual([{ id: 'ai-foreign', workspace_id: 'workspace-1' }])
  })

  it('a teammate that belongs here is written onto the action', async () => {
    const res = await POST(req({ title: 'Ours', assignee_ai_member_id: 'ai-here' }))
    expect(res.status).toBe(200)
    expect(hoisted.actionsInsert).toHaveBeenCalledTimes(1)
    expect(hoisted.actionsInsert.mock.calls[0][0]).toMatchObject({ assignee_ai_member_id: 'ai-here' })
  })

  it('a private team’s agent the caller is not on is a 403 and nothing is inserted', async () => {
    hoisted.privateTeam = true
    const res = await POST(req({ title: 'Secret', assignee_ai_member_id: 'ai-here' }))
    expect(res.status).toBe(403)
    expect(hoisted.actionsInsert).not.toHaveBeenCalled()
  })

  it('no teammate → no lookup', async () => {
    const res = await POST(req({ title: 'Plain' }))
    expect(res.status).toBe(200)
    expect(hoisted.aiMemberLookups).toEqual([])
  })
})
