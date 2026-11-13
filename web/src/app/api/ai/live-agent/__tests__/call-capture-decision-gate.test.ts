/**
 * Decisions and milestones on a call the recorder heard (migration 587),
 * through the real POST /api/ai/live-agent: filed without a person's click
 * only when the line they were quoted from was said by a member (their own
 * roster row), as an action is only when said by its assignee. A guest's
 * "we decided to ship Monday" stays a suggestion for the owner; a decision
 * with no quote too. A call's capture from before the roster (no line anyone
 * is known to have said) files nothing without a click, whatever its
 * pass. A follow-up email draft on a call's capture is always staged for its
 * owner, even where the workspace's allow_external would apply it. An
 * ordinary capture keeps its gate (explicitly stated
 * and confident: filed).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createFakeSupabase, eqValue, meetingFixture, FIX, type FakeQuery } from '@/lib/live-agent/__tests__/helpers/live-turn-fixture'
import { fakeTaskResponse, quietTurn } from '@/lib/live-agent/__tests__/helpers/fake-eve-turn'

const h = vi.hoisted(() => ({ client: null as unknown as SupabaseClient, applied: [] as string[], allowExternal: false }))

vi.mock('@/lib/proposed-changes/trust-policy', async (orig) => {
  const real = await orig<typeof import('@/lib/proposed-changes/trust-policy')>()
  return {
    ...real,
    resolveTrustPolicyFromSettings: (s: unknown) => {
      const p = real.resolveTrustPolicyFromSettings(s)
      return h.allowExternal ? { ...p, allow_external: true } : p
    },
  }
})

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
// A follow-up email draft (the end-of-call pass's), said by a member.
const draft = { id: 'draft', change_type: 'send_email', entity_type: 'action', trigger_quote: 'We decided to ship on Monday', status: 'pending', confidence: 0.97, title: 'Follow up', display_text: 'Follow up', sort_order: 0, extra: {} }

const speakers: Record<string, Array<{ participant_id: string; member_id: string | null; source: string }>> = {
  'We decided to ship on Monday': [{ participant_id: 'p-rosa', member_id: 'mem-rosa', source: 'call_roster' }],
  'So we decided the price is final': [{ participant_id: 'p-guest', member_id: null, source: 'call_roster' }],
  'The pilot ends on the first': [{ participant_id: 'p-guest', member_id: null, source: 'call_roster' }],
}

function seedDb(callRoster: boolean, opts: { callCaptureRow?: boolean; withDraft?: boolean } = {}) {
  const base = meetingFixture()
  h.client = createFakeSupabase((q: FakeQuery) => {
    if (q.table === 'proposed_change' && q.op === 'select' && q.columns === '*' && eqValue(q, 'status') === 'pending') return { data: opts.withDraft ? [...proposals, draft] : proposals, error: null }
    if (q.table === 'proposed_change' && q.op === 'update') return { data: { id: eqValue(q, 'id') }, error: null }
    if (q.table === 'capture_participant' && eqValue(q, 'source') === 'call_roster') return { data: callRoster ? [{ id: 'p-owner' }] : [], error: null }
    if (q.table === 'rpc:capture_feed_quote_speakers') return { data: callRoster ? speakers[(q.payload as { p_quote: string }).p_quote] ?? [] : [], error: null }
    const r = base(q)
    // A call's capture (its notes channel set), here from before the roster.
    if (opts.callCaptureRow && q.table === 'captures' && r.data && !Array.isArray(r.data)) {
      return { ...r, data: { ...(r.data as Record<string, unknown>), notes_channel_id: 'chan-call-1' } }
    }
    return r
  }).client
}

const post = () => POST(new Request('https://app.test/api/ai/live-agent', { method: 'POST', body: JSON.stringify({ capture_id: FIX.captureId, recent_chunks: ['Rosa Lind: We decided to ship on Monday'] }) }))

beforeEach(() => {
  process.env.LIVE_AGENT_INTERNAL_SECRET = 'route-secret'
  h.applied = []
  h.allowExternal = false
})

describe('decisions and milestones on a call the recorder heard', () => {
  it('filed only when a member said the line; a guest’s, or none, stays a suggestion', async () => {
    seedDb(true)
    expect((await post()).status).toBe(200)
    expect(h.applied).toContain('dec-member')
    expect(h.applied).not.toContain('dec-guest')
    expect(h.applied).not.toContain('ms-guest')
    expect(h.applied).not.toContain('dec-no-quote')
  })

  it('a call’s capture from before the roster (no line anyone is known to have said): nothing filed without a click', async () => {
    // A batch: a call's capture takes no device's live turn; its Reprocess is the owner's batch (the call long over).
    const batch = () => POST(new Request('https://app.test/api/ai/live-agent', { method: 'POST', body: JSON.stringify({ capture_id: FIX.captureId, mode: 'batch' }) }))
    // The same batch on an ordinary capture files them: the pass reaches the gate.
    seedDb(false)
    expect((await batch()).status).toBe(200)
    expect(h.applied).toEqual(expect.arrayContaining(['dec-member', 'dec-guest']))
    h.applied = []
    seedDb(false, { callCaptureRow: true })
    expect((await batch()).status).toBe(200)
    expect(h.applied).toEqual([])
  })

  it('a follow-up email draft on a call’s capture is staged for its owner, even with allow_external on', async () => {
    h.allowExternal = true
    const batch = () => POST(new Request('https://app.test/api/ai/live-agent', { method: 'POST', body: JSON.stringify({ capture_id: FIX.captureId, mode: 'batch' }) }))
    // An ordinary capture with allow_external: the draft rides the actions rule and is applied.
    seedDb(false, { withDraft: true })
    await batch()
    expect(h.applied).toContain('draft')
    h.applied = []
    // A call's capture (roster or not): never.
    for (const callRoster of [true, false]) {
      seedDb(callRoster, { callCaptureRow: true, withDraft: true })
      expect((await batch()).status).toBe(200)
      expect(h.applied).not.toContain('draft')
    }
    // With the roster, the member's decision is still filed: only the draft was held.
    seedDb(true, { callCaptureRow: true, withDraft: true })
    h.applied = []
    await batch()
    expect(h.applied).toContain('dec-member')
  })

  it('an ordinary capture keeps its gate', async () => {
    seedDb(false)
    await post()
    expect(h.applied).toEqual(expect.arrayContaining(['dec-member', 'dec-guest', 'ms-guest', 'dec-no-quote']))
  })
})
