/**
 * PATCH /api/account/chat-history/[id] — the knowledge-ingest signal skips a
 * TEAMMATE thread (bots v2, migration 300: chat_conversations.ai_team_member_id).
 *
 * A conversation with an AI teammate is a working conversation with a bot,
 * never a source of facts: a save to it lands as usual, but it never fires
 * `conversation/activity`. An ordinary chat still does. A failed read of the
 * row fails closed (no signal), and never fails the save.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const hoisted = vi.hoisted(() => ({
  send: vi.fn(async () => ({})),
  convRow: null as { ai_team_member_id: string | null } | null,
  convError: null as { message: string } | null,
  updates: [] as unknown[],
}))

vi.mock('@/lib/inngest/client', () => ({ inngest: { send: hoisted.send } }))
vi.mock('@/lib/workspace', () => ({ getCurrentWorkspaceId: async () => 'ws-1' }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } } }) },
    from: (table: string) => {
      const c: Record<string, unknown> = {}
      for (const m of ['select', 'eq']) c[m] = () => c
      c.upsert = () => Promise.resolve({ error: null })
      c.update = (v: unknown) => (hoisted.updates.push(v), c)
      c.maybeSingle = async () =>
        table === 'chat_conversations' ? { data: hoisted.convRow, error: hoisted.convError } : { data: null, error: null }
      c.then = (resolve: (v: { error: null }) => unknown) => resolve({ error: null })
      return c
    },
  }),
}))

const { PATCH } = await import('../route')

const patch = () =>
  PATCH(
    new Request('http://localhost/api/account/chat-history/conv-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }] }),
    }) as never,
    { params: Promise.resolve({ id: 'conv-1' }) },
  )

beforeEach(() => {
  hoisted.send.mockClear()
  hoisted.convRow = null
  hoisted.convError = null
  hoisted.updates.length = 0
})

describe('PATCH /api/account/chat-history/[id] — ingest signal', () => {
  it('an ordinary chat signals conversation/activity', async () => {
    hoisted.convRow = { ai_team_member_id: null }
    expect((await patch()).status).toBe(200)
    expect(hoisted.send).toHaveBeenCalledWith({
      name: 'conversation/activity',
      data: { workspaceId: 'ws-1', userId: 'user-1', conversationId: 'conv-1' },
    })
  })

  it('a teammate thread saves but never signals ingest', async () => {
    hoisted.convRow = { ai_team_member_id: 'tm-1' }
    expect((await patch()).status).toBe(200)
    expect(hoisted.updates).toHaveLength(1)
    expect(hoisted.send).not.toHaveBeenCalled()
  })

  it('no row back, or a failed read, fails closed: no signal, and the save still answers ok', async () => {
    expect((await patch()).status).toBe(200)
    hoisted.convError = { message: 'boom' }
    expect((await patch()).status).toBe(200)
    expect(hoisted.send).not.toHaveBeenCalled()
  })
})
