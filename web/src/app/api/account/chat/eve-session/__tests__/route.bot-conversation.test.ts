/**
 * POST /api/account/chat/eve-session — what is left of BOT CONVERSATIONS
 * (bots-v4 Phase C: a main-chat conversation with a bot as its agent,
 * `{ action: 'mint', teammateId, asAgent: true }`). One chat (Slice 2) retired
 * them and Slice 5 took their mint out. Pins:
 *   - the mint makes none: `asAgent` is ignored, and a teammateId is the bot's
 *     own thread, as it always was without it;
 *   - an old conversation that names a bot stays read-only: the ordinary mint
 *     refuses it (409 BOT_CONVERSATION); a deleted bot's (SET NULL) carries on
 *     as an ordinary chat;
 *   - a failed conversation read is a 500, never a false "not yours".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// The idle-compaction signal is covered in route.idle-compaction.test.ts: no Inngest here.
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
const renderConversationPrimer = vi.fn(async (..._a: unknown[]): Promise<string | null> => '<conversation-so-far/>')
vi.mock('@/lib/chat/conversation-history', () => ({
  renderConversationPrimer: (...a: unknown[]) => renderConversationPrimer(...a),
}))

import { POST } from '../route'
import type { NextRequest } from 'next/server'

const req = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  new Request('http://localhost/api/account/chat/eve-session', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }) as unknown as NextRequest

const mint = (over: Record<string, unknown> = {}) => POST(req({ action: 'mint', teammateId: 'tm-writer', asAgent: true, ...over }))

/** user-1 is a member of ws-1 (mem-1) and ws-2; Writer is on ws-1's public team, Closer on its private one. */
function seed(): FakeSupabase {
  const db = makeFakeSupabase({ project: true })
  db.seed('member', [
    { id: 'mem-1', user_id: 'user-1', workspace_id: 'ws-1' },
    { id: 'mem-2', user_id: 'user-1', workspace_id: 'ws-2' },
  ])
  db.seed('team', [
    { id: 'team-open', workspace_id: 'ws-1', is_private: false },
    { id: 'team-private', workspace_id: 'ws-1', is_private: true },
    { id: 'team-ws2', workspace_id: 'ws-2', is_private: false },
  ])
  db.seed('team_member', [])
  db.seed('ai_team_member', [
    { id: 'tm-writer', workspace_id: 'ws-1', team_id: 'team-open', name: 'Writer', is_system: false, system_key: null },
    { id: 'tm-triage', workspace_id: 'ws-1', team_id: null, name: 'Triage', is_system: true, system_key: 'triage' },
    { id: 'tm-closer', workspace_id: 'ws-1', team_id: 'team-private', name: 'Closer', is_system: false, system_key: null },
    { id: 'tm-elsewhere', workspace_id: 'ws-2', team_id: 'team-ws2', name: 'Elsewhere', is_system: false, system_key: null },
  ])
  db.seed('chat_conversations', [])
  db.seed('recipe', [
    { id: 'sk-ws1', category: 'skill', workspace_id: 'ws-1', is_system: false },
    { id: 'sk-sys', category: 'skill', workspace_id: null, is_system: true },
    { id: 'sk-ws2', category: 'skill', workspace_id: 'ws-2', is_system: false },
  ])
  return db
}

const conversations = () => state.db!.rows('chat_conversations')

beforeEach(() => {
  vi.clearAllMocks()
  state.db = seed()
})

describe('mint — bot conversations, retired', () => {
  it('makes none: asAgent is ignored, and a teammateId is the bot’s own thread', async () => {
    const res = await mint()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.bot).toBeUndefined()
    const [thread] = conversations()
    expect(thread).toMatchObject({ ai_team_member_id: 'tm-writer', workspace_id: 'ws-1' })
    expect(thread.agent_teammate_id).toBeUndefined()
    expect(mintChatRunToken).toHaveBeenCalledWith(expect.not.objectContaining({ teammateIn: expect.anything() }))
  })

  it('the ordinary mint refuses a conversation that names a bot: it stays read-only', async () => {
    state.db!.seed('chat_conversations', [{ id: 'conv-bot', user_id: 'user-1', workspace_id: 'ws-1', agent_teammate_id: 'tm-writer', title: 'd' }])
    const res = await POST(req({ action: 'mint', conversationId: 'conv-bot' }))
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'BOT_CONVERSATION', details: { teammateId: 'tm-writer' } })
    expect(mintChatRunToken).not.toHaveBeenCalled()
  })

  it('a deleted bot’s conversation (SET NULL) carries on as an ordinary chat', async () => {
    state.db!.seed('chat_conversations', [{ id: 'conv-was-bot', user_id: 'user-1', workspace_id: 'ws-1', agent_teammate_id: null, eve_session_id: 'wrun_9', title: 'd' }])
    const res = await POST(req({ action: 'mint', conversationId: 'conv-was-bot' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ conversationId: 'conv-was-bot', eveSessionId: 'wrun_9' })
    expect(mintChatRunToken).toHaveBeenCalledWith({ conversationId: 'conv-was-bot', workspaceId: 'ws-1', userId: 'user-1' })
  })

  it('a failed conversation read is a 500, never a false “not yours” that forks the conversation', async () => {
    state.db!.seed('chat_conversations', [{ id: 'conv-bot', user_id: 'user-1', workspace_id: 'ws-1', agent_teammate_id: 'tm-writer', title: 'd' }])
    // What a database without migration 307's column answers for the read, on either path.
    const failing = state.db!
    const reads = failing.from.bind(failing)
    failing.from = ((table: string) => {
      const builder = reads(table) as Record<string, unknown>
      if (table === 'chat_conversations') {
        builder.maybeSingle = async () => ({ data: null, error: { code: '42703', message: 'column chat_conversations.agent_teammate_id does not exist' } })
      }
      return builder
    }) as typeof failing.from
    for (const body of [{ action: 'mint', conversationId: 'conv-bot' }]) {
      const res = await POST(req(body))
      expect(res.status, JSON.stringify(body)).toBe(500)
      expect(JSON.stringify(await res.json())).not.toContain('42703')
    }
    expect(conversations()).toHaveLength(1)
    expect(mintChatRunToken).not.toHaveBeenCalled()
  })
})
