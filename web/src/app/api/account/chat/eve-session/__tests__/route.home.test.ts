/**
 * POST /api/account/chat/eve-session — the home thread (A3, migration 330).
 * Over the shared fake (`project` mode). Pins:
 *   - `{ action: 'mint', home: true }` makes the caller's home thread here
 *     when there is none (is_home, in this workspace, no focus), mints a
 *     main-agent token for it and answers `home: true`; the body's
 *     conversationId and focusArea are ignored;
 *   - a second home mint reuses the same row (one per person per workspace),
 *     with its registered eve session;
 *   - another person's or another workspace's home row is never used;
 *   - the usage gate holds before anything is made;
 *   - a primer for a home thread is the home primer when it has one, else
 *     the ordinary one; a new home thread asks for none;
 *   - the ordinary mint naming the home thread answers `home: true` too.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/chat/idle-compaction-signal', () => ({ signalChatSessionActivity: vi.fn() }))
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'

const state: { db: FakeSupabase | null } = { db: null }
vi.mock('@/lib/api-auth', () => ({
  requireWorkspace: async () => ({ supabase: state.db, user: { id: 'user-1' }, workspaceId: 'ws-1' }),
}))
const mintChatRunToken = vi.fn((_c: unknown) => 'signed.token')
vi.mock('@/lib/chat/chat-run-token', () => ({
  mintChatRunToken: (c: unknown) => mintChatRunToken(c),
  internalSecret: () => 'test-secret',
}))
const checkUsageLimits = vi.fn(async (_u: string): Promise<void> => undefined)
vi.mock('@/lib/ai/auth', () => ({ checkUsageLimits: (u: string) => checkUsageLimits(u) }))
vi.mock('@/lib/chat/chat-run-credential', () => ({ sealRunCredential: () => 'sealed' }))
const renderConversationPrimer = vi.fn(async (_s: unknown, _a: unknown): Promise<string | null> => 'ORDINARY PRIMER')
const renderHomePrimer = vi.fn(async (_s: unknown, _a: unknown): Promise<string | null> => 'HOME PRIMER')
vi.mock('@/lib/chat/conversation-history', () => ({
  renderConversationPrimer: (s: unknown, a: unknown) => renderConversationPrimer(s, a),
  renderHomePrimer: (s: unknown, a: unknown) => renderHomePrimer(s, a),
}))

import { POST } from '../route'
import type { NextRequest } from 'next/server'

const req = (body: Record<string, unknown>) =>
  new Request('http://localhost/api/account/chat/eve-session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest

const conversations = () => state.db!.rows('chat_conversations')
const claims = () => mintChatRunToken.mock.calls.map((c) => c[0] as Record<string, unknown>)

beforeEach(() => {
  vi.clearAllMocks()
  const db = makeFakeSupabase({ project: true })
  db.seed('chat_conversations', [
    { id: 'conv-plain', user_id: 'user-1', workspace_id: 'ws-1', eve_session_id: null, agent_teammate_id: null, focus_area: null, is_home: null },
    { id: 'home-elsewhere', user_id: 'user-1', workspace_id: 'ws-2', eve_session_id: null, agent_teammate_id: null, focus_area: null, is_home: true },
    { id: 'home-theirs', user_id: 'user-2', workspace_id: 'ws-1', eve_session_id: null, agent_teammate_id: null, focus_area: null, is_home: true },
  ])
  db.seed('recipe', [])
  state.db = db
})

describe("mint { home: true } — the caller's home thread (A3)", () => {
  it('makes the home thread here when there is none, ignoring the body’s conversation and focus', async () => {
    const res = await POST(req({ action: 'mint', home: true, conversationId: 'conv-plain', focusArea: 'mail', wantHistory: true }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ token: 'signed.token', home: true, eveSessionId: null })
    expect(body.conversationId).not.toBe('conv-plain')
    expect(body).not.toHaveProperty('focusArea')
    const made = conversations().find((c) => c.id === body.conversationId)!
    expect(made).toMatchObject({ user_id: 'user-1', workspace_id: 'ws-1', is_home: true })
    expect(made.focus_area ?? null).toBeNull()
    const [signed] = claims()
    expect(signed).toMatchObject({ conversationId: body.conversationId, workspaceId: 'ws-1', userId: 'user-1' })
    for (const key of ['teammateId', 'teammateIn', 'focusArea']) expect(signed).not.toHaveProperty(key)
    // A new thread is empty: no primer is read for it.
    expect(body.historyPrimer).toBeNull()
    expect(renderHomePrimer).not.toHaveBeenCalled()
    expect(renderConversationPrimer).not.toHaveBeenCalled()
  })

  it('a second home mint reuses the one row, with its eve session', async () => {
    state.db!.seed('chat_conversations', [
      { id: 'home-mine', user_id: 'user-1', workspace_id: 'ws-1', eve_session_id: 'wrun_home', agent_teammate_id: null, focus_area: null, is_home: true },
    ])
    const before = conversations().length
    const a = await (await POST(req({ action: 'mint', home: true }))).json()
    const b = await (await POST(req({ action: 'mint', home: true }))).json()
    expect(a).toMatchObject({ conversationId: 'home-mine', eveSessionId: 'wrun_home', home: true })
    expect(b).toMatchObject({ conversationId: 'home-mine', eveSessionId: 'wrun_home', home: true })
    expect(conversations()).toHaveLength(before)
  })

  it('an existing home thread primes from its checkpoint when it has one, else the ordinary primer', async () => {
    state.db!.seed('chat_conversations', [
      { id: 'home-mine', user_id: 'user-1', workspace_id: 'ws-1', eve_session_id: null, agent_teammate_id: null, focus_area: null, is_home: true },
    ])
    expect((await (await POST(req({ action: 'mint', home: true, wantHistory: true }))).json()).historyPrimer).toBe('HOME PRIMER')
    expect(renderHomePrimer).toHaveBeenCalledWith(expect.anything(), { conversationId: 'home-mine', userId: 'user-1', workspaceId: 'ws-1' })
    renderHomePrimer.mockResolvedValueOnce(null)
    expect((await (await POST(req({ action: 'mint', home: true, wantHistory: true }))).json()).historyPrimer).toBe('ORDINARY PRIMER')
    renderHomePrimer.mockRejectedValueOnce(new Error('down'))
    expect((await (await POST(req({ action: 'mint', home: true, wantHistory: true }))).json()).historyPrimer).toBe('ORDINARY PRIMER')
  })

  it('the ordinary mint naming the home thread answers home: true and uses the home primer; a side chat does not', async () => {
    state.db!.seed('chat_conversations', [
      { id: 'home-mine', user_id: 'user-1', workspace_id: 'ws-1', eve_session_id: null, agent_teammate_id: null, focus_area: null, is_home: true },
    ])
    const home = await (await POST(req({ action: 'mint', conversationId: 'home-mine', wantHistory: true }))).json()
    expect(home).toMatchObject({ conversationId: 'home-mine', home: true, historyPrimer: 'HOME PRIMER' })
    const side = await (await POST(req({ action: 'mint', conversationId: 'conv-plain', wantHistory: true }))).json()
    expect(side).toMatchObject({ conversationId: 'conv-plain', historyPrimer: 'ORDINARY PRIMER' })
    expect(side).not.toHaveProperty('home')
  })

  it('is usage-gated before anything is made', async () => {
    checkUsageLimits.mockImplementationOnce(async () => {
      throw new Response(JSON.stringify({ error: 'limit' }), { status: 429 })
    })
    const before = conversations().length
    expect((await POST(req({ action: 'mint', home: true }))).status).toBe(429)
    expect(conversations()).toHaveLength(before)
    expect(mintChatRunToken).not.toHaveBeenCalled()
  })
})
