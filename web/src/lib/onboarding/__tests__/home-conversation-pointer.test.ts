import { describe, it, expect } from 'vitest'
import { resolveHomeConversation } from '../home-conversation-pointer'
import { homeThreadFake } from '@/test/home-thread-fake'

/**
 * The onboarding home conversation IS the home thread (migration 330):
 *   - a non-member gets null and nothing is read or written past the member row;
 *   - a member's existing home thread is reused, a missing one created through
 *     ensureHomeThread's upsert (titled by the caller when it passes one);
 *   - the old member.onboarding_progress pointer is never read or written;
 *   - a failure answers null, never a throw.
 */
describe('resolveHomeConversation (home thread)', () => {
  it('a non-member gets null', async () => {
    const { client, calls } = homeThreadFake(() => ({ data: null }))
    expect(await resolveHomeConversation(client, { userId: 'u1', workspaceId: 'w1' })).toBeNull()
    expect(calls.map((c) => c.table)).toEqual(['member'])
  })

  it('reuses the existing home thread and never touches onboarding_progress', async () => {
    const { client, calls } = homeThreadFake((c) => (c.table === 'member' ? { data: { id: 'm1' } } : { data: { id: 'home-1', eve_session_id: null } }))
    expect(await resolveHomeConversation(client, { userId: 'u1', workspaceId: 'w1' })).toEqual({ conversationId: 'home-1', created: false })
    expect(calls.every((c) => c.op === 'select')).toBe(true)
    expect(calls.some((c) => (c.cols ?? '').includes('onboarding_progress'))).toBe(false)
  })

  it('creates a missing one with the caller’s title', async () => {
    const { client, calls } = homeThreadFake((c) =>
      c.table === 'member' ? { data: { id: 'm1' } } : c.op === 'upsert' ? { data: { id: 'home-new', eve_session_id: null } } : { data: null },
    )
    expect(await resolveHomeConversation(client, { userId: 'u1', workspaceId: 'w1', title: 'Welcome' })).toEqual({ conversationId: 'home-new', created: true })
    expect(calls.find((c) => c.op === 'upsert')!.payload).toEqual({ user_id: 'u1', workspace_id: 'w1', is_home: true, title: 'Welcome' })
    expect(calls.some((c) => c.op === 'update')).toBe(false)
  })

  it('answers null on a failed read', async () => {
    const { client } = homeThreadFake((c) => (c.table === 'member' ? { data: { id: 'm1' } } : { data: null, error: { message: 'down' } }))
    expect(await resolveHomeConversation(client, { userId: 'u1', workspaceId: 'w1' })).toBeNull()
  })
})
