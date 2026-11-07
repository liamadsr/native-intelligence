/**
 * A turn on the person's own ChatGPT plan (the free tier,
 * docs/plans/chatgpt-free-tier.md §4). Pinned: the spec's usage check opts in
 * (never on the device); a person the check puts on their plan, active or out
 * of credits, gets `chatgptPlan` and OpenAI's slug for Sol, with Think
 * thinking harder, no Gateway attribution and an identity line that names the
 * plan; everyone else's spec is unchanged.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const state = vi.hoisted(() => ({
  usageRow: { allowed: true, is_paid_plan: true } as Record<string, unknown>,
  checkUsageLimits: vi.fn(),
  buildChatSystemPrompt: vi.fn(async (..._args: unknown[]) => ({
    stable: [{ key: 'base', markdown: 'SYSTEM_PROMPT' }],
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
vi.mock('@/lib/ai/auth', () => ({
  checkUsageLimits: (...args: unknown[]) => {
    state.checkUsageLimits(...args)
    return Promise.resolve(state.usageRow)
  },
}))
vi.mock('@/lib/log/log-section', () => ({ buildLogSection: vi.fn(async () => null) }))
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
vi.mock('@/lib/live-agent/live-turn-gate', () => ({ isLiveCallTurn: async () => false }))
vi.mock('../recent-section', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../recent-section')>()),
  buildRecentSection: vi.fn(async () => null),
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
/** A turn the rules route to Think: a long message. */
const THINK = { route: { excerpt: 'a long one', chars: 9000, attachmentKinds: [], codeFences: 0, listItems: 0 } }

describe('rebuildChatSpec — a turn on the ChatGPT plan', () => {
  beforeEach(() => {
    state.checkUsageLimits.mockClear()
    state.usageRow = { allowed: true, is_paid_plan: true, reason: 'within_limits' }
  })

  it('opts the usage check in to the plan, the device ask included', async () => {
    await rebuildChatSpec(claims(), {}, SPLIT)
    expect(state.checkUsageLimits).toHaveBeenCalledWith('user-1', undefined, { chatgptPlan: true })
    await rebuildChatSpec(claims({ surface: 'device_ask' }), {}, SPLIT).catch(() => null)
    expect(state.checkUsageLimits).toHaveBeenLastCalledWith('user-1', undefined, { chatgptPlan: true })
  })

  it('routes a person on their plan to Sol on the plan, with no Gateway attribution', async () => {
    for (const reason of ['chatgpt_plan', 'chatgpt_plan_exhausted']) {
      state.usageRow = { allowed: true, is_paid_plan: false, reason }
      const spec = await rebuildChatSpec(claims(), {}, SPLIT)
      expect(spec.chatgptPlan).toEqual({ model: 'gpt-6.1-sol', helperModel: 'gpt-6-luna', reasoning: 'low' })
      expect(spec.model).toBe('openai/gpt-6.1-sol')
      expect(spec.modelPolicy).toEqual({ contextWindowTokens: 1_050_000, reasoning: 'low' })
      expect(spec.gatewayTelemetry).toBeUndefined()
      expect(spec.modelRoute?.reasoning).toBe('low')
      expect(spec.systemPrompt.split('\n')[0]).toContain("Active model: GPT-6.1 Sol (`openai/gpt-6.1-sol`), on the person's own ChatGPT plan.")
      // Its helpers run the plan's model: no roster, no Gateway helper models.
      expect(spec.systemPrompt).not.toContain('## Models for helpers')
      expect(spec).not.toHaveProperty('helperModels')
    }
  })

  it('thinks harder on Think', async () => {
    state.usageRow = { allowed: true, is_paid_plan: false, reason: 'chatgpt_plan' }
    const spec = await rebuildChatSpec(claims(), THINK, SPLIT)
    expect(spec.modelRoute?.tier).toBe('think')
    expect(spec.chatgptPlan?.reasoning).toBe('medium')
    expect(spec.modelPolicy?.reasoning).toBe('medium')
    expect(spec.modelRoute?.reasoning).toBe('medium')
  })

  it('leaves everyone else on Haiku 5.5, with the helper roster', async () => {
    const spec = await rebuildChatSpec(claims(), {}, SPLIT)
    expect(spec).not.toHaveProperty('chatgptPlan')
    expect(spec.model).toBe('anthropic/claude-haiku-5.5')
    expect(spec.helperModels).toBeDefined()
    expect(spec.systemPrompt).not.toContain('ChatGPT plan')
  })
})
