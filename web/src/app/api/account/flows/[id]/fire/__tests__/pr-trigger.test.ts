/**
 * Run now on a pr_status_changed loop (F1 review): it fires against an action
 * (a synthetic one by default) with the PR state the loop waits for, the same
 * trigger build as test_flow (test-fire.ts prTestTrigger).
 */
import { describe, it, expect, vi } from 'vitest'

const h = vi.hoisted(() => ({ runFlow: vi.fn(async () => ({ status: 'success', action_results: [] })) }))

vi.mock('@/lib/api-auth', () => ({
  requireWorkspaceMember: async () => ({
    user: { id: 'user-1' },
    workspaceId: 'ws-1',
    supabase: {
      from: () => {
        const c: Record<string, unknown> = {}
        c.select = () => c
        c.eq = () => c
        c.maybeSingle = async () => ({
          data: {
            id: 'flow-1',
            workspace_id: 'ws-1',
            trigger_type: 'pr_status_changed',
            trigger_config: { kind: 'pr_status_changed', repo_full_name: 'acme/web', to_state: 'closed' },
            actions: [],
            created_by: 'user-1',
          },
          error: null,
        })
        return c
      },
    },
  }),
}))
vi.mock('@/lib/admin', () => ({
  getServiceClient: () => {
    const c: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'is', 'update']) c[m] = () => c
    c.maybeSingle = async () => ({ data: { settings: {} }, error: null })
    c.insert = async () => ({ error: null })
    c.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve)
    return { from: () => c }
  },
}))
vi.mock('@/lib/flows/runner', () => ({ runFlow: h.runFlow }))
vi.mock('@/lib/flows/run-skill', () => ({ createRunSkillExecutor: () => async () => ({}), flowRunDeadlineMs: () => Date.now() + 1000 }))
vi.mock('@/lib/flows/run-agent', () => ({ createRunAgentExecutor: () => async () => ({}) }))
vi.mock('@/lib/flows/archive-capture', () => ({ createArchiveCaptureExecutor: () => async () => ({}) }))
vi.mock('@/lib/flows/queries', () => ({ loadRunnerEntityData: async () => null }))

import { POST } from '../route'

describe('Run now on a PR loop', () => {
  it('fires against a synthetic action with the state the loop waits for', async () => {
    const res = await POST(new Request('http://localhost/api/account/flows/flow-1/fire', { method: 'POST', body: '{}' }) as never, {
      params: Promise.resolve({ id: 'flow-1' }),
    })
    expect(res.status).toBe(200)
    const [, entity, trigger] = h.runFlow.mock.calls[0] as unknown as [unknown, { kind: string; status_id: string }, Record<string, unknown>]
    expect(entity).toMatchObject({ kind: 'action', status_id: 'closed' })
    expect(trigger).toMatchObject({ type: 'pr_status_changed', entity_type: 'action', from_status_id: null, to_status_id: 'closed' })
  })
})
