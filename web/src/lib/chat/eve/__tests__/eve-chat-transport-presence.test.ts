// @vitest-environment jsdom
/**
 * EveChatTransport.presence: the composer's "someone is typing" ping for the
 * server's idle-compaction timer (src/lib/chat/idle-compaction-signal.ts).
 * Pinned: one POST `{ action: 'presence', conversationId }` to eve-session per
 * conversation per PRESENCE_PING_INTERVAL_MS however many keystrokes call it,
 * with the caller's Bearer and the host's workspace header; nothing without a
 * conversation or with an injected mint; and a failed ping never throws.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EveChatTransport, PRESENCE_PING_INTERVAL_MS } from '../eve-chat-transport'

const fetchMock = vi.fn(async (..._a: unknown[]) => new Response('{"ok":true}', { status: 200 }))

beforeEach(() => {
  fetchMock.mockClear()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

const calls = () =>
  fetchMock.mock.calls.map(([url, init]) => {
    const i = init as RequestInit
    return { url, body: JSON.parse(String(i.body)), headers: i.headers as Record<string, string> }
  })

describe('EveChatTransport.presence', () => {
  it('pings eve-session once per conversation per interval, however many keystrokes', () => {
    const t = new EveChatTransport({ getAccessToken: () => 'jwt-1' })
    const now = 1_000_000
    for (let i = 0; i < 50; i++) t.presence('conv-1', now + i * 100)
    t.presence('conv-2', now + 1000)
    t.presence('conv-1', now + PRESENCE_PING_INTERVAL_MS - 1)
    t.presence('conv-1', now + PRESENCE_PING_INTERVAL_MS)
    expect(calls().map((c) => c.body)).toEqual([
      { action: 'presence', conversationId: 'conv-1' },
      { action: 'presence', conversationId: 'conv-2' },
      { action: 'presence', conversationId: 'conv-1' },
    ])
    expect(calls()[0]).toMatchObject({ url: '/api/account/chat/eve-session', headers: { Authorization: 'Bearer jwt-1' } })
  })

  it('sends the host’s workspace header (a teammate thread in another workspace)', () => {
    new EveChatTransport({ getAccessToken: () => 'jwt-1', workspaceId: 'ws-2' }).presence('conv-1')
    expect(calls()[0].headers).toMatchObject({ 'x-workspace-id': 'ws-2' })
  })

  it('nothing without a conversation, or when the host injects its own mint', () => {
    const t = new EveChatTransport({ getAccessToken: () => 'jwt-1' })
    t.presence(null)
    t.presence(undefined)
    t.presence('')
    new EveChatTransport({ mintRunToken: async () => ({ token: 't', conversationId: 'c' }) as never }).presence('conv-1')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a failed ping never throws and is not retried inside the interval', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'))
    const t = new EveChatTransport({ getAccessToken: () => 'jwt-1' })
    expect(() => t.presence('conv-1', 5_000)).not.toThrow()
    await Promise.resolve()
    t.presence('conv-1', 6_000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
