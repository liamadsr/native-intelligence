// @vitest-environment jsdom
/**
 * EveChatTransport's `getFocusArea` (one-agent plan S3): a main-chat
 * conversation focused on an area.
 *
 *   - the default mint sends `focusArea` and stays the MAIN agent's mint: no
 *     `teammateId`;
 *   - a focus is fixed: a session made for another focus (or none) is never
 *     sent on;
 *   - a teammate's own thread never sends it.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { EveChatTransport } from '../eve-chat-transport'
import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai'
import type { HandleMessageStreamEvent } from 'eve/client'

const ev = (e: object) => e as unknown as HandleMessageStreamEvent
const DONE = [
  ev({ type: 'message.appended', data: { messageDelta: 'hi', sequence: 0, stepIndex: 0, turnId: 't0' } }),
  ev({ type: 'message.completed', data: { finishReason: 'stop', message: 'hi' } }),
  ev({ type: 'turn.completed', data: {} }),
]

function fakeClient() {
  let n = 0
  const response = (sessionId: string) => ({
    sessionId,
    async *[Symbol.asyncIterator]() {
      for (const e of DONE) yield e
    },
  })
  const create = vi.fn(async (_input: Record<string, unknown>) => {
    n += 1
    const sessionId = `wrun_${n}`
    const session = {
      send: vi.fn(async () => response(sessionId)),
      respond: vi.fn(),
      cancel: vi.fn(),
      stream: vi.fn(),
      state: { sessionId, streamIndex: 0 },
    }
    return { response: response(sessionId), session }
  })
  return { client: { sessions: { create, attach: vi.fn() } }, create }
}

function sendOpts(body: Record<string, unknown> = {}): Parameters<ChatTransport<UIMessage>['sendMessages']>[0] {
  return {
    chatId: 'chat-1',
    messages: [{ id: `m-${Math.random()}`, role: 'user', parts: [{ type: 'text', text: 'hello' }] }],
    trigger: 'submit-message',
    messageId: undefined,
    body,
  } as unknown as Parameters<ChatTransport<UIMessage>['sendMessages']>[0]
}

async function drain(stream: ReadableStream<UIMessageChunk>) {
  const reader = stream.getReader()
  for (;;) if ((await reader.read()).done) break
}

/** The default fetch paths: each mint answers a new conversation (`conv-<n>`). */
function stubFetch() {
  const calls: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = []
  let mints = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
      calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string>, body })
      if (body.action === 'mint') {
        mints += 1
        const conversationId = (body.conversationId as string | null) ?? `conv-${mints}`
        return { ok: true, status: 200, json: async () => ({ token: 'tok.sig', conversationId, eveSessionId: null }) }
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '' }
    }),
  )
  return calls
}

const settle = () => new Promise((r) => setTimeout(r, 0))
const mintsOf = (calls: ReturnType<typeof stubFetch>) => calls.filter((c) => c.body.action === 'mint').map((c) => c.body)

afterEach(() => vi.unstubAllGlobals())

describe('EveChatTransport — a focused conversation', () => {
  it('the mint sends the focus, as the main agent: no teammate, no asAgent', async () => {
    const calls = stubFetch()
    const fake = fakeClient()
    let conversationId: string | null = null
    const transport = new EveChatTransport({
      getAccessToken: () => 'jwt',
      getFocusArea: () => 'mail',
      getConversationId: () => conversationId,
      onConversationEnsured: (_chat, id) => {
        conversationId = id
      },
      createClient: () => fake.client as never,
    })
    await drain(await transport.sendMessages(sendOpts()))
    await drain(await transport.sendMessages(sendOpts()))
    await settle()
    const [first, second] = mintsOf(calls)
    expect(first).toMatchObject({ action: 'mint', conversationId: null, focusArea: 'mail' })
    expect(first).not.toHaveProperty('teammateId')
    expect(first).not.toHaveProperty('asAgent')
    expect(second).toMatchObject({ conversationId: 'conv-1', focusArea: 'mail' })
    expect(fake.create).toHaveBeenCalledTimes(1)
  })

  it('a focus is fixed: a session made for another focus, or none, is never sent on', async () => {
    const calls = stubFetch()
    const fake = fakeClient()
    let focus: string | null = null
    const transport = new EveChatTransport({
      getAccessToken: () => 'jwt',
      getFocusArea: () => focus,
      createClient: () => fake.client as never,
    })
    await drain(await transport.sendMessages(sendOpts()))
    focus = 'captures'
    await drain(await transport.sendMessages(sendOpts()))
    await settle()
    const mints = mintsOf(calls)
    expect(mints[0]).not.toHaveProperty('focusArea')
    expect(mints[1]).toMatchObject({ focusArea: 'captures' })
    // A new session for the focused conversation, never the plain one's.
    expect(fake.create).toHaveBeenCalledTimes(2)
  })

  it('a teammate’s own thread never sends a focus', async () => {
    const calls = stubFetch()
    const fake = fakeClient()
    const thread = new EveChatTransport({
      getAccessToken: () => 'jwt',
      teammateId: 'tm-mail',
      getFocusArea: () => 'mail',
      createClient: () => fake.client as never,
    })
    await drain(await thread.sendMessages(sendOpts()))
    await settle()
    for (const mint of mintsOf(calls)) expect(mint).not.toHaveProperty('focusArea')
  })

  it('an injected mint is told the focus', async () => {
    const fake = fakeClient()
    stubFetch()
    const mintRunToken = vi.fn(async (args: { conversationId: string | null; focusArea?: string }) => ({
      token: 'tok.sig',
      conversationId: args.conversationId ?? 'conv-x',
    }))
    const transport = new EveChatTransport({
      getAccessToken: () => 'jwt',
      getFocusArea: () => 'evals',
      mintRunToken,
      createClient: () => fake.client as never,
    })
    await drain(await transport.sendMessages(sendOpts()))
    expect(mintRunToken.mock.calls[0][0]).toMatchObject({ focusArea: 'evals' })
    expect(mintRunToken.mock.calls[0][0]).not.toHaveProperty('agentTeammateId')
  })
})
