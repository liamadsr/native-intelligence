/**
 * A call's capture has one live agent, the server's (src/lib/team-calls/
 * live-turns.ts), driven through the real POST /api/ai/live-agent. A person's
 * own app never drives a second one on it: opening the call's capture in the
 * capture panel starts no live turn (only a recording does), and should any
 * app bind a recording to it (a resume, a calendar Start that found it), its
 * live turns are refused here, before any session, because only the server
 * holds the capture's call-turn key. The server's own turn, with the key,
 * runs; another capture's key opens nothing; the owner's end-of-call pass and
 * Reprocess (batch) are not live turns and are not held to it; an ordinary
 * capture's live turns need no key.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createFakeSupabase, meetingFixture, FIX, type FakeQuery } from '@/lib/live-agent/__tests__/helpers/live-turn-fixture'
import { fakeTaskResponse, quietTurn } from '@/lib/live-agent/__tests__/helpers/fake-eve-turn'

const h = vi.hoisted(() => ({ client: null as unknown as SupabaseClient, sessions: 0 }))

vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: () => {} }))
vi.mock('@/lib/ai/auth', async (orig) => ({
  ...(await orig<typeof import('@/lib/ai/auth')>()),
  authenticateUser: async () => ({ user: { id: FIX.userId, email: FIX.userEmail }, supabase: h.client }),
  checkUsageLimits: async () => {},
  logUsage: async () => {},
}))
vi.mock('@/lib/workspace', async (orig) => ({ ...(await orig<typeof import('@/lib/workspace')>()), getCurrentWorkspaceId: async () => FIX.workspaceId }))
vi.mock('@/lib/admin', async (orig) => ({ ...(await orig<typeof import('@/lib/admin')>()), getServiceClient: () => h.client }))
vi.mock('@/lib/crm/contacts', async (orig) => ({ ...(await orig<typeof import('@/lib/crm/contacts')>()), seedSelfParticipant: async () => {} }))
vi.mock('@/lib/live-agent/conversation-writer', async (orig) => ({ ...(await orig<typeof import('@/lib/live-agent/conversation-writer')>()), syncProposalsCard: async () => {} }))
vi.mock('@/lib/live-agent/nudge-channel', async (orig) => ({ ...(await orig<typeof import('@/lib/live-agent/nudge-channel')>()), broadcastNudge: async () => true }))
vi.mock('@/lib/flows/emit-capture-processed', () => ({ emitCaptureProcessed: () => {} }))
vi.mock('@/lib/eve/task-session', () => ({
  createTaskSession: async () => {
    h.sessions++
    return fakeTaskResponse(quietTurn())
  },
  cancelTaskSession: async () => true,
}))

const { POST } = await import('../route')
const { callTurnKey } = await import('@/lib/live-agent/call-turn-key')

/** The fixture's capture as a call's (its notes channel set), or an ordinary one. */
function useDb(call: boolean) {
  const base = meetingFixture()
  h.client = createFakeSupabase((q: FakeQuery) => {
    const r = base(q)
    if (call && q.table === 'captures' && r.data && !Array.isArray(r.data)) {
      return { ...r, data: { ...(r.data as Record<string, unknown>), notes_channel_id: 'chan-call-1' } }
    }
    return r
  }).client
}

const post = (body: Record<string, unknown>) =>
  POST(new Request('https://app.test/api/ai/live-agent', { method: 'POST', body: JSON.stringify({ capture_id: FIX.captureId, ...body }) }))

beforeEach(() => {
  process.env.LIVE_AGENT_INTERNAL_SECRET = 'route-secret-for-the-call-key-test'
  h.sessions = 0
})

describe('a call’s capture: the server’s live agent alone', () => {
  it('a person’s app driving live turns on it is refused, before any session', async () => {
    useDb(true)
    for (const role of [undefined, 'notes']) {
      const res = await post({ recent_chunks: ['Rosa Lind: I will send the contract'], ...(role ? { live_role: role } : {}) })
      expect(res.status).toBe(409)
      expect((await res.json()).code).toBe('CALL_CAPTURE_SERVER_TURNS')
    }
    // Another capture's key opens nothing.
    const wrong = await post({ recent_chunks: ['x'], live_role: 'notes', call_turn_key: callTurnKey('another-capture') })
    expect(wrong.status).toBe(409)
    expect(h.sessions).toBe(0)
  })

  it('the server’s own turn, with the capture’s key, runs', async () => {
    useDb(true)
    const res = await post({ recent_chunks: ['Rosa Lind: I will send the contract today'], live_role: 'notes', call_turn_key: callTurnKey(FIX.captureId) })
    expect(res.status).toBe(200)
    expect(h.sessions).toBe(1)
  })

  it('an ordinary capture’s live turns need no key', async () => {
    useDb(false)
    const res = await post({ recent_chunks: ['Rosa Lind: I will send the contract today'] })
    expect(res.status).toBe(200)
    expect(h.sessions).toBe(1)
  })
})
