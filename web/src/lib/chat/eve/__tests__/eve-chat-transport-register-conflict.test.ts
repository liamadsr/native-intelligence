/**
 * Two windows on one conversation (A3, the home thread). Pinned:
 *   - a fresh session registers over the session the mint said the row held
 *     (`previousSessionId`), null when it held none;
 *   - a re-attached session that can't take the turn forks a new one, which
 *     registers over the OLD id, so a second window that already forked wins;
 *   - when that register loses (EveSessionConflictError), the turn still
 *     streams, and the chat's next send mints afresh and re-attaches to the
 *     session the row now holds instead of carrying on with its own.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai'
import type { HandleMessageStreamEvent } from 'eve/client'
import { EveChatTransport, EveSessionConflictError } from '../eve-chat-transport'

const evText = (delta: string) =>
  ({ type: 'message.appended', data: { messageDelta: delta, sequence: 0, stepIndex: 0, turnId: 'turn_0' } }) as unknown as HandleMessageStreamEvent
const evDone = () => ({ type: 'turn.completed', data: {} }) as unknown as HandleMessageStreamEvent

function response(sessionId: string) {
  return {
    sessionId,
    async *[Symbol.asyncIterator]() {
      yield evText('hi')
      yield evDone()
    },
  }
}

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

function setup(opts: {
  rowSession: () => string | null
  attachedFails?: (id: string) => boolean
  /** eve refuses a send on this session on its credentials (the ownership ACL: not the conversation's session). */
  authFails?: (id: string) => boolean
  register: (a: { sessionId: string; previousSessionId: string | null }) => Promise<void>
}) {
  const mints: Array<{ wantHistory?: boolean }> = []
  const attached: string[] = []
  const sent: Array<{ session: string; message: unknown }> = []
  let created = 0
  const makeSession = (id: string) => ({
    send: vi.fn(async (message: unknown) => {
      if (opts.attachedFails?.(id)) throw new Error('session retired')
      if (opts.authFails?.(id)) throw Object.assign(new Error('forbidden'), { status: 403, code: 'session_forbidden' })
      sent.push({ session: id, message })
      return response(id)
    }),
    respond: vi.fn(),
    cancel: vi.fn(async () => ({})),
    state: { sessionId: id },
  })
  const client = {
    sessions: {
      create: vi.fn(async () => {
        const id = `wrun_NEW${++created}`
        return { response: response(id), session: makeSession(id) }
      }),
      attach: vi.fn((id: string) => {
        attached.push(id)
        return makeSession(id)
      }),
    },
  }
  const registered: Array<{ sessionId: string; previousSessionId: string | null }> = []
  const transport = new EveChatTransport({
    getAccessToken: () => 'tok',
    refreshAccessToken: async () => 'tok2',
    mintRunToken: async (args) => {
      mints.push(args as { wantHistory?: boolean })
      const current = opts.rowSession()
      return { token: 'run', conversationId: 'home-1', ...(current ? { eveSessionId: current } : {}) }
    },
    registerEveSession: async (a) => {
      registered.push({ sessionId: a.sessionId, previousSessionId: a.previousSessionId })
      await opts.register(a)
    },
    persistTurn: async () => {},
    createClient: () => client as never,
  })
  return { transport, mints, attached, registered, client, sent }
}

let warn: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => warn.mockRestore())

describe('register over the known session (A3)', () => {
  it('a first session registers over none', async () => {
    const s = setup({ rowSession: () => null, register: async () => {} })
    await drain(await s.transport.sendMessages(sendOpts()))
    expect(s.registered).toEqual([{ sessionId: 'wrun_NEW1', previousSessionId: null }])
  })

  it('a re-attached session that forks registers over the old id', async () => {
    const s = setup({ rowSession: () => 'wrun_A', attachedFails: (id) => id === 'wrun_A', register: async () => {} })
    await drain(await s.transport.sendMessages(sendOpts()))
    expect(s.attached).toEqual(['wrun_A'])
    expect(s.registered).toEqual([{ sessionId: 'wrun_NEW1', previousSessionId: 'wrun_A' }])
  })

  it('a lost register still streams the turn, then the next send re-attaches to the row’s session', async () => {
    let row: string | null = 'wrun_A'
    const s = setup({
      rowSession: () => row,
      attachedFails: (id) => id === 'wrun_A',
      register: async () => {
        // Another window registered its fork first.
        row = 'wrun_OTHER'
        throw new EveSessionConflictError('wrun_OTHER')
      },
    })
    const first = await drain(await s.transport.sendMessages(sendOpts()))
    expect(first.some((c) => c.type === 'text-delta')).toBe(true)
    expect(row).toBe('wrun_OTHER')
    await drain(await s.transport.sendMessages(sendOpts()))
    // Minted afresh (no live handle), and re-attached to the winner's session.
    expect(s.mints).toHaveLength(2)
    expect(s.mints[1].wantHistory).toBe(true)
    expect(s.attached).toEqual(['wrun_A', 'wrun_OTHER'])
    expect(s.registered.map((r) => r.sessionId)).toEqual(['wrun_NEW1'])
    // The winner's session learns the orphaned exchange, once, with the next message.
    const toWinner = s.sent.filter((m) => m.session === 'wrun_OTHER')
    expect(toWinner).toHaveLength(1)
    const carried = JSON.stringify(toWinner[0].message)
    expect(carried).toContain('conversation-so-far')
    expect(carried).toContain('User: hello')
    expect(carried).toContain('Assistant: hi')
    await drain(await s.transport.sendMessages(sendOpts()))
    expect(JSON.stringify(s.sent.at(-1)!.message)).not.toContain('conversation-so-far')
  })

  it('the orphaned handle stays until its turn settles, then goes (A3 verification)', async () => {
    let row: string | null = 'wrun_A'
    const s = setup({
      rowSession: () => row,
      attachedFails: (id) => id === 'wrun_A',
      register: async () => {
        row = 'wrun_OTHER'
        throw new EveSessionConflictError('wrun_OTHER')
      },
    })
    const stream = await s.transport.sendMessages(sendOpts())
    const reader = stream.getReader()
    // The first chunk is out: the register has settled, the turn is still running.
    await reader.read()
    expect(s.transport.eveSessionIdOf('chat-1')).toBe('wrun_NEW1')
    for (;;) if ((await reader.read()).done) break
    expect(s.transport.eveSessionIdOf('chat-1')).toBeNull()
  })

  it('a window whose session another window replaced re-attaches to the row’s and retries (A3 verification)', async () => {
    let row: string | null = 'wrun_A'
    const s = setup({ rowSession: () => row, authFails: (id) => id === 'wrun_A' && row !== 'wrun_A', register: async () => {} })
    await drain(await s.transport.sendMessages(sendOpts()))
    expect(s.sent.map((m) => m.session)).toEqual(['wrun_A'])
    // Another window replaced the conversation's session.
    row = 'wrun_Z'
    const second = await drain(await s.transport.sendMessages(sendOpts()))
    expect(second.some((c) => c.type === 'text-delta')).toBe(true)
    expect(s.attached).toEqual(['wrun_A', 'wrun_Z'])
    expect(s.sent.map((m) => m.session)).toEqual(['wrun_A', 'wrun_Z'])
    expect(s.transport.eveSessionIdOf('chat-1')).toBe('wrun_Z')
    expect(s.registered).toEqual([])
  })
})
