/**
 * The researcher's mirror of the home thread get-or-create
 * (src/lib/chat/home-thread.ts, migration 330): a member's existing home
 * thread is reused, a missing one is created with the same ignored-duplicate
 * upsert on (user_id, workspace_id, is_home), a lost race re-reads the winner,
 * a non-member gets null, the old onboarding_progress pointer is never read or
 * written, and nothing throws.
 */
import { describe, it, expect } from 'vitest'
import { resolveHomeConversation } from '../home-conversation-pointer.js'

type Row = Record<string, unknown> | null
interface Call {
  table: string
  op: 'select' | 'upsert' | 'update'
  cols?: string
  payload?: unknown
  options?: unknown
}

function fake(answer: (call: Call) => { data: Row; error?: { message: string } | null }) {
  const calls: Call[] = []
  const from = (table: string) => {
    const call: Call = { table, op: 'select' }
    calls.push(call)
    const c: Record<string, unknown> = {}
    c.select = (cols?: string) => {
      if (call.op === 'select') call.cols = cols
      return c
    }
    c.eq = () => c
    c.is = () => c
    c.upsert = (payload: unknown, options: unknown) => {
      call.op = 'upsert'
      call.payload = payload
      call.options = options
      return c
    }
    c.update = () => {
      call.op = 'update'
      return c
    }
    c.maybeSingle = async () => {
      const r = answer(call)
      return { data: r.data, error: r.error ?? null }
    }
    c.then = (resolve: (v: unknown) => unknown) => {
      const r = answer(call)
      return Promise.resolve({ data: r.data, error: r.error ?? null }).then(resolve)
    }
    return c
  }
  return { client: { from } as never, calls }
}

describe('resolveHomeConversation (researcher mirror)', () => {
  it('a non-member gets null', async () => {
    const { client, calls } = fake(() => ({ data: null }))
    expect(await resolveHomeConversation(client, 'u1', 'w1')).toBeNull()
    expect(calls.map((c) => c.table)).toEqual(['member'])
  })

  it('reuses the existing home thread with no write', async () => {
    const { client, calls } = fake((c) => (c.table === 'member' ? { data: { id: 'm1' } } : { data: { id: 'home-1' } }))
    expect(await resolveHomeConversation(client, 'u1', 'w1')).toEqual({ conversationId: 'home-1', created: false })
    expect(calls.every((c) => c.op === 'select')).toBe(true)
    expect(calls.some((c) => c.table === 'member' && c.op !== 'select')).toBe(false)
  })

  it('creates a missing one with the app’s upsert', async () => {
    const { client, calls } = fake((c) => (c.table === 'member' ? { data: { id: 'm1' } } : c.op === 'upsert' ? { data: { id: 'home-new' } } : { data: null }))
    expect(await resolveHomeConversation(client, 'u1', 'w1')).toEqual({ conversationId: 'home-new', created: true })
    const upsert = calls.find((c) => c.op === 'upsert')!
    expect(upsert.payload).toEqual({ user_id: 'u1', workspace_id: 'w1', is_home: true, title: 'Home' })
    expect(upsert.options).toEqual({ onConflict: 'user_id,workspace_id,is_home', ignoreDuplicates: true })
  })

  it('a lost race re-reads the winner', async () => {
    let homeReads = 0
    const { client } = fake((c) => {
      if (c.table === 'member') return { data: { id: 'm1' } }
      if (c.op === 'upsert') return { data: null }
      homeReads += 1
      return homeReads === 1 ? { data: null } : { data: { id: 'home-winner' } }
    })
    expect(await resolveHomeConversation(client, 'u1', 'w1')).toEqual({ conversationId: 'home-winner', created: false })
  })

  it('adopts the old pointer’s plain row once instead of creating an empty one', async () => {
    let adopted = false
    const { client, calls } = fake((c) => {
      if (c.table === 'member') return { data: { id: 'm1', onboarding_progress: { conversation: { homeConversationId: 'conv-old' } } } }
      if (c.op === 'update') {
        adopted = true
        return { data: null }
      }
      if (c.op === 'upsert') throw new Error('must not create')
      if ((c.cols ?? '').startsWith('id, ai_team_member_id')) return { data: { id: 'conv-old', ai_team_member_id: null, agent_teammate_id: null, capture_id: null, focus_area: null, is_home: null } }
      return { data: adopted ? { id: 'conv-old' } : null }
    })
    expect(await resolveHomeConversation(client, 'u1', 'w1')).toEqual({ conversationId: 'conv-old', created: false })
    expect(calls.some((c) => c.table === 'member' && c.op !== 'select')).toBe(false)
  })

  it('answers null (never throws) on a failed read', async () => {
    const { client } = fake((c) => (c.table === 'member' ? { data: { id: 'm1' } } : { data: null, error: { message: 'down' } }))
    expect(await resolveHomeConversation(client, 'u1', 'w1')).toBeNull()
  })
})
