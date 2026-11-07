/**
 * POST /api/account/workspace/agent-autonomy/resume ("Resume role", plan Part 5
 * row 9): owner/admin only; an attemptable role; the body's workspace must be
 * the one the request resolved to; writes resumed_at[role] = now and nothing
 * else in the policy or the settings.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  auth: null as unknown,
  stored: {} as Record<string, unknown>,
  written: null as Record<string, unknown> | null,
}))
vi.mock('@/lib/api-auth', () => ({ requireWorkspaceMember: async () => h.auth }))
vi.mock('@/lib/supabase/service', () => ({
  getServiceClient: () => ({
    from: () => {
      const chain: Record<string, unknown> = {}
      chain.select = () => chain
      chain.eq = () => chain
      chain.maybeSingle = async () => ({ data: { settings: h.stored }, error: null })
      chain.update = (vals: { settings: Record<string, unknown> }) => ({
        eq: () => ({
          select: async () => {
            h.written = vals.settings
            return { data: [{ id: 'ws-1' }], error: null }
          },
        }),
      })
      return chain
    },
  }),
}))

import { POST } from '../route'

const post = (body: unknown) =>
  POST(new Request('http://x/api/account/workspace/agent-autonomy/resume', { method: 'POST', body: JSON.stringify(body) }) as never)
const asRole = (role: string) => {
  h.auth = { supabase: {}, user: { id: 'u1' }, workspaceId: 'ws-1', member: { id: 'm1', role } }
}

beforeEach(() => {
  asRole('owner')
  h.written = null
  h.stored = {
    labels: { x: 1 },
    agent_autonomy: { mode: 'attempt', max_attempts_per_day: 4, role_breaker_resumed_at: { researcher: '2026-09-01T00:00:00.000Z' } },
  }
})

describe('Resume role', () => {
  it('writes the role’s resume time and keeps everything else', async () => {
    const before = Date.now()
    const res = await post({ role: 'writer', workspace_id: 'ws-1' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.role).toBe('writer')
    expect(Date.parse(body.resumed_at)).toBeGreaterThanOrEqual(before)
    expect(h.written?.labels).toEqual({ x: 1 })
    expect(h.written?.agent_autonomy).toMatchObject({
      mode: 'attempt',
      max_attempts_per_day: 4,
      role_breaker_resumed_at: { researcher: '2026-09-01T00:00:00.000Z', writer: body.resumed_at },
    })
  })

  it('admins only', async () => {
    asRole('member')
    expect((await post({ role: 'writer', workspace_id: 'ws-1' })).status).toBe(403)
    expect(h.written).toBeNull()
  })

  it('an attemptable role only (a developer has no breaker)', async () => {
    for (const role of ['developer', 'astronaut', null]) {
      expect((await post({ role, workspace_id: 'ws-1' })).status, String(role)).toBe(400)
    }
    expect(h.written).toBeNull()
  })

  it('refuses when the body names another workspace than the request resolved to', async () => {
    const res = await post({ role: 'writer', workspace_id: 'ws-other' })
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('WORKSPACE_MISMATCH')
    expect(h.written).toBeNull()
  })
})
