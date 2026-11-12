// @vitest-environment jsdom
/**
 * The card in front settles before its note is read (settleCardContext): the
 * Studio saves the person's last edits, so the agent's turn edits the video as
 * they see it. It starts with the send (beside the mint), the cards are read
 * once it is done, and a card that cannot settle never holds or fails a send.
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
    send: vi.fn(async () => response),
    respond: vi.fn(),
    cancel: vi.fn(),
    stream: vi.fn(),
    state: { sessionId: 'wrun_ABC', streamIndex: 0 },
  }
  return {
    sessions: {
      create: vi.fn(async (input: { message?: string }) => {
        log.push('create')
        return 'message' in input ? { response, session } : { session }
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

function transport(log: string[], settle: () => Promise<void>) {
  return new EveChatTransport({
    getAccessToken: () => 'jwt',
    mintRunToken: async () => {
      log.push('mint')
      return { token: 'tok.sig', conversationId: 'conv-1' }
    },
    registerEveSession: async () => {},
    createClient: () => fakeClient(log) as never,
    persistTurn: async () => {},
    getCardContext: () => {
      log.push('read cards')
      return [{ n: 1, id: 'card-studio', kind: 'studio', title: 'Studio' }]
    },
    settleCardContext: settle,
  })
}

describe('settling the card in front before a send reads it', () => {
  it('starts with the send, beside the mint, and the cards are read only once it is done', async () => {
    const log: string[] = []
    const t = transport(log, async () => {
      log.push('save started')
      await new Promise((r) => setTimeout(r, 15))
      log.push('saved')
    })
    await drain(await t.sendMessages(send('make this bigger and move it up a little')))
    expect(log.indexOf('save started')).toBe(0)
    expect(log.indexOf('saved')).toBeLessThan(log.indexOf('read cards'))
    expect(log).toContain('create')
  })

  it('a save that fails still sends the turn with its cards', async () => {
    const log: string[] = []
    const t = transport(log, async () => {
      throw new Error('offline')
    })
    await drain(await t.sendMessages(send('make this bigger')))
    expect(log).toContain('read cards')
    expect(log).toContain('create')
  })
})
