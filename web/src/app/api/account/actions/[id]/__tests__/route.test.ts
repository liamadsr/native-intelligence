/**
 * Tests for PATCH /api/account/actions/[id]
 *
 * Covers title update — the original bug was that the UI rendered the action
 * title as a static <h1> with no editable input, so users couldn't rename
 * actions or sub-tasks (GEN-61). The PATCH handler already supported title
 * updates; this suite locks in that behaviour for both top-level actions and
 * sub-tasks (actions with a parent_id).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { buildRequest, readJson } from '@/test/integration'

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const hoisted = vi.hoisted(() => ({
  requireWorkspaceMember: vi.fn(),
  // Track what .update() is called with so we can assert side-effects
  actionsUpdate: vi.fn(),
  // Call-count tracker — the actions table is hit 3 times during a PATCH:
  // 1. Promise.all previousData fetch, 2. update, 3. re-fetch
  actionsCallCount: { value: 0 },
}))

// PATCH-to-completed reaches trackServerEvent('action_completed'); unmocked,
// a set NEXT_PUBLIC_POSTHOG_KEY (e.g. the Vercel build env) would flush a real
// /batch/ request per test.
vi.mock('@/lib/posthog', () => ({ trackServerEvent: vi.fn() }))

// The route resolves auth + the member row via requireWorkspaceMember (perf
// phase 2 migration) — the old separate member-table fetch is gone.
vi.mock('@/lib/api-auth', () => ({
  requireWorkspace: vi.fn(),
  requireWorkspaceMember: hoisted.requireWorkspaceMember,
}))

vi.mock('@/lib/notifications', () => ({
  createNotification: vi.fn(),
}))

vi.mock('@/lib/flows/emit-status-change', () => ({
  emitStatusChange: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Fake Supabase helpers
// ---------------------------------------------------------------------------

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
            }),
          }),
        }
      }

      if (table === 'action_assignee') {
        return {
          select: () => ({
            eq: () => Promise.resolve({ data: [], error: null }),
          }),
          delete: () => ({ eq: () => ({ in: () => Promise.resolve({ error: null }) }) }),
          insert: () => Promise.resolve({ error: null }),
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

/** Happy-path auth context: a fresh fake supabase per call so the actions
 * call-index closure resets between requests (mirrors the old per-createClient
 * behavior). */
function authedMember() {
  return {
    supabase: makeFakeSupabase(),
    user: { id: 'user-1' },
    workspaceId: 'workspace-1',
    member: { id: 'member-1', display_name: 'Alice' },
  }
}

function patchReq(body: unknown): NextRequest {
  return buildRequest({
    url: 'https://nativeintelligence.dev/api/account/actions/action-1',
    method: 'PATCH',
    body,
  }) as unknown as NextRequest
}

const fakeParams = Promise.resolve({ id: 'action-1' })

// ---------------------------------------------------------------------------

beforeEach(() => {
  hoisted.requireWorkspaceMember.mockReset()
  hoisted.actionsUpdate.mockReset()
  hoisted.actionsCallCount.value = 0

  // A fresh fake supabase per auth resolution, so actionsCallIndex resets
  // automatically for every request.
  hoisted.requireWorkspaceMember.mockImplementation(async () => authedMember())
})

// ---------------------------------------------------------------------------

describe('PATCH /api/account/actions/[id] — title update', () => {
  it('returns 401 when unauthenticated', async () => {
    hoisted.requireWorkspaceMember.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Unauthorized', code: 'UNAUTHORIZED' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    const res = await PATCH(patchReq({ title: 'New title' }), { params: fakeParams })
    expect(res.status).toBe(401)
    expect(hoisted.actionsUpdate).not.toHaveBeenCalled()
  })

  it('returns 400 when workspace is missing', async () => {
    hoisted.requireWorkspaceMember.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'No workspace', code: 'NO_WORKSPACE' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    const res = await PATCH(patchReq({ title: 'New title' }), { params: fakeParams })
    expect(res.status).toBe(400)
    expect(hoisted.actionsUpdate).not.toHaveBeenCalled()
  })

  it('updates the title and returns 200 with the new title', async () => {
    const res = await PATCH(patchReq({ title: 'Updated title' }), { params: fakeParams })
    expect(res.status).toBe(200)

    const body = await readJson<{ action: { id: string; title: string } }>(res)
    expect(body.action.id).toBe('action-1')

    expect(hoisted.actionsUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Updated title' }),
    )
  })

  it('updates the title of a sub-task (action with parent_id) identically', async () => {
    // Sub-tasks are just actions with a non-null parent_id; the PATCH handler
    // treats them no differently. This test confirms the title field flows
    // through correctly regardless of parent_id.
    const res = await PATCH(patchReq({ title: 'Sub-task new title' }), { params: fakeParams })
    expect(res.status).toBe(200)
    expect(hoisted.actionsUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Sub-task new title' }),
    )
  })

  it('does not include title in the update payload when title is not supplied', async () => {
    const res = await PATCH(patchReq({ priority: 'high' }), { params: fakeParams })
    expect(res.status).toBe(200)

    const payload = hoisted.actionsUpdate.mock.calls[0]?.[0] as Record<string, unknown>
    expect(payload).not.toHaveProperty('title')
    expect(payload).toHaveProperty('priority', 'high')
  })

  it('returns 500 when the database update fails', async () => {
    // Override the authed supabase for this test only to return an error on
    // the update. The fake client covers only the chains the handler touches.
    hoisted.requireWorkspaceMember.mockImplementation(async () => {
      let actionsCallIndex = 0
      const failingSupabase = {
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
                }),
              }),
            }
          }
          if (table === 'action_assignee') {
            return {
              select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }),
            }
          }
          if (table === 'actions') {
            actionsCallIndex++
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
            return {
              update: () => ({
                eq: () => ({
                  eq: () => ({
                    select: () => ({
                      single: async () => ({
                        data: null,
                        error: { message: 'db error' },
                      }),
                    }),
                  }),
                }),
              }),
            }
          }
          return chainProxy({ data: null, error: null })
        },
      }
      return {
        supabase: failingSupabase,
        user: { id: 'user-1' },
        workspaceId: 'workspace-1',
        member: { id: 'member-1', display_name: 'Alice' },
      }
    })

    const res = await PATCH(patchReq({ title: 'Will fail' }), { params: fakeParams })
    expect(res.status).toBe(500)
  })
})
