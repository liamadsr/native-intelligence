/**
 * A call's capture has one live agent, the server's (src/lib/team-calls/
 * live-turns.ts), driven through the real POST /api/ai/live-agent. A person's
 * own app never drives a second one on it: opening the call's capture in the
 * capture panel starts no live turn (only a recording does; the panel's own
 * calls to this route are Reprocess, a batch), the panel offers no Resume on
 * a call's capture, the resume route refuses one, and should any app still
 * bind a recording to it, its live turns are refused here, before any
 * session: only the server holds the key, and the key is bound to the
 * running turn's lease, which must be the one running now. The server's own
 * turn runs, its tools stopping at its lease's end (the run token's
 * notAfter); a replayed key of an earlier turn, another capture's key, or a
 * turn whose lease ran out are refused. The owner's Reprocess (a batch) needs
 * no key, but waits for the call: refused while the call's notes are live.
 * An ordinary capture's live turns need no key.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createFakeSupabase, eqValue, meetingFixture, FIX, type FakeQuery } from '@/lib/live-agent/__tests__/helpers/live-turn-fixture'
import { fakeTaskResponse, quietTurn } from '@/lib/live-agent/__tests__/helpers/fake-eve-turn'

const h = vi.hoisted(() => ({
  client: null as unknown as SupabaseClient,
  sessions: 0,
  /** The running lease, and until when. */
  lease: { id: 'lease-now', until: 0 },
  callLive: true,
  /** The claims each minted run token carried. */
  minted: [] as Array<{ notAfter?: number }>,
}))

vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: () => {} }))
vi.mock('@/lib/ai/auth', async (orig) => ({
  ...(await orig<typeof import('@/lib/ai/auth')>()),
  authenticateUser: async () => ({ user: { id: FIX.userId, email: FIX.userEmail }, supabase: h.client }),
  checkUsageLimits: async () => {},
  logUsage: async () => {},
}))
vi.mock('@/lib/workspace', async (orig) => ({ ...(await orig<typeof import('@/lib/workspace')>()), getCurrentWorkspaceId: async () => FIX.workspaceId }))
vi.mock('@/lib/admin', async (orig) => ({ ...(await orig<typeof import('@/lib/admin')>()), getServiceClient: () => h.client }))
// The extraction ledger and its work item write through the service client of their own module: the fake, never the network.
vi.mock('@/lib/supabase/service', async (orig) => ({ ...(await orig<typeof import('@/lib/supabase/service')>()), getServiceClient: () => h.client }))
vi.mock('@/lib/crm/contacts', async (orig) => ({ ...(await orig<typeof import('@/lib/crm/contacts')>()), seedSelfParticipant: async () => {} }))
vi.mock('@/lib/live-agent/conversation-writer', async (orig) => ({ ...(await orig<typeof import('@/lib/live-agent/conversation-writer')>()), syncProposalsCard: async () => {} }))
vi.mock('@/lib/live-agent/nudge-channel', async (orig) => ({ ...(await orig<typeof import('@/lib/live-agent/nudge-channel')>()), broadcastNudge: async () => true }))
vi.mock('@/lib/flows/emit-capture-processed', () => ({ emitCaptureProcessed: () => {} }))
vi.mock('@/lib/live-agent/live-agent-run-token', async (orig) => {
  const real = await orig<typeof import('@/lib/live-agent/live-agent-run-token')>()
  return {
    ...real,
    mintLiveAgentRunToken: (claims: Parameters<typeof real.mintLiveAgentRunToken>[0]) => {
      h.minted.push(claims)
      return real.mintLiveAgentRunToken(claims)
    },
  }
})
vi.mock('@/lib/eve/task-session', () => ({
  createTaskSession: async () => {
    h.sessions++
    return fakeTaskResponse(quietTurn())
  },
  cancelTaskSession: async () => true,
}))

const { POST } = await import('../route')
const { callTurnKey } = await import('@/lib/live-agent/call-turn-key')

/** The fixture's capture as a call's (its notes channel set), or an ordinary one; the call live or over. */
function useDb(call: boolean) {
  const base = meetingFixture()
  h.client = createFakeSupabase((q: FakeQuery) => {
    if (q.table === 'rpc:team_call_live_turn_lease_until') {
      const p = q.payload as { turn_lease: string }
      return { data: p.turn_lease === h.lease.id && h.lease.until > Date.now() ? new Date(h.lease.until).toISOString() : null, error: null }
    }
    if (q.table === 'team_call' && eqValue(q, 'capture_id') === FIX.captureId) return { data: call && h.callLive ? { id: 'call-1' } : null, error: null }
    if (q.table === 'captures' && q.columns.includes('is_transcript_locked')) return { data: { ended_at: null, is_transcript_locked: false }, error: null }
    const r = base(q)
    if (call && q.table === 'captures' && r.data && !Array.isArray(r.data)) {
      return { ...r, data: { ...(r.data as Record<string, unknown>), notes_channel_id: 'chan-call-1' } }
    }
    return r
  }).client
}

const post = (body: Record<string, unknown>) =>
  POST(new Request('https://app.test/api/ai/live-agent', { method: 'POST', body: JSON.stringify({ capture_id: FIX.captureId, ...body }) }))
const serverTurn = (lease = h.lease.id, key = callTurnKey(FIX.captureId, lease)) =>
  post({ recent_chunks: ['Rosa Lind: I will send the contract today'], live_role: 'notes', call_turn_lease: lease, call_turn_key: key })

beforeEach(() => {
  process.env.LIVE_AGENT_INTERNAL_SECRET = 'route-secret-for-the-call-key-test'
  h.sessions = 0
  h.minted = []
  h.lease = { id: 'lease-now', until: Date.now() + 240_000 }
  h.callLive = true
})

describe('a call’s capture: the server’s live agent alone', () => {
  it('a person’s app driving live turns on it is refused, before any session', async () => {
    useDb(true)
    for (const role of [undefined, 'notes']) {
      const res = await post({ recent_chunks: ['Rosa Lind: I will send the contract'], ...(role ? { live_role: role } : {}) })
      expect(res.status).toBe(409)
      expect((await res.json()).code).toBe('CALL_CAPTURE_SERVER_TURNS')
    }
    expect(h.sessions).toBe(0)
  })

  it('the server’s own turn, holding the running lease, runs, and its tools stop at the lease’s end', async () => {
    useDb(true)
    const res = await serverTurn()
    expect(res.status).toBe(200)
    expect(h.sessions).toBe(1)
    expect(h.minted).toHaveLength(1)
    expect(h.minted[0].notAfter).toBe(h.lease.until)
  })

  it('a replayed key of an earlier turn, another capture’s key, or a lease that ran out: refused', async () => {
    useDb(true)
    // An earlier turn's lease and key, replayed: not the running lease.
    expect((await serverTurn('lease-earlier')).status).toBe(409)
    // The running lease with another capture's key.
    expect((await serverTurn(h.lease.id, callTurnKey('another-capture', h.lease.id))).status).toBe(409)
    // The running lease named with a key made for another lease.
    expect((await serverTurn(h.lease.id, callTurnKey(FIX.captureId, 'lease-earlier'))).status).toBe(409)
    // The right key, its lease run out.
    h.lease.until = Date.now() - 1
    expect((await serverTurn()).status).toBe(409)
    expect(h.sessions).toBe(0)
  })

  it('Reprocess (a batch) needs no key, but waits for the call: refused while its notes are live', async () => {
    useDb(true)
    const live = await post({ mode: 'batch' })
    expect(live.status).toBe(409)
    expect(await live.json()).toMatchObject({ code: 'CALL_NOTES_LIVE', error: 'This call is still taking notes. Reprocess it once the call has ended.' })
    expect(h.sessions).toBe(0)
    h.callLive = false
    useDb(true)
    expect((await post({ mode: 'batch' })).status).not.toBe(409)
  })

  it('an ordinary capture’s live turns need no key', async () => {
    useDb(false)
    const res = await post({ recent_chunks: ['Rosa Lind: I will send the contract today'] })
    expect(res.status).toBe(200)
    expect(h.sessions).toBe(1)
  })
})
