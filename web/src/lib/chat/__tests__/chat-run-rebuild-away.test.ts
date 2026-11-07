/**
 * The `away` turn-context section in the chat spec (A6 slice 2,
 * src/lib/agent-events/away-section.ts) and the member.time_zone save.
 *
 * Pinned: the main chat's split spec asks for it for the token's own
 * conversation with the turn's checked zone and carries it right after
 * `recent` in TURN_CONTEXT_KEYS order; a teammate chat, the device ask and the
 * full-prompt variant never read or carry it; a failed read leaves it out
 * without holding it. The checked zone is saved off the turn's path (never
 * for the device ask, never an unchecked one). A turn with no browser zone (a
 * server-written home turn) is in the person's stored zone: its clock, its
 * log and the zone the tools are told, never saved back; UTC only when none
 * is known.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const state = vi.hoisted(() => ({
  buildRecentSection: vi.fn(async (..._args: unknown[]): Promise<unknown> => null),
  buildLogSection: vi.fn(async (..._args: unknown[]): Promise<unknown> => null),
  buildAwaySection: vi.fn(async (..._args: unknown[]): Promise<unknown> => null),
  saveMemberTimeZone: vi.fn(async (..._args: unknown[]) => true),
  readMemberTimeZone: vi.fn(async (..._args: unknown[]): Promise<{ timeZone: string; source: string }> => ({ timeZone: 'UTC', source: 'utc' })),
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
vi.mock('@/lib/log/log-section', () => ({ buildLogSection: state.buildLogSection }))
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
vi.mock('../recent-section', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../recent-section')>()),
  buildRecentSection: state.buildRecentSection,
}))
vi.mock('@/lib/agent-events/away-section', () => ({ buildAwaySection: state.buildAwaySection }))
vi.mock('@/lib/agent-events/member-time-zone', () => ({ saveMemberTimeZone: state.saveMemberTimeZone, readMemberTimeZone: state.readMemberTimeZone }))

import { buildChatSystemPrompt } from '@/lib/ai/chat-system-prompt'
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
const RECENT = { key: 'recent', markdown: 'Recent exchange: …' }
const LOG = { key: 'log', heading: 'Log', entries: [{ id: '1', line: 'x' }], markdown: 'Log\nx' }
const AWAY = { key: 'away', markdown: 'While you were away: …' }

describe('rebuildChatSpec — the away section', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.buildRecentSection.mockResolvedValue(RECENT)
    state.buildLogSection.mockResolvedValue(LOG)
    state.buildAwaySection.mockResolvedValue(AWAY)
    state.readMemberTimeZone.mockResolvedValue({ timeZone: 'UTC', source: 'utc' })
  })

  it("rides the main chat's split spec right after recent, read for the token's own conversation with the checked zone", async () => {
    const spec = await rebuildChatSpec(claims(), { systemContext: { timeZone: 'Europe/London' } as never }, SPLIT)
    expect(state.buildAwaySection).toHaveBeenCalledWith(
      { marker: 'service' },
      { conversationId: 'conv-1', workspaceId: 'ws-1', userId: 'user-1', timeZone: 'Europe/London' },
    )
    expect(spec.turnContext?.map((s) => s.key)).toEqual(['time', 'log', 'recent', 'away', 'about'])
    expect(spec.systemPrompt).not.toContain('While you were away')
  })

  it('is never read or carried for a teammate chat, the device ask, or the full-prompt variant', async () => {
    const teammate = await rebuildChatSpec(claims({ teammateId: 'tm-1' }), {}, SPLIT)
    const device = await rebuildChatSpec(claims({ surface: 'device_ask' } as Partial<ChatRunTokenClaims>), {}, SPLIT)
    const full = await rebuildChatSpec(claims(), {})
    expect(state.buildAwaySection).not.toHaveBeenCalled()
    expect(teammate.turnContext?.some((s) => s.key === 'away')).toBe(false)
    expect(device.turnContext?.some((s) => s.key === 'away')).toBe(false)
    expect(full.turnContext).toBeUndefined()
  })

  it('a server-written turn (a helper report, the digest) or a turn with no person behind it never builds it (never marks rows delivered)', async () => {
    const homeTurn = await rebuildChatSpec(claims({ server: 'home_turn' } as Partial<ChatRunTokenClaims>), { systemContext: { timeZone: 'Europe/London' } as never }, SPLIT)
    const noPerson = await rebuildChatSpec(claims(), {}, SPLIT)
    expect(state.buildAwaySection).not.toHaveBeenCalled()
    expect(homeTurn.turnContext?.some((s) => s.key === 'away')).toBe(false)
    expect(noPerson.turnContext?.some((s) => s.key === 'away')).toBe(false)
    // The person's next turn still gets it.
    await rebuildChatSpec(claims(), { systemContext: { timeZone: 'Europe/London' } as never }, SPLIT)
    expect(state.buildAwaySection).toHaveBeenCalledOnce()
  })

  it('a failed read leaves it out and holds nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    state.buildAwaySection.mockRejectedValueOnce(new Error('agent_event read failed: boom'))
    const spec = await rebuildChatSpec(claims(), { systemContext: {} as never }, SPLIT)
    expect(spec.turnContext?.map((s) => s.key)).toEqual(['time', 'log', 'recent', 'about'])
    expect(spec).not.toHaveProperty('turnContextHeld')
    expect(warn).toHaveBeenCalledWith('[chat-spec] away section skipped:', 'agent_event read failed: boom')
    warn.mockRestore()
  })

  it("saves the turn's checked zone on the member row, never an unchecked one or the device's", async () => {
    await rebuildChatSpec(claims(), { systemContext: { timeZone: 'America/Toronto' } as never }, SPLIT)
    expect(state.saveMemberTimeZone).toHaveBeenCalledWith({ marker: 'service' }, { workspaceId: 'ws-1', userId: 'user-1', timeZone: 'America/Toronto' })
    state.saveMemberTimeZone.mockClear()
    await rebuildChatSpec(claims(), { systemContext: { timeZone: 'Not/AZone' } as never }, SPLIT)
    await rebuildChatSpec(claims({ surface: 'device_ask' } as Partial<ChatRunTokenClaims>), { systemContext: { timeZone: 'America/Toronto' } as never }, SPLIT)
    expect(state.saveMemberTimeZone).not.toHaveBeenCalled()
  })

  it("a server-written turn (no browser zone) is in the person's stored zone: clock, log and tools; never saved back", async () => {
    state.readMemberTimeZone.mockResolvedValue({ timeZone: 'America/New_York', source: 'member' })
    const spec = await rebuildChatSpec(claims({ server: 'home_turn' } as Partial<ChatRunTokenClaims>), {}, SPLIT)
    expect(state.readMemberTimeZone).toHaveBeenCalledWith({ marker: 'service' }, { workspaceId: 'ws-1', userId: 'user-1' })
    const promptInput = vi.mocked(buildChatSystemPrompt).mock.calls.at(-1)![0]
    expect(await promptInput.timeZone).toBe('America/New_York')
    expect(state.buildLogSection).toHaveBeenCalledWith({ marker: 'service' }, { workspaceId: 'ws-1', userId: 'user-1', timeZone: 'America/New_York' })
    expect(spec.timeZone).toBe('America/New_York')
    expect(state.saveMemberTimeZone).not.toHaveBeenCalled()
  })

  it('no zone known at all: UTC (no zone forwarded); a browser zone is never looked up', async () => {
    const none = await rebuildChatSpec(claims({ server: 'home_turn' } as Partial<ChatRunTokenClaims>), {}, SPLIT)
    expect(none).not.toHaveProperty('timeZone')
    expect(await vi.mocked(buildChatSystemPrompt).mock.calls.at(-1)![0].timeZone).toBeNull()
    state.readMemberTimeZone.mockClear()
    const browser = await rebuildChatSpec(claims(), { systemContext: { timeZone: 'Europe/London' } as never }, SPLIT)
    expect(state.readMemberTimeZone).not.toHaveBeenCalled()
    expect(browser.timeZone).toBe('Europe/London')
  })
})
