/**
 * Route tests for POST /api/internal/analytics/skill-loaded — the eve main-chat
 * runtime's fire-and-forget `skill_auto_loaded` beacon (Agents & Skills redesign,
 * Phase 1 analytics).
 *
 * Asserts: 401 on a wrong/absent internal secret; 401 on an invalid/absent run
 * token; a valid call emits `skill_auto_loaded` with TOKEN tenancy (never the
 * body) + the skill name; a malformed body still 200s (analytics is best-effort).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const SECRET = 'test-chat-internal-secret-abcdefghij'

// ── Mock the analytics emitter (the only collaborator) ───────────────────────
const trackSpy = vi.fn((..._a: unknown[]) => {})
vi.mock('@/lib/posthog', () => ({
  trackServerEvent: (...a: unknown[]) => trackSpy(...a),
}))

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

import { POST } from '@/app/api/internal/analytics/skill-loaded/route'
import { mintChatRunToken, CHAT_RUN_SECRET_HEADER, CHAT_RUN_TOKEN_HEADER } from '@/lib/chat/chat-run-token'

function req(
  opts: { secret?: string; token?: string; body?: unknown; rawBody?: string } = {},
) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (opts.secret) headers[CHAT_RUN_SECRET_HEADER] = opts.secret
  if (opts.token) headers[CHAT_RUN_TOKEN_HEADER] = opts.token
  const body =
    opts.rawBody !== undefined ? opts.rawBody : JSON.stringify(opts.body ?? {})
  return new Request('http://localhost/api/internal/analytics/skill-loaded', {
    method: 'POST',
    headers,
    body,
  })
}

function validToken() {
  return mintChatRunToken({ conversationId: 'conv-1', workspaceId: 'ws-1', userId: 'user-1' })
}

describe('POST /api/internal/analytics/skill-loaded', () => {
  beforeEach(() => {
    process.env.CHAT_INTERNAL_SECRET = SECRET
    trackSpy.mockClear()
    serviceFrom.mockClear()
    ownerRowLive.current = true
    ownerLookupError.current = null
  })
  afterEach(() => {
    delete process.env.CHAT_INTERNAL_SECRET
  })

  it('401 when the internal secret is wrong/absent — no event', async () => {
    expect((await POST(req({ token: validToken(), body: { skillName: 'x' } }))).status).toBe(401)
    expect((await POST(req({ secret: 'nope', token: validToken(), body: { skillName: 'x' } }))).status).toBe(401)
    expect(trackSpy).not.toHaveBeenCalled()
  })

  it('401 when the run token is invalid/absent — no event', async () => {
    expect((await POST(req({ secret: SECRET, body: { skillName: 'x' } }))).status).toBe(401)
    expect((await POST(req({ secret: SECRET, token: 'garbage', body: { skillName: 'x' } }))).status).toBe(401)
    expect(trackSpy).not.toHaveBeenCalled()
  })

  it('200 and emits skill_auto_loaded with TOKEN tenancy (not the body)', async () => {
    const res = await POST(
      req({
        secret: SECRET,
        token: validToken(),
        // Body tries to spoof tenancy — must be ignored.
        body: { skillName: 'Weekly Planner', userId: 'HACKER', workspaceId: 'HACKER-WS' },
      }),
    )
    expect(res.status).toBe(200)
    expect(trackSpy).toHaveBeenCalledTimes(1)
    const [event, ctx, props] = trackSpy.mock.calls[0] as [
      string,
      Record<string, unknown>,
      Record<string, unknown>,
    ]
    expect(event).toBe('skill_auto_loaded')
    expect(ctx.userId).toBe('user-1')
    expect(ctx.workspaceId).toBe('ws-1')
    expect(props.skill_name).toBe('Weekly Planner')
    expect(props.conversation_id).toBe('conv-1')
    expect(props.workspace_id).toBe('ws-1')
  })

  it('device_ask token: accepted while its ownership row exists; 403 SURFACE_RUN_ENDED (no event) once it is deleted', async () => {
    const token = mintChatRunToken({ conversationId: 'conv-dev', workspaceId: 'ws-1', userId: 'user-1', surface: 'device_ask' })
    expect((await POST(req({ secret: SECRET, token, body: { skillName: 'x' } }))).status).toBe(200)
    expect(serviceFrom).toHaveBeenCalledWith('chat_conversations')
    expect(trackSpy).toHaveBeenCalledTimes(1)

    ownerRowLive.current = false
    const res = await POST(req({ secret: SECRET, token, body: { skillName: 'x' } }))
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe('SURFACE_RUN_ENDED')
    expect(trackSpy).toHaveBeenCalledTimes(1)
  })

  it('device_ask token: a DB blip on the liveness lookup is a transient 503 SURFACE_RUN_UNVERIFIED (never ENDED) — no event', async () => {
    const token = mintChatRunToken({ conversationId: 'conv-dev', workspaceId: 'ws-1', userId: 'user-1', surface: 'device_ask' })
    ownerLookupError.current = { message: 'connection reset' }
    const res = await POST(req({ secret: SECRET, token, body: { skillName: 'x' } }))
    expect(res.status).toBe(503)
    expect((await res.json()).code).toBe('SURFACE_RUN_UNVERIFIED')
    expect(trackSpy).not.toHaveBeenCalled()
  })

  it('a browser chat token binds to its conversation row too, and is refused once it is gone (security review 2026-10-31, P0-1)', async () => {
    expect((await POST(req({ secret: SECRET, token: validToken(), body: { skillName: 'x' } }))).status).toBe(200)
    expect(serviceFrom).toHaveBeenCalledWith('chat_conversations')
    ownerRowLive.current = false
    const res = await POST(req({ secret: SECRET, token: validToken(), body: { skillName: 'x' } }))
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe('RUN_TOKEN_UNBOUND')
  })

  it('200 with an undefined skill_name when the body is malformed (best-effort)', async () => {
    const res = await POST(req({ secret: SECRET, token: validToken(), rawBody: 'not json' }))
    expect(res.status).toBe(200)
    expect(trackSpy).toHaveBeenCalledTimes(1)
    const props = trackSpy.mock.calls[0][2] as Record<string, unknown>
    expect(props.skill_name).toBeUndefined()
  })
})
