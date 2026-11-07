/**
 * A turn the main agent relayed into a bot's thread, at the chat tool route,
 * with the REAL reviewer and ACTION_REVIEW_MODE (L5). Only Jev, the approval
 * writer and the bot's ceiling are stubbed:
 *   - the default (unset): relays stay shadow, as on PROD (the call runs, no
 *     card: a card would hold the bot's follow-through);
 *   - blocking: the relayed call is held and never runs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const SECRET = 'test-chat-internal-secret-relay'
const jev = vi.hoisted(() => ({ decide: vi.fn() }))
vi.mock('@/lib/ai/decisions/run-decision', () => ({ runDecision: jev.decide }))
const approvals = vi.hoisted(() => ({ create: vi.fn(async (..._a: unknown[]) => ({ ok: true, approvalId: 'appr-1', cardId: 'card-1' })) }))
vi.mock('@/lib/safety/approvals', async (orig) => ({ ...(await orig<typeof import('@/lib/safety/approvals')>()), createToolApproval: approvals.create }))
vi.mock('@/lib/chat/surface-run-guard', () => ({ chatRunBindingRefusal: async () => null }))
vi.mock('@/lib/chat/chat-ceiling', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/chat/chat-ceiling')>()),
  resolveChatCeiling: async () => null,
  resolveTeammateChatBounds: async () => ({}),
  resolveTeammateChatCeiling: async () => new Set(['delete_action']),
}))
vi.mock('@/lib/chat/follow-through', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/chat/follow-through')>()),
  resolveFollowThrough: async () => new Set<string>(),
}))
vi.mock('@/lib/admin', () => ({
  getServiceClient: () => {
    const chain = (table: string) => {
      const c: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'in', 'limit', 'order']) c[m] = () => c
      c.maybeSingle = async () => ({ data: table === 'workspace' ? { settings: null } : { agent_config: null }, error: null })
      c.then = (resolve: (r: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve)
      return c
    }
    return { from: (table: string) => chain(table) }
  },
}))
vi.mock('@/lib/work/touch', () => ({ recordToolCallTouches: vi.fn(async () => undefined) }))
vi.mock('@/lib/mcp-client/adapter', () => ({ createExternalMcpTools: async () => ({ tools: {}, meta: new Map(), servers: [] }) }))
const executeSpy = vi.fn(async () => ({ ok: true }))
vi.mock('@/lib/ai/tools', () => ({
  createTools: () => ({ delete_action: { description: 'stub', inputSchema: { safeParse: (v: unknown) => ({ success: true, data: v }) }, execute: executeSpy } }),
}))

import { POST } from '@/app/api/internal/chat/tool/route'
import { mintChatRunToken, CHAT_RUN_SECRET_HEADER, CHAT_RUN_TOKEN_HEADER } from '@/lib/chat/chat-run-token'
import { resetRepeatBreaker } from '@/lib/chat/tool-repeat-breaker'
import { resetTurnTools } from '@/lib/safety/turn-tools'

const relayed = () => {
  const token = mintChatRunToken({ conversationId: 'conv-1', workspaceId: 'ws-1', userId: 'user-1', teammateId: 'bot-1', relay: 'relay-1' })
  return new Request('http://localhost/api/internal/chat/tool', {
    method: 'POST',
    headers: { 'content-type': 'application/json', [CHAT_RUN_SECRET_HEADER]: SECRET, [CHAT_RUN_TOKEN_HEADER]: token },
    body: JSON.stringify({ toolName: 'delete_action', input: { action_id: 'GEN-1' }, turnId: 'turn-1', sessionId: 'sess-1' }),
  })
}

beforeEach(() => {
  process.env.CHAT_INTERNAL_SECRET = SECRET
  jev.decide.mockReset().mockResolvedValue({ status: 'accepted', inferenceId: 'inf-b', value: { allow: false, probability: 0.1 } })
  approvals.create.mockClear()
  executeSpy.mockClear()
  resetRepeatBreaker()
  resetTurnTools()
  vi.spyOn(console, 'info').mockImplementation(() => {})
})
afterEach(() => {
  delete process.env.CHAT_INTERNAL_SECRET
  vi.unstubAllEnvs()
})

describe('chat tool route, a relayed turn and the reviewer modes', () => {
  it('the default: a relayed call stays shadow, as on PROD (it runs, no card)', async () => {
    const res = await POST(relayed())
    expect(res.status).toBe(200)
    expect(executeSpy).toHaveBeenCalledTimes(1)
    expect(approvals.create).not.toHaveBeenCalled()
  })

  it('blocking: the relayed call is held and never runs', async () => {
    vi.stubEnv('ACTION_REVIEW_MODE', 'blocking')
    const res = await POST(relayed())
    expect((await res.json()).output).toMatchObject({ code: 'APPROVAL_REQUIRED' })
    expect(executeSpy).not.toHaveBeenCalled()
  })
})
