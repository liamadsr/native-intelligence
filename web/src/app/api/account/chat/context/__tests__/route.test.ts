/**
 * GET /api/account/chat/context — how full one of the caller's chat
 * conversations' context is (src/lib/chat/context-usage.ts): the side panel's
 * Context card. Pinned:
 *   - auth through requireWorkspace, every read on its RLS client;
 *   - 400 for an id that isn't a uuid; 404 for a conversation that isn't the
 *     caller's in this workspace;
 *   - 200 { context: null } with no eve session, or no measured turn;
 *   - 200 with the newest measured turn of THIS session by THIS person
 *     (another session's rows, another person's and another feature's never
 *     count); a newer compaction reads as compactedAt with no size;
 *   - only the session's newest CONTEXT_ROWS_READ rows are read;
 *   - 500 on a failed read.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { buildRequest, readJson } from '@/test/integration'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'

const hoisted = vi.hoisted(() => ({ requireWorkspace: vi.fn() }))
vi.mock('@/lib/api-auth', () => ({ requireWorkspace: hoisted.requireWorkspace }))

import { GET } from '@/app/api/account/chat/context/route'
import { CONTEXT_ROWS_READ } from '@/lib/chat/context-usage'
import type { ChatContextUsage } from '@/lib/chat/context-usage'

const WS = 'a1000000-0000-4000-8000-000000000001'
const OTHER_WS = 'a1000000-0000-4000-8000-000000000002'
const USER = 'b1000000-0000-4000-8000-000000000001'
const OTHER_USER = 'b1000000-0000-4000-8000-000000000002'
const CONV = 'c1000000-0000-4000-8000-000000000001'
const NEW_CONV = 'c1000000-0000-4000-8000-000000000002'
const THEIR_CONV = 'c1000000-0000-4000-8000-000000000003'
const MISSING_CONV = 'c1000000-0000-4000-8000-000000000009'

const PARTS = { system: 9000, skills: 1200, tools: 14_000, memory: 300 }

let fake: FakeSupabase

function signIn(userId = USER, workspaceId = WS, supabase: unknown = fake) {
  hoisted.requireWorkspace.mockResolvedValue({ supabase, user: { id: userId }, workspaceId })
}

/** A usage row as chat-usage-meter.ts writes it. */
function usage(at: string, metadata: Record<string, unknown>, over: Record<string, unknown> = {}) {
  return { user_id: USER, feature: 'ai_chat', model: 'deepseek-v4-flash', created_at: at, metadata: { eve_session_id: 'sess-1', ...metadata }, ...over }
}

beforeEach(() => {
  vi.clearAllMocks()
  // `project`: a select returns only what it names, as PostgREST does.
  fake = makeFakeSupabase({ project: true })
  fake.seed('chat_conversations', [
    { id: CONV, user_id: USER, workspace_id: WS, eve_session_id: 'sess-1' },
    { id: NEW_CONV, user_id: USER, workspace_id: WS, eve_session_id: null },
    { id: THEIR_CONV, user_id: OTHER_USER, workspace_id: WS, eve_session_id: 'sess-2' },
  ])
  fake.seed('ai_usage_logs', [
    usage('2026-10-22T10:01:00Z', { context_last_step_input_tokens: 120_000, context_parts: PARTS }),
    usage('2026-10-22T10:05:00Z', { context_last_step_input_tokens: 185_000, context_parts: PARTS }),
    // Never this conversation's: another session, another person, another feature.
    usage('2026-10-22T10:30:00Z', { eve_session_id: 'sess-2', context_last_step_input_tokens: 9 }),
    usage('2026-10-22T10:31:00Z', { context_last_step_input_tokens: 8 }, { user_id: OTHER_USER }),
    usage('2026-10-22T10:32:00Z', { context_last_step_input_tokens: 7 }, { feature: 'device_ask' }),
  ])
  signIn()
})

const get = (query: string) =>
  GET(buildRequest({ url: `https://dial8.ai/api/account/chat/context${query}`, method: 'GET' }) as unknown as NextRequest)
const contextOf = async (res: Response) => ((await readJson(res)) as { context: ChatContextUsage | null }).context

describe('GET /api/account/chat/context', () => {
  it('auth: a failed requireWorkspace is returned as is', async () => {
    hoisted.requireWorkspace.mockResolvedValue(new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }))
    expect((await get(`?conversationId=${CONV}`)).status).toBe(401)
  })

  it('400 for an id that isn’t a uuid', async () => {
    for (const q of ['', '?conversationId=', '?conversationId=conv-1', `?conversationId=${CONV}x`]) {
      const res = await get(q)
      expect(res.status, q).toBe(400)
      expect(await readJson(res)).toMatchObject({ code: 'BAD_REQUEST' })
    }
  })

  it('404 for a conversation that isn’t the caller’s in this workspace', async () => {
    for (const id of [THEIR_CONV, MISSING_CONV]) {
      const res = await get(`?conversationId=${id}`)
      expect(res.status, id).toBe(404)
      expect(await readJson(res)).toMatchObject({ code: 'NOT_FOUND' })
    }
    signIn(USER, OTHER_WS)
    expect((await get(`?conversationId=${CONV}`)).status).toBe(404)
  })

  it('null with no eve session yet, or no measured turn', async () => {
    const fresh = await get(`?conversationId=${NEW_CONV}`)
    expect(fresh.status).toBe(200)
    expect(await readJson(fresh)).toEqual({ context: null })
    fake.rows('ai_usage_logs').splice(0)
    fake.seed('ai_usage_logs', [usage('2026-10-22T10:05:00Z', { steps: 2 })])
    expect(await readJson(await get(`?conversationId=${CONV}`))).toEqual({ context: null })
  })

  it('the newest measured turn of this session, by this person, by part', async () => {
    const res = await get(`?conversationId=${CONV}`)
    expect(res.status).toBe(200)
    expect(await contextOf(res)).toEqual({
      model: 'deepseek-v4-flash',
      usedTokens: 185_000,
      windowTokens: 250_000,
      compactAtTokens: 225_000,
      idleCompactTokens: 150_000,
      modelWindowTokens: 1_000_000,
      parts: [
        { key: 'messages', tokens: 160_500 },
        { key: 'system', tokens: 9000 },
        { key: 'tools', tokens: 14_000 },
        { key: 'skills', tokens: 1200 },
        { key: 'memory', tokens: 300 },
      ],
      measuredAt: '2026-10-22T10:05:00Z',
      compactedAt: null,
    })
  })

  it('a compaction since the newest turn: no size until the next message', async () => {
    fake.seed('ai_usage_logs', [usage('2026-10-22T10:09:00Z', { compaction: true, compactionTrigger: 'manual' })])
    expect(await contextOf(await get(`?conversationId=${CONV}`))).toMatchObject({
      usedTokens: null,
      compactedAt: '2026-10-22T10:09:00Z',
      measuredAt: '2026-10-22T10:05:00Z',
    })
    // The next turn measures again.
    fake.seed('ai_usage_logs', [usage('2026-10-22T10:15:00Z', { context_last_step_input_tokens: 61_000, context_parts: PARTS })])
    expect(await contextOf(await get(`?conversationId=${CONV}`))).toMatchObject({ usedTokens: 61_000, compactedAt: null })
  })

  it(`reads only the session's newest ${CONTEXT_ROWS_READ} rows`, async () => {
    fake.seed(
      'ai_usage_logs',
      Array.from({ length: CONTEXT_ROWS_READ }, (_, i) => usage(`2026-10-22T11:0${i}:00Z`, { compaction: true })),
    )
    expect(await readJson(await get(`?conversationId=${CONV}`))).toEqual({ context: null })
  })

  it('500 on a failed read, of the conversation or of its rows', async () => {
    for (const failing of ['chat_conversations', 'ai_usage_logs']) {
      const result = (table: string) =>
        table === failing
          ? { data: null, error: { message: 'db down' } }
          : { data: table === 'chat_conversations' ? { id: CONV, eve_session_id: 'sess-1' } : [], error: null }
      const client = {
        from: (table: string) => {
          const chain: Record<string, unknown> = {}
          for (const k of ['select', 'eq', 'order']) chain[k] = () => chain
          chain.maybeSingle = async () => result(table)
          chain.limit = async () => result(table)
          return chain
        },
      }
      signIn(USER, WS, client)
      const res = await get(`?conversationId=${CONV}`)
      expect(res.status, failing).toBe(500)
      expect(await readJson(res)).toMatchObject({ code: 'INTERNAL' })
    }
  })
})
