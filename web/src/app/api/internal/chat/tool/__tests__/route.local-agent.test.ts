/**
 * POST /api/internal/chat/tool — the local-agent branches (docs/plans/
 * local-agents.md, contract F3). The handlers themselves are
 * src/lib/chat/__tests__/local-agent-tools.test.ts; this pins the route's
 * fences around them:
 *   - the main chat's alone: a teammate token is refused before anything
 *     (RELAY_TOOLS);
 *   - start_local_agent runs only in a typed turn, with eve's call, turn and
 *     session ids, through the reviewer as chat-native (held = refused);
 *   - a home turn may read them, stop one and message one (the handler then
 *     admits only an answer to an open question), past no reviewer; never
 *     start one; another server principal reaches none;
 *   - the reads skip the reviewer;
 *   - a schema refusal is a 400 and a failure a 503 that says not to retry.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The run-token DB binding (src/lib/chat/surface-run-guard.ts) has its own
// tests; this file's fake database holds no conversation / member rows.
vi.mock('@/lib/chat/surface-run-guard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/chat/surface-run-guard')>()),
  chatRunBindingRefusal: async () => null,
}))

const handlers = vi.hoisted(() => ({
  listLocalAgents: vi.fn(async (..._a: unknown[]): Promise<Record<string, unknown>> => ({ devices: [] })),
  startLocalAgent: vi.fn(async (..._a: unknown[]): Promise<Record<string, unknown>> => ({ status: 'queued', session_id: 's-1' })),
  messageLocalAgent: vi.fn(async (..._a: unknown[]): Promise<Record<string, unknown>> => ({ status: 'sent' })),
  readLocalAgent: vi.fn(async (..._a: unknown[]): Promise<Record<string, unknown>> => ({ items: [] })),
  stopLocalAgent: vi.fn(async (..._a: unknown[]): Promise<Record<string, unknown>> => ({ status: 'stopping' })),
}))
vi.mock('@/lib/chat/local-agent-tools', () => handlers)

// The reviewer, as a spy that runs the call: what it was asked is the assertion.
const gate = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>,
}))
vi.mock('@/lib/safety/action-review', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/safety/action-review')>()
  return {
    ...actual,
    gateRiskyCall: async (request: Record<string, unknown>, run: () => Promise<unknown>) => {
      gate.calls.push(request)
      return { held: false, value: await run() }
    },
  }
})

vi.mock('@/lib/admin', () => ({
  getServiceClient: () => {
    const chain = (table: string) => {
      const c: Record<string, unknown> = {}
      for (const m of ['select', 'eq']) c[m] = () => c
      c.maybeSingle = async () => ({ data: table === 'workspace' ? { settings: null } : { agent_config: null }, error: null })
      return c
    }
    return { from: (table: string) => chain(table) }
  },
}))
vi.mock('@/lib/ai/tools', () => ({ createTools: () => ({}) }))
vi.mock('@/lib/mcp-client/adapter', () => ({
  createExternalMcpTools: async () => ({ tools: {}, meta: new Map(), servers: [] }),
}))

import { POST } from '@/app/api/internal/chat/tool/route'
import { mintChatRunToken, CHAT_RUN_SECRET_HEADER, CHAT_RUN_TOKEN_HEADER } from '@/lib/chat/chat-run-token'
import { LOCAL_AGENT_TOOL_NAMES } from '@/lib/ai/tools/local-agent'

const SECRET = 'test-chat-internal-secret-abcdefghij'
const ID = '0b8f0c1e-4c1a-4f7e-9a51-1f0e2d3c4b5a'

function toolReq(token: string, toolName: string, input: unknown = {}, callId?: string, turnId?: string, sessionId?: string) {
  return new Request('http://localhost/api/internal/chat/tool', {
    method: 'POST',
    headers: { 'content-type': 'application/json', [CHAT_RUN_SECRET_HEADER]: SECRET, [CHAT_RUN_TOKEN_HEADER]: token },
    body: JSON.stringify({ toolName, input, callId, turnId, sessionId }),
  })
}

const typed = () => mintChatRunToken({ conversationId: 'c', workspaceId: 'ws-1', userId: 'user-1' })
const homeTurn = () => mintChatRunToken({ conversationId: 'c', workspaceId: 'ws-1', userId: 'user-1', server: 'home_turn' })

const INPUTS: Record<(typeof LOCAL_AGENT_TOOL_NAMES)[number], unknown> = {
  local_agents: {},
  start_local_agent: { folder_id: ID, request: 'Take a look at this repository' },
  message_local_agent: { session_id: ID, text: 'Stick to src/' },
  read_local_agent: { session_id: ID },
  stop_local_agent: { session_id: ID },
}

beforeEach(() => {
  process.env.CHAT_INTERNAL_SECRET = SECRET
  gate.calls.length = 0
  for (const fn of Object.values(handlers)) fn.mockClear()
})
afterEach(() => {
  delete process.env.CHAT_INTERNAL_SECRET
})

describe('the local-agent tools on the chat tool route', () => {
  it('a teammate token is refused every one, before any handler (RELAY_NOT_ALLOWED)', async () => {
    const teammate = mintChatRunToken({ conversationId: 'c', workspaceId: 'ws-1', userId: 'user-1', teammateId: 'tm-1' })
    for (const name of LOCAL_AGENT_TOOL_NAMES) {
      const res = await POST(toolReq(teammate, name, INPUTS[name], 'call', 'turn', 'session'))
      expect([name, res.status, (await res.json()).code]).toEqual([name, 403, 'RELAY_NOT_ALLOWED'])
    }
    for (const fn of Object.values(handlers)) expect(fn).not.toHaveBeenCalled()
  })

  it('a typed turn starts one with eve’s ids, through the reviewer as chat-native (held = refused)', async () => {
    const res = await POST(toolReq(typed(), 'start_local_agent', { ...(INPUTS.start_local_agent as object), mode: 'edit' }, 'call-1', 'turn-1', 'wrun_s1'))
    expect(res.status).toBe(200)
    expect((await res.json()).output).toEqual({ status: 'queued', session_id: 's-1' })
    expect(handlers.startLocalAgent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: 'user-1', workspaceId: 'ws-1', conversationId: 'c' }),
      { callId: 'call-1', turnId: 'turn-1', sessionId: 'wrun_s1' },
      { folder_id: ID, request: 'Take a look at this repository', mode: 'edit' },
    )
    expect(gate.calls).toHaveLength(1)
    expect(gate.calls[0]).toMatchObject({ toolName: 'start_local_agent', sideEffect: 'automation-write', holdAs: 'refusal', door: 'chat' })
  })

  it('start_local_agent needs eve’s durable ids, and its schema', async () => {
    expect((await POST(toolReq(typed(), 'start_local_agent', INPUTS.start_local_agent))).status).toBe(400)
    expect((await POST(toolReq(typed(), 'start_local_agent', INPUTS.start_local_agent, 'call', 'a:b', 'session'))).status).toBe(400)
    expect((await POST(toolReq(typed(), 'start_local_agent', INPUTS.start_local_agent, 'call', 'turn', 'a:b'))).status).toBe(400)
    const bad = await POST(toolReq(typed(), 'start_local_agent', { folder_id: 'native-intelligence', request: 'x' }, 'call', 'turn', 'session'))
    expect([bad.status, (await bad.json()).code]).toEqual([400, 'INPUT_INVALID'])
    expect(handlers.startLocalAgent).not.toHaveBeenCalled()
  })

  it('message_local_agent needs eve’s durable ids too (its key: a retried call sends once)', async () => {
    expect((await POST(toolReq(typed(), 'message_local_agent', INPUTS.message_local_agent))).status).toBe(400)
    expect((await POST(toolReq(typed(), 'message_local_agent', INPUTS.message_local_agent, 'call', 'a:b', 'session'))).status).toBe(400)
    expect((await POST(toolReq(homeTurn(), 'message_local_agent', INPUTS.message_local_agent, 'call', 'turn'))).status).toBe(400)
    expect(handlers.messageLocalAgent).not.toHaveBeenCalled()
  })

  it('a failed start is a 503 that says not to start it again', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    handlers.startLocalAgent.mockRejectedValueOnce(new Error('db down'))
    const res = await POST(toolReq(typed(), 'start_local_agent', INPUTS.start_local_agent, 'call', 'turn', 'session'))
    expect(res.status).toBe(503)
    expect((await res.json()).error).toMatch(/Do not call start_local_agent again/)
    error.mockRestore()
  })

  it('a typed turn’s message and stop go through the reviewer; the reads do not', async () => {
    for (const name of ['message_local_agent', 'stop_local_agent'] as const) {
      gate.calls.length = 0
      expect((await POST(toolReq(typed(), name, INPUTS[name], 'call', 'turn', 'session'))).status).toBe(200)
      expect(gate.calls.map((c) => [c.toolName, c.holdAs])).toEqual([[name, 'refusal']])
    }
    gate.calls.length = 0
    for (const name of ['local_agents', 'read_local_agent'] as const) {
      expect((await POST(toolReq(typed(), name, INPUTS[name], 'call', 'turn', 'session'))).status).toBe(200)
    }
    expect(gate.calls).toEqual([])
    expect(handlers.messageLocalAgent).toHaveBeenCalledWith(expect.anything(), expect.anything(), { callId: 'call', turnId: 'turn', sessionId: 'session' }, { session_id: ID, text: 'Stick to src/' })
    expect(handlers.readLocalAgent).toHaveBeenCalledWith(expect.anything(), expect.anything(), { session_id: ID })
  })

  it('a home turn reads, stops and messages (the handler checks the open question) past no reviewer; it never starts one', async () => {
    for (const name of ['local_agents', 'read_local_agent', 'stop_local_agent', 'message_local_agent'] as const) {
      const res = await POST(toolReq(homeTurn(), name, INPUTS[name], 'call', 'turn', 'session'))
      expect([name, res.status]).toEqual([name, 200])
    }
    expect(handlers.messageLocalAgent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ server: 'home_turn' }),
      { callId: 'call', turnId: 'turn', sessionId: 'session' },
      INPUTS.message_local_agent,
    )
    expect(gate.calls).toEqual([])
    const start = await POST(toolReq(homeTurn(), 'start_local_agent', INPUTS.start_local_agent, 'call', 'turn', 'session'))
    expect([start.status, (await start.json()).code]).toEqual([403, 'SERVER_TURN_READ_ONLY'])
    expect(handlers.startLocalAgent).not.toHaveBeenCalled()
  })

  it('another server principal (idle compaction) reaches none of them', async () => {
    const compaction = mintChatRunToken({ conversationId: 'c', workspaceId: 'ws-1', userId: 'user-1', server: 'idle_compaction' })
    for (const name of LOCAL_AGENT_TOOL_NAMES) {
      const res = await POST(toolReq(compaction, name, INPUTS[name], 'call', 'turn', 'session'))
      expect([name, res.status]).toEqual([name, 403])
    }
    for (const fn of Object.values(handlers)) expect(fn).not.toHaveBeenCalled()
  })

  it('a failed message is a 503 that says not to send it again', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    handlers.messageLocalAgent.mockRejectedValueOnce(new Error('db down'))
    const res = await POST(toolReq(typed(), 'message_local_agent', INPUTS.message_local_agent, 'call', 'turn', 'session'))
    expect(res.status).toBe(503)
    expect((await res.json()).error).toMatch(/Do not send it again/)
    error.mockRestore()
  })
})
