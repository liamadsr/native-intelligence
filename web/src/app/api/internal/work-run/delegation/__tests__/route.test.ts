/**
 * POST /api/internal/work-run/delegation — what one delegate_work call handed
 * back, read by the tool's execute. Pins the auth (the internal secret plus the
 * PARENT's run token) and that the lookup is keyed on the token's own run, so a
 * run can only read its own handoffs. The result itself is delegation.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const SECRET = 'test-agent-run-secret-delegation0'
const h = vi.hoisted(() => ({ build: vi.fn(async (..._a: unknown[]) => ({ type: 'delegation_result', status: 'completed' })) }))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({ tag: 'service' }) }))
vi.mock('@/lib/agent-run/delegation', () => ({ buildDelegationResult: h.build }))

import { POST } from '../route'
import { mintAgentRunToken, AGENT_RUN_SECRET_HEADER, AGENT_RUN_TOKEN_HEADER } from '@/lib/agent-run/agent-run-token'

function req(opts: { secret?: string | null; token?: string | null; body?: string }) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (opts.secret != null) headers[AGENT_RUN_SECRET_HEADER] = opts.secret
  if (opts.token != null) headers[AGENT_RUN_TOKEN_HEADER] = opts.token
  return new Request('http://localhost/api/internal/work-run/delegation', { method: 'POST', headers, body: opts.body ?? '{}' })
}
const token = () => mintAgentRunToken({ agentRunId: 'run-parent', workspaceId: 'ws-1', userId: 'user-1' })

beforeEach(() => {
  process.env.AGENT_RUN_INTERNAL_SECRET = SECRET
  h.build.mockClear()
})

describe('POST /api/internal/work-run/delegation', () => {
  it('returns the result for the token’s own run and the call id', async () => {
    const res = await POST(req({ secret: SECRET, token: token(), body: JSON.stringify({ call_id: ' call-1 ' }) }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ type: 'delegation_result', status: 'completed' })
    expect(h.build).toHaveBeenCalledWith({ tag: 'service' }, { parentRunId: 'run-parent', workspaceId: 'ws-1', callId: 'call-1' })
  })

  it('401 without the internal secret or a valid run token', async () => {
    expect((await POST(req({ token: token(), body: '{"call_id":"c"}' }))).status).toBe(401)
    expect((await POST(req({ secret: 'wrong', token: token(), body: '{"call_id":"c"}' }))).status).toBe(401)
    expect((await POST(req({ secret: SECRET, token: 'forged.token', body: '{"call_id":"c"}' }))).status).toBe(401)
    expect(h.build).not.toHaveBeenCalled()
  })

  it('400 on a bad body or a missing call id', async () => {
    expect((await POST(req({ secret: SECRET, token: token(), body: 'not json' }))).status).toBe(400)
    expect((await POST(req({ secret: SECRET, token: token(), body: '{"call_id":"  "}' }))).status).toBe(400)
    expect(h.build).not.toHaveBeenCalled()
  })
})
