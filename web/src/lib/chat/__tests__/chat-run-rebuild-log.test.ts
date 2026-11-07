/**
 * The chat spec's `log` section (A2b, src/lib/log/log-section.ts).
 *
 * Pinned: the main chat's split spec carries it, in TURN_CONTEXT_KEYS order,
 * read for the token's own (workspace, user) in the turn's zone, with its
 * lines and ids intact on the wire; a teammate chat, the device ask and the
 * unsplit (full-prompt) variant never read or carry it; a failed read leaves
 * it out without holding it (the log is append-only: no section means no new
 * lines, never a clear).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const logState = vi.hoisted(() => ({
  buildLogSection: vi.fn(async (..._args: unknown[]): Promise<unknown> => null),
}))

vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({ marker: 'service' }) }))
// The chat's environment (environment-section.ts) is read by user on
// every turn; the stub service client can't, so: none.
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
      { key: 'teammates', markdown: 'TEAMMATES' },
      { key: 'about', markdown: 'ABOUT' },
    ],
    turnContextHeld: [],
    activeSkillSlug: null,
    agentToolCeiling: null,
    agentEnabledCategories: [],
    agentDisabledTools: [],
    teammateChat: null,
  })),
}))
vi.mock('@/lib/mcp-client/adapter', () => ({
  CONFIRM_TOOL_NAME: 'mcp_confirm_call',
  createExternalMcpTools: vi.fn(async () => ({ tools: {}, meta: new Map(), servers: [] })),
}))
vi.mock('@/lib/ai/auth', () => ({ checkUsageLimits: vi.fn(async () => ({ allowed: true, is_paid_plan: true })) }))
vi.mock('@/lib/log/log-section', () => ({ buildLogSection: logState.buildLogSection }))
// The person's Now file (src/lib/now/now-section.ts): none here; chat-run-rebuild-now.test.ts pins it.
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
vi.mock('@/lib/chat/recent-section', () => ({ buildRecentSection: vi.fn(async () => null) }))

import { rebuildChatSpec } from '../chat-run-rebuild'
import type { ChatRunTokenClaims } from '../chat-run-token'

const claims = (over: Partial<ChatRunTokenClaims> = {}): ChatRunTokenClaims => ({
  conversationId: 'c',
  workspaceId: 'ws-1',
  userId: 'user-1',
  exp: Date.now() + 60_000,
  ...over,
})

const LOG = {
  key: 'log',
  heading: 'Log: …',
  entries: [
    { id: '41', line: '2026-10-14 09:00 Meeting processed: Acme kickoff' },
    { id: '42', line: '2026-10-14 10:30 Started: Reply drafts' },
  ],
  markdown: 'Log: …\n2026-10-14 09:00 Meeting processed: Acme kickoff\n2026-10-14 10:30 Started: Reply drafts',
}

const SPLIT = { splitTurnContext: true }

beforeEach(() => {
  vi.clearAllMocks()
  logState.buildLogSection.mockResolvedValue(LOG)
})

describe('rebuildChatSpec — the log section', () => {
  it("rides the main chat's split spec, in key order, read for the token's own workspace and user in the turn's zone", async () => {
    const spec = await rebuildChatSpec(claims(), { systemContext: { timeZone: 'America/New_York' } as never }, SPLIT)
    expect(logState.buildLogSection).toHaveBeenCalledTimes(1)
    expect(logState.buildLogSection).toHaveBeenCalledWith({ marker: 'service' }, { workspaceId: 'ws-1', userId: 'user-1', timeZone: 'America/New_York' })
    expect(spec.turnContext?.map((s) => s.key)).toEqual(['time', 'teammates', 'log', 'about'])
    // Its lines and ids reach the agent intact.
    expect(JSON.parse(JSON.stringify(spec)).turnContext[2]).toEqual(LOG)
    // Never in the stable prompt.
    expect(spec.systemPrompt).not.toContain('Meeting processed')
  })

  it('reads in UTC when the turn carries no real zone', async () => {
    await rebuildChatSpec(claims(), { systemContext: { timeZone: 'Mars/Olympus' } as never }, SPLIT)
    expect(logState.buildLogSection).toHaveBeenCalledWith(expect.anything(), { workspaceId: 'ws-1', userId: 'user-1', timeZone: null })
  })

  it('is never read or carried for a teammate chat, the device ask, or the full-prompt variant', async () => {
    const teammate = await rebuildChatSpec(claims({ teammateId: 'tm-1' }), {}, SPLIT)
    const device = await rebuildChatSpec(claims({ surface: 'device_ask' } as Partial<ChatRunTokenClaims>), {}, SPLIT)
    const full = await rebuildChatSpec(claims(), {})
    expect(logState.buildLogSection).not.toHaveBeenCalled()
    expect(teammate.turnContext?.some((s) => s.key === 'log')).toBe(false)
    expect(device.turnContext?.some((s) => s.key === 'log')).toBe(false)
    expect(full.turnContext).toBeUndefined()
    expect(full.systemPrompt).not.toContain('Meeting processed')
  })

  it('a failed read leaves it out and holds nothing (no lines is never a clear)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    logState.buildLogSection.mockRejectedValueOnce(new Error('agent_log read failed: boom'))
    const spec = await rebuildChatSpec(claims(), {}, SPLIT)
    expect(spec.turnContext?.map((s) => s.key)).toEqual(['time', 'teammates', 'about'])
    expect(spec).not.toHaveProperty('turnContextHeld')
    expect(warn).toHaveBeenCalledWith('[chat-spec] log section skipped:', 'agent_log read failed: boom')
    warn.mockRestore()
  })

  it('an empty log adds nothing', async () => {
    logState.buildLogSection.mockResolvedValueOnce(null)
    const spec = await rebuildChatSpec(claims(), {}, SPLIT)
    expect(spec.turnContext?.map((s) => s.key)).toEqual(['time', 'teammates', 'about'])
  })
})
