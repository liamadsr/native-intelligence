import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * GET /api/account/chat-history/live?capture_id=… (one-chat plan, Slice 3):
 * the capture's live conversation for its page's read-only "Live chat"
 * section: its id and how many messages it holds, the caller's own only.
 */

const state = vi.hoisted(() => ({
  conversation: null as { id: string } | null,
  count: 0,
  filters: [] as Array<[string, string, unknown]>,
}))

function client() {
  const from = (table: string) => {
    const c: Record<string, unknown> = {}
    c.select = () => c
    c.eq = (k: string, v: unknown) => {
      state.filters.push([table, k, v])
      return table === 'chat_messages' ? Promise.resolve({ count: state.count, error: null }) : c
    }
    c.maybeSingle = async () => ({ data: state.conversation, error: null })
    return c
  }
  return { from }
}

vi.mock('@/lib/api-auth', () => ({
  requireWorkspace: vi.fn(async () => ({ supabase: client(), user: { id: 'user-1' }, workspaceId: 'ws-1' })),
}))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/workspace', () => ({ getCurrentWorkspaceId: vi.fn() }))
vi.mock('@/lib/live-agent/conversation-writer', () => ({ appendAgentMessage: vi.fn() }))
vi.mock('@/lib/live-agent/default-agent', () => ({ resolveDefaultRecipeForCapture: vi.fn() }))
vi.mock('@/lib/live-agent/package-greeting', () => ({ describeAttachedPackages: vi.fn() }))

import { GET } from '../route'
import { NextRequest } from 'next/server'

const get = (query: string) => GET(new NextRequest(`http://localhost/api/account/chat-history/live${query}`))

beforeEach(() => {
  state.conversation = null
  state.count = 0
  state.filters = []
})

describe('GET /api/account/chat-history/live', () => {
  it('answers the caller’s own conversation for the capture and its message count', async () => {
    state.conversation = { id: 'conv-live' }
    state.count = 7
    const res = await get('?capture_id=11111111-2222-3333-4444-555555555555')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ conversationId: 'conv-live', messageCount: 7 })
    expect(state.filters).toEqual([
      ['chat_conversations', 'capture_id', '11111111-2222-3333-4444-555555555555'],
      ['chat_conversations', 'user_id', 'user-1'],
      ['chat_conversations', 'workspace_id', 'ws-1'],
      ['chat_messages', 'conversation_id', 'conv-live'],
    ])
  })

  it('no conversation of the caller’s: null, and nothing else is read', async () => {
    const res = await get('?capture_id=11111111-2222-3333-4444-555555555555')
    expect(await res.json()).toEqual({ conversationId: null, messageCount: 0 })
    expect(state.filters.some(([table]) => table === 'chat_messages')).toBe(false)
  })

  it('needs a capture id: none, or anything that isn’t a uuid, is a 400 with nothing read', async () => {
    expect((await get('')).status).toBe(400)
    expect((await get('?capture_id=cap-1')).status).toBe(400)
    expect((await get("?capture_id=1'%20or%201=1")).status).toBe(400)
    expect(state.filters).toEqual([])
  })
})
