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
 * notAfter, and the lease itself for the tool route), its finalize beginning
 * no write past that end; a replayed key of an earlier turn, another
 * capture's key, or a turn whose lease ran out are refused. The owner's
 * Reprocess (a batch) needs no key, but waits for the call: refused while the
 * call's notes are live, and after it while its last turn holds its lease.
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
  /** 655's busy(): the last turn still holding its lease (or within the margin after it). */
  turnBusy: false,
  /** The claims each minted run token carried. */
  minted: [] as Array<{ notAfter?: number; callTurnLease?: string }>,
  /** Pending proposals finalize may auto-apply, and what it applied (each apply moves the clock by `applyTakesMs`). */
  pending: [] as Array<Record<string, unknown>>,
  applied: [] as string[],
  applyTakesMs: 0,
  clockShift: 0,
  /** Proposals the race damp would withhold (by id), and what it marked. */
  dampIds: [] as string[],
  damped: [] as string[],
  /** The turn's pending directives, and what it marked consumed. */
  directives: [] as Array<Record<string, unknown>>,
  consumed: [] as string[],
  log: [] as Array<{ table: string; op: string }>,
}))

vi.mock('@/lib/proposed-changes/auto-accept-race-damp', async (orig) => ({
  ...(await orig<typeof import('@/lib/proposed-changes/auto-accept-race-damp')>()),
  RACE_DAMP_ENABLED: true,
  fetchRaceCandidates: async () => [],
  shouldRefuseAutoAccept: (p: { title?: string | null }) =>
    h.dampIds.includes(String(p.title)) ? { refuse: true, matched_action_id: 'act-near', note: 'near-duplicate' } : { refuse: false },
  markRaceDamped: async (_sb: unknown, change: { id: string }) => {
    h.damped.push(change.id)
  },
}))
vi.mock('@/lib/live-agent/directives', async (orig) => ({
  ...(await orig<typeof import('@/lib/live-agent/directives')>()),
  loadPendingDirectives: async () => h.directives,
  consumeDirectives: async (_svc: unknown, args: { ids: string[] }) => {
    h.consumed.push(...args.ids)
  },
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
vi.mock('@/lib/proposed-changes/apply-engine', async (orig) => ({
  ...(await orig<typeof import('@/lib/proposed-changes/apply-engine')>()),
  applyChange: async (_sb: unknown, change: { id: string }) => {
    h.applied.push(change.id)
    h.clockShift += h.applyTakesMs
    return { success: true, entity_id: `ent-${change.id}` }
  },
}))
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
function seedDb(call: boolean) {
  const base = meetingFixture()
  const fake = createFakeSupabase((q: FakeQuery) => {
    if (q.table === 'rpc:team_call_live_turn_busy') return { data: h.turnBusy, error: null }
    if (q.table === 'proposed_change' && q.op === 'select' && q.columns === '*' && eqValue(q, 'status') === 'pending') return { data: h.pending, error: null }
    if (q.table === 'proposed_change' && q.op === 'update') return { data: { id: eqValue(q, 'id') }, error: null }
    if (q.table === 'rpc:capture_feed_quote_speakers') return { data: [{ participant_id: 'p-rosa', member_id: 'mem-rosa', source: 'call_roster' }], error: null }
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
  })
  h.client = fake.client
  h.log = fake.log as Array<{ table: string; op: string }>
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
  h.turnBusy = false
  h.pending = []
  h.applied = []
  h.applyTakesMs = 0
  h.clockShift = 0
  h.dampIds = []
  h.damped = []
  h.directives = []
  h.consumed = []
  vi.restoreAllMocks()
})

/** Two member decisions, the first apply taking `firstTakesMs` of a lease that ends in 60 s. */
function nearTheEnd(firstTakesMs: number) {
  h.lease.until = Date.now() + 60_000
  h.applyTakesMs = firstTakesMs
  h.clockShift = 0
  h.pending = ['d1', 'd2'].map((id) => ({
    id, change_type: 'create', entity_type: 'decision', status: 'pending', confidence: 0.97, title: id, display_text: id,
    sort_order: 0, trigger_quote: 'We decided to ship on Monday', extra: { is_explicitly_stated: true },
  }))
  seedDb(true)
  const realNow = Date.now.bind(Date)
  vi.spyOn(Date, 'now').mockImplementation(() => realNow() + h.clockShift)
}

describe('a call’s capture: the server’s live agent alone', () => {
  it('a person’s app driving live turns on it is refused, before any session', async () => {
    seedDb(true)
    for (const role of [undefined, 'notes']) {
      const res = await post({ recent_chunks: ['Rosa Lind: I will send the contract'], ...(role ? { live_role: role } : {}) })
      expect(res.status).toBe(409)
      expect((await res.json()).code).toBe('CALL_CAPTURE_SERVER_TURNS')
    }
    expect(h.sessions).toBe(0)
  })

  it('the server’s own turn, holding the running lease, runs, and its tools stop at the lease’s end', async () => {
    seedDb(true)
    const res = await serverTurn()
    expect(res.status).toBe(200)
    expect(h.sessions).toBe(1)
    expect(h.minted).toHaveLength(1)
    expect(h.minted[0].notAfter).toBe(h.lease.until)
    // And the lease itself: the tool route takes its calls only while it is held.
    expect(h.minted[0].callTurnLease).toBe(h.lease.id)
  })

  it('past the lease’s end no race-damp mark is written either (the check is at the top of the loop)', async () => {
    h.dampIds = ['d2']
    nearTheEnd(70_000) // d1's apply ends past the lease's end
    expect((await serverTurn()).status).toBe(200)
    expect(h.applied).toEqual(['d1'])
    expect(h.damped).toEqual([])
    // The control: with time to spare, d2 reaches the race damp and is marked.
    h.applied = []
    nearTheEnd(0)
    h.dampIds = ['d2']
    expect((await serverTurn()).status).toBe(200)
    expect(h.damped).toEqual(['d2'])
  })

  it('past the lease’s end its directives are not marked consumed (the end-of-meeting pass reads them)', async () => {
    h.directives = [{ id: 'dir-1', capture_id: FIX.captureId, source: 'talk_back', text: 'Dana owns the budget', status: 'pending', created_at: new Date().toISOString(), consumed_at: null }]
    nearTheEnd(70_000)
    expect((await serverTurn()).status).toBe(200)
    expect(h.consumed).toEqual([])
    // The control: in time, they are consumed.
    nearTheEnd(0)
    expect((await serverTurn()).status).toBe(200)
    expect(h.consumed).toEqual(['dir-1'])
  })

  it('past the lease’s end the pass ledger is still recorded: insert-only rows of its own (what the turn did)', async () => {
    nearTheEnd(70_000)
    expect((await serverTurn()).status).toBe(200)
    expect(h.log.some((q) => q.table === 'extraction_pass' && q.op === 'insert')).toBe(true)
    // It touches no proposal after the end: the only proposal write is d1's own apply (mocked), none for d2.
    expect(h.applied).toEqual(['d1'])
  })

  it('its finalize begins no write past the lease’s end: what is left stays pending for the pass', async () => {
    // Three member decisions to file; each apply takes 40 s of the lease's last 60 s.
    h.lease.until = Date.now() + 60_000
    h.applyTakesMs = 40_000
    h.pending = ['d1', 'd2', 'd3'].map((id) => ({
      id, change_type: 'create', entity_type: 'decision', status: 'pending', confidence: 0.97, title: id, display_text: id,
      sort_order: 0, trigger_quote: 'We decided to ship on Monday', extra: { is_explicitly_stated: true },
    }))
    seedDb(true)
    const realNow = Date.now.bind(Date)
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + h.clockShift)
    const res = await serverTurn()
    expect(res.status).toBe(200)
    // d1 begins at +0 s, d2 at +40 s (both before the end at +60 s); d3 would begin at +80 s: not begun.
    expect(h.applied).toEqual(['d1', 'd2'])
    // The control: with time to spare, all three are filed (so it was the lease's end that held d3).
    h.applied = []
    h.applyTakesMs = 0
    h.clockShift = 0
    seedDb(true)
    expect((await serverTurn()).status).toBe(200)
    expect(h.applied).toEqual(['d1', 'd2', 'd3'])
  })

  it('a replayed key of an earlier turn, another capture’s key, or a lease that ran out: refused', async () => {
    seedDb(true)
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
    seedDb(true)
    const live = await post({ mode: 'batch' })
    expect(live.status).toBe(409)
    expect(await live.json()).toMatchObject({ code: 'CALL_NOTES_LIVE', error: 'This call is still taking notes. Reprocess it once the call has ended.' })
    expect(h.sessions).toBe(0)
    h.callLive = false
    seedDb(true)
    expect((await post({ mode: 'batch' })).status).not.toBe(409)
  })

  it('Reprocess after the call ended, while its last turn still holds its lease: refused the same way', async () => {
    h.callLive = false
    h.turnBusy = true
    seedDb(true)
    const res = await post({ mode: 'batch' })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'CALL_NOTES_LIVE', error: 'This call is still finishing its notes. Reprocess it in a few minutes.' })
    expect(h.sessions).toBe(0)
    h.turnBusy = false
    seedDb(true)
    expect((await post({ mode: 'batch' })).status).not.toBe(409)
  })

  it('an ordinary capture’s live turns need no key', async () => {
    seedDb(false)
    const res = await post({ recent_chunks: ['Rosa Lind: I will send the contract today'] })
    expect(res.status).toBe(200)
    expect(h.sessions).toBe(1)
  })
})
