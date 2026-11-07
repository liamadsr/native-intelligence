/**
 * The home thread (A3): ensureHomeThread is ensureTeammateThread's shape on
 * (user_id, workspace_id, is_home): an existing row is reused with no write; a
 * missing one is created with an ignored-duplicate upsert; two first calls
 * racing land on one row (the loser re-reads it); errors throw. And the
 * checkpoint store: capped, owner-scoped, and idempotent (the same text again
 * leaves checkpoint_at alone).
 */
import { describe, it, expect } from 'vitest'
import { HOME_CHECKPOINT_MAX_CHARS, HOME_THREAD_TITLE, HomeThreadUnavailableError, clipCheckpoint, ensureHomeThread, storeCheckpoint } from '../home-thread'
import { homeThreadFake, type FakeCall } from '@/test/home-thread-fake'

describe('ensureHomeThread', () => {
  it('reuses the existing home thread with no write', async () => {
    const { client, calls } = homeThreadFake(() => ({ data: { id: 'home-1', eve_session_id: 'wrun_1' } }))
    expect(await ensureHomeThread(client, { userId: 'u1', workspaceId: 'w1' })).toEqual({ id: 'home-1', eveSessionId: 'wrun_1', created: false })
    expect(calls.map((c) => c.op)).toEqual(['select'])
    expect(calls[0].eqs).toEqual([['user_id', 'u1'], ['workspace_id', 'w1'], ['is_home', true]])
  })

  it('creates a missing one with an ignored-duplicate upsert on (user_id, workspace_id, is_home)', async () => {
    const { client, calls } = homeThreadFake((c) => (c.op === 'upsert' ? { data: { id: 'home-new', eve_session_id: null } } : { data: null }))
    expect(await ensureHomeThread(client, { userId: 'u1', workspaceId: 'w1' })).toEqual({ id: 'home-new', eveSessionId: null, created: true })
    const upsert = calls.find((c) => c.op === 'upsert')!
    expect(upsert.payload).toEqual({ user_id: 'u1', workspace_id: 'w1', is_home: true, title: HOME_THREAD_TITLE })
    expect(upsert.options).toEqual({ onConflict: 'user_id,workspace_id,is_home', ignoreDuplicates: true })
  })

  it('takes a caller title on create', async () => {
    const { client, calls } = homeThreadFake((c) => (c.op === 'upsert' ? { data: { id: 'h', eve_session_id: null } } : { data: null }))
    await ensureHomeThread(client, { userId: 'u1', workspaceId: 'w1', title: 'Welcome' })
    expect((calls.find((c) => c.op === 'upsert')!.payload as { title: string }).title).toBe('Welcome')
  })

  it('a lost race (ignored duplicate: no row back) re-reads the winner, created false', async () => {
    let reads = 0
    const { client, calls } = homeThreadFake((c) => {
      if (c.table === 'member') return { data: null }
      if (c.op === 'upsert') return { data: null }
      reads += 1
      return reads === 1 ? { data: null } : { data: { id: 'home-winner', eve_session_id: null } }
    })
    expect(await ensureHomeThread(client, { userId: 'u1', workspaceId: 'w1' })).toEqual({ id: 'home-winner', eveSessionId: null, created: false })
    expect(calls.filter((c) => c.table === 'chat_conversations').map((c) => c.op)).toEqual(['select', 'upsert', 'select'])
  })

  it('two first calls racing land on one row, and only one says it created it', async () => {
    // One shared table: both read "none" first, the first upsert wins, the
    // second is an ignored duplicate (no row back) and re-reads.
    let row: { id: string; eve_session_id: null } | null = null
    let firstReads = 0
    const answer = (c: FakeCall) => {
      if (c.op === 'upsert') {
        if (row) return { data: null }
        row = { id: 'home-one', eve_session_id: null }
        return { data: row }
      }
      if (firstReads < 2) {
        firstReads += 1
        return { data: null }
      }
      return { data: row }
    }
    const a = homeThreadFake(answer)
    const b = homeThreadFake(answer)
    const [x, y] = await Promise.all([
      ensureHomeThread(a.client, { userId: 'u1', workspaceId: 'w1' }),
      ensureHomeThread(b.client, { userId: 'u1', workspaceId: 'w1' }),
    ])
    expect(x.id).toBe('home-one')
    expect(y.id).toBe('home-one')
    expect([x.created, y.created].filter(Boolean)).toHaveLength(1)
  })

  it('throws on a failed read or upsert, and when the row is missing after the upsert', async () => {
    await expect(ensureHomeThread(homeThreadFake(() => ({ data: null, error: { message: 'boom' } })).client, { userId: 'u', workspaceId: 'w' })).rejects.toThrow(/lookup failed/)
    await expect(
      ensureHomeThread(homeThreadFake((c) => (c.op === 'upsert' ? { data: null, error: { message: 'x' } } : { data: null })).client, { userId: 'u', workspaceId: 'w' }),
    ).rejects.toThrow(/create failed/)
    await expect(ensureHomeThread(homeThreadFake(() => ({ data: null })).client, { userId: 'u', workspaceId: 'w' })).rejects.toThrow(/missing after upsert/)
  })
})

describe('ensureHomeThread — the old onboarding pointer (A3 review)', () => {
  const pointerMember = { onboarding_progress: { conversation: { homeConversationId: 'conv-old' } } }
  const plain = { id: 'conv-old', eve_session_id: 'wrun_old', user_id: 'u1', workspace_id: 'w1', ai_team_member_id: null, agent_teammate_id: null, capture_id: null, focus_area: null, is_home: null }
  const isHomeRead = (c: FakeCall) => c.op === 'select' && c.eqs.some(([k]) => k === 'is_home')

  it('adopts the pointed-to plain row of the person’s own, once, instead of creating an empty one', async () => {
    let adopted = false
    const { client, calls } = homeThreadFake((c) => {
      if (c.table === 'member') return { data: pointerMember }
      if (c.op === 'update') {
        adopted = true
        return { data: null }
      }
      if (c.op === 'upsert') throw new Error('must not create')
      if (isHomeRead(c)) return { data: adopted ? { id: 'conv-old', eve_session_id: 'wrun_old' } : null }
      return { data: plain }
    })
    expect(await ensureHomeThread(client, { userId: 'u1', workspaceId: 'w1' })).toEqual({ id: 'conv-old', eveSessionId: 'wrun_old', created: false })
    const update = calls.find((c) => c.op === 'update')!
    expect(update.payload).toEqual({ is_home: true })
    expect(update.eqs).toEqual([['id', 'conv-old'], ['user_id', 'u1'], ['workspace_id', 'w1'], ['is_home:is', null]])
    // A read of the pointer only: the member row is never written.
    expect(calls.some((c) => c.table === 'member' && c.op !== 'select')).toBe(false)
  })

  it('never adopts a teammate, bot, meeting or focused row, nor one not the person’s here: it creates an empty one', async () => {
    for (const bad of [{ ai_team_member_id: 't' }, { agent_teammate_id: 'b' }, { capture_id: 'c' }, { focus_area: 'mail' }, null]) {
      const { client, calls } = homeThreadFake((c) => {
        if (c.table === 'member') return { data: pointerMember }
        if (c.op === 'upsert') return { data: { id: 'home-new', eve_session_id: null } }
        if (isHomeRead(c)) return { data: null }
        return { data: bad ? { ...plain, ...bad } : null }
      })
      expect((await ensureHomeThread(client, { userId: 'u1', workspaceId: 'w1' })).id).toBe('home-new')
      expect(calls.some((c) => c.op === 'update')).toBe(false)
    }
  })

  it('a racer adopting first (the unique index) leaves its row the home thread', async () => {
    let homeReads = 0
    const { client } = homeThreadFake((c) => {
      if (c.table === 'member') return { data: pointerMember }
      if (c.op === 'update') return { data: null, error: { message: 'duplicate', code: '23505' } as { message: string } }
      if (c.op === 'upsert') throw new Error('must not create')
      if (isHomeRead(c)) {
        homeReads += 1
        return { data: homeReads === 1 ? null : { id: 'home-racer', eve_session_id: null } }
      }
      return { data: plain }
    })
    expect(await ensureHomeThread(client, { userId: 'u1', workspaceId: 'w1' })).toEqual({ id: 'home-racer', eveSessionId: null, created: false })
  })
})

describe('storeCheckpoint', () => {
  it('caps the text and writes it with checkpoint_at, owner-scoped', async () => {
    const { client, calls } = homeThreadFake((c) => (c.op === 'select' ? { data: { id: 'c1', checkpoint_summary: null, is_home: true } } : { data: null }))
    const now = new Date('2026-10-14T10:00:00Z')
    const out = await storeCheckpoint(client, { conversationId: 'c1', userId: 'u1', workspaceId: 'w1', text: 'x'.repeat(HOME_CHECKPOINT_MAX_CHARS + 50), now })
    expect(out).toEqual({ stored: true, unchanged: false })
    const update = calls.find((c) => c.op === 'update')!
    const payload = update.payload as { checkpoint_summary: string; checkpoint_at: string }
    expect(payload.checkpoint_summary.length).toBe(HOME_CHECKPOINT_MAX_CHARS)
    expect(payload.checkpoint_at).toBe(now.toISOString())
    expect(update.eqs).toEqual([['id', 'c1'], ['user_id', 'u1'], ['workspace_id', 'w1']])
  })

  it('the same text again (a replay) writes nothing', async () => {
    const { client, calls } = homeThreadFake(() => ({ data: { id: 'c1', checkpoint_summary: 'Summary', is_home: true } }))
    expect(await storeCheckpoint(client, { conversationId: 'c1', userId: 'u1', workspaceId: 'w1', text: '  Summary ' })).toEqual({ stored: false, unchanged: true })
    expect(calls.some((c) => c.op === 'update')).toBe(false)
  })

  it('a blank text or a conversation not the caller’s writes nothing', async () => {
    const none = homeThreadFake(() => ({ data: null }))
    expect(await storeCheckpoint(none.client, { conversationId: 'c1', userId: 'u1', workspaceId: 'w1', text: 'Hi' })).toEqual({ stored: false, unchanged: false })
    expect(await storeCheckpoint(none.client, { conversationId: 'c1', userId: 'u1', workspaceId: 'w1', text: '   ' })).toEqual({ stored: false, unchanged: false })
    expect(clipCheckpoint(42)).toBeNull()
  })
})

describe('the home thread degrading (A3 verification)', () => {
  it('a database without migration 330: ensureHomeThread says so and creates nothing', async () => {
    const { client, calls } = homeThreadFake(() => ({ data: null, error: { message: 'column is_home does not exist', code: '42703' } as { message: string } }))
    await expect(ensureHomeThread(client, { userId: 'u1', workspaceId: 'w1' })).rejects.toBeInstanceOf(HomeThreadUnavailableError)
    expect(calls.some((c) => c.op === 'upsert')).toBe(false)
  })

  it('a failed read of the old pointer creates no empty home thread: it throws, so the next call retries', async () => {
    const { client, calls } = homeThreadFake((c) => {
      if (c.table === 'member') return { data: null, error: { message: 'timeout' } }
      return { data: null }
    })
    await expect(ensureHomeThread(client, { userId: 'u1', workspaceId: 'w1' })).rejects.toThrow(/pointer read failed/)
    expect(calls.some((c) => c.op === 'upsert')).toBe(false)
  })

  it('a failed read of the pointed-to conversation creates nothing either', async () => {
    const { client, calls } = homeThreadFake((c) => {
      if (c.table === 'member') return { data: { onboarding_progress: { conversation: { homeConversationId: 'conv-old' } } } }
      if (c.eqs.some(([k]) => k === 'is_home')) return { data: null }
      return { data: null, error: { message: 'timeout' } }
    })
    await expect(ensureHomeThread(client, { userId: 'u1', workspaceId: 'w1' })).rejects.toThrow(/onboarding conversation read failed/)
    expect(calls.some((c) => c.op === 'upsert')).toBe(false)
  })

  it('storeCheckpoint stores nothing for a side chat, or without migration 330', async () => {
    const side = homeThreadFake(() => ({ data: { id: 'c1', checkpoint_summary: null, is_home: null } }))
    expect(await storeCheckpoint(side.client, { conversationId: 'c1', userId: 'u1', workspaceId: 'w1', text: 'S' })).toEqual({ stored: false, unchanged: false })
    expect(side.calls.some((c) => c.op === 'update')).toBe(false)
    const old = homeThreadFake(() => ({ data: null, error: { message: 'no column', code: '42703' } as { message: string } }))
    expect(await storeCheckpoint(old.client, { conversationId: 'c1', userId: 'u1', workspaceId: 'w1', text: 'S' })).toEqual({ stored: false, unchanged: false })
  })
})
