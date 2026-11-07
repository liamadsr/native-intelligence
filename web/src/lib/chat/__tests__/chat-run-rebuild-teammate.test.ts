/**
 * rebuildChatSpec for a TEAMMATE-chat token (bots v2, Phase 1, decision 3).
 *
 * Pins the ADVERTISE half of the teammate ceiling:
 *   1. the token's teammateId reaches buildChatSystemPrompt (persona + memory);
 *   2. the user's external MCP tools are never loaded or advertised;
 *   3. the ceiling is the teammate rule — a {read} system teammate is offered
 *      no write (core board writes included), a {read, internal-write} role
 *      teammate can draft — never ask_user / start_helper, always search_tools;
 *   4. the upfront core set stays inside it;
 *   5. a teammate that is gone (null bounds) is offered nothing.
 * The enforce half (the tool route) is pinned in
 * src/app/api/internal/chat/tool/__tests__/route.teammate.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ALL_TOOL_NAMES, getToolDefinition } from '@/lib/ai/tool-registry'
import type { TeammateChatBounds } from '../chat-ceiling'

const boundsState: { value: TeammateChatBounds | null } = { value: null }
/** Names added to the teammate's ceiling, to prove a rule holds even if a grant ever reached it. */
const ceilingExtra: { names: string[] } = { names: [] }
vi.mock('../chat-ceiling', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../chat-ceiling')>()
  return {
    ...actual,
    resolveTeammateChatCeiling: async (...args: Parameters<typeof actual.resolveTeammateChatCeiling>) =>
      new Set([...(await actual.resolveTeammateChatCeiling(...args)), ...ceilingExtra.names]),
  }
})

vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({}) }))
vi.mock('@/lib/ai/chat-system-prompt', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/chat-system-prompt')>()),
  buildChatSystemPrompt: vi.fn(async (input: { teammateId?: string }) => ({
    stable: [{ key: 'base', markdown: 'SYSTEM_PROMPT' }],
    turnContext: [],
    turnContextHeld: [],
    activeSkillSlug: null,
    agentToolCeiling: null,
    agentEnabledCategories: [],
    agentDisabledTools: [],
    teammateChat: input.teammateId ? { bounds: boundsState.value } : null,
  })),
}))
vi.mock('@/lib/mcp-client/adapter', () => ({
  CONFIRM_TOOL_NAME: 'mcp_confirm_call',
  createExternalMcpTools: vi.fn(async () => ({
    tools: { mcp__linear__create_issue: { description: 'ext' }, mcp_confirm_call: { description: 'confirm' } },
    meta: new Map(),
    servers: [],
  })),
}))
vi.mock('@/lib/ai/auth', () => ({ checkUsageLimits: vi.fn(async () => ({ allowed: true, is_paid_plan: true })) }))

// A connected website (src/lib/website/section.ts): none here.
vi.mock('@/lib/website/section', () => ({
  WEBSITE_SECTION_KEY: 'website',
  websiteForChatSpec: vi.fn(async () => ({ section: null, held: false })),
}))
import { rebuildChatSpec } from '../chat-run-rebuild'
import { buildChatSystemPrompt } from '@/lib/ai/chat-system-prompt'
import { createExternalMcpTools } from '@/lib/mcp-client/adapter'
import type { ChatRunTokenClaims } from '../chat-run-token'

const claims = (over: Partial<ChatRunTokenClaims> = {}): ChatRunTokenClaims => ({
  conversationId: 'conv-tm',
  workspaceId: 'ws-2',
  userId: 'user-1',
  teammateId: 'tm-1',
  exp: Date.now() + 60_000,
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  boundsState.value = { allowed_side_effects: ['read'], tool_allowlist: null, agentConfig: null }
  ceilingExtra.names = []
})

describe('rebuildChatSpec — teammate chat', () => {
  it('hands the token’s teammate to the prompt builder and loads no external MCP tools', async () => {
    const spec = await rebuildChatSpec(claims(), {}, { includeSchemas: true })
    expect(buildChatSystemPrompt).toHaveBeenCalledWith(expect.objectContaining({ teammateId: 'tm-1', workspaceId: 'ws-2' }))
    expect(createExternalMcpTools).not.toHaveBeenCalled()
    const names = spec.ceilingTools.map((t) => t.name)
    expect(names.some((n) => n.startsWith('mcp'))).toBe(false)
  })

  it('a {read} system teammate is offered reads only — no core board write, no ask_user, no start_helper', async () => {
    const spec = await rebuildChatSpec(claims(), {})
    expect(spec.ceiling).not.toBeNull()
    const ceiling = new Set(spec.ceiling!)
    for (const name of ceiling) if (name !== 'search_tools') expect(getToolDefinition(name)?.sideEffect).toBe('read')
    for (const name of ['create_action', 'update_action', 'complete_action', 'ask_user', 'start_helper']) {
      expect(ceiling.has(name), name).toBe(false)
    }
    expect(ceiling.has('search_tools')).toBe(true)
    expect(ceiling.has('list_emails')).toBe(true)
    // The advertised surface IS the ceiling, and the upfront core stays inside it.
    expect(new Set(spec.ceilingTools.map((t) => t.name))).toEqual(ceiling)
    for (const name of spec.coreToolNames) expect(ceiling.has(name), name).toBe(true)
    expect(spec.coreToolNames).not.toContain('create_action')
  })

  it('a {read, internal-write} role teammate can draft', async () => {
    boundsState.value = { allowed_side_effects: ['read', 'internal-write'], tool_allowlist: null, agentConfig: null }
    const ceiling = new Set((await rebuildChatSpec(claims(), {})).ceiling!)
    expect(ceiling.has('create_document')).toBe(true)
    expect(ceiling.has('create_email_draft')).toBe(true)
    expect(ceiling.has('delete_action')).toBe(false)
  })

  it('a teammate that is gone is offered nothing at all', async () => {
    boundsState.value = null
    const spec = await rebuildChatSpec(claims(), {})
    expect(spec.ceiling).toEqual([])
    expect(spec.ceilingTools).toEqual([])
    expect(spec.coreToolNames).toEqual([])
  })

  it('never advertises remember up front in a teammate chat, even were it in the ceiling; the main chat always does', async () => {
    boundsState.value = { allowed_side_effects: ['read', 'internal-write'], tool_allowlist: null, agentConfig: null }
    ceilingExtra.names = ['remember']
    const teammate = await rebuildChatSpec(claims(), {})
    expect(teammate.coreToolNames).not.toContain('remember')
    const main = await rebuildChatSpec(claims({ teammateId: undefined }), {})
    expect(main.coreToolNames).toContain('remember')
  })

  it('an ordinary chat token still loads external tools and takes the ordinary rule', async () => {
    const spec = await rebuildChatSpec(claims({ teammateId: undefined }), {})
    expect(createExternalMcpTools).toHaveBeenCalled()
    expect(spec.ceilingTools.map((t) => t.name)).toContain('mcp__linear__create_issue')
    expect(buildChatSystemPrompt).toHaveBeenCalledWith(expect.not.objectContaining({ teammateId: expect.anything() }))
  })
})

// ── A bot conversation in the main chat (bots-v4 Phase C) ─────────────────────
// The token names the bot with `teammateIn: 'chat'`. Its turn takes the very
// same teammate path as the bot's thread: the bot's layer (the prompt builder
// gets the bot and where it is), its teammate ceiling over its own limits
// (decision 12), and none of the main chat's own reach.
describe('rebuildChatSpec — a bot conversation (teammateIn: chat)', () => {
  const botClaims = (over: Partial<ChatRunTokenClaims> = {}) => claims({ conversationId: 'conv-bot', workspaceId: 'ws-1', teammateIn: 'chat', ...over })
  const externalWrites = ALL_TOOL_NAMES.filter((name) => getToolDefinition(name)?.sideEffect === 'external-write')

  it('hands the prompt builder the bot and where it is, and loads no external MCP tool', async () => {
    const spec = await rebuildChatSpec(botClaims(), {}, { includeSchemas: true })
    expect(buildChatSystemPrompt).toHaveBeenCalledWith(expect.objectContaining({ teammateId: 'tm-1', teammateIn: 'chat', workspaceId: 'ws-1' }))
    expect(createExternalMcpTools).not.toHaveBeenCalled()
    expect(spec.ceilingTools.some((t) => t.name.startsWith('mcp'))).toBe(false)
  })

  it('a read-only bot can’t write there: reads only, and never start_helper, ask_user, external MCP or an outside write', async () => {
    const ceiling = new Set((await rebuildChatSpec(botClaims(), {})).ceiling!)
    for (const name of ceiling) if (name !== 'search_tools') expect(getToolDefinition(name)?.sideEffect, name).toBe('read')
    for (const name of ['create_action', 'update_action', 'create_document', 'start_helper', 'ask_user', 'mcp_confirm_call', ...externalWrites]) {
      expect(ceiling.has(name), name).toBe(false)
    }
  })

  it('one set to change Dial8 records can, but still never sends, delegates, asks or reaches external MCP', async () => {
    boundsState.value = { allowed_side_effects: ['read', 'internal-write'], tool_allowlist: null, agentConfig: null }
    const ceiling = new Set((await rebuildChatSpec(botClaims(), {})).ceiling!)
    expect(ceiling.has('create_document')).toBe(true)
    expect(ceiling.has('create_action')).toBe(true)
    expect(externalWrites.length).toBeGreaterThan(0)
    for (const name of ['start_helper', 'ask_user', 'mcp_confirm_call', 'delete_action', ...externalWrites]) {
      expect(ceiling.has(name), name).toBe(false)
    }
  })

  it('the bot’s own thread (no teammateIn) tells the builder nothing of the main chat', async () => {
    await rebuildChatSpec(claims(), {})
    expect(buildChatSystemPrompt).toHaveBeenCalledWith(expect.not.objectContaining({ teammateIn: expect.anything() }))
  })
})
