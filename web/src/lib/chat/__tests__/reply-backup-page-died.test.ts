/**
 * A main-chat turn survives the page dying mid-turn (2026-10-19: a WebKit
 * crash and a silent reload four seconds after Liam spoke; eve finished the
 * turn and its tools ran, but the thread never showed it).
 *
 * End to end, with the real pieces and an in-memory chat_messages:
 *   the transport (eve-chat-transport.ts) sends the turn: it saves the
 *     person's message at once through eve-persist and names its reply id
 *     on the send (x-chat-reply-id);
 *   the chat-agent's reply-backup hook folds the turn as eve emits it and
 *     posts it at the turn's end (its real spec-client POST, routed into the
 *     real /api/internal/chat/reply handler);
 *   the browser never calls eve-persist for the reply (the page is gone).
 * The thread still ends with both rows, in order, under the ids the browser
 * rendered. With the page alive, whichever copy lands first, the thread keeps
 * one row per message and the browser's copy of the reply.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai'
import type { HandleMessageStreamEvent } from 'eve/client'
import { chatMessagesFake } from '@/test/chat-messages-fake'

const SECRET = 'test-chat-internal-secret-abcdefghij'
const USER = { id: 'u-1', email: 'liam@example.com' }

let db = chatMessagesFake([])
vi.mock('@/lib/admin', () => ({ getServiceClient: () => db.client }))
const inngestSend = vi.fn(async (..._a: unknown[]) => undefined)
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: (...a: unknown[]) => inngestSend(...a) } }))
vi.mock('@/lib/chat/idle-compaction-signal', () => ({ signalChatSessionActivity: vi.fn() }))
vi.mock('@/lib/posthog', () => ({ trackServerEvent: vi.fn() }))
vi.mock('@/lib/api-auth', () => ({ requireWorkspace: async () => ({ supabase: {}, user: USER, workspaceId: 'ws-1' }) }))
// eve's durable state, in memory (the real one only works inside the eve runtime).
const agentState = new Map<string, unknown>()
vi.mock('eve/context', () => ({
  defineState: <T,>(name: string, initial: () => T) => ({
    get: () => (agentState.has(name) ? (agentState.get(name) as T) : initial()),
    update: (fn: (prev: T) => T) => agentState.set(name, fn(agentState.has(name) ? (agentState.get(name) as T) : initial())),
  }),
}))

const { POST: evePersist } = await import('@/app/api/account/chat/eve-persist/route')
const { POST: replyRoute } = await import('@/app/api/internal/chat/reply/route')
const { EveChatTransport, CHAT_REPLY_ID_HEADER } = await import('../eve/eve-chat-transport')
const { mintChatRunToken, CHAT_RUN_TOKEN_HEADER } = await import('../chat-run-token')
const { EVE_PROVISIONAL_METADATA_KEY } = await import('../eve-message-writer')
const { default: replyBackupHook } = await import('../../../../agents/chat-agent/hooks/reply-backup')

type Handler = (event: unknown, ctx: unknown) => Promise<void>
const hookHandlers = (replyBackupHook as unknown as { events: Record<string, Handler> }).events

// ── The turn, as eve emits it ────────────────────────────────────────────────
const e = (type: string, data: Record<string, unknown> = {}) =>
  ({ type, data: { turnId: 'turn_5', sequence: 5, stepIndex: 0, ...data } }) as unknown as HandleMessageStreamEvent
const TURN: HandleMessageStreamEvent[] = [
  e('turn.started'),
  e('message.received'),
  e('step.started', { modelId: 'anthropic/claude-sonnet-5.5' }),
  e('actions.requested', { actions: [{ kind: 'tool-call', callId: 'call_1', toolName: 'update_sequence', input: { sequenceId: 'd481a2dd', steps: 3 } }] }),
  e('action.result', { result: { kind: 'tool-result', callId: 'call_1', toolName: 'update_sequence', output: { updated: 3 } } }),
  e('message.appended', { messageDelta: 'I rewrote all three ' }),
  e('message.appended', { messageDelta: 'steps of the outreach sequence.' }),
  e('message.completed', { message: 'I rewrote all three steps of the outreach sequence.' }),
  e('step.completed', { usage: { inputTokens: 10, outputTokens: 5 } }),
  e('turn.completed'),
]
const REPLY_TEXT = 'I rewrote all three steps of the outreach sequence.'

// ── The browser ──────────────────────────────────────────────────────────────

/** A fake eve client whose one response yields `before`, waits for `gate`, then yields `after` (or never returns). */
function fakeEve(before: HandleMessageStreamEvent[], after: HandleMessageStreamEvent[] | 'page-died', gate: Promise<void> = Promise.resolve()) {
  const sent: Array<Record<string, unknown>> = []
  const response = {
    sessionId: 'wrun_1',
    async *[Symbol.asyncIterator]() {
      for (const ev of before) yield ev
      if (after === 'page-died') await new Promise(() => {}) // The page is gone: nothing reads the rest.
      await gate
      for (const ev of after as HandleMessageStreamEvent[]) yield ev
    },
  }
  const session = { send: vi.fn(), respond: vi.fn(), cancel: vi.fn(), stream: vi.fn(), state: { sessionId: 'wrun_1', streamIndex: 0 } }
  const create = vi.fn(async (input: Record<string, unknown>) => {
    sent.push(input)
    return { response, session }
  })
  return { client: { sessions: { create, attach: () => session } }, sent }
}

function browser(token: string, eve: ReturnType<typeof fakeEve>) {
  const persisted: Array<{ role: string; messageId: string }> = []
  const transport = new EveChatTransport({
    getAccessToken: () => 'jwt',
    mintRunToken: async () => ({ token, conversationId: 'conv-1' }),
    registerEveSession: async () => {},
    createClient: () => eve.client as never,
    panelNamesChats: () => true,
    // The real eve-persist route (cookie auth mocked to this user).
    persistTurn: async ({ token: t, body }) => {
      persisted.push({ role: body.role, messageId: body.messageId })
      const res = await evePersist(
        new Request('http://localhost/api/account/chat/eve-persist', {
          method: 'POST',
          headers: { 'content-type': 'application/json', [CHAT_RUN_TOKEN_HEADER]: t },
          body: JSON.stringify(body),
        }) as never,
      )
      if (!res.ok) throw new Error(`eve-persist ${res.status}`)
    },
  })
  return { transport, persisted }
}

const sendOpts = {
  chatId: 'chat-1',
  messages: [{ id: 'user-msg-1', role: 'user', parts: [{ type: 'text', text: 'Rewrite the outreach steps' }] }],
  trigger: 'submit-message',
  messageId: undefined,
  body: { conversationId: 'conv-1' },
} as unknown as Parameters<ChatTransport<UIMessage>['sendMessages']>[0]

async function readUntil(stream: ReadableStream<UIMessageChunk>, pred: (c: UIMessageChunk) => boolean): Promise<UIMessageChunk[]> {
  const chunks: UIMessageChunk[] = []
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    if (pred(value)) break
  }
  reader.releaseLock()
  return chunks
}

// ── eve on the server: the hook, posting through its real spec-client ───────
async function eveRunsTheTurn(token: string, replyId: string) {
  const ctx = { session: { id: 'wrun_1', auth: { current: { attributes: { chatRunToken: token, chatReplyId: replyId } } } } }
  for (const ev of TURN) await hookHandlers[ev.type]?.(ev, ctx)
}

describe('a main-chat turn survives the page dying mid-turn', () => {
  let token: string
  beforeEach(() => {
    process.env.CHAT_INTERNAL_SECRET = SECRET
    process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000'
    delete process.env.VERCEL_URL
    db = chatMessagesFake([{ id: 'conv-1', user_id: USER.id, workspace_id: 'ws-1', title: 'New conversation' }])
    agentState.clear()
    inngestSend.mockClear()
    token = mintChatRunToken({ conversationId: 'conv-1', userId: USER.id, workspaceId: 'ws-1' })
    // The agent's POST lands on the real internal route.
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      if (String(url).endsWith('/api/internal/chat/reply')) return replyRoute(new Request(url, init))
      throw new Error(`unexpected fetch ${url}`)
    })
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    delete process.env.CHAT_INTERNAL_SECRET
    delete process.env.NEXT_PUBLIC_APP_URL
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('the client never calls eve-persist for the reply, and both rows still land', async () => {
    // The browser sees the first few events, then the page dies.
    const eve = fakeEve(TURN.slice(0, 6), 'page-died')
    const { transport, persisted } = browser(token, eve)
    const stream = await transport.sendMessages(sendOpts)
    const chunks = await readUntil(stream, (c) => c.type === 'text-delta')
    await transport.turnPersisted('chat-1')

    // The send named the reply the browser renders.
    const replyId = (eve.sent[0].headers as Record<string, string>)[CHAT_REPLY_ID_HEADER]
    expect(replyId).toMatch(/^eve-msg-chat-1-/)
    expect(chunks.find((c) => c.type === 'start')).toMatchObject({ messageId: replyId })
    // The person's message is already saved; the reply isn't, and the browser never sends it.
    expect(persisted).toEqual([{ role: 'user', messageId: 'user-msg-1' }])
    expect(db.thread()).toEqual([{ role: 'user', id: 'user-msg-1' }])

    // eve finishes the turn on the server.
    await eveRunsTheTurn(token, replyId)

    expect(persisted).toEqual([{ role: 'user', messageId: 'user-msg-1' }])
    expect(db.thread()).toEqual([
      { role: 'user', id: 'user-msg-1' },
      { role: 'assistant', id: replyId },
    ])
    const reply = db.messages.find((m) => m.ui_message.id === replyId)!
    expect(reply.ui_message.parts).toEqual([
      expect.objectContaining({ type: 'dynamic-tool', toolName: 'update_sequence', state: 'output-available', output: { updated: 3 } }),
      { type: 'text', text: REPLY_TEXT },
    ])
    expect(reply.ui_message.metadata?.[EVE_PROVISIONAL_METADATA_KEY]).toBe(true)
    // The knowledge hook fired once for the turn: the reply's write (the
    // send-time user message leaves it to the reply).
    expect(inngestSend).toHaveBeenCalledTimes(1)
  })

  it("page alive, the server's copy first: the browser's replaces it, one row each", async () => {
    let open!: () => void
    const gate = new Promise<void>((resolve) => (open = resolve))
    const eve = fakeEve(TURN.slice(0, 1), TURN.slice(1), gate)
    const { transport, persisted } = browser(token, eve)
    const stream = await transport.sendMessages(sendOpts)
    const reading = readUntil(stream, () => false)
    await transport.turnPersisted('chat-1')
    const replyId = (eve.sent[0].headers as Record<string, string>)[CHAT_REPLY_ID_HEADER]

    await eveRunsTheTurn(token, replyId)
    open()
    await reading
    await transport.turnPersisted('chat-1')

    expect(persisted.map((p) => p.role)).toEqual(['user', 'assistant'])
    expect(db.thread()).toEqual([
      { role: 'user', id: 'user-msg-1' },
      { role: 'assistant', id: replyId },
    ])
    const reply = db.messages.find((m) => m.ui_message.id === replyId)!
    expect(reply.ui_message.metadata?.[EVE_PROVISIONAL_METADATA_KEY]).toBeUndefined()
    expect(reply.ui_message.parts).toContainEqual({ type: 'text', text: REPLY_TEXT })
  })

  it("page alive, the browser's copy first: the server's is a no-op", async () => {
    const eve = fakeEve(TURN, [])
    const { transport } = browser(token, eve)
    await readUntil(await transport.sendMessages(sendOpts), () => false)
    await transport.turnPersisted('chat-1')
    const replyId = (eve.sent[0].headers as Record<string, string>)[CHAT_REPLY_ID_HEADER]

    await eveRunsTheTurn(token, replyId)

    expect(db.thread()).toEqual([
      { role: 'user', id: 'user-msg-1' },
      { role: 'assistant', id: replyId },
    ])
    expect(db.messages.find((m) => m.ui_message.id === replyId)!.ui_message.metadata?.[EVE_PROVISIONAL_METADATA_KEY]).toBeUndefined()
  })
})
