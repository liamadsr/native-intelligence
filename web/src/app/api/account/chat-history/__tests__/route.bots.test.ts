/**
 * A conversation's row beside its thread: GET /api/account/chat-history/[id],
 * over the shared fake in `project` mode (only the columns a select names come
 * back). Pins whether its row was read at all (`agentTeammateKnown`): a failed
 * read, or no row of yours, still answers the thread, with the row not known.
 * The conversation's bot (bots-v4 Phase C) is no longer answered: nothing
 * reads it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'

const state: { db: FakeSupabase | null; failConversationRead: boolean } = { db: null, failConversationRead: false }
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } } }) },
    // PostgREST's single() hands back the one row; the double's hands back the list.
    from: (table: string) => {
      const builder = state.db!.from(table) as Record<string, unknown>
      builder.single = builder.maybeSingle
      // A database without migration 307's column, or a passing outage.
      if (table === 'chat_conversations' && state.failConversationRead) {
        builder.maybeSingle = async () => ({ data: null, error: { code: '42703', message: 'column chat_conversations.agent_teammate_id does not exist' } })
      }
      return builder
    },
  }),
}))
vi.mock('@/lib/workspace', () => ({ getCurrentWorkspaceId: async () => 'ws-1' }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }))

const { GET: one } = await import('../[id]/route')

const TM = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const at = (minute: number) => `2026-10-07T10:${String(minute).padStart(2, '0')}:00.000Z`
const conv = (id: string, minute: number, over: Record<string, unknown> = {}) => ({
  id,
  user_id: 'user-1',
  workspace_id: 'ws-1',
  title: `Chat ${id}`,
  created_at: at(0),
  updated_at: at(minute),
  ai_team_member_id: null,
  agent_teammate_id: null,
  capture: null,
  ...over,
})
const writer = { id: TM, name: 'Writer', bot_character: 'writer' }

beforeEach(() => {
  state.failConversationRead = false
  state.db = makeFakeSupabase({ project: true })
  state.db.seed('chat_conversations', [
    conv('plain', 9),
    conv('bot-1', 8, { agent_teammate_id: TM, bot: writer }),
    conv('bot-hidden', 7, { agent_teammate_id: OTHER, bot: null }),
    conv('thread', 6, { ai_team_member_id: TM }),
    ...Array.from({ length: 7 }, (_, i) => conv(`bot-old-${i}`, 5 - i < 0 ? 0 : 5 - i, { agent_teammate_id: TM, bot: writer, updated_at: `2026-10-0${6 - (i % 3)}T09:0${i}:00.000Z` })),
    conv('theirs', 9, { user_id: 'user-2', agent_teammate_id: TM, bot: writer }),
    conv('ws2', 9, { workspace_id: 'ws-2', agent_teammate_id: TM, bot: writer }),
  ])
  state.db.seed('chat_messages', [])
})


describe('GET /api/account/chat-history/[id] — the conversation’s row', () => {
  const read = async (id: string) => (await one(new Request(`http://localhost/x`) as never, { params: Promise.resolve({ id }) })).json()

  it('no longer answers the conversation’s bot', async () => {
    expect((await read('bot-1')).agentTeammate).toBeUndefined()
  })

  it('says the bot is known when the conversation’s row was read', async () => {
    expect((await read('bot-1')).agentTeammateKnown).toBe(true)
    expect((await read('plain')).agentTeammateKnown).toBe(true)
  })

  it('a failed row read still answers the thread, with the bot not known (never “no bot”)', async () => {
    state.db!.seed('chat_messages', [
      { id: 'm-1', conversation_id: 'bot-1', user_id: 'user-1', workspace_id: 'ws-1', created_at: at(1), ui_message: { id: 'u1', role: 'user', parts: [] } },
    ])
    state.failConversationRead = true
    const body = await read('bot-1')
    // With its row's time (message-time.ts): the chat's day lines.
    expect(body.messages).toEqual([{ id: 'u1', role: 'user', parts: [], metadata: { createdAt: at(1) } }])
    expect(body.agentTeammateKnown).toBe(false)
    // The rest of the row is unread too (the 307 header says so).
    expect(body).toMatchObject({ title: null, captureId: null, recipeId: null })
  })

  it('a conversation that isn’t yours here: its bot is not known', async () => {
    const body = await read('theirs')
    expect(body.agentTeammateKnown).toBe(false)
  })
})
