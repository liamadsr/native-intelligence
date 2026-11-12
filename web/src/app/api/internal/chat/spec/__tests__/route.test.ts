/**
 * Route tests for GET /api/internal/chat/spec — the eve chat agent's
 * spec-rebuild trust boundary (Phase 4).
 *
 * Asserts: 401 on a wrong/absent internal secret; 401 on an invalid/absent run
 * token; a 200 ChatSpec on a valid secret+token, with the per-turn `ctx` query
 * param decoded and forwarded to the rebuild; and that a usage/billing Response
 * thrown by the rebuild is surfaced verbatim (not swallowed into a 500).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const SECRET = 'test-chat-internal-secret-abcdefghij'

const rebuildState: { spec: unknown; throws: Response | null } = {
  spec: { systemPrompt: 'SP', model: 'claude-haiku-4-5-20251001', ceiling: null, ceilingTools: [] },
  throws: null,
}
const rebuildSpy = vi.fn(async () => {
  if (rebuildState.throws) throw rebuildState.throws
  return rebuildState.spec
})

vi.mock('@/lib/chat/chat-run-rebuild', () => ({ rebuildChatSpec: (...a: unknown[]) => rebuildSpy(...(a as [])) }))

// The run-token DB binding's reads (surface-run-guard.ts): the token's
// conversation row (user-1's, in ws-1) exists iff `ownerRowLive.current` —
// for a device ask, its ownership row — and user-1 is a member of ws-1.
const ownerRowLive = { current: true }
// A lookup ERROR (a DB blip) instead of an answer, when set.
const ownerLookupError: { current: { message: string } | null } = { current: null }
const serviceFrom = vi.fn((table: string) => {
  const c: Record<string, unknown> = {}
  c.select = () => c
  c.eq = () => c
  c.maybeSingle = async () => {
    if (table === 'member') return { data: { id: 'member-1' }, error: null }
    return ownerLookupError.current
      ? { data: null, error: ownerLookupError.current }
      : { data: ownerRowLive.current ? { id: 'conv', user_id: 'user-1', workspace_id: 'ws-1' } : null, error: null }
  }
  return c
})
vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({ from: serviceFrom }) }))

// The turn's mention edges (src/lib/entity-links/turn-mentions.ts): the writer
// is spied on; which refs a context names is the real reader's.
const turnMentionsSpy = vi.fn(async (..._args: unknown[]) => {})
vi.mock('@/lib/entity-links/turn-mentions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entity-links/turn-mentions')>()),
  syncTurnMentions: (...a: unknown[]) => turnMentionsSpy(...a),
}))

import { GET } from '@/app/api/internal/chat/spec/route'
import { mintChatRunToken, CHAT_RUN_SECRET_HEADER, CHAT_RUN_TOKEN_HEADER } from '@/lib/chat/chat-run-token'

function req(opts: { secret?: string; token?: string; ctx?: unknown; live?: boolean } = {}) {
  const url = new URL('http://localhost/api/internal/chat/spec')
  if (opts.live) url.searchParams.set('live', '1')
  if (opts.ctx !== undefined) {
    url.searchParams.set('ctx', Buffer.from(JSON.stringify(opts.ctx), 'utf8').toString('base64url'))
  }
  const headers: Record<string, string> = {}
  if (opts.secret) headers[CHAT_RUN_SECRET_HEADER] = opts.secret
  if (opts.token) headers[CHAT_RUN_TOKEN_HEADER] = opts.token
  return new Request(url, { method: 'GET', headers })
}

function validToken() {
  return mintChatRunToken({ conversationId: 'c', workspaceId: 'ws-1', userId: 'user-1' })
}

describe('GET /api/internal/chat/spec', () => {
  beforeEach(() => {
    process.env.CHAT_INTERNAL_SECRET = SECRET
    rebuildState.spec = { systemPrompt: 'SP', model: 'claude-haiku-4-5-20251001', ceiling: null, ceilingTools: [] }
    rebuildState.throws = null
    rebuildSpy.mockClear()
    serviceFrom.mockClear()
    turnMentionsSpy.mockClear()
    ownerRowLive.current = true
  })
  afterEach(() => {
    delete process.env.CHAT_INTERNAL_SECRET
  })

  it('401 when the internal secret is wrong/absent', async () => {
    expect((await GET(req({ token: validToken() }))).status).toBe(401)
    expect((await GET(req({ secret: 'nope', token: validToken() }))).status).toBe(401)
    expect(rebuildSpy).not.toHaveBeenCalled()
  })

  it('401 when the run token is invalid/absent', async () => {
    expect((await GET(req({ secret: SECRET }))).status).toBe(401)
    expect((await GET(req({ secret: SECRET, token: 'garbage' }))).status).toBe(401)
    expect(rebuildSpy).not.toHaveBeenCalled()
  })

  it('200 ChatSpec on valid secret+token, forwarding decoded ctx', async () => {
    const route = { excerpt: 'hi', chars: 2, attachmentKinds: [], codeFences: 0, listItems: 0 }
    const turn = { route, systemContext: { liveCaptureId: 'cap-1' } }
    const res = await GET(req({ secret: SECRET, token: validToken(), ctx: turn }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.systemPrompt).toBe('SP')
    expect(body.model).toBe('claude-haiku-4-5-20251001')
    expect(body.ceiling).toBeNull()
    // ctx was decoded and forwarded to the rebuild's second arg.
    expect(rebuildSpy).toHaveBeenCalledTimes(1)
    const [claimsArg, turnArg] = rebuildSpy.mock.calls[0] as unknown[]
    expect((claimsArg as { userId: string }).userId).toBe('user-1')
    expect(turnArg).toMatchObject({ route })
    expect((turnArg as { systemContext: { liveCaptureId: string } }).systemContext.liveCaptureId).toBe('cap-1')
  })

  it('forwards the variant flags: ?skills=1 &schemas=1 &turnContext=1 (the split prompt), each off unless asked', async () => {
    const asked = new URL('http://localhost/api/internal/chat/spec?skills=1&schemas=1&turnContext=1')
    const headers = { [CHAT_RUN_SECRET_HEADER]: SECRET, [CHAT_RUN_TOKEN_HEADER]: validToken() }
    expect((await GET(new Request(asked, { method: 'GET', headers }))).status).toBe(200)
    expect((rebuildSpy.mock.calls[0] as unknown[])[2]).toEqual({ includeSkills: true, includeSchemas: true, splitTurnContext: true })
    expect((await GET(req({ secret: SECRET, token: validToken() }))).status).toBe(200)
    expect((rebuildSpy.mock.calls[1] as unknown[])[2]).toEqual({ includeSkills: false, includeSchemas: false, splitTurnContext: false })
  })

  it('never forwards an older client\'s model or thinking (nobody picks a model); a malformed route is dropped', async () => {
    await GET(req({ secret: SECRET, token: validToken(), ctx: { model: 'deepseek-v4-pro', thinking: 'max' } }))
    const turn = (rebuildSpy.mock.calls[0] as unknown[])[1] as Record<string, unknown>
    expect(turn).not.toHaveProperty('model')
    expect(turn).not.toHaveProperty('thinking')
    expect(turn.route).toBeNull()
    rebuildSpy.mockClear()
    await GET(req({ secret: SECRET, token: validToken(), ctx: { route: { excerpt: 'x', chars: -1, codeFences: 0, listItems: 0 } } }))
    expect(((rebuildSpy.mock.calls[0] as unknown[])[1] as { route?: unknown }).route).toBeNull()
  })

  it('does not forward the removed "My captures" picker: an older client\'s searchSettings is dropped', async () => {
    const searchSettings = { timeWindow: 'recent', includeTranscripts: false, includeAttachments: true }
    const res = await GET(req({ secret: SECRET, token: validToken(), ctx: { searchSettings, systemContext: { liveCaptureId: 'c' } } }))
    expect(res.status).toBe(200)
    const turn = (rebuildSpy.mock.calls[0] as unknown[])[1] as Record<string, unknown>
    expect(turn).not.toHaveProperty('searchSettings')
    expect(turn).toMatchObject({ systemContext: { liveCaptureId: 'c' } })
  })

  it('degrades a malformed ctx to an empty turn context (still 200)', async () => {
    const url = new URL('http://localhost/api/internal/chat/spec')
    url.searchParams.set('ctx', 'not-valid-base64url-json!!!')
    const res = await GET(
      new Request(url, {
        method: 'GET',
        headers: { [CHAT_RUN_SECRET_HEADER]: SECRET, [CHAT_RUN_TOKEN_HEADER]: validToken() },
      }),
    )
    expect(res.status).toBe(200)
    expect(rebuildSpy).toHaveBeenCalledTimes(1)
  })

  it('quick helpers: the flag and the helper tools come from the VERIFIED token, with the reason when refused', async () => {
    rebuildState.spec = {
      systemPrompt: 'SP',
      model: 'm',
      ceiling: null,
      ceilingTools: ['find', 'show', 'push_action_to_jira', 'read_browser_page', 'create_email_draft', 'create_action', 'remember', 'mcp__x__y'].map((name) => ({ name })),
    }
    const main = await (await GET(req({ secret: SECRET, token: validToken() }))).json()
    expect(main).toMatchObject({ helpersAllowed: true, helperToolNames: ['find', 'create_email_draft'] })
    expect(main.helpersRefusal).toBeUndefined()

    const relay = mintChatRunToken({ conversationId: 'c', workspaceId: 'ws-1', userId: 'user-1', teammateId: 'tm-1', relay: 'r-1' })
    const bot = await (await GET(req({ secret: SECRET, token: relay }))).json()
    expect(bot).toMatchObject({ helpersAllowed: false, helperToolNames: [] })
    expect(bot.helpersRefusal).toMatch(/relayed turn/)

    const server = mintChatRunToken({ conversationId: 'c', workspaceId: 'ws-1', userId: 'user-1', server: 'idle_compaction' })
    expect(await (await GET(req({ secret: SECRET, token: server }))).json()).toMatchObject({ helpersAllowed: false })
  })

  it('surfaces a usage/billing Response thrown by the rebuild verbatim', async () => {
    rebuildState.throws = new Response(JSON.stringify({ error: 'Usage limit exceeded' }), { status: 429 })
    const res = await GET(req({ secret: SECRET, token: validToken() }))
    expect(res.status).toBe(429)
  })

  it('device_ask token: rebuilds while its ownership row exists; a deleted row REVOKES it (403, no rebuild)', async () => {
    const token = mintChatRunToken({ conversationId: 'conv-dev', workspaceId: 'ws-1', userId: 'user-1', surface: 'device_ask' })
    expect((await GET(req({ secret: SECRET, token }))).status).toBe(200)
    expect(serviceFrom).toHaveBeenCalledWith('chat_conversations')
    expect(rebuildSpy).toHaveBeenCalledTimes(1)

    ownerRowLive.current = false
    const res = await GET(req({ secret: SECRET, token }))
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe('SURFACE_RUN_ENDED')
    expect(rebuildSpy).toHaveBeenCalledTimes(1)
  })

  it('?live=1 answers the liveness gate only: 200 {live} with no rebuild, 403 SURFACE_RUN_ENDED once the row is gone, 401 on a bad token', async () => {
    const token = mintChatRunToken({ conversationId: 'conv-dev', workspaceId: 'ws-1', userId: 'user-1', surface: 'device_ask' })
    const live = await GET(req({ secret: SECRET, token, live: true }))
    expect(live.status).toBe(200)
    expect(await live.json()).toEqual({ live: true })
    expect(rebuildSpy).not.toHaveBeenCalled()

    ownerRowLive.current = false
    const ended = await GET(req({ secret: SECRET, token, live: true }))
    expect(ended.status).toBe(403)
    expect((await ended.json()).code).toBe('SURFACE_RUN_ENDED')

    expect((await GET(req({ secret: SECRET, token: 'garbage', live: true }))).status).toBe(401)
    expect(rebuildSpy).not.toHaveBeenCalled()
  })

  it('device_ask: a DB blip on the liveness lookup is a transient 503 SURFACE_RUN_UNVERIFIED (spec and ?live=1), never SURFACE_RUN_ENDED — and nothing is rebuilt', async () => {
    const token = mintChatRunToken({ conversationId: 'conv-dev', workspaceId: 'ws-1', userId: 'user-1', surface: 'device_ask' })
    ownerLookupError.current = { message: 'connection reset' }
    try {
      for (const live of [false, true]) {
        const res = await GET(req({ secret: SECRET, token, live }))
        expect(res.status).toBe(503)
        expect((await res.json()).code).toBe('SURFACE_RUN_UNVERIFIED')
      }
      expect(rebuildSpy).not.toHaveBeenCalled()
    } finally {
      ownerLookupError.current = null
    }
  })

  it('a browser chat token binds to its conversation row and membership too (security review 2026-10-31, P0-1)', async () => {
    expect((await GET(req({ secret: SECRET, token: validToken() }))).status).toBe(200)
    expect(serviceFrom.mock.calls.map(([t]) => t).sort()).toEqual(['chat_conversations', 'member'])
  })

  it('a browser token whose conversation row is gone is refused (RUN_TOKEN_UNBOUND) and nothing is rebuilt', async () => {
    ownerRowLive.current = false
    const res = await GET(req({ secret: SECRET, token: validToken() }))
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe('RUN_TOKEN_UNBOUND')
    expect(rebuildSpy).not.toHaveBeenCalled()
  })

  it('500 on a non-Response rebuild failure', async () => {
    rebuildState.throws = null
    rebuildSpy.mockImplementationOnce(async () => {
      throw new Error('boom')
    })
    const res = await GET(req({ secret: SECRET, token: validToken() }))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.code).toBe('CHAT_SPEC_REBUILD_FAILED')
  })

  it('the turn’s @-mentions become edges from the conversation, once a turn (the skills fetch only)', async () => {
    const ctx = { systemContext: { attachedDealIds: ['de000000-0000-4000-8000-000000000001'] } }
    const plain = new URL(req({ secret: SECRET, token: validToken(), ctx }).url)
    await GET(new Request(plain, { headers: { [CHAT_RUN_SECRET_HEADER]: SECRET, [CHAT_RUN_TOKEN_HEADER]: validToken() } }))
    expect(turnMentionsSpy).not.toHaveBeenCalled()
    plain.searchParams.set('skills', '1')
    await GET(new Request(plain, { headers: { [CHAT_RUN_SECRET_HEADER]: SECRET, [CHAT_RUN_TOKEN_HEADER]: validToken() } }))
    await new Promise((r) => setTimeout(r, 0))
    expect(turnMentionsSpy).toHaveBeenCalledTimes(1)
    expect(turnMentionsSpy.mock.calls[0][1]).toMatchObject({ workspaceId: 'ws-1', userId: 'user-1', conversationId: 'c', systemContext: ctx.systemContext })
  })
})
