/**
 * GEN-1172: the chat door's held connected-app call (loadChatExternalTools)
 * raises no second card for the same call already approved in this
 * conversation lately: it answers with that run (recentApprovedRun, keyed by
 * the conversation the card would land in, the tool and the inputs' hash).
 * The person asking to run it again holds it as before.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
const approvals = vi.hoisted(() => ({ create: vi.fn(async (_supabase: unknown, _approval: Record<string, unknown>) => ({ ok: true as const, approvalId: 'appr-new', cardId: 'card-1' })) }))
vi.mock('@/lib/safety/approvals', async (orig) => ({ ...(await orig<typeof import('@/lib/safety/approvals')>()), createToolApproval: approvals.create }))
const results = vi.hoisted(() => ({ recent: vi.fn(async (..._args: unknown[]): Promise<unknown> => null) }))
vi.mock('@/lib/safety/approval-results', async (orig) => ({ ...(await orig<typeof import('@/lib/safety/approval-results')>()), recentApprovedRun: results.recent }))
const adapter = vi.hoisted(() => ({ options: null as null | { requestApproval?: (call: Record<string, unknown>) => Promise<unknown> } }))
vi.mock('@/lib/mcp-client/adapter', async (orig) => ({
  ...(await orig<typeof import('@/lib/mcp-client/adapter')>()),
  createExternalMcpTools: async (_userId: string, _supabase: unknown, options: typeof adapter.options) => {
    adapter.options = options
    return { tools: {}, meta: new Map(), servers: [] }
  },
}))

import { loadChatExternalTools, type ToolDispatchContext } from '@/lib/chat/chat-tool-dispatch'
import { inputHash } from '@/lib/safety/approvals'

const supabase = { marker: 'db' }
const ctx = { userId: 'user-1', workspaceId: 'ws-1', supabase, conversationId: 'conv-1', caller: 'person', approvalContext: {} } as unknown as ToolDispatchContext
const RAN = { id: 'appr-old', tool: 'mcp__supabase__execute_sql', status: 'approved', executed_at: '2026-10-27T11:00:01Z', result: { success: true, content: [] } }

async function hold(runAgain: boolean, over: Partial<ToolDispatchContext> = {}) {
  await loadChatExternalTools({ ...ctx, ...over } as ToolDispatchContext, {})
  return adapter.options!.requestApproval!({
    toolName: 'mcp__supabase__execute_sql',
    serverName: 'Supabase',
    args: { query: 'select 1' },
    serverId: 'srv-1',
    remoteTool: 'execute_sql',
    alwaysAsks: false,
    runAgain,
  })
}

describe('the chat door’s held call that already ran', () => {
  beforeEach(() => {
    approvals.create.mockClear()
    results.recent.mockReset()
    results.recent.mockResolvedValue(null)
  })

  it('answers with the earlier run and raises no card', async () => {
    results.recent.mockResolvedValue(RAN)
    expect(await hold(false)).toEqual({ ok: true, approvalId: 'appr-old', alreadyRan: RAN })
    expect(results.recent).toHaveBeenCalledWith(supabase, {
      userId: 'user-1',
      workspaceId: 'ws-1',
      conversationId: 'conv-1',
      tool: 'mcp__supabase__execute_sql',
      inputHash: inputHash({ query: 'select 1' }),
    })
    expect(approvals.create).not.toHaveBeenCalled()
  })

  it('looks where the card would land (the home thread for a Mac job)', async () => {
    await hold(false, { cardConversationId: 'home-1' } as never)
    expect(results.recent).toHaveBeenCalledWith(supabase, expect.objectContaining({ conversationId: 'home-1' }))
    expect(approvals.create.mock.calls[0][1]).toMatchObject({ conversationId: 'home-1' })
  })

  it('none ran: the card is raised as before', async () => {
    expect(await hold(false)).toMatchObject({ ok: true, approvalId: 'appr-new' })
    expect(approvals.create).toHaveBeenCalledOnce()
  })

  it('the person asked to run it again: it is held without looking', async () => {
    results.recent.mockResolvedValue(RAN)
    expect(await hold(true)).toMatchObject({ ok: true, approvalId: 'appr-new' })
    expect(results.recent).not.toHaveBeenCalled()
    expect(approvals.create).toHaveBeenCalledOnce()
  })
})
