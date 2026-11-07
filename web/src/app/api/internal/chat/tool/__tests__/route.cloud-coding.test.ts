/**
 * POST /api/internal/chat/tool — start_cloud_coding_run (docs/plans/
 * environments.md E2). The handler is src/lib/chat/__tests__/
 * cloud-coding-tools.test.ts; this pins the route's fences around it, as for
 * start_local_agent: the main chat's alone (a teammate token is refused
 * before anything), a typed turn only (a home turn never starts one), eve's
 * durable ids and the schema, through the reviewer as chat-native (held =
 * refused), and a failure is a 503 that says not to start it again.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The run-token DB binding (src/lib/chat/surface-run-guard.ts) has its own
// tests; this file's fake database holds no conversation / member rows.
vi.mock('@/lib/chat/surface-run-guard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/chat/surface-run-guard')>()),
  chatRunBindingRefusal: async () => null,
}))

const handlers = vi.hoisted(() => ({
  startCloudCodingRun: vi.fn(async (..._a: unknown[]): Promise<Record<string, unknown>> => ({ status: 'started', agent_run_id: 'run-1' })),
}))
vi.mock('@/lib/chat/cloud-coding-tools', () => handlers)

const gate = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }))
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

const SECRET = 'test-chat-internal-secret-abcdefghij'
const PROJECT = '0b8f0c1e-4c1a-4f7e-9a51-1f0e2d3c4b5a'
const INPUT = { project_id: PROJECT, request: 'Fix the CSV export' }

function toolReq(token: string, input: unknown = INPUT, callId?: string, turnId?: string, sessionId?: string) {
  return new Request('http://localhost/api/internal/chat/tool', {
    method: 'POST',
    headers: { 'content-type': 'application/json', [CHAT_RUN_SECRET_HEADER]: SECRET, [CHAT_RUN_TOKEN_HEADER]: token },
    body: JSON.stringify({ toolName: 'start_cloud_coding_run', input, callId, turnId, sessionId }),
  })
}

const typed = () => mintChatRunToken({ conversationId: 'c', workspaceId: 'ws-1', userId: 'user-1' })

beforeEach(() => {
  process.env.CHAT_INTERNAL_SECRET = SECRET
  gate.calls.length = 0
  handlers.startCloudCodingRun.mockClear()
})
afterEach(() => {
  delete process.env.CHAT_INTERNAL_SECRET
})

describe('start_cloud_coding_run on the chat tool route', () => {
  it('a typed turn starts one with eve’s ids, through the reviewer as chat-native (held = refused)', async () => {
    const res = await POST(toolReq(typed(), INPUT, 'call-1', 'turn-1', 'wrun_s1'))
    expect(res.status).toBe(200)
    expect((await res.json()).output).toEqual({ status: 'started', agent_run_id: 'run-1' })
    expect(handlers.startCloudCodingRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: 'user-1', workspaceId: 'ws-1', conversationId: 'c' }),
      { callId: 'call-1', turnId: 'turn-1', sessionId: 'wrun_s1' },
      INPUT,
    )
    expect(gate.calls).toEqual([expect.objectContaining({ toolName: 'start_cloud_coding_run', sideEffect: 'automation-write', holdAs: 'refusal', door: 'chat' })])
  })

  it('a teammate token is refused before the handler; a home turn never starts one', async () => {
    const teammate = mintChatRunToken({ conversationId: 'c', workspaceId: 'ws-1', userId: 'user-1', teammateId: 'tm-1' })
    const t = await POST(toolReq(teammate, INPUT, 'call', 'turn', 'session'))
    expect([t.status, (await t.json()).code]).toEqual([403, 'RELAY_NOT_ALLOWED'])
    const home = mintChatRunToken({ conversationId: 'c', workspaceId: 'ws-1', userId: 'user-1', server: 'home_turn' })
    const h = await POST(toolReq(home, INPUT, 'call', 'turn', 'session'))
    expect([h.status, (await h.json()).code]).toEqual([403, 'SERVER_TURN_READ_ONLY'])
    expect(handlers.startCloudCodingRun).not.toHaveBeenCalled()
  })

  it('needs eve’s durable ids, and its schema (exactly one of a project or a repo)', async () => {
    expect((await POST(toolReq(typed(), INPUT))).status).toBe(400)
    expect((await POST(toolReq(typed(), INPUT, 'call', 'a:b', 'session'))).status).toBe(400)
    for (const bad of [{ request: 'x' }, { project_id: PROJECT, repo: 'acme/core', request: 'x' }, { repo: 'not a repo', request: 'x' }]) {
      const res = await POST(toolReq(typed(), bad, 'call', 'turn', 'session'))
      expect([res.status, (await res.json()).code]).toEqual([400, 'INPUT_INVALID'])
    }
    expect(handlers.startCloudCodingRun).not.toHaveBeenCalled()
  })

  it('a failed start is a 503 that says not to start it again', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    handlers.startCloudCodingRun.mockRejectedValueOnce(new Error('db down'))
    const res = await POST(toolReq(typed(), INPUT, 'call', 'turn', 'session'))
    expect(res.status).toBe(503)
    expect((await res.json()).error).toMatch(/Do not call start_cloud_coding_run again/)
    error.mockRestore()
  })
})
