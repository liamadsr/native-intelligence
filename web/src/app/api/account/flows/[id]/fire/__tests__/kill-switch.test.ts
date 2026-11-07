/**
 * The kill switch on a person's own Run now (A5 review): with autonomy off the
 * test-fire is refused up front with AGENT_PAUSED and a message the editor's
 * toast shows, and no skill runs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ paused: true, runFlow: vi.fn() }))

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
          data: { id: 'flow-1', workspace_id: 'ws-1', trigger_type: 'schedule', trigger_config: {}, actions: [], created_by: 'user-1' },
          error: null,
        })
        return c
      },
    },
  }),
}))
vi.mock('@/lib/admin', () => ({
  getServiceClient: () => ({
    from: () => {
      const c: Record<string, unknown> = {}
      c.select = () => c
      c.eq = () => c
      c.maybeSingle = async () => ({ data: { settings: h.paused ? { agent_autonomy: { mode: 'off' } } : {} }, error: null })
      return c
    },
  }),
}))
vi.mock('@/lib/flows/runner', () => ({ runFlow: h.runFlow }))
vi.mock('@/lib/flows/run-skill', () => ({ createRunSkillExecutor: () => async () => ({}), flowRunDeadlineMs: () => Date.now() + 1000 }))
vi.mock('@/lib/flows/run-agent', () => ({ createRunAgentExecutor: () => async () => ({}) }))
vi.mock('@/lib/flows/archive-capture', () => ({ createArchiveCaptureExecutor: () => async () => ({}) }))
vi.mock('@/lib/flows/queries', () => ({ loadRunnerEntityData: async () => null }))

import { POST } from '../route'

beforeEach(() => {
  h.runFlow.mockReset()
  vi.spyOn(console, 'info').mockImplementation(() => {})
})

describe('Run now: the kill switch', () => {
  it('refuses 409 AGENT_PAUSED with a message the toast can show; nothing runs', async () => {
    h.paused = true
    const res = await POST(new Request('http://localhost/api/account/flows/flow-1/fire', { method: 'POST', body: '{}' }) as never, {
      params: Promise.resolve({ id: 'flow-1' }),
    })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.code).toBe('AGENT_PAUSED')
    expect(body.error).toMatch(/switched off.*Settings → Autonomy/)
    expect(h.runFlow).not.toHaveBeenCalled()
  })
})
