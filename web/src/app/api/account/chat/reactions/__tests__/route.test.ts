/**
 * /api/account/chat/reactions — the person's emoji on one of the agent's
 * messages (src/lib/chat/message-reactions.ts). Pinned:
 *   - auth through requireWorkspace, and every read and write on its RLS
 *     client; the conversation must be the caller's in this workspace (404
 *     otherwise, nothing written);
 *   - the reaction lands on its bubble's entry in `ui_message.metadata.reactions`
 *     ({ "0": { emoji, at } }), and nothing else of the message changes; a new
 *     one replaces it, null takes it off (the key goes with the last); each
 *     bubble keeps its own;
 *   - 404 for a message not persisted yet, 400 for the person's own message;
 *   - 400 on bad input: an id that isn't one, a word or two emoji;
 *   - a provisional reply (the server's backup) is written fenced on its
 *     mark: replaced by the final copy since the read, the final copy is read
 *     again and keeps its parts;
 *   - GET lists the conversation's reacted replies by their ids (the caller's
 *     conversation only), and nothing else of them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { buildRequest, readJson } from '@/test/integration'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'

const hoisted = vi.hoisted(() => ({ requireWorkspace: vi.fn() }))
vi.mock('@/lib/api-auth', () => ({ requireWorkspace: hoisted.requireWorkspace }))

import { GET, POST } from '@/app/api/account/chat/reactions/route'

const WS = 'a1000000-0000-4000-8000-000000000001'
const OTHER_WS = 'a1000000-0000-4000-8000-000000000002'
const USER = 'b1000000-0000-4000-8000-000000000001'
const OTHER_USER = 'b1000000-0000-4000-8000-000000000002'
const CONV = 'c1000000-0000-4000-8000-000000000001'
const OTHER_CONV = 'c1000000-0000-4000-8000-000000000002'

const reply = (id: string, metadata: Record<string, unknown> = {}) => ({
  id,
  role: 'assistant',
  parts: [{ type: 'text', text: 'Want me to draft it?' }],
  metadata: { eve_written: true, ...metadata },
})

let fake: FakeSupabase

function signIn(userId = USER, workspaceId = WS) {
  hoisted.requireWorkspace.mockResolvedValue({ supabase: fake, user: { id: userId }, workspaceId })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  // `project`: a select returns only what it names, as PostgREST does (GET reads two jsonb fields, never the message).
  fake = makeFakeSupabase({ project: true })
  fake.seed('chat_conversations', [
    { id: CONV, user_id: USER, workspace_id: WS },
    { id: OTHER_CONV, user_id: OTHER_USER, workspace_id: WS },
  ])
  fake.seed('chat_messages', [
    { id: 'r1', conversation_id: CONV, user_id: USER, workspace_id: WS, role: 'user', ui_message: { id: 'msg-u1', role: 'user', parts: [{ type: 'text', text: 'Draft a reply to Dana' }] }, ui_message_id: 'msg-u1' },
    { id: 'r2', conversation_id: CONV, user_id: USER, workspace_id: WS, role: 'assistant', ui_message: reply('msg-a1', { createdAt: '2026-10-20T10:00:00.000Z' }), ui_message_id: 'msg-a1' },
    { id: 'r3', conversation_id: OTHER_CONV, user_id: OTHER_USER, workspace_id: WS, role: 'assistant', ui_message: reply('msg-x1'), ui_message_id: 'msg-x1' },
  ])
  signIn()
})

/** A POST, on the first bubble unless the body names one. */
const post = (body: unknown) =>
  POST(
    buildRequest({
      url: 'https://dial8.ai/api/account/chat/reactions',
      body: body && typeof body === 'object' && !('bubble' in body) ? { bubble: 0, ...body } : body,
    }) as unknown as NextRequest,
  )
type Reactions = { reactions?: Record<string, { emoji: string; at: string }> }
const stored = (id: string) => fake.rows('chat_messages').find((r) => r.id === id)!.ui_message as ReturnType<typeof reply>

describe('POST', () => {
  it('auth: a failed requireWorkspace is returned as is', async () => {
    hoisted.requireWorkspace.mockResolvedValue(new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }))
    expect((await post({ conversationId: CONV, messageId: 'msg-a1', emoji: '👍' })).status).toBe(401)
    expect(stored('r2').metadata).not.toHaveProperty('reactions')
  })

  it('sets the reaction on the message’s metadata, and nothing else of it changes', async () => {
    const before = stored('r2')
    const res = await post({ conversationId: CONV, messageId: 'msg-a1', emoji: '👍🏽' })
    expect(res.status).toBe(200)
    const { reaction } = (await readJson(res)) as { reaction: { emoji: string; at: string } }
    expect(reaction.emoji).toBe('👍🏽')
    expect(Number.isFinite(Date.parse(reaction.at))).toBe(true)
    expect(stored('r2')).toEqual({ ...before, metadata: { ...before.metadata, reactions: { '0': reaction } } })
  })

  it('a new one replaces it; null takes it off and leaves the rest', async () => {
    await post({ conversationId: CONV, messageId: 'msg-a1', emoji: '👍' })
    await post({ conversationId: CONV, messageId: 'msg-a1', emoji: '❤️' })
    expect((stored('r2').metadata as Reactions).reactions?.['0']?.emoji).toBe('❤️')
    const res = await post({ conversationId: CONV, messageId: 'msg-a1', emoji: null })
    expect(res.status).toBe(200)
    expect(await readJson(res)).toEqual({ reaction: null })
    expect(stored('r2').metadata).toEqual({ eve_written: true, createdAt: '2026-10-20T10:00:00.000Z' })
    // Taking off a reaction that isn't there is fine too.
    expect((await post({ conversationId: CONV, messageId: 'msg-a1', emoji: null })).status).toBe(200)
  })

  it('each bubble keeps its own; the last one off takes the key', async () => {
    await post({ conversationId: CONV, messageId: 'msg-a1', bubble: 0, emoji: '👀' })
    await post({ conversationId: CONV, messageId: 'msg-a1', bubble: 2, emoji: '👍' })
    const reactions = (stored('r2').metadata as Reactions).reactions!
    expect(Object.keys(reactions).sort()).toEqual(['0', '2'])
    expect(reactions['2'].emoji).toBe('👍')
    await post({ conversationId: CONV, messageId: 'msg-a1', bubble: 0, emoji: null })
    expect(Object.keys((stored('r2').metadata as Reactions).reactions!)).toEqual(['2'])
    await post({ conversationId: CONV, messageId: 'msg-a1', bubble: 2, emoji: null })
    expect(stored('r2').metadata).not.toHaveProperty('reactions')
  })

  it('400 for a bubble that isn’t one', async () => {
    for (const bubble of [-1, 1.5, 50, '1', null]) {
      expect((await post({ conversationId: CONV, messageId: 'msg-a1', bubble, emoji: '👍' })).status, String(bubble)).toBe(400)
    }
  })

  it('404 when the conversation is someone else’s or in another workspace, and nothing is written', async () => {
    const res = await post({ conversationId: OTHER_CONV, messageId: 'msg-x1', emoji: '👍' })
    expect(res.status).toBe(404)
    expect(((await readJson(res)) as { code?: string }).code).toBe('NOT_FOUND')
    signIn(USER, OTHER_WS)
    expect((await post({ conversationId: CONV, messageId: 'msg-a1', emoji: '👍' })).status).toBe(404)
    expect(stored('r3').metadata).not.toHaveProperty('reactions')
    expect(stored('r2').metadata).not.toHaveProperty('reactions')
  })

  it('404 for a message not persisted yet (the client retries); 400 for the person’s own message', async () => {
    const missing = await post({ conversationId: CONV, messageId: 'msg-a2', emoji: '👍' })
    expect(missing.status).toBe(404)
    expect(((await readJson(missing)) as { code?: string }).code).toBe('NOT_FOUND')
    expect((await post({ conversationId: CONV, messageId: 'msg-u1', emoji: '👍' })).status).toBe(400)
    expect(stored('r1')).not.toHaveProperty('metadata')
  })

  it('400 on bad input', async () => {
    for (const body of [
      { conversationId: 'nope', messageId: 'msg-a1', emoji: '👍' },
      { conversationId: CONV, messageId: 'has space', emoji: '👍' },
      { conversationId: CONV, messageId: 'x'.repeat(201), emoji: '👍' },
      { conversationId: CONV, messageId: 'msg-a1', emoji: 'ok' },
      { conversationId: CONV, messageId: 'msg-a1', emoji: '' },
      { conversationId: CONV, messageId: 'msg-a1', emoji: 'nice 👍' },
      { conversationId: CONV, messageId: 'msg-a1' },
      { conversationId: CONV, messageId: 'msg-a1', emoji: 5 },
    ]) {
      expect((await post(body)).status, JSON.stringify(body)).toBe(400)
    }
    const bad = await POST(buildRequest({ url: 'https://dial8.ai/api/account/chat/reactions', body: '{', raw: true }) as unknown as NextRequest)
    expect(bad.status).toBe(400)
    expect(stored('r2').metadata).not.toHaveProperty('reactions')
  })

  it('a provisional reply takes the reaction under its mark', async () => {
    fake.seed('chat_messages', [
      { id: 'r4', conversation_id: CONV, user_id: USER, workspace_id: WS, role: 'assistant', ui_message: reply('msg-a3', { eve_provisional: true }), ui_message_id: 'msg-a3' },
    ])
    expect((await post({ conversationId: CONV, messageId: 'msg-a3', emoji: '🎉' })).status).toBe(200)
    expect(stored('r4').metadata).toMatchObject({ eve_provisional: true, reactions: { '0': { emoji: '🎉' } } })
  })

  it('a provisional reply the final copy replaced since the read: the final copy is read again and keeps its parts', async () => {
    const finalCopy = { ...reply('msg-a3'), parts: [{ type: 'text', text: 'Want me to draft it? (final)' }] }
    fake.seed('chat_messages', [
      { id: 'r4', conversation_id: CONV, user_id: USER, workspace_id: WS, role: 'assistant', ui_message: reply('msg-a3', { eve_provisional: true }), ui_message_id: 'msg-a3' },
    ])
    // The browser's write lands between the route's first read and its write.
    type Chain = { select: (cols?: string) => Chain; maybeSingle: () => Promise<unknown> } & Record<string, unknown>
    let reads = 0
    const racing = {
      from: (table: string) => {
        const b = fake.from(table) as unknown as Chain
        if (table !== 'chat_messages') return b
        const select = b.select.bind(b)
        b.select = (cols?: string) => {
          const out = select(cols)
          if (cols !== 'id, role, ui_message' || reads++ > 0) return out
          const maybeSingle = out.maybeSingle.bind(out)
          out.maybeSingle = async () => {
            const read = await maybeSingle()
            fake.rows('chat_messages').find((r) => r.id === 'r4')!.ui_message = finalCopy
            return read
          }
          return out
        }
        return b
      },
    }
    hoisted.requireWorkspace.mockResolvedValue({ supabase: racing, user: { id: USER }, workspaceId: WS })
    expect((await post({ conversationId: CONV, messageId: 'msg-a3', emoji: '👍' })).status).toBe(200)
    expect(reads).toBe(2)
    const now = stored('r4')
    expect(now.parts).toEqual(finalCopy.parts)
    expect(now.metadata).toMatchObject({ reactions: { '0': { emoji: '👍' } } })
    expect(now.metadata).not.toHaveProperty('eve_provisional')
  })
})

const get = (conversationId: string) =>
  GET(buildRequest({ url: `https://dial8.ai/api/account/chat/reactions?conversationId=${conversationId}`, method: 'GET' }) as unknown as NextRequest)

describe('GET', () => {
  it('lists the reacted replies of the caller’s conversation by id', async () => {
    fake.rows('chat_messages').push({ id: 'r5', conversation_id: CONV, user_id: USER, workspace_id: WS, role: 'assistant', ui_message: reply('msg-a5'), ui_message_id: 'msg-a5' })
    await post({ conversationId: CONV, messageId: 'msg-a1', emoji: '🎉' })
    const res = await get(CONV)
    expect(res.status).toBe(200)
    const { reactions } = (await readJson(res)) as { reactions: Record<string, Record<string, { emoji: string; at: string }>> }
    expect(Object.keys(reactions)).toEqual(['msg-a1'])
    expect(reactions['msg-a1']['0'].emoji).toBe('🎉')
    expect(Number.isFinite(Date.parse(reactions['msg-a1']['0'].at))).toBe(true)
  })

  it('404 for someone else’s conversation, 400 for a bad id, and auth as POST', async () => {
    expect((await get(OTHER_CONV)).status).toBe(404)
    expect((await get('nope')).status).toBe(400)
    hoisted.requireWorkspace.mockResolvedValue(new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }))
    expect((await get(CONV)).status).toBe(401)
  })
})
