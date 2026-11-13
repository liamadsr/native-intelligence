/**
 * Decisions and milestones on a call the recorder heard (migration 587),
 * through the real POST /api/ai/live-agent: filed without a person's click
 * only when the line they were quoted from was said by a member (their own
 * roster row), as an action is only when said by its assignee. A guest's
 * "we decided to ship Monday" stays a suggestion for the owner; a decision
 * with no quote too. An ordinary capture keeps its gate (explicitly stated
 * and confident: filed).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createFakeSupabase, eqValue, meetingFixture, FIX, type FakeQuery } from '@/lib/live-agent/__tests__/helpers/live-turn-fixture'
import { fakeTaskResponse, quietTurn } from '@/lib/live-agent/__tests__/helpers/fake-eve-turn'

const h = vi.hoisted(() => ({ client: null as unknown as SupabaseClient, applied: [] as string[] }))

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
vi.mock('@/lib/eve/task-session', () => ({ createTaskSession: async () => fakeTaskResponse(quietTurn()), cancelTaskSession: async () => true }))
vi.mock('@/lib/proposed-changes/apply-engine', async (orig) => ({
  ...(await orig<typeof import('@/lib/proposed-changes/apply-engine')>()),
  applyChange: async (_sb: unknown, change: { id: string }) => {
    h.applied.push(change.id)
    return { success: true, entity_id: `ent-${change.id}` }
  },
}))

const { POST } = await import('../route')

const proposals = [
  { id: 'dec-member', entity_type: 'decision', trigger_quote: 'We decided to ship on Monday' },
  { id: 'dec-guest', entity_type: 'decision', trigger_quote: 'So we decided the price is final' },
  { id: 'ms-guest', entity_type: 'milestone', trigger_quote: 'The pilot ends on the first' },
  { id: 'dec-no-quote', entity_type: 'decision', trigger_quote: null },
].map((p) => ({ ...p, change_type: 'create', status: 'pending', confidence: 0.97, title: p.id, display_text: p.id, sort_order: 0, extra: { is_explicitly_stated: true } }))

const speakers: Record<string, Array<{ participant_id: string; member_id: string | null; source: string }>> = {
  'We decided to ship on Monday': [{ participant_id: 'p-rosa', member_id: 'mem-rosa', source: 'call_roster' }],
  'So we decided the price is final': [{ participant_id: 'p-guest', member_id: null, source: 'call_roster' }],
  'The pilot ends on the first': [{ participant_id: 'p-guest', member_id: null, source: 'call_roster' }],
}

function useDb(callRoster: boolean) {
  const base = meetingFixture()
  h.client = createFakeSupabase((q: FakeQuery) => {
    if (q.table === 'proposed_change' && q.op === 'select' && q.columns === '*' && eqValue(q, 'status') === 'pending') return { data: proposals, error: null }
    if (q.table === 'proposed_change' && q.op === 'update') return { data: { id: eqValue(q, 'id') }, error: null }
    if (q.table === 'capture_participant' && eqValue(q, 'source') === 'call_roster') return { data: callRoster ? [{ id: 'p-owner' }] : [], error: null }
    if (q.table === 'rpc:capture_feed_quote_speakers') return { data: speakers[(q.payload as { p_quote: string }).p_quote] ?? [], error: null }
    return base(q)
  }).client
}

const post = () => POST(new Request('https://app.test/api/ai/live-agent', { method: 'POST', body: JSON.stringify({ capture_id: FIX.captureId, recent_chunks: ['Rosa Lind: We decided to ship on Monday'] }) }))

beforeEach(() => {
  process.env.LIVE_AGENT_INTERNAL_SECRET = 'route-secret'
  h.applied = []
})

describe('decisions and milestones on a call the recorder heard', () => {
  it('filed only when a member said the line; a guest’s, or none, stays a suggestion', async () => {
    useDb(true)
    expect((await post()).status).toBe(200)
    expect(h.applied).toContain('dec-member')
    expect(h.applied).not.toContain('dec-guest')
    expect(h.applied).not.toContain('ms-guest')
    expect(h.applied).not.toContain('dec-no-quote')
  })

  it('an ordinary capture keeps its gate', async () => {
    useDb(false)
    await post()
    expect(h.applied).toEqual(expect.arrayContaining(['dec-member', 'dec-guest', 'ms-guest', 'dec-no-quote']))
  })
})
