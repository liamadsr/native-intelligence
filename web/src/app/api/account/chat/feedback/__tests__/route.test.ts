/**
 * /api/account/chat/feedback — thumbs ratings as eval candidates. Pinned:
 *   - auth through requireWorkspace; the conversation must be the caller's
 *     in this workspace (404 otherwise, nothing written);
 *   - the evidence is built from the stored messages, never the body: only
 *     `reason` is the client's;
 *   - 404 for a message not persisted yet (or not the assistant's);
 *   - a server-written home turn (no message of the person's before it) is
 *     rateable: its request says what started it, and a turn that read mail
 *     keeps no reply;
 *   - a live nudge is rateable: its evidence carries pointers (kind, capture,
 *     when, the call's goal id), never meeting text;
 *   - a thumbs-down nudge's reason chip is `evidence.nudge_reason`: an
 *     unknown chip, a chip on a thumbs-up or on a chat reply is a 400, and
 *     the same thumbs-down again keeps it; only the call's owner rates its
 *     nudges (the conversation is theirs);
 *   - one row per message per person: a changed rating updates in place;
 *     null clears a `new` row;
 *   - 409 LOCKED when clearing or changing a promoted or exported rating, the
 *     rating kept and named; the same rating again is a no-op 200;
 *   - 400 on bad input;
 *   - GET returns only the caller's ratings in that conversation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { buildRequest, readJson } from '@/test/integration'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'
import { assistantMessage, nudgeMessage, userMessage } from '@/lib/evals/flywheel/__tests__/fixtures'
import type { ChatTurnEvidence } from '@/lib/evals/flywheel/types'

const hoisted = vi.hoisted(() => ({ requireWorkspace: vi.fn(), service: { current: null as unknown } }))
vi.mock('@/lib/api-auth', () => ({ requireWorkspace: hoisted.requireWorkspace }))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => hoisted.service.current }))

import { GET, POST } from '@/app/api/account/chat/feedback/route'

const WS = 'a1000000-0000-4000-8000-000000000001'
const OTHER_WS = 'a1000000-0000-4000-8000-000000000002'
const USER = 'b1000000-0000-4000-8000-000000000001'
const OTHER_USER = 'b1000000-0000-4000-8000-000000000002'
const CONV = 'c1000000-0000-4000-8000-000000000001'
const OTHER_CONV = 'c1000000-0000-4000-8000-000000000002'

let fake: FakeSupabase

function signIn(userId = USER, workspaceId = WS) {
  hoisted.requireWorkspace.mockResolvedValue({ supabase: {}, user: { id: userId }, workspaceId })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  fake = makeFakeSupabase({ unique: { eval_candidate: ['dedupe_key'] } })
  hoisted.service.current = fake
  fake.seed('chat_conversations', [
    { id: CONV, user_id: USER, workspace_id: WS },
    { id: OTHER_CONV, user_id: OTHER_USER, workspace_id: WS },
  ])
  fake.seed('chat_messages', [
    { id: 'r1', conversation_id: CONV, user_id: USER, workspace_id: WS, role: 'user', ui_message: userMessage('Move ENG-1 to done'), ui_message_id: 'msg-u1', created_at: '2026-10-16T09:59:00.000Z' },
    { id: 'r2', conversation_id: CONV, user_id: USER, workspace_id: WS, role: 'assistant', ui_message: assistantMessage('msg-a1'), ui_message_id: 'msg-a1', created_at: '2026-10-16T10:00:00.000Z' },
  ])
  signIn()
})

const post = (body: unknown) => POST(buildRequest({ url: 'https://nativeintelligence.dev/api/account/chat/feedback', body }) as unknown as NextRequest)
const get = (conversationId: string) =>
  GET(buildRequest({ url: `https://nativeintelligence.dev/api/account/chat/feedback?conversationId=${conversationId}`, method: 'GET' }) as unknown as NextRequest)

describe('POST', () => {
  it('auth: a failed requireWorkspace is returned as is', async () => {
    hoisted.requireWorkspace.mockResolvedValue(new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }))
    expect((await post({ conversationId: CONV, messageId: 'msg-a1', rating: 'down' })).status).toBe(401)
    expect(fake.rows('eval_candidate')).toHaveLength(0)
  })

  it('a thumbs-down records a candidate built from the stored turn; client text beyond reason is ignored', async () => {
    const res = await post({ conversationId: CONV, messageId: 'msg-a1', rating: 'down', reason: '  It picked the wrong action ', request: 'FORGED', evidence: { request: 'FORGED' } })
    expect(res.status).toBe(200)
    expect(await readJson(res)).toEqual({ rating: 'down' })
    const [row] = fake.rows('eval_candidate')
    expect(row).toMatchObject({
      workspace_id: WS,
      user_id: USER,
      source: 'thumbs_down',
      polarity: 'bad',
      dedupe_key: 'feedback:msg-a1',
      ref_type: 'chat_message',
      ref_id: 'msg-a1',
      conversation_id: CONV,
      reason: 'It picked the wrong action',
      skill_slugs: ['triage'],
      status: 'new',
    })
    const ev = row.evidence as ChatTurnEvidence
    expect(ev.request).toBe('Move ENG-1 to done')
    expect(JSON.stringify(row)).not.toContain('FORGED')
  })

  it('a home turn the server wrote, with no message of the person’s before it, records', async () => {
    const home = { id: 'home-turn:h1', role: 'assistant', metadata: { kind: 'home_turn', home_turn_id: 'h1', reason: 'event' }, parts: [{ type: 'text', text: 'Dana replied about the renewal.' }] }
    const conv = 'c1000000-0000-4000-8000-000000000003'
    fake.seed('chat_conversations', [{ id: conv, user_id: USER, workspace_id: WS }])
    fake.seed('chat_messages', [{ id: 'r9', conversation_id: conv, user_id: USER, workspace_id: WS, role: 'assistant', ui_message: home, ui_message_id: 'home-turn:h1', created_at: '2026-10-16T08:00:00.000Z' }])
    const res = await post({ conversationId: conv, messageId: 'home-turn:h1', rating: 'down' })
    expect(res.status).toBe(200)
    const [row] = fake.rows('eval_candidate')
    expect(row).toMatchObject({ source: 'thumbs_down', ref_id: 'home-turn:h1', conversation_id: conv, dedupe_key: 'feedback:home-turn:h1' })
    const ev = row.evidence as ChatTurnEvidence
    expect(ev.request).toMatch(/nobody typed this.*event/)
    expect(ev.reply).toBe('Dana replied about the renewal.')
  })

  it('a live nudge records with its pointers (kind, capture, when, goal id) and no meeting text', async () => {
    const conv = 'c1000000-0000-4000-8000-000000000004'
    const capture = 'd1000000-0000-4000-8000-000000000001'
    const nudgeId = 'e1000000-0000-4000-8000-000000000001'
    fake.seed('chat_conversations', [{ id: conv, user_id: USER, workspace_id: WS, capture_id: capture }])
    fake.seed('meeting_goal', [{ id: 'f1000000-0000-4000-8000-000000000001', workspace_id: WS, user_id: USER, capture_id: capture, goal: 'Land the pilot', updated_at: '2026-10-16T09:00:00.000Z' }])
    fake.seed('chat_messages', [
      { id: 'r10', conversation_id: conv, user_id: USER, workspace_id: WS, role: 'assistant', ui_message: nudgeMessage(nudgeId, 'Ask who signs off.', 'reminder', capture), ui_message_id: nudgeId, created_at: '2026-10-16T10:01:00.000Z' },
    ])
    const res = await post({ conversationId: conv, messageId: nudgeId, rating: 'up' })
    expect(res.status).toBe(200)
    const [row] = fake.rows('eval_candidate')
    expect(row).toMatchObject({ source: 'thumbs_up', ref_id: nudgeId, conversation_id: conv })
    expect(row.evidence).toMatchObject({
      messageId: nudgeId,
      reply: 'Ask who signs off.',
      nudge_kind: 'reminder',
      capture_id: capture,
      nudge_at: '2026-10-16T10:01:00.000Z',
      meeting_goal_id: 'f1000000-0000-4000-8000-000000000001',
    })
    expect(JSON.stringify(row.evidence)).not.toContain('Land the pilot')
  })

  describe('a nudge’s reason chip', () => {
    const conv = 'c1000000-0000-4000-8000-000000000005'
    const capture = 'd1000000-0000-4000-8000-000000000002'
    const nudgeId = 'e1000000-0000-4000-8000-000000000002'
    beforeEach(() => {
      fake.seed('chat_conversations', [{ id: conv, user_id: USER, workspace_id: WS, capture_id: capture }])
      fake.seed('chat_messages', [
        { id: 'r11', conversation_id: conv, user_id: USER, workspace_id: WS, role: 'assistant', ui_message: nudgeMessage(nudgeId, 'Ask who signs off.', 'reminder', capture), ui_message_id: nudgeId, created_at: '2026-10-16T10:01:00.000Z' },
      ])
    })

    it('stored as evidence.nudge_reason on a thumbs-down, with the optional words as reason', async () => {
      const res = await post({ conversationId: conv, messageId: nudgeId, rating: 'down', nudge_reason: 'too_late', reason: 'The moment had passed' })
      expect(res.status).toBe(200)
      const [row] = fake.rows('eval_candidate')
      expect(row).toMatchObject({ source: 'thumbs_down', reason: 'The moment had passed' })
      expect(row.evidence).toMatchObject({ nudge_kind: 'reminder', nudge_reason: 'too_late' })
    })

    it('the same thumbs-down again keeps its chip unless a new one came; a thumbs-up drops it', async () => {
      await post({ conversationId: conv, messageId: nudgeId, rating: 'down', nudge_reason: 'repeated' })
      await post({ conversationId: conv, messageId: nudgeId, rating: 'down', reason: 'Said it twice' })
      expect(fake.rows('eval_candidate')[0].evidence).toMatchObject({ nudge_reason: 'repeated' })
      await post({ conversationId: conv, messageId: nudgeId, rating: 'down', nudge_reason: 'wrong' })
      expect(fake.rows('eval_candidate')[0].evidence).toMatchObject({ nudge_reason: 'wrong' })
      await post({ conversationId: conv, messageId: nudgeId, rating: 'up' })
      expect(fake.rows('eval_candidate')).toHaveLength(1)
      expect(fake.rows('eval_candidate')[0].evidence).not.toHaveProperty('nudge_reason')
    })

    it('400 for an unknown chip, a chip on a thumbs-up, or a chip on a chat reply; nothing written', async () => {
      for (const body of [
        { conversationId: conv, messageId: nudgeId, rating: 'down', nudge_reason: 'boring' },
        { conversationId: conv, messageId: nudgeId, rating: 'down', nudge_reason: 7 },
        { conversationId: conv, messageId: nudgeId, rating: 'up', nudge_reason: 'wrong' },
        { conversationId: CONV, messageId: 'msg-a1', rating: 'down', nudge_reason: 'wrong' },
      ]) {
        expect((await post(body)).status, JSON.stringify(body)).toBe(400)
      }
      expect(fake.rows('eval_candidate')).toHaveLength(0)
    })

    it('only the call’s owner rates its nudges: another member gets a 404, nothing written', async () => {
      signIn(OTHER_USER)
      expect((await post({ conversationId: conv, messageId: nudgeId, rating: 'down', nudge_reason: 'wrong' })).status).toBe(404)
      expect(fake.rows('eval_candidate')).toHaveLength(0)
    })
  })

  it('a turn that used a mail tool keeps the request and the tool path, not the reply', async () => {
    await post({ conversationId: CONV, messageId: 'msg-a1', rating: 'down' })
    const ev = fake.rows('eval_candidate')[0].evidence as ChatTurnEvidence
    // The fixture's turn ran create_email_draft.
    expect(ev.reply).toBeUndefined()
    expect(ev.request).toBe('Move ENG-1 to done')
    expect(ev.steps.map((step) => step.name)).toContain('create_email_draft')
  })

  it('a changed rating updates the same row in place, and a new reason replaces the old', async () => {
    await post({ conversationId: CONV, messageId: 'msg-a1', rating: 'down', reason: 'wrong' })
    const res = await post({ conversationId: CONV, messageId: 'msg-a1', rating: 'up' })
    expect(await readJson(res)).toEqual({ rating: 'up' })
    const rows = fake.rows('eval_candidate')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ source: 'thumbs_up', polarity: 'good', reason: null })
  })

  it('the same rating again keeps the reason unless a new one comes', async () => {
    await post({ conversationId: CONV, messageId: 'msg-a1', rating: 'down', reason: 'wrong' })
    await post({ conversationId: CONV, messageId: 'msg-a1', rating: 'down' })
    expect(fake.rows('eval_candidate')[0].reason).toBe('wrong')
    await post({ conversationId: CONV, messageId: 'msg-a1', rating: 'down', reason: 'still wrong' })
    expect(fake.rows('eval_candidate')[0].reason).toBe('still wrong')
  })

  it('null clears a new rating; clearing nothing is fine', async () => {
    await post({ conversationId: CONV, messageId: 'msg-a1', rating: 'down' })
    const res = await post({ conversationId: CONV, messageId: 'msg-a1', rating: null })
    expect(res.status).toBe(200)
    expect(await readJson(res)).toEqual({ rating: null })
    expect(fake.rows('eval_candidate')).toHaveLength(0)
    expect((await post({ conversationId: CONV, messageId: 'msg-a1', rating: null })).status).toBe(200)
  })

  it('404 when the conversation is someone else’s, or in another workspace; nothing written', async () => {
    const res = await post({ conversationId: OTHER_CONV, messageId: 'msg-a1', rating: 'down' })
    expect(res.status).toBe(404)
    expect((await readJson<{ code: string }>(res)).code).toBe('NOT_FOUND')
    signIn(USER, OTHER_WS)
    expect((await post({ conversationId: CONV, messageId: 'msg-a1', rating: 'down' })).status).toBe(404)
    expect(fake.rows('eval_candidate')).toHaveLength(0)
  })

  it('404 when the message is not persisted yet, or is the person’s own', async () => {
    expect((await post({ conversationId: CONV, messageId: 'msg-not-yet', rating: 'down' })).status).toBe(404)
    expect((await post({ conversationId: CONV, messageId: 'msg-u1', rating: 'up' })).status).toBe(404)
    expect(fake.rows('eval_candidate')).toHaveLength(0)
  })

  for (const status of ['promoted', 'exported']) {
    it(`409 LOCKED when clearing or changing a ${status} rating; the rating stays`, async () => {
      await post({ conversationId: CONV, messageId: 'msg-a1', rating: 'down', reason: 'wrong' })
      fake.rows('eval_candidate')[0].status = status
      for (const rating of [null, 'up']) {
        const res = await post({ conversationId: CONV, messageId: 'msg-a1', rating })
        expect(res.status).toBe(409)
        expect(await readJson(res)).toMatchObject({ code: 'LOCKED', details: { rating: 'down' } })
      }
      expect(fake.rows('eval_candidate')[0]).toMatchObject({ status, source: 'thumbs_down', reason: 'wrong' })
      // The same rating again changes nothing and is fine.
      expect((await post({ conversationId: CONV, messageId: 'msg-a1', rating: 'down' })).status).toBe(200)
    })
  }

  it.each([
    [{ conversationId: 'nope', messageId: 'msg-a1', rating: 'down' }],
    [{ conversationId: CONV, messageId: '', rating: 'down' }],
    [{ conversationId: CONV, messageId: 'has spaces', rating: 'down' }],
    [{ conversationId: CONV, messageId: 'msg-a1', rating: 'meh' }],
    [{ conversationId: CONV, messageId: 'msg-a1' }],
    [{ conversationId: CONV, messageId: 'msg-a1', rating: 'down', reason: 'x'.repeat(501) }],
    [{ conversationId: CONV, messageId: 'msg-a1', rating: 'down', reason: 7 }],
    [['not', 'an', 'object']],
  ])('400 on bad input %#', async (body) => {
    const res = await post(body)
    expect(res.status).toBe(400)
    expect(fake.rows('eval_candidate')).toHaveLength(0)
  })

  it('400 on a body that is not JSON', async () => {
    const res = await POST(buildRequest({ url: 'https://nativeintelligence.dev/api/account/chat/feedback', body: '{nope', raw: true }) as unknown as NextRequest)
    expect(res.status).toBe(400)
  })
})

describe('GET', () => {
  it('the caller’s ratings in that conversation, by message id', async () => {
    fake.seed('eval_candidate', [
      { id: 'e1', workspace_id: WS, user_id: USER, conversation_id: CONV, source: 'thumbs_down', ref_id: 'msg-a1', dedupe_key: 'feedback:msg-a1', status: 'new' },
      { id: 'e2', workspace_id: WS, user_id: USER, conversation_id: CONV, source: 'thumbs_up', ref_id: 'msg-a2', dedupe_key: 'feedback:msg-a2', status: 'promoted' },
      // Not a rating.
      { id: 'e3', workspace_id: WS, user_id: USER, conversation_id: CONV, source: 'repeated_failure', ref_id: 'msg-a1', dedupe_key: 'chat:msg-a1:REPEATED_FAILURE', status: 'new' },
      // Someone else's, same conversation id.
      { id: 'e4', workspace_id: WS, user_id: OTHER_USER, conversation_id: CONV, source: 'thumbs_up', ref_id: 'msg-a3', dedupe_key: 'feedback:msg-a3', status: 'new' },
    ])
    const res = await get(CONV)
    expect(res.status).toBe(200)
    expect(await readJson(res)).toEqual({ ratings: { 'msg-a1': 'down', 'msg-a2': 'up' } })
  })

  it('404 for someone else’s conversation, 400 for a bad id', async () => {
    expect((await get(OTHER_CONV)).status).toBe(404)
    expect((await get('nope')).status).toBe(400)
  })
})
