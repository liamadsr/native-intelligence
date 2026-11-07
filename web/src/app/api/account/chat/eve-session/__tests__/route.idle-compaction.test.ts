/**
 * POST /api/account/chat/eve-session — the idle-compaction "someone is here"
 * signals (src/lib/chat/idle-compaction-signal.ts), ids only:
 *   - a mint signals `mint`, only after a token was minted, never for a
 *     refused mint, and never with the caller's JWT;
 *   - `presence` (the composer, typing in an existing conversation) signals
 *     `typing` only for the caller's own conversation, in this workspace,
 *     with a registered eve session; one of the caller's with no session yet
 *     is a quiet 200 (nothing to compact), anything else a 404, neither signals;
 *     at most 10 a minute per person (429 past it, before any read).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'

const state: { db: FakeSupabase | null } = { db: null }
vi.mock('@/lib/api-auth', () => ({
  requireWorkspace: async () => ({ supabase: state.db, user: { id: 'user-1' }, workspaceId: 'ws-1' }),
}))
vi.mock('@/lib/chat/chat-run-token', () => ({ mintChatRunToken: () => 'signed.token', internalSecret: () => 'test-secret' }))
const checkUsageLimits = vi.fn(async (_u: string): Promise<void> => undefined)
vi.mock('@/lib/ai/auth', () => ({ checkUsageLimits: (u: string) => checkUsageLimits(u) }))
vi.mock('@/lib/chat/chat-run-credential', () => ({ sealRunCredential: () => 'sealed' }))
vi.mock('@/lib/chat/conversation-history', () => ({ renderConversationPrimer: async () => null }))
const signalChatSessionActivity = vi.fn()
vi.mock('@/lib/chat/idle-compaction-signal', async () => {
  const actual = await vi.importActual<typeof import('@/lib/chat/idle-compaction-signal')>('@/lib/chat/idle-compaction-signal')
  return {
    allowPresencePing: actual.allowPresencePing,
    resetChatActivityThrottle: actual.resetChatActivityThrottle,
    signalChatSessionActivity: (a: unknown) => signalChatSessionActivity(a),
  }
})

import { POST } from '../route'
import { resetChatActivityThrottle } from '@/lib/chat/idle-compaction-signal'
import type { NextRequest } from 'next/server'

const jwt = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ sub: 'user-1' })).toString('base64url')}.c2ln`
const req = (body: Record<string, unknown>, bearer?: string) =>
  new Request('http://localhost/api/account/chat/eve-session', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify(body),
  }) as unknown as NextRequest

beforeEach(() => {
  vi.clearAllMocks()
  resetChatActivityThrottle()
  const db = makeFakeSupabase()
  db.seed('chat_conversations', [
    { id: 'conv-1', user_id: 'user-1', workspace_id: 'ws-1', eve_session_id: 'sess-1', agent_teammate_id: null, focus_area: null },
    { id: 'conv-other-user', user_id: 'user-2', workspace_id: 'ws-1', eve_session_id: 'sess-2', agent_teammate_id: null, focus_area: null },
    { id: 'conv-other-ws', user_id: 'user-1', workspace_id: 'ws-2', eve_session_id: 'sess-3', agent_teammate_id: null, focus_area: null },
    { id: 'conv-no-session', user_id: 'user-1', workspace_id: 'ws-1', eve_session_id: null, agent_teammate_id: null, focus_area: null },
  ])
  state.db = db
})

describe('mint → idle-compaction signal', () => {
  it('signals the minted conversation, ids only (never the caller’s JWT)', async () => {
    const res = await POST(req({ action: 'mint', conversationId: 'conv-1' }, jwt))
    expect(res.status).toBe(200)
    expect(signalChatSessionActivity).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      workspaceId: 'ws-1',
      userId: 'user-1',
      source: 'mint',
    })
  })

  it('a refused mint (usage limit) signals nothing', async () => {
    checkUsageLimits.mockRejectedValueOnce(new Response('{}', { status: 429 }))
    const res = await POST(req({ action: 'mint', conversationId: 'conv-1' }, jwt))
    expect(res.status).toBe(429)
    expect(signalChatSessionActivity).not.toHaveBeenCalled()
  })

  it('register signals nothing', async () => {
    await POST(req({ action: 'register', conversationId: 'conv-1', sessionId: 'sess-2' }, jwt))
    expect(signalChatSessionActivity).not.toHaveBeenCalled()
  })
})

describe('presence → idle-compaction signal', () => {
  it('the caller’s own conversation with a session: `typing`, ids only, no usage gate', async () => {
    const res = await POST(req({ action: 'presence', conversationId: 'conv-1' }, jwt))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(signalChatSessionActivity).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      workspaceId: 'ws-1',
      userId: 'user-1',
      source: 'typing',
    })
    expect(checkUsageLimits).not.toHaveBeenCalled()
  })

  it.each([
    ['another user’s conversation', 'conv-other-user'],
    ['the caller’s conversation in another workspace', 'conv-other-ws'],
    ['an unknown id', 'conv-nope'],
  ])('%s → 404, no signal', async (_label, conversationId) => {
    const res = await POST(req({ action: 'presence', conversationId }, jwt))
    expect(res.status).toBe(404)
    expect(signalChatSessionActivity).not.toHaveBeenCalled()
  })

  // Prod 404'd here on every throttled keystroke in a home thread or a live
  // call's chat that had no registered session yet (2026-10-15).
  it('the caller’s own conversation with no eve session yet → 200, session: false, no signal', async () => {
    const res = await POST(req({ action: 'presence', conversationId: 'conv-no-session' }, jwt))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, session: false })
    expect(signalChatSessionActivity).not.toHaveBeenCalled()
  })

  it('at most 10 pings a minute per person, across conversations: past it a 429 before any read', async () => {
    for (let i = 0; i < 10; i++) {
      expect((await POST(req({ action: 'presence', conversationId: i % 2 ? 'conv-1' : 'conv-nope' }, jwt))).status).not.toBe(429)
    }
    const reads = state.db!.calls.length
    const res = await POST(req({ action: 'presence', conversationId: 'conv-1' }, jwt))
    expect(res.status).toBe(429)
    expect(await res.json()).toMatchObject({ code: 'RATE_LIMITED' })
    expect(state.db!.calls.length).toBe(reads)
    expect(signalChatSessionActivity).toHaveBeenCalledTimes(5)
  })

  it('no conversation id → 400, no signal', async () => {
    expect((await POST(req({ action: 'presence' }, jwt))).status).toBe(400)
    expect(signalChatSessionActivity).not.toHaveBeenCalled()
  })
})
