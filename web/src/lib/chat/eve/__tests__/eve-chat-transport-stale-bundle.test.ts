/**
 * A window on an older bundle than the server (lib/deploy-reload.ts): the eve
 * transport never shows an "Unsupported message stream version" error. It hands
 * the error to reloadForStaleStream, which reloads the page, and shows nothing;
 * any other error surfaces as before. While a send or turn is open, the
 * transport's reload blocker reports busy.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai'
import type { HandleMessageStreamEvent } from 'eve/client'

const blockers: Array<() => boolean> = []
const reloadForStaleStream = vi.fn((err: unknown) => /Unsupported message stream version/.test(String((err as Error)?.message)))
vi.mock('@/lib/deploy-reload', () => ({
  registerReloadBlocker: (fn: () => boolean) => {
    blockers.push(fn)
    return () => blockers.splice(blockers.indexOf(fn), 1)
  },
  reloadForStaleStream: (err: unknown) => reloadForStaleStream(err),
}))

import { EveChatTransport } from '../eve-chat-transport'

const STALE = new TypeError('Unsupported message stream version: 26.')

function sendOpts(): Parameters<ChatTransport<UIMessage>['sendMessages']>[0] {
  return {
    chatId: 'chat-1',
    messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hello' }] }],
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

/** A transport whose first message's stream throws `error` after `before` events. */
function setup(error: Error, mintRunToken: () => Promise<{ token: string; conversationId: string }> = async () => ({ token: 'run', conversationId: 'home-1' })) {
  const throwing = {
    sessionId: 'wrun_1',
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<HandleMessageStreamEvent>> {
          throw error
        },
      }
    },
  }
  const session = { send: vi.fn(), respond: vi.fn(), cancel: vi.fn(async () => ({})), state: { sessionId: 'wrun_1' } }
  const client = {
    sessions: {
      create: vi.fn(async () => ({ response: throwing, session })),
      attach: vi.fn(() => session),
    },
  }
  const transport = new EveChatTransport({
    getAccessToken: () => 'tok',
    mintRunToken,
    registerEveSession: async () => {},
    persistTurn: async () => {},
    createClient: () => client as never,
  })
  return { transport }
}

beforeEach(() => {
  blockers.length = 0
  reloadForStaleStream.mockClear()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('the eve transport on a stale bundle', () => {
  it('a stream-version error reloads instead of failing the turn', async () => {
    const { transport } = setup(STALE)
    const stream = await transport.sendMessages(sendOpts())
    // The turn is left open (the page is reloading): it neither errors nor finishes.
    const outcome = await Promise.race([drain(stream).then(() => 'ended', () => 'errored'), new Promise((r) => setTimeout(() => r('open'), 50))])
    expect(outcome).toBe('open')
    expect(reloadForStaleStream).toHaveBeenCalledWith(STALE)
  })

  it('any other stream error still fails the turn', async () => {
    const { transport } = setup(new Error('socket hang up'))
    await expect(drain(await transport.sendMessages(sendOpts()))).rejects.toThrow('socket hang up')
  })

  it('a stream-version error thrown before the stream opens returns an empty stream, not a throw', async () => {
    const { transport } = setup(new Error('unused'), async () => {
      throw STALE
    })
    expect(await drain(await transport.sendMessages(sendOpts()))).toEqual([])
    expect(reloadForStaleStream).toHaveBeenCalledWith(STALE)
  })

  it('registers a reload blocker that is busy while a send is on its way, and releases it on dispose', async () => {
    let unblock: (() => void) | null = null
    const { transport } = setup(new Error('unused'), () =>
      new Promise((_, reject) => {
        unblock = () => reject(new Error('mint failed'))
      }),
    )
    expect(blockers).toHaveLength(1)
    const busy = blockers[0]
    expect(busy()).toBe(false)
    const sending = transport.sendMessages(sendOpts()).catch(() => null)
    await vi.waitFor(() => expect(unblock).not.toBeNull())
    expect(busy()).toBe(true)
    unblock!()
    await sending
    expect(busy()).toBe(false)
    await transport.disposeAll()
    expect(blockers).toHaveLength(0)
  })
})
