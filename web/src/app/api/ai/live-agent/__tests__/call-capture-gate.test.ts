/**
 * The auto-apply gate on a call the recorder heard (migration 587), driven
 * through the real POST /api/ai/live-agent: an action is filed as its
 * assignee's own only when the line it was quoted from was said by that
 * member's own roster row (588's capture_feed_quote_speakers, then
 * quoteIsTheirs). The owner asking "Rosa, can you send the contract?" is
 * staged, never filed as Rosa's; Rosa's own "I'll send the contract" is filed
 * as hers; a guest named like a member saying it is staged; the owner's own
 * words are filed as theirs only from their own line. An ordinary capture
 * (no roster rows) keeps its gate as it was: someone else's action is staged.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createFakeSupabase, eqValue, meetingFixture, FIX, type FakeQuery } from '@/lib/live-agent/__tests__/helpers/live-turn-fixture'
import { fakeTaskResponse, quietTurn } from '@/lib/live-agent/__tests__/helpers/fake-eve-turn'

const ROSA = 'mem-rosa'

const h = vi.hoisted(() => ({
  client: null as unknown as SupabaseClient,
  applied: [] as string[],
  quotes: [] as string[],
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
vi.mock('@/lib/crm/contacts', async (orig) => ({ ...(await orig<typeof import('@/lib/crm/contacts')>()), seedSelfParticipant: async () => {} }))
vi.mock('@/lib/live-agent/conversation-writer', async (orig) => ({ ...(await orig<typeof import('@/lib/live-agent/conversation-writer')>()), syncProposalsCard: async () => {} }))
vi.mock('@/lib/live-agent/nudge-channel', async (orig) => ({ ...(await orig<typeof import('@/lib/live-agent/nudge-channel')>()), broadcastNudge: async () => true }))
vi.mock('@/lib/flows/emit-capture-processed', () => ({ emitCaptureProcessed: () => {} }))
vi.mock('@/lib/eve/task-session', () => ({
  createTaskSession: async () => fakeTaskResponse(quietTurn()),
  cancelTaskSession: async () => true,
}))
// What the gate let through is what reaches the apply engine.
vi.mock('@/lib/proposed-changes/apply-engine', async (orig) => ({
  ...(await orig<typeof import('@/lib/proposed-changes/apply-engine')>()),
  applyChange: async (_sb: unknown, change: { id: string }) => {
    h.applied.push(change.id)
    return { success: true, entity_id: `act-${change.id}` }
  },
}))

const { POST } = await import('../route')

/** The proposals pending on the capture, each an action for someone, quoting a line. */
const proposals = [
  { id: 'pc-ask', assignee_member_id: ROSA, assignee_name: 'Rosa Lind', trigger_quote: 'Rosa, can you send the contract?', extra: { assignee_resolution: 'speaker_label' } },
  { id: 'pc-rosa', assignee_member_id: ROSA, assignee_name: 'Rosa Lind', trigger_quote: 'I will send the contract today', extra: { assignee_resolution: 'speaker_label' } },
  { id: 'pc-guest', assignee_member_id: ROSA, assignee_name: 'Rosa Lind', trigger_quote: 'I can draft the proposal tonight', extra: { assignee_resolution: 'speaker_label' } },
  { id: 'pc-mine', assignee_member_id: FIX.memberId, assignee_name: FIX.memberName, trigger_quote: 'I will book the venue', extra: { assignee_resolution: 'speaker_label' } },
  { id: 'pc-name-only', assignee_member_id: ROSA, assignee_name: 'Rosa Lind', trigger_quote: null, extra: { assignee_resolution: 'speaker_label' } },
].map((p) => ({ ...p, change_type: 'create', entity_type: 'action', status: 'pending', confidence: 0.97, title: p.id, display_text: p.id, sort_order: 0 }))

/** Who said each quote, as 588 answers it: the owner asked Rosa; Rosa promised; a guest named Rosa Lind spoke; the owner promised. */
const speakers: Record<string, Array<{ participant_id: string; member_id: string | null; source: string }>> = {
  'Rosa, can you send the contract?': [{ participant_id: 'p-owner', member_id: FIX.memberId, source: 'call_roster' }],
  'I will send the contract today': [{ participant_id: 'p-rosa', member_id: ROSA, source: 'call_roster' }],
  'I can draft the proposal tonight': [{ participant_id: 'p-guest', member_id: null, source: 'call_roster' }],
  'I will book the venue': [{ participant_id: 'p-owner', member_id: FIX.memberId, source: 'call_roster' }],
}

function useDb(opts: { callRoster: boolean }) {
  const base = meetingFixture()
  const fake = createFakeSupabase((q: FakeQuery) => {
    if (q.table === 'proposed_change' && q.op === 'select' && q.columns === '*' && eqValue(q, 'status') === 'pending') {
      return { data: proposals, error: null }
    }
    if (q.table === 'proposed_change' && q.op === 'update') return { data: { id: eqValue(q, 'id') }, error: null }
    if (q.table === 'capture_participant' && eqValue(q, 'source') === 'call_roster') {
      return { data: opts.callRoster ? [{ id: 'p-owner' }] : [], error: null }
    }
    if (q.table === 'rpc:capture_feed_quote_speakers') {
      const quote = (q.payload as { p_quote: string }).p_quote
      h.quotes.push(quote)
      return { data: speakers[quote] ?? [], error: null }
    }
    return base(q)
  })
  h.client = fake.client
}

const post = () =>
  POST(new Request('https://app.test/api/ai/live-agent', { method: 'POST', body: JSON.stringify({ capture_id: FIX.captureId, recent_chunks: ['Rosa Lind: I will send the contract today'] }) }))

beforeEach(() => {
  process.env.LIVE_AGENT_INTERNAL_SECRET = 'route-secret'
  h.applied = []
  h.quotes = []
})

describe('the auto-apply gate on a call the recorder heard', () => {
  it('files an action as someone’s own only from a line their own roster row said', async () => {
    useDb({ callRoster: true })
    const res = await post()
    expect(res.status).toBe(200)
    // Rosa's own promise is hers; the owner's own promise is the owner's.
    expect(h.applied).toContain('pc-rosa')
    expect(h.applied).toContain('pc-mine')
    // "Rosa, can you…" said by the owner: staged. A guest named like Rosa: staged. No quote at all: staged.
    expect(h.applied).not.toContain('pc-ask')
    expect(h.applied).not.toContain('pc-guest')
    expect(h.applied).not.toContain('pc-name-only')
  })

  it('an ordinary capture keeps its gate: someone else’s action is staged whatever its label says', async () => {
    useDb({ callRoster: false })
    await post()
    expect(h.applied).not.toContain('pc-rosa')
    expect(h.applied).not.toContain('pc-ask')
    expect(h.applied).not.toContain('pc-guest')
    expect(h.quotes).toEqual([])
  })
})
