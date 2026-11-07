/**
 * A dormant home thread whose stream history passed eve's World retention
 * (eve 0.79): the re-attached session may take the POST, but its stream answers
 * 410 `session_expired`. Pinned (A3's re-prime): before any event, the turn goes
 * to a fresh session primed with the thread, registered over the expired one,
 * which is reset (its unreadable turn stopped) and never re-attached; the
 * person sees the reply, not an error. A 410 after events have arrived, or any
 * other error, still fails the turn.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai'
import type { HandleMessageStreamEvent } from 'eve/client'
import { EveChatTransport, isEveHistoryExpiredError } from '../eve-chat-transport'

const ev = (type: string, data: Record<string, unknown> = {}) => ({ type, data: { sequence: 0, stepIndex: 0, turnId: 'turn_0', ...data } }) as unknown as HandleMessageStreamEvent
const EXPIRED = Object.assign(new Error('Session history is no longer available.'), { status: 410, code: 'session_expired' })

function response(sessionId: string, events: HandleMessageStreamEvent[], fail?: Error) {
  return {
    sessionId,
    [Symbol.asyncIterator]() {
      const queue = [...events]
      return {
        async next(): Promise<IteratorResult<HandleMessageStreamEvent>> {
          const value = queue.shift()
          if (value) return { done: false, value }
          if (fail) throw fail
          return { done: true, value: undefined }
        },
      }
    },
  }
}

function sendOpts(): Parameters<ChatTransport<UIMessage>['sendMessages']>[0] {
  return {
    chatId: 'chat-1',
    messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hello again' }] }],
    trigger: 'submit-message',
    messageId: undefined,
    body: { conversationId: 'home-1' },
  } as unknown as Parameters<ChatTransport<UIMessage>['sendMessages']>[0]
}

async function drain(stream: ReadableStream<UIMessageChunk>): Promise<UIMessageChunk[]> {
  const chunks: UIMessageChunk[] = []
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  return chunks
}

function setup(oldStream: { events: HandleMessageStreamEvent[]; fail?: Error }) {
  const created: Array<{ message: unknown }> = []
  const registered: Array<{ sessionId: string; previousSessionId: string | null }> = []
  const reset = vi.fn(async () => ({ status: 'reset' }))
  const attached: string[] = []
  const makeSession = (id: string) => ({
    send: vi.fn(async () => response(id, oldStream.events, oldStream.fail)),
    respond: vi.fn(),
    cancel: vi.fn(async () => ({})),
    reset,
    snapshot: vi.fn(async () => ({ events: [] })),
    state: { sessionId: id },
  })
  const client = {
    sessions: {
      create: vi.fn(async (input: { message: unknown }) => {
        created.push({ message: input.message })
        return { response: response('wrun_FRESH', [ev('turn.started'), ev('message.appended', { messageDelta: 'welcome back' }), ev('turn.completed')]), session: makeSession('wrun_FRESH') }
      }),
      attach: vi.fn((id: string) => {
        attached.push(id)
        return makeSession(id)
      }),
    },
  }
  const transport = new EveChatTransport({
    getAccessToken: () => 'tok',
    mintRunToken: async () => ({ token: 'run', conversationId: 'home-1', historyPrimer: 'PRIMER', eveSessionId: 'wrun_OLD' }),
    registerEveSession: async (a) => void registered.push({ sessionId: a.sessionId, previousSessionId: a.previousSessionId }),
    persistTurn: async () => {},
    createClient: () => client as never,
    checkUsage: async () => 'ok',
  })
  return { transport, created, registered, reset, attached }
}

let warn: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => warn.mockRestore())

describe('a re-attached session whose stream history expired (eve 410 session_expired)', () => {
  it('re-primes a fresh session before any event, registers it over the expired one, and resets the old one', async () => {
    const s = setup({ events: [], fail: EXPIRED })
    const chunks = await drain(await s.transport.sendMessages(sendOpts()))
    expect(chunks.filter((c) => c.type === 'text-delta').map((c) => (c as { delta: string }).delta).join('')).toBe('welcome back')
    expect(chunks.some((c) => c.type === 'error')).toBe(false)
    expect(s.attached).toEqual(['wrun_OLD'])
    expect(s.created).toHaveLength(1)
    expect(JSON.stringify(s.created[0].message)).toContain('PRIMER')
    expect(JSON.stringify(s.created[0].message)).toContain('hello again')
    expect(s.registered).toEqual([{ sessionId: 'wrun_FRESH', previousSessionId: 'wrun_OLD' }])
    expect(s.reset).toHaveBeenCalledTimes(1)
    expect(s.transport.eveSessionIdOf('chat-1')).toBe('wrun_FRESH')
  })

  it('a 410 after the turn has shown events still fails it (nothing goes twice)', async () => {
    const s = setup({ events: [ev('turn.started'), ev('message.appended', { messageDelta: 'partial' })], fail: EXPIRED })
    await expect(drain(await s.transport.sendMessages(sendOpts()))).rejects.toThrow('Session history is no longer available.')
    expect(s.created).toHaveLength(0)
  })

  it('reads only a 410 session_expired as expired history (never the 401/403 credentials code)', () => {
    expect(isEveHistoryExpiredError(EXPIRED)).toBe(true)
    expect(isEveHistoryExpiredError({ status: 403, code: 'session_expired' })).toBe(false)
    expect(isEveHistoryExpiredError({ status: 410, code: 'other' })).toBe(false)
    expect(isEveHistoryExpiredError(null)).toBe(false)
  })
})
