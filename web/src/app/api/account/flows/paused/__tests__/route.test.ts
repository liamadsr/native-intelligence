/**
 * GET /api/account/flows/paused: a loop on its owner's mail, chat or documents
 * never shows in another member's banner (its runs are the owner's alone,
 * migration 640), while every other loop's pause still does.
 */
import { describe, expect, it, vi } from 'vitest'
import { readJson } from '@/test/integration'

const LIMIT_ERROR = 'AI usage limit reached for this plan'
const now = new Date().toISOString()

const runs = [
  { id: 'r1', flow_id: 'f-mail', status: 'failed', fired_at: now, error_message: LIMIT_ERROR, action_results: [], flow: { id: 'f-mail', name: 'Mail digest', workspace_id: 'ws-1', trigger_type: 'email_received', created_by: 'user-owner' } },
  { id: 'r2', flow_id: 'f-daily', status: 'failed', fired_at: now, error_message: LIMIT_ERROR, action_results: [], flow: { id: 'f-daily', name: 'Daily brief', workspace_id: 'ws-1', trigger_type: 'schedule', created_by: 'user-owner' } },
]

const caller = vi.hoisted(() => ({ id: 'user-teammate' }))

vi.mock('@/lib/api-auth', () => ({
  requireWorkspaceMember: vi.fn(async () => {
    const chain: Record<string, unknown> = {}
    for (const m of ['from', 'select', 'eq', 'gte', 'order']) chain[m] = vi.fn(() => chain)
    chain.limit = vi.fn(async () => ({ data: runs, error: null }))
    return { supabase: chain, workspaceId: 'ws-1', user: { id: caller.id } }
  }),
}))

const { GET } = await import('@/app/api/account/flows/paused/route')

describe('GET /api/account/flows/paused', () => {
  it("leaves another member's event loop out", async () => {
    caller.id = 'user-teammate'
    const body = await readJson<{ paused_flows: Array<{ flow_id: string }> }>(await GET())
    expect(body.paused_flows.map((p) => p.flow_id)).toEqual(['f-daily'])
  })

  it('shows the owner their own', async () => {
    caller.id = 'user-owner'
    const body = await readJson<{ paused_flows: Array<{ flow_id: string }> }>(await GET())
    expect(body.paused_flows.map((p) => p.flow_id).sort()).toEqual(['f-daily', 'f-mail'])
  })
})
