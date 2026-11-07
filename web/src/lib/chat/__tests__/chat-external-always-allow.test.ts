/**
 * The chat door's held connected-app call (loadChatExternalTools): the card
 * offers Always allow with the server and the tool's own name, unless the
 * tool always asks (a catalog app's publish/schedule tool), or the call is
 * not the person's own chat (an unattended run, a job on their Mac).
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
const approvals = vi.hoisted(() => ({ create: vi.fn(async (_supabase: unknown, _approval: Record<string, unknown>) => ({ ok: true as const, approvalId: 'appr-1', cardId: 'card-1' })) }))
vi.mock('@/lib/safety/approvals', async (orig) => ({ ...(await orig<typeof import('@/lib/safety/approvals')>()), createToolApproval: approvals.create }))
const adapter = vi.hoisted(() => ({ options: null as null | { requestApproval?: (call: Record<string, unknown>) => Promise<unknown> } }))
vi.mock('@/lib/mcp-client/adapter', async (orig) => ({
  ...(await orig<typeof import('@/lib/mcp-client/adapter')>()),
  createExternalMcpTools: async (_userId: string, _supabase: unknown, options: typeof adapter.options) => {
    adapter.options = options
    return { tools: {}, meta: new Map(), servers: [] }
  },
}))

import { loadChatExternalTools, type ToolDispatchContext } from '@/lib/chat/chat-tool-dispatch'

const ctx = { userId: 'user-1', workspaceId: 'ws-1', supabase: {}, conversationId: 'conv-1', caller: 'person', approvalContext: { agentId: 'agent-1' } } as unknown as ToolDispatchContext

async function hold(alwaysAsks: boolean, over: Partial<ToolDispatchContext> = {}) {
  approvals.create.mockClear()
  await loadChatExternalTools({ ...ctx, ...over } as ToolDispatchContext, {})
  await adapter.options!.requestApproval!({
    toolName: 'mcp__linear__create_issue',
    serverName: 'Linear',
    args: { title: 'Bug' },
    serverId: 'srv-1',
    remoteTool: 'create_issue',
    alwaysAsks,
    runAgain: false,
  })
  return approvals.create.mock.calls[0][1]
}

describe('the chat door’s held connected-app call', () => {
  it('offers Always allow with the server and the tool’s own name', async () => {
    const approval = await hold(false)
    expect(approval).toMatchObject({ door: 'chat', toolName: 'mcp__linear__create_issue', alwaysAllow: { serverId: 'srv-1', tool: 'create_issue' } })
  })

  it('offers none for a tool that always asks', async () => {
    expect(await hold(true)).not.toHaveProperty('alwaysAllow')
  })

  it('offers none outside the person’s own chat: an unattended run, or a job on their Mac', async () => {
    expect(await hold(false, { caller: 'agent_unattended' } as never)).not.toHaveProperty('alwaysAllow')
    expect(await hold(false, { approvalContext: { localAgent: { jobId: 'job-1' } } } as never)).not.toHaveProperty('alwaysAllow')
  })
})
