/**
 * POST /api/internal/chat/memory (slice A2a): the chat agent's profile memory
 * slot recalls through here. Pins the auth, exactly as the tool route's: the
 * internal secret, then an unexpired run token as the only source of tenancy,
 * eve's locked scope must name that token's own user and workspace, a teammate
 * token is refused (it keeps its own memory), and a device-ask token must still
 * be live. Then the recall itself: two records, epochs and the memo by
 * operationId (profile-recall.test.ts covers the details).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { FakeSupabase } from '@/lib/work/__tests__/fake-supabase'
import { makeFakeMemoryDb } from '@/lib/memory/__tests__/fake-memory-db'

const SECRET = 'test-chat-internal-secret-abcdefghij'

const state = vi.hoisted(() => ({ db: null as unknown, surfaceRefusal: null as Response | null, sent: [] as unknown[], sendFails: false }))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => state.db }))
vi.mock('@/lib/inngest/client', () => ({
  inngest: {
    send: async (event: unknown) => {
      if (state.sendFails) throw new Error('inngest down')
      state.sent.push(event)
      return { ids: ['e'] }
    },
  },
}))
vi.mock('@/lib/chat/surface-run-guard', () => ({
  chatRunBindingRefusal: async (claims: { surface?: string }) => (claims.surface ? state.surfaceRefusal : null),
}))

const { POST } = await import('../route')
const { mintChatRunToken, CHAT_RUN_SECRET_HEADER, CHAT_RUN_TOKEN_HEADER } = await import('@/lib/chat/chat-run-token')

const browserToken = (over: Record<string, unknown> = {}) =>
  mintChatRunToken({ conversationId: 'conv-1', workspaceId: 'ws-1', userId: 'user-1', ...over } as Parameters<typeof mintChatRunToken>[0])

function req(opts: { secret?: string; token?: string; body?: unknown }) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (opts.secret) headers[CHAT_RUN_SECRET_HEADER] = opts.secret
  if (opts.token) headers[CHAT_RUN_TOKEN_HEADER] = opts.token
  return new Request('https://dial8.ai/api/internal/chat/memory', { method: 'POST', headers, body: JSON.stringify(opts.body ?? {}) })
}
const body = (over: Record<string, unknown> = {}) => ({
  op: 'recall',
  phase: 'turn.started',
  operationId: 'eve-memory-operation-v1:sess-1:1:turn_1:turn.started:profile',
  sessionId: 'sess-1',
  scope: ['user-1', 'ws-1'],
  ...over,
})

let db: FakeSupabase
beforeEach(() => {
  process.env.CHAT_INTERNAL_SECRET = SECRET
  db = makeFakeMemoryDb()
  db.seed('profile_fact', [{ id: 'a', user_id: 'user-1', text: 'Keep answers short', status: 'active', importance: 3, superseded_by: null, updated_at: '2026-10-01' }])
  state.db = db
  state.surfaceRefusal = null
  state.sent = []
  state.sendFails = false
})
afterEach(() => {
  delete process.env.CHAT_INTERNAL_SECRET
})

describe('POST /api/internal/chat/memory', () => {
  const expiredToken = () => {
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() - 2 * 60 * 60 * 1000)
    try {
      return browserToken()
    } finally {
      vi.useRealTimers()
    }
  }

  it('refuses a missing or wrong secret, and a missing or forged token (401)', async () => {
    expect((await POST(req({ token: browserToken(), body: body() }))).status).toBe(401)
    expect((await POST(req({ secret: 'nope', token: browserToken(), body: body() }))).status).toBe(401)
    expect((await POST(req({ secret: SECRET, body: body() }))).status).toBe(401)
    expect((await POST(req({ secret: SECRET, token: `${browserToken()}x`, body: body() }))).status).toBe(401)
    expect(db.calls).toHaveLength(0)
  })

  it('an expired token only replays a stored result: never new work (401 without one)', async () => {
    expect((await POST(req({ secret: SECRET, token: expiredToken(), body: body() }))).status).toBe(401)
    expect(db.rows('chat_memory_epoch')).toHaveLength(0)
    expect(db.rows('chat_memory_op')).toHaveLength(0)
    const first = (await (await POST(req({ secret: SECRET, token: browserToken(), body: body() }))).json()) as { result: unknown }
    const replay = await POST(req({ secret: SECRET, token: expiredToken(), body: body() }))
    expect(replay.status).toBe(200)
    expect(JSON.stringify(((await replay.json()) as { result: unknown }).result)).toBe(JSON.stringify(first.result))
    // A new operation on the expired token is refused.
    expect((await POST(req({ secret: SECRET, token: expiredToken(), body: body({ operationId: 'op-new' }) }))).status).toBe(401)
  })

  it("refuses a scope that is not the token's own user and workspace (403)", async () => {
    for (const scope of [['user-2', 'ws-1'], ['user-1', 'ws-2'], ['user-1'], 'user-1', undefined]) {
      const res = await POST(req({ secret: SECRET, token: browserToken(), body: body({ scope }) }))
      expect(res.status).toBe(403)
    }
    expect(db.calls).toHaveLength(0)
  })

  it('refuses a teammate token: a teammate chat keeps its own memory', async () => {
    const res = await POST(req({ secret: SECRET, token: browserToken({ teammateId: 'tm-1' }), body: body() }))
    expect(res.status).toBe(403)
  })

  it('refuses a device ask that has ended, and recalls for a live one', async () => {
    const device = browserToken({ surface: 'device_ask' })
    state.surfaceRefusal = Response.json({ error: 'this run has ended' }, { status: 403 })
    expect((await POST(req({ secret: SECRET, token: device, body: body() }))).status).toBe(403)
    state.surfaceRefusal = null
    expect((await POST(req({ secret: SECRET, token: device, body: body() }))).status).toBe(200)
  })

  it('rejects a malformed body (400): op, phase, operationId and sessionId are checked', async () => {
    for (const bad of [body({ op: 'capture' }), body({ phase: 'turn.completed' }), body({ operationId: '' }), body({ sessionId: 7 })]) {
      expect((await POST(req({ secret: SECRET, token: browserToken(), body: bad }))).status).toBe(400)
    }
  })

  it('recalls the facts record, tenancy from the token, and a replay returns the same bytes', async () => {
    const res = await POST(req({ secret: SECRET, token: browserToken(), body: body() }))
    expect(res.status).toBe(200)
    const json = (await res.json()) as { result: { messages: Array<{ id: string; content: string }> }; replayed: boolean }
    // No delta record until something changes (A2a review).
    expect(json.result.messages.map((m) => m.id)).toEqual(['facts'])
    expect(json.result.messages[0].content).toContain('- Keep answers short')
    expect(json.replayed).toBe(false)
    expect(db.rows('chat_memory_epoch')[0]).toMatchObject({ session_id: 'sess-1', user_id: 'user-1', workspace_id: 'ws-1', conversation_id: 'conv-1' })

    db.seed('profile_fact', [{ id: 'b', user_id: 'user-1', text: 'Works 7am to 3pm', status: 'active', importance: 3, superseded_by: null, updated_at: '2026-10-14' }])
    const again = (await (await POST(req({ secret: SECRET, token: browserToken(), body: body() }))).json()) as typeof json
    expect(again.replayed).toBe(true)
    expect(JSON.stringify(again.result)).toBe(JSON.stringify(json.result))
  })

  describe("a home thread's session (created parked by the server principal, 2026-10-18)", () => {
    // The slot's scope there is the server principal's: the verified home-turn token's user + workspace.
    const homeTurnToken = (over: Record<string, unknown> = {}) => browserToken({ server: 'home_turn', ...over })

    it("recalls on a server turn's home-turn token and on the person's own turn, both for the person's scope", async () => {
      const server = await POST(req({ secret: SECRET, token: homeTurnToken(), body: body() }))
      expect(server.status).toBe(200)
      expect(db.rows('chat_memory_epoch')[0]).toMatchObject({ session_id: 'sess-1', user_id: 'user-1', workspace_id: 'ws-1' })
      const person = await POST(req({ secret: SECRET, token: browserToken(), body: body({ operationId: 'op-person' }) }))
      expect(person.status).toBe(200)
    })

    it("refuses a scope that is not the token's own: no server principal reads or writes another person's memory (403)", async () => {
      // Another person's home-turn token against this person's scope, and the reverse.
      expect((await POST(req({ secret: SECRET, token: homeTurnToken({ userId: 'user-2' }), body: body() }))).status).toBe(403)
      expect((await POST(req({ secret: SECRET, token: homeTurnToken(), body: body({ scope: ['user-2', 'ws-1'] }) }))).status).toBe(403)
      expect((await POST(req({ secret: SECRET, token: homeTurnToken({ workspaceId: 'ws-2' }), body: body() }))).status).toBe(403)
      for (const op of ['pin', 'capture', 'checkpoint']) {
        const extra = op === 'pin' ? { phase: 'turn.started', result: { messages: [] } } : op === 'capture' ? { phase: 'compaction.requested', messages: [{ role: 'user', text: 'x' }] } : { phase: 'compaction.completed', text: 'x' }
        expect((await POST(req({ secret: SECRET, token: homeTurnToken({ userId: 'user-2' }), body: body({ op, ...extra }) }))).status).toBe(403)
      }
      expect(db.calls).toHaveLength(0)
    })

    it("refuses another person's token on this person's session, even with a scope matching that token (403)", async () => {
      expect((await POST(req({ secret: SECRET, token: homeTurnToken(), body: body() }))).status).toBe(200)
      const other = browserToken({ userId: 'user-2', server: 'home_turn' })
      const res = await POST(req({ secret: SECRET, token: other, body: body({ operationId: 'op-other', scope: ['user-2', 'ws-1'] }) }))
      expect(res.status).toBe(403)
    })
  })

  it('a database failure is a 500, never a partial result', async () => {
    state.db = { from: () => ({ select: () => { throw new Error('db down') } }) }
    const res = await POST(req({ secret: SECRET, token: browserToken(), body: body() }))
    expect(res.status).toBe(500)
  })

  it("op 'pin' stores the provider's fallback unless a result is stored, and answers the stored bytes", async () => {
    const fallback = { messages: [{ id: 'facts', content: '<memory>fallback</memory>' }] }
    const pin = (over: Record<string, unknown> = {}) => POST(req({ secret: SECRET, token: browserToken(), body: body({ op: 'pin', result: fallback, ...over }) }))
    const first = await pin()
    expect(first.status).toBe(200)
    expect(((await first.json()) as { result: unknown }).result).toEqual(fallback)
    // A later recall of that operation (a replay) gets the pinned bytes.
    const replay = (await (await POST(req({ secret: SECRET, token: browserToken(), body: body() }))).json()) as { result: unknown; replayed: boolean }
    expect(replay).toEqual({ result: fallback, replayed: true })
    // A pin after the app stored its own result gets that result back.
    const stored = (await (await POST(req({ secret: SECRET, token: browserToken(), body: body({ operationId: 'op-2' }) }))).json()) as { result: unknown }
    const lost = (await (await pin({ operationId: 'op-2' })).json()) as { result: unknown }
    expect(lost.result).toEqual(stored.result)
    expect((await pin({ result: { messages: [{ id: 'x', content: '' }] } })).status).toBe(400)
    expect((await pin({ scope: ['user-2', 'ws-1'] })).status).toBe(403)
  })
})

describe("POST /api/internal/chat/memory — op 'capture' (A2c)", () => {
  const capture = (over: Record<string, unknown> = {}) =>
    body({
      op: 'capture',
      phase: 'compaction.requested',
      operationId: 'eve-memory-operation-v1:sess-1:9:turn_9:compaction.requested:profile',
      sequence: 9,
      messages: [
        { role: 'user', text: 'Call me Liam. I prefer bullet points.' },
        { role: 'assistant', text: 'Noted.' },
        { role: 'tool', text: 'dropped' },
      ],
      ...over,
    })
  const tokenExpiredBy = (ms: number) => {
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() - 60 * 60 * 1000 - ms)
    try {
      return browserToken()
    } finally {
      vi.useRealTimers()
    }
  }

  it('queues the pass: records the operation, sends ids and the slice, and the session’s bookkeeping', async () => {
    db.seed('chat_memory_epoch', [{ session_id: 'sess-1', user_id: 'user-1', workspace_id: 'ws-1', snapshot: [] }])
    const res = await POST(req({ secret: SECRET, token: browserToken(), body: capture() }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ result: { queued: true, replayed: false } })
    expect(state.sent).toHaveLength(1)
    expect(state.sent[0]).toMatchObject({
      name: 'chat/memory.capture',
      id: expect.stringMatching(/^memory-capture-[0-9a-f]{40}$/),
      data: {
        operationId: capture().operationId,
        sessionId: 'sess-1',
        userId: 'user-1',
        workspaceId: 'ws-1',
        conversationId: 'conv-1',
        slice: [
          { role: 'user', text: 'Call me Liam. I prefer bullet points.' },
          { role: 'assistant', text: 'Noted.' },
        ],
      },
    })
    expect(db.rows('chat_memory_op')[0]).toMatchObject({ op: 'capture', phase: 'compaction.requested', session_id: 'sess-1', user_id: 'user-1', result: { status: 'queued' } })
    expect(db.rows('chat_memory_epoch')[0]).toMatchObject({ captured_through_seq: 9, captured_through_at: expect.any(String), last_capture_at: expect.any(String) })
  })

  it('is idempotent by operationId: a replay queues nothing', async () => {
    await POST(req({ secret: SECRET, token: browserToken(), body: capture() }))
    const again = await POST(req({ secret: SECRET, token: browserToken(), body: capture() }))
    expect(await again.json()).toEqual({ result: { queued: false, replayed: true } })
    expect(state.sent).toHaveLength(1)
    expect(db.rows('chat_memory_op')).toHaveLength(1)
  })

  it('makes the session’s epoch when it has none, so its bookkeeping lands', async () => {
    await POST(req({ secret: SECRET, token: browserToken(), body: capture() }))
    expect(db.rows('chat_memory_epoch')[0]).toMatchObject({ session_id: 'sess-1', user_id: 'user-1', workspace_id: 'ws-1', snapshot: [{ id: 'a', text: 'Keep answers short' }], last_capture_at: expect.any(String) })
  })

  it('accepts a token up to two hours past expiry for capture only, never longer', async () => {
    expect((await POST(req({ secret: SECRET, token: tokenExpiredBy(60 * 60 * 1000), body: capture() }))).status).toBe(200)
    expect((await POST(req({ secret: SECRET, token: tokenExpiredBy(3 * 60 * 60 * 1000), body: capture({ operationId: 'op-late' }) }))).status).toBe(401)
    // Recall keeps its replay-only rule on the same expired token.
    expect((await POST(req({ secret: SECRET, token: tokenExpiredBy(60 * 60 * 1000), body: body({ operationId: 'op-recall-new' }) }))).status).toBe(401)
  })

  it('holds the same auth as recall: scope and teammate checks', async () => {
    expect((await POST(req({ secret: SECRET, token: browserToken(), body: capture({ scope: ['user-2', 'ws-1'] }) }))).status).toBe(403)
    expect((await POST(req({ secret: SECRET, token: browserToken({ teammateId: 'tm-1' }), body: capture() }))).status).toBe(403)
    expect((await POST(req({ secret: 'nope', token: browserToken(), body: capture() }))).status).toBe(401)
    expect((await POST(req({ secret: SECRET, token: browserToken(), body: capture({ messages: 'x' }) }))).status).toBe(400)
    expect(state.sent).toHaveLength(0)
  })

  it('records but queues nothing when the person said nothing', async () => {
    const res = await POST(req({ secret: SECRET, token: browserToken(), body: capture({ messages: [{ role: 'assistant', text: 'Hi' }] }) }))
    expect(await res.json()).toEqual({ result: { queued: false, replayed: false } })
    expect(state.sent).toHaveLength(0)
    expect(db.rows('chat_memory_op')[0]).toMatchObject({ result: { status: 'empty' } })
  })

  it('a failed send frees the operation (500), so a retry can queue it', async () => {
    state.sendFails = true
    expect((await POST(req({ secret: SECRET, token: browserToken(), body: capture() }))).status).toBe(500)
    expect(db.rows('chat_memory_op')).toHaveLength(0)
    state.sendFails = false
    expect(await (await POST(req({ secret: SECRET, token: browserToken(), body: capture() }))).json()).toEqual({ result: { queued: true, replayed: false } })
  })
})

describe('the capture route through the slot’s real postChatMemory (A2 review)', () => {
  it('parses a capture answer as a success, so a queued capture is not logged as a failure', async () => {
    const { postChatMemory } = await import('../../../../../../../agents/chat-agent/lib/spec-client')
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.test'
    const realFetch = global.fetch
    // The slot's fetch lands on this route.
    global.fetch = (async (_url: unknown, init?: RequestInit) =>
      POST(new Request('https://app.test/api/internal/chat/memory', init))) as typeof fetch
    try {
      const result = await postChatMemory(browserToken(), {
        op: 'capture',
        phase: 'compaction.requested',
        operationId: 'op-real-parse',
        sessionId: 'sess-1',
        scope: ['user-1', 'ws-1'],
        sequence: 2,
        messages: [{ role: 'user', text: 'Call me Liam, please.' }],
      })
      expect(result).toEqual({ queued: true, replayed: false })
    } finally {
      global.fetch = realFetch
      delete process.env.NEXT_PUBLIC_APP_URL
    }
  })
})

describe("op 'checkpoint' (A3 re-priming)", () => {
  const checkpoint = (over: Record<string, unknown> = {}) => body({ op: 'checkpoint', phase: 'compaction.completed', text: 'We planned the renewal.', ...over })
  const seedConv = () =>
    db.seed('chat_conversations', [{ id: 'conv-1', user_id: 'user-1', workspace_id: 'ws-1', is_home: true, checkpoint_summary: null, checkpoint_at: null }])

  it("stores the text on the token's own conversation, and a replay of the same text leaves checkpoint_at alone", async () => {
    seedConv()
    const res = await POST(req({ secret: SECRET, token: browserToken(), body: checkpoint() }))
    expect(res.status).toBe(200)
    expect(((await res.json()) as { result: unknown }).result).toEqual({ stored: true, unchanged: false })
    const row = db.rows('chat_conversations')[0]
    expect(row.checkpoint_summary).toBe('We planned the renewal.')
    const at = row.checkpoint_at
    expect(typeof at).toBe('string')
    const replay = await POST(req({ secret: SECRET, token: browserToken(), body: checkpoint() }))
    expect(((await replay.json()) as { result: unknown }).result).toEqual({ stored: false, unchanged: true })
    expect(db.rows('chat_conversations')[0].checkpoint_at).toBe(at)
  })

  it('needs the compaction.completed phase and a text', async () => {
    seedConv()
    expect((await POST(req({ secret: SECRET, token: browserToken(), body: checkpoint({ phase: 'turn.started' }) }))).status).toBe(400)
    expect((await POST(req({ secret: SECRET, token: browserToken(), body: checkpoint({ text: '  ' }) }))).status).toBe(400)
    expect(db.rows('chat_conversations')[0].checkpoint_summary).toBeNull()
  })

  it('holds the same auth as recall: scope and teammate checks', async () => {
    seedConv()
    expect((await POST(req({ secret: SECRET, token: browserToken(), body: checkpoint({ scope: ['user-2', 'ws-1'] }) }))).status).toBe(403)
    expect((await POST(req({ secret: SECRET, token: browserToken({ teammateId: 'tm-1' }), body: checkpoint() }))).status).toBe(403)
    expect(db.rows('chat_conversations')[0].checkpoint_summary).toBeNull()
  })
})
