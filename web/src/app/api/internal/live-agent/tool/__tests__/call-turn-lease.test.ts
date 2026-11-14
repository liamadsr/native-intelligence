/**
 * POST /api/internal/live-agent/tool for a call's server turn (src/lib/team-calls/
 * live-turns.ts): its run token carries the turn's lease, and every tool call is
 * taken only while that lease is still the capture's and unexpired (655's
 * team_call_live_agent row, read on each call). Once the turn released its lease
 * (its answer in), a session whose cancel never landed writes nothing more beside
 * the call's end-of-meeting pass; a lease that ran out, another lease, or a read
 * that fails: refused. The lease, not the agent's state: a turn still holding its
 * lease after the call ended (the agent stopped) keeps its writes, as the call's
 * finish waits for it. A token without a lease (every other turn) is not asked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createFakeSupabase, eqValue, meetingFixture, FIX, type FakeQuery } from '@/lib/live-agent/__tests__/helpers/live-turn-fixture'
import { LIVE_AGENT_SECRET_HEADER, LIVE_AGENT_TOKEN_HEADER, mintLiveAgentRunToken, type LiveAgentTokenClaims } from '@/lib/live-agent/live-agent-run-token'

const h = vi.hoisted(() => ({
  client: null as unknown as SupabaseClient,
  /** The capture's agent row as 655 holds it: the running lease and its end, the state; or a read error. */
  agent: { lease_id: 'lease-now' as string | null, lease_until: '' as string | null, state: 'working' },
  readError: false,
  leaseReads: 0,
}))

vi.mock('@/lib/admin', async (orig) => ({ ...(await orig<typeof import('@/lib/admin')>()), getServiceClient: () => h.client }))
vi.mock('@/lib/supabase/service', async (orig) => ({ ...(await orig<typeof import('@/lib/supabase/service')>()), getServiceClient: () => h.client }))
vi.mock('@/lib/posthog', async (orig) => ({ ...(await orig<typeof import('@/lib/posthog')>()), trackServerEvent: () => {} }))

const { POST } = await import('../route')

const SECRET = 'live-internal-secret-for-the-lease-test'

function seed() {
  const base = meetingFixture()
  h.client = createFakeSupabase((q: FakeQuery) => {
    if (q.table === 'team_call_live_agent' && q.op === 'select') {
      h.leaseReads++
      if (h.readError) return { data: null, error: { message: 'read failed' } }
      const row = h.agent.lease_id === eqValue(q, 'lease_id') && eqValue(q, 'capture_id') === FIX.captureId ? { lease_until: h.agent.lease_until } : null
      return { data: row, error: null }
    }
    const r = base(q)
    // A call's capture (its notes channel set).
    if (q.table === 'captures' && r.data && !Array.isArray(r.data)) {
      return { ...r, data: { ...(r.data as Record<string, unknown>), notes_channel_id: 'chan-call-1' } }
    }
    return r
  }).client
}

function claims(over: Partial<LiveAgentTokenClaims> = {}): Omit<LiveAgentTokenClaims, 'exp'> {
  return {
    captureId: FIX.captureId,
    workspaceId: FIX.workspaceId,
    userId: FIX.userId,
    currentMemberId: FIX.memberId,
    turnType: 'notes',
    model: 'deepseek-v4-flash',
    isEvalCapture: false,
    allowAutoArchive: false,
    notAfter: Date.now() + 240_000,
    callTurnLease: 'lease-now',
    ...over,
  }
}

async function call(tokenClaims = claims()) {
  const res = await POST(
    new Request('https://app.test/api/internal/live-agent/tool', {
      method: 'POST',
      headers: { 'content-type': 'application/json', [LIVE_AGENT_SECRET_HEADER]: SECRET, [LIVE_AGENT_TOKEN_HEADER]: mintLiveAgentRunToken(tokenClaims) },
      body: JSON.stringify({ toolName: 'list_workspace_members', input: {} }),
    }),
  )
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

beforeEach(() => {
  process.env.LIVE_AGENT_INTERNAL_SECRET = SECRET
  h.agent = { lease_id: 'lease-now', lease_until: new Date(Date.now() + 240_000).toISOString(), state: 'working' }
  h.readError = false
  h.leaseReads = 0
  seed()
})

describe('a call’s server turn writes only while it holds its lease', () => {
  it('while the lease is held: the tool call runs', async () => {
    const res = await call()
    expect(res.body.code).not.toBe('CALL_TURN_LEASE_OVER')
    expect(res.status).toBe(200)
    expect(h.leaseReads).toBe(1)
  })

  it('the agent stopped (the call ended) but the turn still holds its lease: its writes go on', async () => {
    h.agent.state = 'stopped'
    const res = await call()
    expect(res.status).toBe(200)
  })

  it('after the turn released its lease (a session whose cancel never landed): refused', async () => {
    h.agent.lease_id = null
    h.agent.lease_until = null
    const res = await call()
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('CALL_TURN_LEASE_OVER')
  })

  it('a later turn’s lease, a lease that ran out, or a read that fails: refused', async () => {
    h.agent.lease_id = 'lease-next'
    expect((await call()).status).toBe(409)
    h.agent.lease_id = 'lease-now'
    h.agent.lease_until = new Date(Date.now() - 1).toISOString()
    expect((await call()).status).toBe(409)
    h.agent.lease_until = new Date(Date.now() + 240_000).toISOString()
    h.readError = true
    expect((await call()).status).toBe(409)
  })

  it('a token with no lease (every other turn) is not asked', async () => {
    const { notAfter: _n, callTurnLease: _l, ...rest } = claims()
    void _n
    void _l
    const res = await call(rest)
    expect(res.body.code).not.toBe('CALL_TURN_LEASE_OVER')
    expect(h.leaseReads).toBe(0)
  })
})
