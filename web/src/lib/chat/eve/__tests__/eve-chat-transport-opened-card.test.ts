// @vitest-environment jsdom
/**
 * What the eve transport does for pages opened from `/` (lib/chat-cards/opened-card.ts):
 *
 *   - turnPersisted settles only once the finished turn's rows are written,
 *     so a card the person picked during that turn is saved after them and a
 *     reload (rows ordered by when they were written) keeps it below the reply;
 *   - a first send while the panel is still creating the chat's conversation
 *     (the page's own save) waits for that row and mints against it, never
 *     claiming the prewarm the `/` keystroke made for another row.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai'
import { EveChatTransport } from '../eve-chat-transport'

function fakeClient(log: string[]) {
  const response = {
    sessionId: 'wrun_ABC',
    async *[Symbol.asyncIterator]() {
      yield { type: 'message.appended', data: { messageDelta: 'Done', sequence: 0, stepIndex: 0, turnId: 'turn_0' } }
      yield { type: 'message.completed', data: { finishReason: 'stop', message: 'Done' } }
      yield { type: 'turn.completed', data: {} }
    },
  }
  const session = {
    send: vi.fn(async (message: string) => {
      log.push(`send:${message}`)
      return response
    }),
    respond: vi.fn(),
    cancel: vi.fn(),
    stream: vi.fn(),
    state: { sessionId: 'wrun_ABC', streamIndex: 0 },
  }
  return {
    sessions: {
      create: vi.fn(async (input: { message?: string }) => {
        if (!('message' in input)) {
          log.push('create:prewarm')
          return { session }
        }
        log.push(`create:${input.message}`)
        return { response, session }
      }),
      attach: vi.fn(() => session),
    },
  }
}

async function drain(stream: ReadableStream<UIMessageChunk>) {
  const reader = stream.getReader()
  for (;;) if ((await reader.read()).done) break
}

const send = (text: string) =>
  ({
    chatId: 'chat-1',
    messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text }] }],
    trigger: 'submit-message',
    messageId: undefined,
    body: {},
  }) as unknown as Parameters<ChatTransport<UIMessage>['sendMessages']>[0]

describe('turnPersisted', () => {
  it('settles only once the finished turn is written', async () => {
    let release!: () => void
    const written = new Promise<void>((r) => (release = r))
    const transport = new EveChatTransport({
      getAccessToken: () => 'jwt',
      mintRunToken: async () => ({ token: 'tok.sig', conversationId: 'conv-1' }),
      registerEveSession: async () => {},
      createClient: () => fakeClient([]) as never,
      persistTurn: () => written,
    })
    // Nothing finished yet: nothing to wait for.
    await transport.turnPersisted('chat-1')

    await drain(await transport.sendMessages(send('hello')))
    let settled = false
    const waiting = transport.turnPersisted('chat-1').then(() => {
      settled = true
    })
    await new Promise((r) => setTimeout(r, 10))
    expect(settled).toBe(false)
    release()
    await waiting
    expect(settled).toBe(true)
  })

  it('never waits past its bound on a write that hangs', async () => {
    const transport = new EveChatTransport({
      getAccessToken: () => 'jwt',
      mintRunToken: async () => ({ token: 'tok.sig', conversationId: 'conv-1' }),
      registerEveSession: async () => {},
      createClient: () => fakeClient([]) as never,
      persistTurn: () => new Promise<void>(() => {}),
    })
    await drain(await transport.sendMessages(send('hello')))
    await expect(transport.turnPersisted('chat-1', 20)).resolves.toBeUndefined()
  })
})

describe('a first send while the panel is creating the conversation', () => {
  it('mints against that row instead of claiming the prewarm made for another', async () => {
    const log: string[] = []
    const mints: Array<string | null | undefined> = []
    let created!: (id: string) => void
    let pending: Promise<string | null> | null = null
    const transport = new EveChatTransport({
      getAccessToken: () => 'jwt',
      mintRunToken: async ({ conversationId }) => {
        mints.push(conversationId)
        return { token: 'tok.sig', conversationId: conversationId ?? 'conv-B' }
      },
      registerEveSession: async () => {},
      createClient: () => fakeClient(log) as never,
      persistTurn: async () => {},
      getPendingConversation: () => pending,
    })
    // The `/` keystroke prewarmed (row B), then the page's save starts creating row A.
    await transport.prewarm('chat-1')
    pending = new Promise((r) => (created = r))
    const sending = transport.sendMessages(send('which are overdue?'))
    await new Promise((r) => setTimeout(r, 10))
    // Still waiting on row A: no mint yet.
    expect(mints).toEqual([null])
    created('conv-A')
    await drain(await sending)
    expect(mints).toEqual([null, 'conv-A'])
    // A new session for row A, not the prewarmed one.
    expect(log).toEqual(['create:prewarm', expect.stringMatching(/^create:.*which are overdue\?/)])
  })
})
