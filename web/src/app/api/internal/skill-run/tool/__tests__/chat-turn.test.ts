/**
 * Bots v3 Phase 4 — the enforce half of a follow-up chat turn's ceiling.
 *
 * A token with a `chat` claim is held to the fronting bot's attended chat
 * ceiling (resolveSkillRunChatCeiling, the call the spec rebuild advertises
 * from): a tool outside it is refused even when the RUN's own ceiling would
 * allow it, a bot that's gone refuses every call, and an allowed call runs as
 * the run-as user, attended (no unattended fencing), still in one workspace.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The run-token DB binding (src/lib/flows/skill-run-binding.ts) has its own
// tests; this file's fake database holds no member / skill rows.
vi.mock('@/lib/flows/skill-run-binding', () => ({ skillRunBindingRefusal: async () => null }))
import { ALL_CATEGORY_IDS } from '@/lib/ai/tool-registry'

const SECRET = 'test-internal-secret-abcdefghij'

const h = vi.hoisted(() => ({
  chatCeiling: new Set(['list_actions', 'search_tools']) as Set<string> | null,
  createToolsArgs: [] as unknown[][],
  execute: vi.fn(async () => ({ ok: true })),
}))

vi.mock('@/lib/admin', () => ({
  getServiceClient: () => {
    const c: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'or', 'limit']) c[m] = () => c
    // The skill's own ceiling is inherit-all (act + every category).
    c.maybeSingle = async () => ({ data: { agent_config: { enabled_tools: [...ALL_CATEGORY_IDS] } }, error: null })
    return { from: () => c }
  },
}))
vi.mock('@/lib/work/touch', () => ({ recordToolCallTouches: async () => {} }))
vi.mock('@/lib/flows/skill-run-chat-ceiling', () => ({
  resolveSkillRunChatCeiling: async () => h.chatCeiling,
}))
vi.mock('@/lib/ai/tools', () => ({
  createTools: (...args: unknown[]) => {
    h.createToolsArgs.push(args)
    const tool = { description: 't', inputSchema: { safeParse: (v: unknown) => ({ success: true, data: v }) }, execute: h.execute }
    return { list_actions: tool, create_action: tool }
  },
}))
vi.mock('@/lib/ai/tool-discovery', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/tool-discovery')>()
  return { ...actual, createSearchToolsTool: () => ({ description: 'search', execute: h.execute }) }
})

import { POST } from '@/app/api/internal/skill-run/tool/route'
import { mintRunToken, RUN_SKILL_SECRET_HEADER, RUN_SKILL_TOKEN_HEADER } from '@/lib/flows/skill-run-token'

const chatToken = () =>
  mintRunToken({
    workspaceId: 'ws-1',
    runAsUserId: 'user-1',
    skillId: 'skill-1',
    mode: 'act',
    hasCapture: false,
    outputContract: 'verdict',
    model: 'claude-haiku-4-5-20251001',
    workItemId: 'job-1',
    chat: { teammateId: 'tm-1' },
  })

const call = (toolName: string, input: Record<string, unknown> = {}) =>
  POST(
    new Request('http://localhost/api/internal/skill-run/tool', {
      method: 'POST',
      headers: { 'content-type': 'application/json', [RUN_SKILL_SECRET_HEADER]: SECRET, [RUN_SKILL_TOKEN_HEADER]: chatToken() },
      body: JSON.stringify({ toolName, input }),
    }),
  )

beforeEach(() => {
  process.env.RUN_SKILL_INTERNAL_SECRET = SECRET
  h.chatCeiling = new Set(['list_actions', 'search_tools'])
  h.createToolsArgs = []
  h.execute.mockClear()
})
afterEach(() => {
  delete process.env.RUN_SKILL_INTERNAL_SECRET
})

describe('POST /api/internal/skill-run/tool with a chat token', () => {
  it('runs a tool in the bot’s chat ceiling, attended, fenced to the workspace', async () => {
    const res = await call('list_actions')
    expect(res.status).toBe(200)
    expect(h.execute).toHaveBeenCalledOnce()
    const [userId, , workspaceId, , opts] = h.createToolsArgs[0]
    expect(userId).toBe('user-1')
    expect(workspaceId).toBe('ws-1')
    expect(opts).toMatchObject({ strictWorkspace: true })
    expect(opts).not.toHaveProperty('unattended')
    // The person is here: the actions it files keep the model's choice.
    expect(opts).not.toHaveProperty('actionRules')
  })

  it('keeps confirmed_with_user: the person is in this chat to have said yes', async () => {
    const res = await call('list_actions', { confirmed_with_user: true })
    expect(res.status).toBe(200)
    expect(h.execute).toHaveBeenCalledOnce()
  })

  it('refuses a tool the RUN could use but the bot may not in chat', async () => {
    const res = await call('create_action')
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe('TOOL_OUT_OF_CEILING')
    expect(h.execute).not.toHaveBeenCalled()
  })

  it('a bot that’s gone refuses every call', async () => {
    h.chatCeiling = null
    const res = await call('list_actions')
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe('TEAMMATE_UNAVAILABLE')
    expect(h.execute).not.toHaveBeenCalled()
  })
})
