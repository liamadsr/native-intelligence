/**
 * The home thread's eve session, end to end through the browser transport and
 * this route (always-on agent §2c / §4c): a home turn sends only into the
 * session registered on the home row (home-turn-server.ts), so every way a
 * home thread gets a new session must leave `eve_session_id` set. The
 * transport's DEFAULT mint and register (no injected helpers) post to the
 * real route over a one-row fake. Pinned:
 *   - the first turn in a home thread with no session registers the session
 *     it creates;
 *   - a re-attached session that can't take the turn (retired, expired,
 *     Retry's fork) registers its replacement over the old id;
 *   - a register that fails on a blip (a dropped request, a 5xx) is retried
 *     once, so the row isn't left empty while the turn runs;
 *   - a register refused for good (a 4xx) is not retried;
 *   - nothing on these paths ever writes NULL.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai'
import type { HandleMessageStreamEvent } from 'eve/client'

vi.mock('@/lib/chat/idle-compaction-signal', () => ({ signalChatSessionActivity: vi.fn() }))

type Row = { id: string; user_id: string; workspace_id: string; eve_session_id: string | null; agent_teammate_id: null; focus_area: null; is_home: boolean; capture_id: null }
const db = vi.hoisted(() => ({ row: null as Row | null, writes: [] as unknown[], failRegister: [] as number[] }))

function orAllows(filter: string, value: string | null): boolean {
  return filter.split(',').some((part) => {
    if (part === 'eve_session_id.is.null') return value === null
    const m = /^eve_session_id\.eq\."?([^"]*)"?$/.exec(part)
    if (!m) throw new Error(`unexpected or filter: ${part}`)
    return value === m[1]
  })
}

function chain() {
  const eqs: Array<[string, unknown]> = []
  let op: 'select' | 'update' = 'select'
  let patch: Record<string, unknown> | null = null
  let or: string | null = null
  const matches = () => !!db.row && eqs.every(([k, v]) => (db.row as unknown as Record<string, unknown>)[k] === v)
  const c: Record<string, unknown> = {}
  c.select = () => c
  c.eq = (k: string, v: unknown) => (eqs.push([k, v]), c)
  c.or = (f: string) => ((or = f), c)
  c.update = (p: Record<string, unknown>) => ((op = 'update'), (patch = p), c)
  c.maybeSingle = async () => ({ data: matches() ? { ...db.row } : null, error: null })
  c.then = (resolve: (v: unknown) => unknown) => {
    let count = 0
    if (op === 'update') {
      db.writes.push(patch)
      if (matches() && (or === null || orAllows(or, db.row!.eve_session_id))) {
        Object.assign(db.row!, patch)
        count = 1
      }
    }
    return Promise.resolve({ data: null, error: null, count }).then(resolve)
  }
  return c
}

vi.mock('@/lib/api-auth', () => ({
  requireWorkspace: async () => ({ supabase: { from: () => chain() }, user: { id: 'user-1' }, workspaceId: 'ws-1' }),
}))
vi.mock('@/lib/chat/chat-run-token', () => ({ mintChatRunToken: () => 'signed.token', internalSecret: () => 'test-secret' }))
vi.mock('@/lib/ai/auth', () => ({ checkUsageLimits: async () => undefined }))
vi.mock('@/lib/chat/chat-run-credential', () => ({ sealRunCredential: () => 'sealed' }))
vi.mock('@/lib/chat/conversation-history', () => ({ renderConversationPrimer: async () => 'PRIMER', renderHomePrimer: async () => 'HOME PRIMER' }))

import { POST } from '../route'
import type { NextRequest } from 'next/server'
import { EveChatTransport } from '@/lib/chat/eve/eve-chat-transport'

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
    chatId: 'chat-home',
    messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hello' }] }],
    trigger: 'submit-message',
    messageId: undefined,
    body: {},
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

/** A page's main chat on the home thread: the transport as chat-panel builds it, minting and registering through the route. */
function homeChat(opts: { attachedFails?: (id: string) => boolean } = {}) {
  let created = 0
  const makeSession = (id: string) => ({
    send: vi.fn(async () => {
      if (opts.attachedFails?.(id)) throw new Error('session retired')
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
      attach: vi.fn((id: string) => makeSession(id)),
    },
  }
  return new EveChatTransport({
    getAccessToken: () => 'tok',
    getConversationId: () => 'home-1',
    persistTurn: async () => {},
    createClient: () => client as never,
    // No wall clock: the register retry goes at once.
    timeouts: { registerRetryMs: 0 },
  })
}

const registers = () => db.writes.length

let warn: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  db.row = { id: 'home-1', user_id: 'user-1', workspace_id: 'ws-1', eve_session_id: null, agent_teammate_id: null, focus_area: null, is_home: true, capture_id: null }
  db.writes.length = 0
  db.failRegister.length = 0
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (!String(url).endsWith('/api/account/chat/eve-session')) throw new Error(`unexpected fetch ${url}`)
    const body = JSON.parse(String(init?.body ?? '{}')) as { action?: string }
    if (body.action === 'register' && db.failRegister.length) {
      const status = db.failRegister.shift()!
      if (status === 0) throw new TypeError('Failed to fetch')
      return Response.json({ error: 'down' }, { status })
    }
    return POST(new Request(`http://localhost${url}`, { method: 'POST', headers: init?.headers, body: init?.body }) as unknown as NextRequest)
  })
})
afterEach(() => {
  warn.mockRestore()
  vi.unstubAllGlobals()
})

describe('a home thread’s session is registered on its row', () => {
  it('the first turn in a home thread with no session registers the one it creates', async () => {
    await drain(await homeChat().sendMessages(sendOpts()))
    expect(db.row!.eve_session_id).toBe('wrun_NEW1')
  })

  it('a registered session that can’t take the turn is replaced, registered over the old id', async () => {
    db.row!.eve_session_id = 'wrun_OLD'
    await drain(await homeChat({ attachedFails: (id) => id === 'wrun_OLD' }).sendMessages(sendOpts()))
    expect(db.row!.eve_session_id).toBe('wrun_NEW1')
  })

  it('a later turn on the live session leaves the row as it is', async () => {
    const chat = homeChat()
    await drain(await chat.sendMessages(sendOpts()))
    await drain(await chat.sendMessages(sendOpts()))
    expect(db.row!.eve_session_id).toBe('wrun_NEW1')
    expect(registers()).toBe(1)
  })

  it('a register lost to a blip (a dropped request, a 5xx) is retried once', async () => {
    for (const blip of [0, 503]) {
      db.row!.eve_session_id = null
      db.writes.length = 0
      db.failRegister.push(blip)
      await drain(await homeChat().sendMessages(sendOpts()))
      expect([blip, db.row!.eve_session_id]).toEqual([blip, 'wrun_NEW1'])
      // The blip, then one retry that landed.
      expect(registers()).toBe(1)
      expect(db.failRegister).toEqual([])
    }
  })

  it('a register refused for good (a 4xx) is not retried', async () => {
    db.failRegister.push(400)
    await drain(await homeChat().sendMessages(sendOpts())).catch(() => [])
    expect(db.row!.eve_session_id).toBeNull()
    expect(registers()).toBe(0)
  })

  it('nothing on these paths writes NULL', async () => {
    db.row!.eve_session_id = 'wrun_OLD'
    await drain(await homeChat({ attachedFails: (id) => id === 'wrun_OLD' }).sendMessages(sendOpts()))
    expect(db.writes.every((w) => (w as { eve_session_id?: unknown }).eve_session_id)).toBe(true)
  })
})
