/**
 * POST /api/account/chat/eve-persist — the BROWSER-facing single writer of eve
 * main-chat assistant turns. Auth matrix + delegation:
 *   - no Supabase session → the requireWorkspace Response is returned (401);
 *   - a valid session but NO / invalid run token → 401;
 *   - a valid session whose user id ≠ the token's userId → 403;
 *   - a server-minted device-surface token → 403 (no in-app chat to write);
 *   - the happy path (session user === token user) → calls the shared
 *     persistEveTurn with the VERIFIED token claims (tenancy never from the body).
 */
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest'

// The idle-compaction signal is covered in route.idle-compaction.test.ts: no Inngest here.
vi.mock('@/lib/chat/idle-compaction-signal', () => ({ signalChatSessionActivity: vi.fn() }))

const SECRET = 'test-chat-internal-secret-abcdefghij'

// ── Mocks ────────────────────────────────────────────────────────────────────
const persistEveTurnSpy = vi.fn(async (..._a: unknown[]) => ({
  written: true,
  conversationId: 'conv-1',
  activityFired: true,
  reason: undefined,
}))
// parsePersistEveTurnBody is the REAL implementation (shared shape validation);
// only the side-effecting persistEveTurn is stubbed so we assert delegation.
vi.mock('@/lib/chat/persist-eve-turn', async () => {
  const actual = await vi.importActual<typeof import('@/lib/chat/persist-eve-turn')>(
    '@/lib/chat/persist-eve-turn',
  )
  return { ...actual, persistEveTurn: (...a: unknown[]) => persistEveTurnSpy(...a) }
})

vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({}) }))

const trackServerEventSpy = vi.fn()
vi.mock('@/lib/posthog', () => ({ trackServerEvent: (...a: unknown[]) => trackServerEventSpy(...a) }))

// requireWorkspace is toggled per test: a Response (unauthed) or an auth object.
const requireWorkspaceMock = vi.fn()
vi.mock('@/lib/api-auth', () => ({ requireWorkspace: () => requireWorkspaceMock() }))

import { POST } from '../route'
import { mintChatRunToken, CHAT_RUN_TOKEN_HEADER } from '@/lib/chat/chat-run-token'
import type { NextRequest } from 'next/server'

function authOk(userId = 'user-1') {
  return { supabase: {}, user: { id: userId }, workspaceId: 'ws-1' }
}

function tokenFor(userId = 'user-1') {
  return mintChatRunToken({ conversationId: 'conv-1', workspaceId: 'ws-1', userId })
}

const goodBody = { messageId: 'm-1', parts: [{ type: 'text', text: 'hi' }] }

function req(opts: { token?: string; body?: Record<string, unknown> } = {}): NextRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (opts.token) headers[CHAT_RUN_TOKEN_HEADER] = opts.token
  return new Request('http://localhost/api/account/chat/eve-persist', {
    method: 'POST',
    headers,
    body: JSON.stringify(opts.body ?? goodBody),
  }) as unknown as NextRequest
}

describe('POST /api/account/chat/eve-persist', () => {
  let infoSpy: MockInstance<typeof console.info>
  /** The route's `[chat-ttft]` lines, parsed. */
  const ttftLines = () =>
    infoSpy.mock.calls.filter(([tag]) => tag === '[chat-ttft]').map(([, json]) => JSON.parse(json as string))

  beforeEach(() => {
    process.env.CHAT_INTERNAL_SECRET = SECRET
    persistEveTurnSpy.mockClear()
    trackServerEventSpy.mockClear()
    requireWorkspaceMock.mockReset()
    requireWorkspaceMock.mockResolvedValue(authOk())
    infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
  })
  afterEach(() => {
    delete process.env.CHAT_INTERNAL_SECRET
    infoSpy.mockRestore()
  })

  it('returns the requireWorkspace Response when there is no session (401)', async () => {
    requireWorkspaceMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
    )
    const res = await POST(req({ token: tokenFor() }))
    expect(res.status).toBe(401)
    expect(persistEveTurnSpy).not.toHaveBeenCalled()
  })

  it('401s when the run token is absent or invalid', async () => {
    expect((await POST(req({ body: goodBody }))).status).toBe(401)
    expect((await POST(req({ token: 'garbage', body: goodBody }))).status).toBe(401)
    expect(persistEveTurnSpy).not.toHaveBeenCalled()
  })

  it('403s when the session user is NOT the token user', async () => {
    // Session is user-1; the token was minted for a DIFFERENT user.
    const res = await POST(req({ token: tokenFor('someone-else'), body: goodBody }))
    expect(res.status).toBe(403)
    expect(persistEveTurnSpy).not.toHaveBeenCalled()
  })

  it('403s a device-surface token even for its own user (no in-app chat behind it)', async () => {
    const deviceToken = mintChatRunToken({
      conversationId: 'conv-device',
      workspaceId: 'ws-1',
      userId: 'user-1',
      surface: 'device_ask',
    })
    const res = await POST(req({ token: deviceToken, body: goodBody }))
    expect(res.status).toBe(403)
    expect(persistEveTurnSpy).not.toHaveBeenCalled()
  })

  it('403s a server-minted token (a home turn, idle compaction): the server writes its own turns', async () => {
    for (const server of ['home_turn', 'idle_compaction'] as const) {
      const serverToken = mintChatRunToken({ conversationId: 'conv-1', workspaceId: 'ws-1', userId: 'user-1', server })
      const res = await POST(req({ token: serverToken, body: goodBody }))
      expect(res.status).toBe(403)
    }
    expect(persistEveTurnSpy).not.toHaveBeenCalled()
  })

  it('400s on a malformed body (missing messageId)', async () => {
    const res = await POST(req({ token: tokenFor(), body: { parts: [] } }))
    expect(res.status).toBe(400)
    expect(persistEveTurnSpy).not.toHaveBeenCalled()
  })

  it('happy path: session user === token user → calls persistEveTurn with TOKEN claims', async () => {
    const res = await POST(
      req({
        token: tokenFor('user-1'),
        // A malicious body cannot smuggle tenancy — the route passes claims only.
        body: { ...goodBody, userId: 'HACKER', workspaceId: 'HACKER-WS' },
      }),
    )
    expect(res.status).toBe(200)
    expect(persistEveTurnSpy).toHaveBeenCalledTimes(1)
    const [, claims, body] = persistEveTurnSpy.mock.calls[0] as [
      unknown,
      Record<string, unknown>,
      Record<string, unknown>,
    ]
    expect(claims.userId).toBe('user-1')
    expect(claims.workspaceId).toBe('ws-1')
    expect(claims.conversationId).toBe('conv-1')
    expect(body.messageId).toBe('m-1')
    const json = await res.json()
    expect(json.written).toBe(true)
    expect(json.conversationId).toBe('conv-1')
  })

  it('emits ai_chat_message_sent once for a NEW turn that carried its user message', async () => {
    const res = await POST(
      req({
        token: tokenFor('user-1'),
        body: {
          ...goodBody,
          userMessage: { messageId: 'u-1', parts: [{ type: 'text', text: 'hi' }, { type: 'file', url: 'x' }] },
          usage: { events: [], model: 'kimi-k3' },
          timings: {
            client_first_output_ms: 1840,
            server_first_output_ms: 912,
            server_thinking_ms: 750_000, // clamped
            new_session: true,
            prewarmed: false,
            model: 'deepseek/deepseek-v4-flash',
            not_a_timing: 'dropped',
          },
        },
      }),
    )
    expect(res.status).toBe(200)
    expect(trackServerEventSpy).toHaveBeenCalledTimes(1)
    const [event, ctx, props] = trackServerEventSpy.mock.calls[0] as [string, Record<string, unknown>, Record<string, unknown>]
    expect(event).toBe('ai_chat_message_sent')
    expect(ctx).toMatchObject({ userId: 'user-1', workspaceId: 'ws-1' })
    expect(props).toEqual({
      has_attachments: true,
      model: 'kimi-k3',
      runtime: 'eve',
      // The turn's TTFT phases (docs/plans/chat-ttft.md), each key prefixed ttft_.
      ttft_client_first_output_ms: 1840,
      ttft_server_first_output_ms: 912,
      ttft_server_thinking_ms: 600_000,
      ttft_new_session: true,
      ttft_prewarmed: false,
      ttft_model: 'deepseek/deepseek-v4-flash',
    })
    // And one [chat-ttft] log line: the same timings plus the conversation id,
    // never the message text.
    expect(ttftLines()).toEqual([
      {
        conversationId: 'conv-1',
        client_first_output_ms: 1840,
        server_first_output_ms: 912,
        server_thinking_ms: 600_000,
        new_session: true,
        prewarmed: false,
        model: 'deepseek/deepseek-v4-flash',
      },
    ])
  })

  it('a turn without timings emits the event with no ttft_* properties and logs no [chat-ttft] line', async () => {
    await POST(
      req({ token: tokenFor(), body: { ...goodBody, userMessage: { messageId: 'u-1', parts: [{ type: 'text', text: 'hi' }] } } }),
    )
    expect(trackServerEventSpy).toHaveBeenCalledTimes(1)
    const props = trackServerEventSpy.mock.calls[0][2] as Record<string, unknown>
    expect(props).toEqual({ has_attachments: false, runtime: 'eve' })
    expect(ttftLines()).toEqual([])
  })

  it('never adds a thinking level (nobody picks one any more), even when an old client reports it', async () => {
    await POST(
      req({
        token: tokenFor('user-1'),
        body: {
          ...goodBody,
          userMessage: { messageId: 'u-1', parts: [{ type: 'text', text: 'hi' }] },
          usage: { events: [], model: 'deepseek-v4-pro', thinking: 'max' },
        },
      }),
    )
    const props = trackServerEventSpy.mock.calls[0][2] as Record<string, unknown>
    expect(props).toEqual({ has_attachments: false, model: 'deepseek-v4-pro', runtime: 'eve' })
  })

  it('emits it, and logs the timings, when the write replaced the reply backup’s provisional row (the server wrote first)', async () => {
    persistEveTurnSpy.mockResolvedValueOnce({ written: false, replaced: true, conversationId: 'conv-1', activityFired: false, reason: undefined } as never)
    const res = await POST(
      req({
        token: tokenFor(),
        body: {
          ...goodBody,
          userMessage: { messageId: 'u-1', parts: [{ type: 'text', text: 'hi' }] },
          timings: { client_first_output_ms: 1840, new_session: false, prewarmed: false },
        },
      }),
    )
    expect(await res.json()).toMatchObject({ written: false, replaced: true })
    expect(trackServerEventSpy).toHaveBeenCalledTimes(1)
    expect(ttftLines()).toHaveLength(1)
  })

  it('does NOT emit it for a replay (no new row) or a turn without its user message', async () => {
    persistEveTurnSpy.mockResolvedValueOnce({ written: false, conversationId: 'conv-1', activityFired: false, reason: undefined })
    await POST(
      req({
        token: tokenFor(),
        body: {
          ...goodBody,
          userMessage: { messageId: 'u-1', parts: [{ type: 'text', text: 'hi' }] },
          timings: { client_first_output_ms: 1840, new_session: false, prewarmed: false },
        },
      }),
    )
    await POST(req({ token: tokenFor() }))
    expect(trackServerEventSpy).not.toHaveBeenCalled()
    // A replay wrote no new turn, so it logs no timings either.
    expect(ttftLines()).toEqual([])
  })

  it('a written turn with timings but no user message logs its [chat-ttft] line and emits no event', async () => {
    await POST(
      req({
        token: tokenFor(),
        body: { ...goodBody, timings: { client_first_output_ms: 100, new_session: false, prewarmed: false } },
      }),
    )
    // The two sinks are gated apart: the event needs the user message, the log only a new row.
    expect(trackServerEventSpy).not.toHaveBeenCalled()
    expect(ttftLines()).toEqual([
      { conversationId: 'conv-1', client_first_output_ms: 100, new_session: false, prewarmed: false },
    ])
  })

  it('a steered turn (UI-2) carries steer_* on the event and logs one [chat-steer] line — numbers and enums only', async () => {
    await POST(
      req({
        token: tokenFor(),
        body: {
          ...goodBody,
          userMessage: { messageId: 'u-2', parts: [{ type: 'text', text: 'shorter' }], metadata: { steer: 'applied' } },
          steer: { outcome: 'applied', held_ms: 420, apply_ms: 180, opening: 'before_output', steers_in_turn: 1 },
        },
      }),
    )
    const props = trackServerEventSpy.mock.calls[0][2] as Record<string, unknown>
    expect(props).toMatchObject({
      steer_outcome: 'applied',
      steer_held_ms: 420,
      steer_apply_ms: 180,
      steer_opening: 'before_output',
      steer_steers_in_turn: 1,
    })
    const steerLines = infoSpy.mock.calls.filter(([tag]) => tag === '[chat-steer]').map(([, json]) => JSON.parse(json as string))
    expect(steerLines).toEqual([
      { conversationId: 'conv-1', outcome: 'applied', held_ms: 420, apply_ms: 180, opening: 'before_output', steers_in_turn: 1 },
    ])
  })
})
