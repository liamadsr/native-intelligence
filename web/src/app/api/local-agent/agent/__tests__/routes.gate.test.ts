/**
 * POST /api/local-agent/agent/tool with the REAL reviewer gate
 * (src/lib/safety/action-review.ts gateRiskyCall), for a job that acts for the
 * person (person_remote): a connected app's write is held by the outward gate
 * as the person's card, asked in their home thread and naming the job, and
 * the model reads where the card is.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  db: null as unknown,
  afters: [] as Array<() => unknown>,
  createToolApproval: vi.fn(async (): Promise<unknown> => ({ ok: true, approvalId: 'appr-1', cardId: 'card-1' })),
  mcpExecute: vi.fn(async (): Promise<unknown> => ({ ok: true })),
  execute: vi.fn(async (): Promise<unknown> => ({ success: true })),
}))
vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => m.db }))
vi.mock('@/lib/ai/auth', () => ({ checkUsageLimits: vi.fn(async () => undefined), logUsage: vi.fn() }))
vi.mock('next/server', async (orig) => ({
  ...(await orig<typeof import('next/server')>()),
  after: (fn: () => unknown) => {
    m.afters.push(fn)
  },
}))
vi.mock('@/lib/chat/chat-ceiling', async (orig) => ({
  ...(await orig<typeof import('@/lib/chat/chat-ceiling')>()),
  resolveChatCeiling: async () => null,
}))
const stub = (execute: () => Promise<unknown>) => ({ description: 'stub', inputSchema: { safeParse: (v: unknown) => ({ success: true, data: v }) }, execute })
vi.mock('@/lib/ai/tools', () => ({ createTools: () => ({ list_actions: stub(m.execute) }) }))
vi.mock('@/lib/mcp-client/adapter', () => ({
  createExternalMcpTools: async () => ({
    tools: { mcp__linear__create_issue: stub(m.mcpExecute) },
    meta: new Map([['mcp__linear__create_issue', { serverName: 'Linear', requiresApproval: true }]]),
    servers: [],
  }),
}))
vi.mock('@/lib/safety/approvals', async (orig) => ({
  ...(await orig<typeof import('@/lib/safety/approvals')>()),
  createToolApproval: m.createToolApproval,
}))
vi.mock('@/lib/work/touch', () => ({ recordToolCallTouches: vi.fn(async () => undefined) }))

import { POST } from '../tool/route'
import { signModelToken } from '@/lib/local-agent/tokens'
import { resetRepeatBreaker } from '@/lib/chat/tool-repeat-breaker'
import { resetTurnTools } from '@/lib/safety/turn-tools'
import { CONV, DEVICE, FOLDER, USER, WS, seeded } from '@/lib/local-agent/__tests__/fake-db'

const SID = '77777777-7777-4777-8777-777777777777'

function call(toolName: string, input: unknown = {}) {
  return POST(new Request('http://localhost/api/local-agent/agent/tool', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${signModelToken({ sid: SID, uid: USER, wid: WS }).token}` },
    body: JSON.stringify({ toolName, input, sessionId: 'eve-1', turnId: 'turn-1', callId: 'call-1' }),
  }))
}

const env = { ...process.env }
beforeEach(() => {
  process.env.LOCAL_AGENT_TOKEN_SECRET = 'mac-body-gate-test-secret'
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
  m.db = seeded({
    local_agent_session: [{
      id: SID, user_id: USER, workspace_id: WS, device_id: DEVICE, folder_id: FOLDER, conversation_id: CONV,
      started_by: 'agent', idempotency_key: `local-agent:${CONV}:session:eve-1:turn:t1:call:c1`,
      mode: 'read', status: 'running', local_model: false, request: 'file the bug', created_at: '2026-10-21T20:00:00.000Z',
      start_words: ['file a Linear issue for the login bug'], stop_requested_at: null,
      lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
    }],
    member: [{ id: 'mem-1', workspace_id: WS, user_id: USER }],
  })
  m.afters = []
  m.createToolApproval.mockClear()
  m.mcpExecute.mockClear()
  m.execute.mockClear()
  resetRepeatBreaker()
  resetTurnTools()
})
afterEach(() => {
  process.env = { ...env }
  vi.restoreAllMocks()
})

describe('the real gate, for a job acting for the person (person_remote)', () => {
  it('a connected app’s write is held as the person’s card: asked at home, naming the job, never run', async () => {
    const res = await call('mcp__linear__create_issue', { title: 'Login redirect loops' })
    expect(res.status).toBe(200)
    const { output } = await res.json()
    expect(output).toMatchObject({ success: false, code: 'APPROVAL_REQUIRED', approval_id: 'appr-1' })
    expect(output.message).toMatch(/home chat/)
    expect(output.message).not.toMatch(/right under your message/)
    expect(m.mcpExecute).not.toHaveBeenCalled()
    expect(m.createToolApproval).toHaveBeenCalledWith(m.db, expect.objectContaining({
      door: 'chat',
      userId: USER,
      workspaceId: WS,
      toolName: 'mcp__linear__create_issue',
      conversationId: null,
      reason: 'mcp_write',
      personMessageSeq: null,
      context: expect.objectContaining({ localAgent: { sessionId: SID, deviceName: 'Liam’s MacBook', folderLabel: 'dial8-website' } }),
    }))
  })

  it('a read runs, with no card', async () => {
    const res = await call('list_actions')
    expect(res.status).toBe(200)
    expect(m.execute).toHaveBeenCalled()
    expect(m.createToolApproval).not.toHaveBeenCalled()
  })
})
