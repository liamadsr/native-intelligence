/**
 * POST /api/account/chat-history/home — the home thread, got or created; on a
 * database without migration 330 a 404 HOME_THREAD_UNAVAILABLE, never a 500.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { HomeThreadUnavailableError } from '@/lib/chat/home-thread'

const state = vi.hoisted(() => ({ outcome: null as unknown }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'user-1' } } }) } }) }))
vi.mock('@/lib/workspace', () => ({ getCurrentWorkspaceId: async () => 'ws-1' }))
vi.mock('@/lib/chat/home-message-writer', () => ({
  resolveHomeConversation: async () => {
    if (state.outcome instanceof Error) throw state.outcome
    return state.outcome
  },
}))

const { POST } = await import('../route')

beforeEach(() => {
  state.outcome = { conversationId: 'home-1', created: false }
})

describe('POST /api/account/chat-history/home', () => {
  it('answers the home thread and its workspace', async () => {
    const res = await POST()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ conversationId: 'home-1', created: false, workspaceId: 'ws-1' })
  })

  it('without migration 330: 404 HOME_THREAD_UNAVAILABLE', async () => {
    state.outcome = new HomeThreadUnavailableError()
    const res = await POST()
    expect(res.status).toBe(404)
    expect((await res.json()).code).toBe('HOME_THREAD_UNAVAILABLE')
  })
})
