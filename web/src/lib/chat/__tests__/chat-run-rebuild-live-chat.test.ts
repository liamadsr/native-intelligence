/**
 * A turn in a capture's live conversation (one-chat plan, Slice 3: the person
 * talking to the call's live agent in its own chat, components/live-chat,
 * which sends systemContext.liveCaptureId).
 *
 * Pinned (audit fix a): the live agent acts for the person, so the prompt
 * builder (profile facts included) runs as for any chat, but the person's
 * agent log and the main chat's recent exchange are the main agent's: never
 * read or carried on a live turn. And only a live turn advertises the
 * note-taker's line (tell_note_taker): the main chat's agent, even during a
 * call, never sees it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const state = vi.hoisted(() => ({
  buildRecentSection: vi.fn(async (..._args: unknown[]): Promise<unknown> => null),
  buildLogSection: vi.fn(async (..._args: unknown[]): Promise<unknown> => null),
  buildChatSystemPrompt: vi.fn(async (..._args: unknown[]) => ({
    stable: [
      { key: 'base', markdown: 'SYSTEM_PROMPT' },
      { key: 'profile', markdown: 'PROFILE_FACTS' },
    ],
    turnContext: [{ key: 'time', markdown: 'Current date and time: CLOCK' }],
    turnContextHeld: [],
    activeSkillSlug: null,
    agentToolCeiling: null,
    agentEnabledCategories: [],
    agentDisabledTools: [],
    teammateChat: null,
  })),
}))

vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({ marker: 'service' }) }))
vi.mock('@/lib/ai/chat-system-prompt', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/chat-system-prompt')>()),
  buildChatSystemPrompt: state.buildChatSystemPrompt,
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
const liveGate = vi.hoisted(() => ({ live: true, calls: [] as unknown[] }))
vi.mock('@/lib/live-agent/live-turn-gate', () => ({
  isLiveCallTurn: async (_s: unknown, input: unknown) => {
    liveGate.calls.push(input)
    return liveGate.live
  },
}))
vi.mock('../recent-section', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../recent-section')>()),
  buildRecentSection: state.buildRecentSection,
}))

import { rebuildChatSpec } from '../chat-run-rebuild'
import type { ChatRunTokenClaims } from '../chat-run-token'

const claims = (over: Partial<ChatRunTokenClaims> = {}): ChatRunTokenClaims => ({
  conversationId: 'conv-live',
  workspaceId: 'ws-1',
  userId: 'user-1',
  exp: Date.now() + 60_000,
  ...over,
})
const SPLIT = { splitTurnContext: true }
const LIVE = { systemContext: { liveCaptureId: 'cap-1' } }

describe('rebuildChatSpec — a live conversation’s turn', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    liveGate.live = true
    liveGate.calls = []
    state.buildRecentSection.mockResolvedValue({ key: 'recent', markdown: 'Recent exchange: …' })
    state.buildLogSection.mockResolvedValue({ key: 'log', heading: 'Log', entries: [{ id: '1', line: 'x' }], markdown: 'Log\nx' })
  })

  it('reads and carries neither the log nor the recent exchange, but keeps the profile', async () => {
    const spec = await rebuildChatSpec(claims(), LIVE, SPLIT)
    expect(state.buildLogSection).not.toHaveBeenCalled()
    expect(state.buildRecentSection).not.toHaveBeenCalled()
    expect(spec.turnContext?.map((s) => s.key)).toEqual(['time'])
    expect(spec.systemPrompt).toContain('PROFILE_FACTS')
  })

  it('the main chat’s turn still carries both (control)', async () => {
    const spec = await rebuildChatSpec(claims({ conversationId: 'conv-home' }), { systemContext: { onCallCaptureId: 'cap-1' } }, SPLIT)
    expect(state.buildLogSection).toHaveBeenCalledTimes(1)
    expect(state.buildRecentSection).toHaveBeenCalledTimes(1)
    expect(spec.turnContext?.map((s) => s.key)).toEqual(['time', 'log', 'recent'])
  })

  it('asks the server with the TOKEN’s conversation, owner and workspace', async () => {
    await rebuildChatSpec(claims(), LIVE, SPLIT)
    expect(liveGate.calls).toEqual([{ conversationId: 'conv-live', captureId: 'cap-1', workspaceId: 'ws-1', userId: 'user-1' }])
    await rebuildChatSpec(claims({ conversationId: 'conv-home' }), { systemContext: { onCallCaptureId: 'cap-1' } }, SPLIT)
    expect(liveGate.calls).toHaveLength(1)
  })

  it('a liveCaptureId the server does not find live is an ordinary turn: log, recent, no note-taker line', async () => {
    liveGate.live = false
    const spec = await rebuildChatSpec(claims({ conversationId: 'conv-home' }), LIVE, SPLIT)
    expect(state.buildLogSection).toHaveBeenCalledTimes(1)
    expect(state.buildRecentSection).toHaveBeenCalledTimes(1)
    expect(spec.coreToolNames).not.toContain('tell_note_taker')
    expect(spec.ceilingTools.map((t) => t.name)).not.toContain('tell_note_taker')
  })

  it('advertises tell_note_taker on a live turn only', async () => {
    const live = await rebuildChatSpec(claims(), LIVE, SPLIT)
    const main = await rebuildChatSpec(claims({ conversationId: 'conv-home' }), { systemContext: { onCallCaptureId: 'cap-1' } }, SPLIT)
    expect(live.ceilingTools.map((t) => t.name)).toContain('tell_note_taker')
    expect(live.coreToolNames).toContain('tell_note_taker')
    expect(main.ceilingTools.map((t) => t.name)).not.toContain('tell_note_taker')
    expect(main.coreToolNames).not.toContain('tell_note_taker')
  })
})
