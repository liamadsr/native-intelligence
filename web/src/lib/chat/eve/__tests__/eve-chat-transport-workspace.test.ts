// @vitest-environment jsdom
/**
 * EveChatTransport's `workspaceId` + `teammateId` options (bots v2, Phase 1).
 *
 * A teammate chat lives in the TEAMMATE's workspace, which can differ from the
 * window's. The mint stamps the token with that workspace and the chat-agent
 * channel refuses a turn whose token workspace differs from the one it
 * resolves (header → cookie → first membership), and register / the history
 * read scope by the resolved workspace too. So with `workspaceId` set, the
 * transport sends `x-workspace-id` on the default mint, register and persist
 * requests, seeds the eve client with it, and repeats it on every turn's
 * headers. With `teammateId`, the default mint asks for the teammate thread.
 * Without either, nothing changes (the fetch interceptor adds the window's
 * workspace, as before).
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
  const createOptions: Array<Record<string, unknown>> = []
  const sendOptions: Array<Record<string, unknown>> = []
  const response = () => ({
    sessionId: 'wrun_TM',
    async *[Symbol.asyncIterator]() {
      for (const e of DONE) yield e
    },
  })
  const session = {
    send: vi.fn(async (_m: string, options?: Record<string, unknown>) => (sendOptions.push(options ?? {}), response())),
    respond: vi.fn(),
    cancel: vi.fn(),
    stream: vi.fn(),
    state: { sessionId: 'wrun_TM', streamIndex: 0 },
  }
  const create = vi.fn(async (input: Record<string, unknown>) => {
    const { message: _m, ...options } = input
    createOptions.push(options)
    return { response: response(), session }
  })
  return { client: { sessions: { create, attach: vi.fn(() => session) } }, createOptions, sendOptions }
}

function sendOpts(): Parameters<ChatTransport<UIMessage>['sendMessages']>[0] {
  return {
    chatId: 'teammate-tm-1',
    messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hello' }] }],
    trigger: 'submit-message',
    messageId: undefined,
    body: {},
  } as unknown as Parameters<ChatTransport<UIMessage>['sendMessages']>[0]
}

async function drain(stream: ReadableStream<UIMessageChunk>) {
  const reader = stream.getReader()
  for (;;) if ((await reader.read()).done) break
}

/** The default fetch paths, answered in order: mint, register, persist. */
function stubFetch() {
  const calls: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = []
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string>, body })
    if (body.action === 'mint') {
      return { ok: true, status: 200, json: async () => ({ token: 'tok.sig', conversationId: 'conv-tm', eveSessionId: null }) }
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '' }
  })
  vi.stubGlobal('fetch', fetchMock)
  return calls
}

/** Let the fire-and-forget persist land. */
const settle = () => new Promise((r) => setTimeout(r, 0))

afterEach(() => vi.unstubAllGlobals())

describe('EveChatTransport — workspaceId + teammateId', () => {
  it('sends x-workspace-id on mint, register, persist, the client seed and the turn; the mint names the teammate', async () => {
    const calls = stubFetch()
    const fake = fakeClient()
    const seeds: Array<string | null | undefined> = []
    const transport = new EveChatTransport({
      getAccessToken: () => 'jwt',
      teammateId: 'tm-1',
      workspaceId: 'ws-TEAMMATE',
      createClient: (args) => (seeds.push(args.workspaceId), fake.client as never),
    })
    await drain(await transport.sendMessages(sendOpts()))
    await settle()

    const mint = calls.find((c) => c.body.action === 'mint')!
    expect(mint.headers['x-workspace-id']).toBe('ws-TEAMMATE')
    expect(mint.body.teammateId).toBe('tm-1')
    const register = calls.find((c) => c.body.action === 'register')!
    expect(register.headers['x-workspace-id']).toBe('ws-TEAMMATE')
    const persist = calls.find((c) => c.url === '/api/account/chat/eve-persist')!
    expect(persist.headers['x-workspace-id']).toBe('ws-TEAMMATE')
    expect(seeds).toEqual(['ws-TEAMMATE'])
    expect((fake.createOptions[0].headers as Record<string, string>)['x-workspace-id']).toBe('ws-TEAMMATE')
  })

  it('a getter is read at request time (the workspace learned after construction is the one sent)', async () => {
    const calls = stubFetch()
    const fake = fakeClient()
    let workspace: string | null = null
    const transport = new EveChatTransport({
      getAccessToken: () => 'jwt',
      workspaceId: () => workspace,
      createClient: () => fake.client as never,
    })
    workspace = 'ws-LATER'
    await drain(await transport.sendMessages(sendOpts()))
    expect(calls.find((c) => c.body.action === 'mint')!.headers['x-workspace-id']).toBe('ws-LATER')
    expect((fake.createOptions[0].headers as Record<string, string>)['x-workspace-id']).toBe('ws-LATER')
  })

  it('without the options nothing changes: no workspace header from the transport, no teammate in the mint', async () => {
    const calls = stubFetch()
    const fake = fakeClient()
    const seeds: Array<string | null | undefined> = []
    const transport = new EveChatTransport({
      getAccessToken: () => 'jwt',
      createClient: (args) => (seeds.push(args.workspaceId), fake.client as never),
    })
    await drain(await transport.sendMessages(sendOpts()))
    await settle()
    for (const c of calls) expect(c.headers).not.toHaveProperty('x-workspace-id')
    expect(calls.find((c) => c.body.action === 'mint')!.body).not.toHaveProperty('teammateId')
    expect(seeds).toEqual([null])
    expect(fake.createOptions[0].headers as Record<string, string>).not.toHaveProperty('x-workspace-id')
  })

  it('a teammate send’s item (bots v3 1d, body.teammateAbout) rides its mint as `about`, ids only, and never the turn context', async () => {
    const calls = stubFetch()
    const fake = fakeClient()
    const job = '77777777-7777-4777-8777-777777777777'
    const transport = new EveChatTransport({
      getAccessToken: () => 'jwt',
      teammateId: 'tm-1',
      workspaceId: 'ws-TEAMMATE',
      createClient: () => fake.client as never,
    })
    const opts = { ...sendOpts(), body: { teammateAbout: { workItemId: job, title: 'not sent' } } }
    await drain(await transport.sendMessages(opts))
    await settle()
    expect(calls.find((c) => c.body.action === 'mint')!.body.about).toEqual({ workItemId: job })
    // The next send about nothing mints without it.
    await drain(await transport.sendMessages(sendOpts()))
    await settle()
    const mints = calls.filter((c) => c.body.action === 'mint')
    expect(mints[1].body).not.toHaveProperty('about')
  })

  it('an ordinary chat never sends an item, whatever its body says', async () => {
    const calls = stubFetch()
    const fake = fakeClient()
    const transport = new EveChatTransport({ getAccessToken: () => 'jwt', createClient: () => fake.client as never })
    await drain(await transport.sendMessages({ ...sendOpts(), body: { teammateAbout: { workItemId: '77777777-7777-4777-8777-777777777777' } } }))
    expect(calls.find((c) => c.body.action === 'mint')!.body).not.toHaveProperty('about')
  })
})

