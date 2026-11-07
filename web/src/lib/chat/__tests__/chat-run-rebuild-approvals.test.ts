/**
 * How each held call ended, in the chat spec (GEN-1172,
 * src/lib/safety/approval-results.ts).
 *
 * Pinned: the split spec reads the outcomes for the token's own conversation
 * and person, and carries one `approval-…` section per call ranked at
 * `approvals` in TURN_CONTEXT_KEYS order (after `asks`, before
 * `suggestions`), in the order read. A teammate chat carries them too (its
 * held calls are its own); the device ask and the full-prompt variant never
 * read them, and a failed read leaves them out without holding anything.
 * get_tool_approval_result rides up front wherever mcp_confirm_call does, or
 * an outcome is carried; never past the ceiling.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const state = vi.hoisted(() => ({
  buildApprovalOutcomeSections: vi.fn(async (..._args: unknown[]): Promise<Array<{ key: string; markdown: string }>> => []),
  externalTools: {} as Record<string, unknown>,
  agentToolCeiling: null as Set<string> | null,
}))

vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({ marker: 'service' }) }))
vi.mock('../environment-section', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../environment-section')>()),
  buildEnvironmentSection: vi.fn(async () => ({ section: null, folderCount: 0, kind: null })),
}))
vi.mock('@/lib/ai/chat-system-prompt', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/chat-system-prompt')>()),
  buildChatSystemPrompt: vi.fn(async () => ({
    stable: [{ key: 'base', markdown: 'SYSTEM_PROMPT' }],
    turnContext: [
      { key: 'time', markdown: 'Current date and time: CLOCK' },
      { key: 'asks', markdown: 'ASKS' },
      { key: 'suggestions', markdown: 'SUGGESTIONS' },
    ],
    turnContextHeld: [],
    activeSkillSlug: null,
    agentToolCeiling: state.agentToolCeiling,
    agentEnabledCategories: [],
    agentDisabledTools: [],
    teammateChat: null,
  })),
}))
vi.mock('@/lib/mcp-client/adapter', () => ({
  CONFIRM_TOOL_NAME: 'mcp_confirm_call',
  createExternalMcpTools: vi.fn(async () => ({ tools: state.externalTools, meta: new Map(), servers: [] })),
}))
vi.mock('@/lib/ai/auth', () => ({ checkUsageLimits: vi.fn(async () => ({ allowed: true, is_paid_plan: true })) }))
vi.mock('@/lib/log/log-section', () => ({ buildLogSection: vi.fn(async () => null) }))
vi.mock('../recent-section', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../recent-section')>()),
  buildRecentSection: vi.fn(async () => null),
}))
vi.mock('@/lib/agent-events/away-section', () => ({ buildAwaySection: vi.fn(async () => null) }))
// The person's Now file (docs/plans/now-file.md): none, so nothing is held for it.
vi.mock('@/lib/now/now-section', () => ({ NOW_SECTION_KEY: 'now', nowForChatSpec: vi.fn(async () => ({ section: null, held: false })) }))
// Getting started (src/lib/onboarding/getting-started.ts): none here; chat-run-rebuild-getting-started.test.ts pins it.
vi.mock('@/lib/onboarding/getting-started', () => ({
  GETTING_STARTED_SECTION_KEY: 'getting-started',
  FINISH_GETTING_STARTED_TOOL: 'finish_getting_started',
  gettingStartedForChatSpec: vi.fn(async () => ({ section: null, held: false })),
}))
// Setup by text (src/lib/onboarding/text-setup.ts): none here.
vi.mock('@/lib/onboarding/text-setup', () => ({
  TEXT_SETUP_SECTION_KEY: 'text-setup',
  TEXT_SETUP_TOOLS: ['connect_link', 'save_business_profile', 'research_my_company'],
  textSetupForChatSpec: vi.fn(async () => ({ section: null, held: false })),
}))
// A connected website (src/lib/website/section.ts): none here.
vi.mock('@/lib/website/section', () => ({
  WEBSITE_SECTION_KEY: 'website',
  websiteForChatSpec: vi.fn(async () => ({ section: null, held: false })),
}))
vi.mock('@/lib/agent-events/member-time-zone', () => ({
  saveMemberTimeZone: vi.fn(async () => true),
  readMemberTimeZone: vi.fn(async () => ({ timeZone: 'UTC', source: 'utc' })),
}))
vi.mock('@/lib/safety/approval-results', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/safety/approval-results')>()),
  buildApprovalOutcomeSections: state.buildApprovalOutcomeSections,
}))

import { rebuildChatSpec } from '../chat-run-rebuild'
import type { ChatRunTokenClaims } from '../chat-run-token'

const claims = (over: Partial<ChatRunTokenClaims> = {}): ChatRunTokenClaims => ({
  conversationId: 'conv-1',
  workspaceId: 'ws-1',
  userId: 'user-1',
  exp: Date.now() + 60_000,
  ...over,
})
const SPLIT = { splitTurnContext: true }
const RAN = { key: 'approval-0b9c1d2e3f40', markdown: '## Approved call finished: `mcp__supabase__execute_sql`' }
const DECLINED = { key: 'approval-1a2b3c4d5e6f', markdown: '## Held call declined: `mcp__linear__create_issue`' }

describe('rebuildChatSpec — held calls’ outcomes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.buildApprovalOutcomeSections.mockResolvedValue([RAN, DECLINED])
    state.externalTools = {}
    state.agentToolCeiling = null
  })

  it("rides the split spec at `approvals`, one section per call in the order read, for the token's own conversation and person", async () => {
    const spec = await rebuildChatSpec(claims(), { systemContext: {} as never }, SPLIT)
    // The test's service client reads no home thread, so it is not one: only this conversation's own calls.
    expect(state.buildApprovalOutcomeSections).toHaveBeenCalledWith({ marker: 'service' }, { conversationId: 'conv-1', workspaceId: 'ws-1', userId: 'user-1', homeThread: false })
    expect(spec.turnContext?.map((s) => s.key)).toEqual(['time', 'asks', RAN.key, DECLINED.key, 'suggestions'])
    expect(spec.systemPrompt).not.toContain('Approved call finished')
  })

  it('a teammate chat carries its own; the device ask and the full-prompt variant never read them', async () => {
    const teammate = await rebuildChatSpec(claims({ teammateId: 'tm-1' }), {}, SPLIT)
    expect(teammate.turnContext?.some((s) => s.key === RAN.key)).toBe(true)
    state.buildApprovalOutcomeSections.mockClear()
    const device = await rebuildChatSpec(claims({ surface: 'device_ask' } as Partial<ChatRunTokenClaims>), {}, SPLIT)
    const full = await rebuildChatSpec(claims(), {})
    expect(state.buildApprovalOutcomeSections).not.toHaveBeenCalled()
    expect(device.turnContext?.some((s) => s.key.startsWith('approval-'))).toBe(false)
    expect(full.turnContext).toBeUndefined()
  })

  it("a check-in (its own session, the Now file's) never reads them: the person's chat and the approval turn carry them", async () => {
    const spec = await rebuildChatSpec(claims({ server: 'home_turn', homeTurnReason: 'check_in' }), { systemContext: {} as never }, SPLIT)
    expect(state.buildApprovalOutcomeSections).not.toHaveBeenCalled()
    expect(spec.turnContext?.some((s) => s.key.startsWith('approval-'))).toBe(false)
  })

  it('a failed read leaves them out and holds nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    state.buildApprovalOutcomeSections.mockRejectedValueOnce(new Error('tool_approval down'))
    const spec = await rebuildChatSpec(claims(), { systemContext: {} as never }, SPLIT)
    expect(spec.turnContext?.map((s) => s.key)).toEqual(['time', 'asks', 'suggestions'])
    expect(spec).not.toHaveProperty('turnContextHeld')
    expect(warn).toHaveBeenCalledWith('[chat-spec] approval outcomes skipped:', 'tool_approval down')
    warn.mockRestore()
  })

  it('get_tool_approval_result rides up front with mcp_confirm_call, or with an outcome', async () => {
    state.buildApprovalOutcomeSections.mockResolvedValue([])
    const none = await rebuildChatSpec(claims(), { systemContext: {} as never }, SPLIT)
    expect(none.coreToolNames).not.toContain('get_tool_approval_result')

    state.externalTools = { mcp_confirm_call: {} }
    const gated = await rebuildChatSpec(claims(), { systemContext: {} as never }, SPLIT)
    expect(gated.coreToolNames).toEqual(expect.arrayContaining(['mcp_confirm_call', 'get_tool_approval_result']))

    state.externalTools = {}
    state.buildApprovalOutcomeSections.mockResolvedValue([RAN])
    const outcome = await rebuildChatSpec(claims(), { systemContext: {} as never }, SPLIT)
    expect(outcome.coreToolNames).toContain('get_tool_approval_result')
  })
})
