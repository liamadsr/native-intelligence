/**
 * The model the person picked for their main agent (src/lib/ai/agent-model.ts,
 * roadmap #9), as each turn's spec applies it. Pinned:
 *  - a pick runs the thread on that model: its Gateway slug, its call, an
 *    identity line and a roster that name it, and a usage route that says so
 *    (`agent_model`); the helpers' models are unchanged;
 *  - on every surface of the person's own agent: a turn in the app (web,
 *    desktop, iPhone), a Slack or text message, a server turn, a relay;
 *  - Auto (nothing saved) is today's thread, byte for byte;
 *  - a premium pick needs a paid plan (Auto otherwise); an inexpensive one
 *    doesn't;
 *  - never on the person's ChatGPT plan (the plan's model), a device ask
 *    (its fixed model) or a teammate's chat (MAIN_MODEL), and those two
 *    never read the account.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const state = vi.hoisted(() => ({
  usageRow: { allowed: true, is_paid_plan: true } as Record<string, unknown>,
  saved: null as string | null,
  readSavedAgentModel: vi.fn(),
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
vi.mock('@/lib/ai/agent-model-store', () => ({
  readSavedAgentModel: (...args: unknown[]) => {
    state.readSavedAgentModel(...args)
    return Promise.resolve(state.saved)
  },
}))
vi.mock('@/lib/ai/chat-system-prompt', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/chat-system-prompt')>()),
  buildChatSystemPrompt: state.buildChatSystemPrompt,
}))
vi.mock('@/lib/mcp-client/adapter', () => ({
  CONFIRM_TOOL_NAME: 'mcp_confirm_call',
  createExternalMcpTools: vi.fn(async () => ({ tools: {}, meta: new Map(), servers: [] })),
}))
vi.mock('@/lib/ai/auth', () => ({ checkUsageLimits: () => Promise.resolve(state.usageRow) }))
vi.mock('@/lib/log/log-section', () => ({ buildLogSection: vi.fn(async () => null) }))
vi.mock('@/lib/now/now-section', () => ({ NOW_SECTION_KEY: 'now', nowForChatSpec: vi.fn(async () => ({ section: null, held: false })) }))
vi.mock('@/lib/onboarding/getting-started', () => ({
  GETTING_STARTED_SECTION_KEY: 'getting-started',
  FINISH_GETTING_STARTED_TOOL: 'finish_getting_started',
  gettingStartedForChatSpec: vi.fn(async () => ({ section: null, held: false })),
}))
vi.mock('@/lib/onboarding/text-setup', () => ({
  TEXT_SETUP_SECTION_KEY: 'text-setup',
  TEXT_SETUP_TOOLS: ['connect_link', 'save_business_profile', 'research_my_company'],
  textSetupForChatSpec: vi.fn(async () => ({ section: null, held: false })),
}))
vi.mock('@/lib/website/section', () => ({
  WEBSITE_SECTION_KEY: 'website',
  websiteForChatSpec: vi.fn(async () => ({ section: null, held: false })),
}))
vi.mock('@/lib/live-agent/live-turn-gate', () => ({ isLiveCallTurn: async () => false }))
vi.mock('../recent-section', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../recent-section')>()),
  buildRecentSection: vi.fn(async () => null),
}))
vi.mock('../environment-section', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../environment-section')>()),
  buildEnvironmentSection: vi.fn(async () => ({ section: null, folderCount: 0, kind: null })),
}))

import { rebuildChatSpec } from '../chat-run-rebuild'
import type { ChatRunTokenClaims } from '../chat-run-token'
import { chatModelPolicy, helperModelSpecs, modelIdentityNote, renderHelperModelRoster, DEFAULT_CHAT_POLICY, MAIN_MODEL } from '@/lib/ai/models'
import { STRONG_DAILY_CAP } from '@/lib/ai/model-route'

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

describe('rebuildChatSpec — the model the person picked for their main agent', () => {
  beforeEach(() => {
    state.usageRow = { allowed: true, is_paid_plan: true, reason: 'within_limits' }
    state.saved = null
    state.readSavedAgentModel.mockClear()
  })

  it('Auto (nothing saved) is the thread of before: Haiku 5.5, its call, its roster', async () => {
    const spec = await rebuildChatSpec(claims(), {}, SPLIT)
    expect(state.readSavedAgentModel).toHaveBeenCalledWith({ marker: 'service' }, 'user-1')
    expect(spec.model).toBe('anthropic/claude-haiku-5.5')
    expect(spec.modelPolicy).toEqual(DEFAULT_CHAT_POLICY)
    expect(spec.modelRoute?.signals).not.toContain('agent_model')
    expect(spec.systemPrompt.startsWith(`${modelIdentityNote(MAIN_MODEL)}\n\n${renderHelperModelRoster(STRONG_DAILY_CAP)}\n\n`)).toBe(true)
  })

  it('runs the thread on the pick, names it, and leaves the helpers as they were', async () => {
    state.saved = 'claude-opus-5-5'
    const spec = await rebuildChatSpec(claims(), {}, SPLIT)
    expect(spec.model).toBe('anthropic/claude-opus-5.5')
    expect(spec.modelPolicy).toEqual(chatModelPolicy('claude-opus-5-5', 'light'))
    expect(spec.modelRoute).toMatchObject({ tier: 'fast', reasoning: 'adaptive', signals: expect.arrayContaining(['agent_model']) })
    const roster = renderHelperModelRoster(STRONG_DAILY_CAP, { name: 'Claude Opus 5.5', premium: true })
    expect(spec.systemPrompt.startsWith(`${modelIdentityNote('claude-opus-5-5')}\n\n${roster}\n\n`)).toBe(true)
    expect(spec.systemPrompt).toContain('you run on a strong model the person chose for you (Claude Opus 5.5)')
    expect(spec.helperModels).toEqual(JSON.parse(JSON.stringify(helperModelSpecs())))
  })

  it('calls an OpenAI pick at its level: low on Fast, medium on Think', async () => {
    state.saved = 'gpt-5.6-terra'
    const fast = await rebuildChatSpec(claims(), {}, SPLIT)
    expect(fast.model).toBe('openai/gpt-5.6-terra')
    expect(fast.modelPolicy).toEqual({ contextWindowTokens: 1_000_000, reasoning: 'low' })
    expect(fast.modelRoute?.reasoning).toBe('low')
    const think = await rebuildChatSpec(claims(), THINK, SPLIT)
    expect(think.modelRoute?.tier).toBe('think')
    expect(think.modelPolicy).toEqual({ contextWindowTokens: 1_000_000, reasoning: 'medium' })
    expect(think.modelRoute?.reasoning).toBe('medium')
  })

  it('applies on every surface of the person\'s own agent: Slack, text, a server turn, a relay, the iPhone', async () => {
    state.saved = 'deepseek-v4-flash'
    for (const over of [
      { server: 'channel_turn' as const, surface: 'slack' as const },
      { server: 'channel_turn' as const, surface: 'sms' as const },
      { server: 'home_turn' as const },
      { relay: 'relay-1' },
      {},
    ]) {
      const spec = await rebuildChatSpec(claims(over as Partial<ChatRunTokenClaims>), {}, SPLIT)
      expect(spec.model, JSON.stringify(over)).toBe('deepseek/deepseek-v4-flash')
      expect(spec.modelPolicy, JSON.stringify(over)).toEqual(chatModelPolicy('deepseek-v4-flash', 'light'))
    }
  })

  it('needs a paid plan for a premium pick (Auto otherwise), not for an inexpensive one', async () => {
    state.usageRow = { allowed: true, is_paid_plan: false, reason: 'using_credits' }
    for (const premium of ['claude-opus-5-5', 'claude-sonnet-5-5', 'gpt-5.6-terra']) {
      state.saved = premium
      const spec = await rebuildChatSpec(claims(), {}, SPLIT)
      expect(spec.model, premium).toBe('anthropic/claude-haiku-5.5')
      expect(spec.modelRoute?.signals, premium).not.toContain('agent_model')
      expect(spec.systemPrompt, premium).toContain('a fast, inexpensive model (Claude Haiku 5.5)')
    }
    state.saved = 'gpt-5.6-luna'
    const luna = await rebuildChatSpec(claims(), {}, SPLIT)
    expect(luna.model).toBe('openai/gpt-5.6-luna')
    expect(luna.systemPrompt).toContain('you run on a fast, inexpensive model the person chose for you (GPT-5.6 Luna)')
    // No usage row (billing failing open): not paid.
    state.usageRow = undefined as unknown as Record<string, unknown>
    state.saved = 'claude-opus-5-5'
    expect((await rebuildChatSpec(claims(), {}, SPLIT)).model).toBe('anthropic/claude-haiku-5.5')
  })

  it('ignores a saved value that is not a pick', async () => {
    state.saved = 'anthropic/claude-opus-5.5'
    expect((await rebuildChatSpec(claims(), {}, SPLIT)).model).toBe('anthropic/claude-haiku-5.5')
  })

  it('never on the person\'s ChatGPT plan: the plan\'s model runs', async () => {
    state.usageRow = { allowed: true, is_paid_plan: false, reason: 'chatgpt_plan' }
    state.saved = 'gpt-5.6-luna'
    const spec = await rebuildChatSpec(claims(), {}, SPLIT)
    expect(spec.model).toBe('openai/gpt-6.1-sol')
    expect(spec.modelRoute?.signals).not.toContain('agent_model')
  })

  it('never on a device ask or a teammate\'s chat, which never read the account', async () => {
    state.saved = 'claude-opus-5-5'
    const device = await rebuildChatSpec(claims({ surface: 'device_ask' }), {}, SPLIT)
    expect(device.model).toBe('deepseek/deepseek-v4-flash')
    const bot = await rebuildChatSpec(claims({ teammateId: 'tm-1' }), {}, SPLIT)
    expect(bot.model).toBe('anthropic/claude-haiku-5.5')
    expect(state.readSavedAgentModel).not.toHaveBeenCalled()
  })
})
