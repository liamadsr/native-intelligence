/**
 * Every delivered say_to_user nudge is a stored, remembered row (live sidekick
 * Phase 7). Runs the real say_to_user, the real conversation writer and the
 * real already-told read over one in-memory database; only the Realtime
 * broadcast and telemetry are stubbed.
 *
 *   - the broadcast's id is the row's ui_message_id;
 *   - a second nudge inside 20 s still writes its row (the old chat throttle
 *     dropped it, so it reached the HUD but not already-told, and the
 *     sidekick could say it again);
 *   - both nudges come back in already-told, oldest first;
 *   - the HUD's id rates the nudge through /api/account/chat/feedback (no
 *     "message not persisted" 404), its evidence the nudge's pointers.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import type { NextRequest } from 'next/server'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'
import { buildRequest, readJson } from '@/test/integration'

const { broadcasts, service, requireWorkspace } = vi.hoisted(() => ({
  broadcasts: [] as Array<{ id: string; message: string }>,
  service: { current: null as unknown },
  requireWorkspace: vi.fn(),
}))

vi.mock('@/lib/live-agent/nudge-channel', () => ({
  broadcastNudge: async (n: { id: string; message: string }) => {
    broadcasts.push(n)
    return true
  },
}))
vi.mock('@/lib/posthog', () => ({ trackServerEvent: vi.fn() }))
vi.mock('@/lib/ai/embeddings', () => ({ embed: vi.fn(async () => [0.1]) }))
vi.mock('@/lib/ai/claim-provenance', () => ({ attachClaimProvenance: vi.fn() }))
vi.mock('@/lib/proposed-changes/apply-engine', () => ({ updateAppliedEntity: vi.fn(), deleteAppliedEntity: vi.fn() }))
vi.mock('@/lib/mcp-client/adapter', () => ({ namespacedToolName: (s: string, t: string) => `mcp__${s}__${t}` }))
vi.mock('@/lib/api-auth', () => ({ requireWorkspace }))
vi.mock('@/lib/admin', async (orig) => ({ ...(await orig<typeof import('@/lib/admin')>()), getServiceClient: () => service.current }))

import { createLiveAgentTools } from '../tools'
import { fetchPriorNudges, renderAlreadyToldSection } from '../already-told'
import { POST as rate } from '@/app/api/account/chat/feedback/route'

const USER = 'b1000000-0000-4000-8000-000000000001'
const WS = 'a1000000-0000-4000-8000-000000000001'
const CAPTURE = 'd1000000-0000-4000-8000-000000000001'
const CONV = 'c1000000-0000-4000-8000-000000000001'
const EXEC = { toolCallId: 'tc', messages: [], context: {} } satisfies ToolExecutionOptions<Record<string, unknown>>

let db: FakeSupabase

beforeEach(() => {
  broadcasts.length = 0
  db = makeFakeSupabase({ unique: { eval_candidate: ['dedupe_key'] } })
  service.current = db
  requireWorkspace.mockResolvedValue({ supabase: {}, user: { id: USER }, workspaceId: WS })
  db.seed('captures', [{ id: CAPTURE, user_id: USER, workspace_id: WS }])
  db.seed('chat_conversations', [{ id: CONV, user_id: USER, workspace_id: WS, capture_id: CAPTURE }])
})

function say(message: string) {
  const tools = createLiveAgentTools(USER, db as never, WS, CAPTURE, null, null, null, null, null)
  return tools.say_to_user.execute!({ message }, EXEC) as Promise<{ delivered: boolean; id: string }>
}

describe('say_to_user rows', () => {
  it('a second nudge inside 20 s writes its row, under the broadcast id, and both are in already-told', async () => {
    const first = await say('Ask about the budget.')
    const second = await say('They have not named a start date yet.') // milliseconds later

    const rows = db.rows('chat_messages')
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.ui_message_id)).toEqual([first.id, second.id])
    expect(broadcasts.map((b) => b.id)).toEqual([first.id, second.id])
    for (const r of rows) {
      expect(r).toMatchObject({ conversation_id: CONV, user_id: USER, workspace_id: WS, role: 'assistant' })
      expect((r.ui_message as { metadata: Record<string, unknown> }).metadata).toMatchObject({ kind: 'say_to_user', nudge_kind: 'insight', capture_id: CAPTURE })
    }

    const prior = await fetchPriorNudges(db as never, CONV)
    expect(prior.map((p) => p.text)).toEqual(['Ask about the budget.', 'They have not named a start date yet.'])
    const section = renderAlreadyToldSection(prior)!
    expect(section).toContain('Ask about the budget.')
    expect(section).toContain('They have not named a start date yet.')
  })
})

describe('rating a nudge', () => {
  it('the id the HUD got rates the nudge, even one inside 20 s of the last; the evidence is pointers', async () => {
    await say('Ask about the budget.')
    const second = await say('They have not named a start date yet.')
    const nudgeId = broadcasts[1].id
    expect(nudgeId).toBe(second.id)

    const res = await rate(
      buildRequest({ url: 'https://nativeintelligence.dev/api/account/chat/feedback', body: { conversationId: CONV, messageId: nudgeId, rating: 'down', reason: 'Too early' } }) as unknown as NextRequest,
    )
    expect(res.status).toBe(200)
    expect(await readJson(res)).toEqual({ rating: 'down' })
    const [row] = db.rows('eval_candidate')
    expect(row).toMatchObject({ source: 'thumbs_down', ref_type: 'chat_message', ref_id: nudgeId, conversation_id: CONV, reason: 'Too early' })
    const evidence = row.evidence as Record<string, unknown>
    expect(evidence).toMatchObject({ kind: 'chat_turn', messageId: nudgeId, nudge_kind: 'insight', capture_id: CAPTURE, reply: 'They have not named a start date yet.' })
    expect(typeof evidence.nudge_at).toBe('string')
    expect(evidence).not.toHaveProperty('meeting_goal_id')
  })
})
