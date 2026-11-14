/**
 * ChatSpec rebuild tests (Phase 4).
 *
 * Pins the load-bearing spec-shape invariants:
 *   1. inherit-all (null agent ceiling, no external tools) → ceilingTools
 *      enumerates every registry tool (∪ search_tools) — never []. Every
 *      feature is on for every edition (manifest invariant 5), so the edition
 *      imposes no ceiling either and the spec's ceiling stays null.
 *   2. an agent ceiling is UNIONED with the user's external-MCP tool names
 *      (user opt-in trumps agent restriction), and ceilingTools == that union.
 *   3. model is CLAMPED to the user's plan (free user can't drive Sonnet).
 *
 * buildChatSystemPrompt (its own parity test covers layering), checkUsageLimits,
 * and createExternalMcpTools are mocked so this test is about the ceiling/model
 * derivation only.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ALL_TOOL_NAMES, isAttendedOnlyTool, isChatNativeTool } from '@/lib/ai/tool-registry'
import {
  BROWSER_TOOL_NAMES,
  CORE_TOOL_NAMES,
  PERSON_MENTION_TOOL_NAMES,
  COMPANY_MENTION_TOOL_NAMES,
  LIVE_MEETING_TOOL_NAMES,
  MAIN_CHAT_MEMORY_TOOL_NAMES,
} from '@/lib/ai/tool-discovery'

/** CORE minus the natives the resolver mints itself (search_tools/ask_user). */
const REGISTRY_CORE = new Set(ALL_TOOL_NAMES)
const NATIVE = new Set(['search_tools', 'ask_user'])
/**
 * ...plus `remember`, which the main chat (no teammate) advertises on every
 * turn, and the agent browser's tools, which ride every turn the ceiling
 * allows them, and with the browser on for everyone that is every turn.
 */
const EXPECTED_INHERIT_CORE = [...new Set([...CORE_TOOL_NAMES, ...MAIN_CHAT_MEMORY_TOOL_NAMES, ...BROWSER_TOOL_NAMES])].filter(
  (n) => !NATIVE.has(n) && REGISTRY_CORE.has(n),
)

const ceilingState: { agentToolCeiling: Set<string> | null } = { agentToolCeiling: null }
const heldState: { keys: string[] } = { keys: [] }
const mcpState: { toolNames: string[] } = { toolNames: [] }
const planState: { isPaid: boolean } = { isPaid: true }
/** The builder's `cards` section, when a test wants one (the real one renders systemContext.cards). */
const cardsSectionState: { markdown: string | null } = { markdown: null }

vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({}) }))
// The chat's environment (environment-section.ts) is read by user on
// every turn; the stub service client can't, so: none.
vi.mock('../environment-section', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../environment-section')>()),
  buildEnvironmentSection: vi.fn(async () => ({ section: null, folderCount: 0, kind: null })),
}))
// The canon registry section (D1): '' unless a test sets one.
const canonState = vi.hoisted(() => ({ section: '' }))
vi.mock('@/lib/documents/canon-registry', () => ({ canonRegistrySection: vi.fn(async () => canonState.section) }))
// The product-facts rider (D1): its own test covers the trigger; here a stand-in answers on 'pricing'.
vi.mock('@/lib/documents/product-facts-rider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/documents/product-facts-rider')>()),
  productFactsRider: vi.fn(async (_s: unknown, args: { text: unknown }) => (String(args.text).includes('pricing') ? 'PRODUCT FACTS' : null)),
}))
// The server's say on a live turn (its own test: live-turn-gate.test.ts).
const liveGate = vi.hoisted(() => ({ live: true }))
vi.mock('@/lib/live-agent/live-turn-gate', () => ({ isLiveCallTurn: vi.fn(async () => liveGate.live) }))

// Jev's model.tier (shadow) is fired after an undecided turn's spec: recorded here, never awaited.
const jevCalls = vi.hoisted(() => [] as unknown[][])
vi.mock('@/lib/ai/decisions/run-decision', () => ({
  runDecision: vi.fn(async (...a: unknown[]) => {
    jevCalls.push(a)
    return { status: 'escalate', reason: 'test' }
  }),
}))

// The builder's sections are fixed; its joins are real.
vi.mock('@/lib/ai/chat-system-prompt', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/chat-system-prompt')>()),
  buildChatSystemPrompt: vi.fn(async () => ({
    stable: [{ key: 'base', markdown: 'SYSTEM_PROMPT' }],
    turnContext: [
      { key: 'time', markdown: 'Current date and time: CLOCK' },
      ...(cardsSectionState.markdown ? [{ key: 'cards', markdown: cardsSectionState.markdown }] : []),
    ],
    turnContextHeld: heldState.keys,
    activeSkillSlug: null,
    agentToolCeiling: ceilingState.agentToolCeiling,
    agentEnabledCategories: [],
    agentDisabledTools: [],
  })),
}))

vi.mock('@/lib/mcp-client/adapter', () => ({
  CONFIRM_TOOL_NAME: 'mcp_confirm_call',
  createExternalMcpTools: vi.fn(async () => ({
    tools: Object.fromEntries(mcpState.toolNames.map((n) => [n, { description: `ext ${n}` }])),
    meta: new Map(),
    servers: [],
  })),
}))

vi.mock('@/lib/ai/auth', () => ({
  checkUsageLimits: vi.fn(async () => ({ allowed: true, is_paid_plan: planState.isPaid })),
}))

// The person has no agent-log lines (the log section: chat-run-rebuild-log.test.ts).
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

import { rebuildChatSpec, settleJevTier, DEVICE_ASK_NOTE, JEV_TIER_GRACE_MS, SMS_TURN_NOTE } from '../chat-run-rebuild'
import { DEVICE_ONLY_EXCLUSIONS } from '../chat-ceiling'
import { DEFAULT_CHAT_POLICY, MAIN_MODEL, deepseekSurfacePolicy, helperModelSpecs, modelIdentityNote, renderHelperModelRoster } from '@/lib/ai/models'
import { STRONG_DAILY_CAP, routeChatTurn, turnRouteSignals } from '@/lib/ai/model-route'

/** The stable prompt's head on the person's main chat: Haiku's identity line, then the helper roster. */
const THREAD = `${modelIdentityNote(MAIN_MODEL)}\n\n${renderHelperModelRoster(STRONG_DAILY_CAP)}\n\n`
import { buildChatSystemPrompt } from '@/lib/ai/chat-system-prompt'
import { checkUsageLimits } from '@/lib/ai/auth'
import type { ChatRunTokenClaims } from '../chat-run-token'

function claims(over: Partial<ChatRunTokenClaims> = {}): ChatRunTokenClaims {
  return { conversationId: 'c', workspaceId: 'ws-1', userId: 'user-1', exp: Date.now() + 60_000, ...over }
}

describe('rebuildChatSpec — ceiling + model', () => {
  beforeEach(() => {
    ceilingState.agentToolCeiling = null
    mcpState.toolNames = []
    planState.isPaid = true
    vi.clearAllMocks()
  })

  // Every edition has every feature (manifest invariant 5), so the edition
  // imposes no ceiling: the spec's ceiling is null (inherit-all) and the
  // rebuild enumerates the whole registry for the advertised surface.
  it('inherit-all: ceilingTools enumerates every registry tool (∪ search_tools)', async () => {
    const spec = await rebuildChatSpec(claims(), {})
    expect(spec.ceiling).toBeNull()

    const advertised = new Set(spec.ceilingTools.map((t) => t.name))
    // The note-taker's line is a live turn's alone (one-chat Slice 3).
    const liveOnly = new Set(LIVE_MEETING_TOOL_NAMES)
    for (const name of ALL_TOOL_NAMES) {
      expect(advertised.has(name), name).toBe(!liveOnly.has(name))
    }
    expect(advertised.has('search_tools')).toBe(true)
  })

  it('inherit-all + external tools: external tools are still advertised', async () => {
    mcpState.toolNames = ['mcp__jira__create_issue']
    const spec = await rebuildChatSpec(claims(), {})
    const advertised = new Set(spec.ceilingTools.map((t) => t.name))
    expect(advertised.has('mcp__jira__create_issue')).toBe(true)
    // Inherit-all stays null with them connected: the rebuild enumerates the
    // registry ∪ the external tools, as the tool route's null ceiling permits.
    expect(spec.ceiling).toBeNull()
  })

  it('agent ceiling: unions the external-MCP tool names', async () => {
    ceilingState.agentToolCeiling = new Set(['list_actions', 'create_action'])
    mcpState.toolNames = ['mcp__jira__create_issue']
    const spec = await rebuildChatSpec(claims({ agentId: 'a1' }), {})
    expect(spec.ceiling).not.toBeNull()
    const set = new Set(spec.ceiling!)
    expect(set.has('list_actions')).toBe(true)
    expect(set.has('create_action')).toBe(true)
    // External opt-in trumps agent restriction.
    expect(set.has('mcp__jira__create_issue')).toBe(true)
    // ceilingTools mirror the ceiling exactly.
    expect(new Set(spec.ceilingTools.map((t) => t.name))).toEqual(set)
  })

  it('runs Haiku 5.5 for everyone, paid or not (Liam, 2026-10-27): no plan clamp on the thread', async () => {
    for (const paid of [true, false]) {
      planState.isPaid = paid
      const spec = await rebuildChatSpec(claims(), { route: turnRouteSignals('hello') })
      expect(spec.model).toBe('anthropic/claude-haiku-5.5')
    }
  })
})

describe('rebuildChatSpec — auto model selection (the turn\'s tier)', () => {
  beforeEach(() => {
    ceilingState.agentToolCeiling = null
    mcpState.toolNames = []
    planState.isPaid = true
    jevCalls.length = 0
    vi.clearAllMocks()
  })

  it('Fast by default: Haiku with adaptive thinking, logged as a rule', async () => {
    const spec = await rebuildChatSpec(claims(), { route: turnRouteSignals('Draft a reply to Sam saying yes.') })
    expect(spec.model).toBe('anthropic/claude-haiku-5.5')
    expect(spec.modelPolicy).toEqual(DEFAULT_CHAT_POLICY)
    expect(spec.modelRoute).toEqual({ tier: 'fast', by: 'rule', signals: ['short'], reasoning: 'adaptive' })
    // It crosses the wire as JSON (the spec route's NextResponse.json).
    expect(JSON.parse(JSON.stringify(spec)).modelPolicy).toEqual(DEFAULT_CHAT_POLICY)
  })

  it('Think on a clear signal: the same model and call (the model decides how hard to think), labelled Think', async () => {
    const spec = await rebuildChatSpec(claims(), { route: turnRouteSignals('Think carefully about our pricing options and walk me through them step by step.') })
    expect(spec.model).toBe('anthropic/claude-haiku-5.5')
    expect(spec.modelPolicy).toEqual(DEFAULT_CHAT_POLICY)
    expect(spec.modelRoute).toMatchObject({ tier: 'think', by: 'rule', reasoning: 'adaptive' })
    // On both return paths.
    const withSkills = await rebuildChatSpec(claims(), { route: turnRouteSignals('think hard') }, { includeSkills: true })
    expect(withSkills.modelPolicy).toEqual(DEFAULT_CHAT_POLICY)
    expect(withSkills.modelRoute?.tier).toBe('think')
  })

  it('never switches the thread for coding, and sends no strong hint: the roster in the stable prompt lets the agent pick a helper', async () => {
    const spec = await rebuildChatSpec(claims(), { route: turnRouteSignals('Why does this fail? SELECT a, b FROM t WHERE x = 1') }, { splitTurnContext: true })
    expect(spec.model).toBe('anthropic/claude-haiku-5.5')
    // The route still logs the signals (what the rules saw).
    expect(spec.modelRoute).toMatchObject({ tier: 'fast', signals: expect.arrayContaining(['sql']) })
    expect(spec.turnContext?.map((s) => s.key)).not.toContain('route')
    // The identity line names the model that runs (Haiku), and the roster follows it.
    expect(spec.systemPrompt.startsWith(THREAD)).toBe(true)
    expect(spec.systemPrompt).toContain('a coding run')
  })

  it('the roster and helperModels ride the person\'s main chat; a bot\'s chat has neither roster nor hint', async () => {
    const main = await rebuildChatSpec(claims(), {}, { splitTurnContext: true })
    expect(main.helperModels).toEqual(JSON.parse(JSON.stringify(helperModelSpecs())))
    expect(main.systemPrompt).toContain('## Models for helpers')
    const bot = await rebuildChatSpec(claims({ teammateId: 'tm-1' }), { route: turnRouteSignals('Fix this: SELECT a, b FROM t') }, { splitTurnContext: true })
    expect(bot.turnContext?.map((s) => s.key)).not.toContain('route')
    expect(bot.systemPrompt).not.toContain('## Models for helpers')
    // The roster is stable text: the same on every turn, so the cached prefix holds.
    const next = await rebuildChatSpec(claims(), { route: turnRouteSignals('think hard') }, { splitTurnContext: true })
    expect(next.systemPrompt).toBe(main.systemPrompt)
  })

  it('names the daily cap and the premium models in the roster, paid plan or not', async () => {
    planState.isPaid = false
    const unpaid = await rebuildChatSpec(claims(), {}, { splitTurnContext: true })
    expect(unpaid.systemPrompt).toContain(`at most ${STRONG_DAILY_CAP} premium helpers a day`)
    expect(unpaid.model).toBe('anthropic/claude-haiku-5.5')
  })

  it('a server-written or relayed turn runs Fast whatever its text says', async () => {
    for (const over of [{ server: 'home_turn' as const }, { relay: 'relay-1' }]) {
      const spec = await rebuildChatSpec(claims(over as Partial<ChatRunTokenClaims>), { route: turnRouteSignals('think hard, step by step') })
      expect(spec.modelRoute?.tier, JSON.stringify(over)).toBe('fast')
    }
  })

  it('a turn without signals (an older client) runs Fast', async () => {
    const spec = await rebuildChatSpec(claims(), {})
    expect(spec.modelPolicy).toEqual(DEFAULT_CHAT_POLICY)
    expect(spec.modelRoute).toMatchObject({ tier: 'fast', signals: ['no_signals'] })
  })

  it('asks Jev in shadow only for an undecided turn, after the spec, and still runs Fast', async () => {
    const undecided = 'I have been wondering whether our onboarding is why people leave in month two, and what we might change, since the numbers have looked off for a while and nobody on the team agrees where it starts going wrong for them, so before planning week I would like your honest view on it, whatever it turns out to be.'
    const spec = await rebuildChatSpec(claims(), { route: turnRouteSignals(undecided) })
    expect(spec.modelRoute).toMatchObject({ tier: 'fast', signals: ['undecided'] })
    await vi.waitFor(() => expect(jevCalls).toHaveLength(1))
    expect(jevCalls[0][0]).toBe('model.tier')
    expect(jevCalls[0][1]).toMatchObject({ surface: 'chat', attachments: [] })
    expect(jevCalls[0][2]).toMatchObject({ userId: 'user-1', workspaceId: 'ws-1', mode: 'shadow' })
    jevCalls.length = 0
    await rebuildChatSpec(claims(), { route: turnRouteSignals('yes') })
    await rebuildChatSpec(claims(), { route: turnRouteSignals('think hard') })
    await new Promise((r) => setTimeout(r, 0))
    expect(jevCalls).toHaveLength(0)
  })
})

describe('rebuildChatSpec — a usage block still escapes the parallel loads', () => {
  // checkUsageLimits loads beside the prompt in one Promise.allSettled, so the
  // block reaches the spec route (which answers it as-is) only because the
  // rebuild rethrows the settled rejection, in the serial rebuild's order.
  const block = (status: 429 | 503) =>
    new Response(JSON.stringify({ error: status === 429 ? 'Usage limit exceeded' : 'Usage check unavailable' }), {
      status,
    })

  beforeEach(() => {
    ceilingState.agentToolCeiling = null
    mcpState.toolNames = []
    planState.isPaid = true
    vi.clearAllMocks()
  })

  it.each([429, 503] as const)('a %i from checkUsageLimits rejects the rebuild with that same Response', async (status) => {
    const blocked = block(status)
    vi.mocked(checkUsageLimits).mockRejectedValueOnce(blocked)
    await expect(rebuildChatSpec(claims(), {})).rejects.toBe(blocked)
  })

  it('a usage block beats a successful prompt, skills and settings (includeSkills too)', async () => {
    const blocked = block(429)
    vi.mocked(checkUsageLimits).mockRejectedValueOnce(blocked)
    await expect(rebuildChatSpec(claims(), {}, { includeSkills: true })).rejects.toBe(blocked)
  })

  it('a prompt-build failure beats a usage block, as the serial rebuild ordered them', async () => {
    const promptError = new Error('prompt build failed')
    vi.mocked(buildChatSystemPrompt).mockRejectedValueOnce(promptError)
    vi.mocked(checkUsageLimits).mockRejectedValueOnce(block(429))
    await expect(rebuildChatSpec(claims(), {})).rejects.toBe(promptError)
  })
})

describe('rebuildChatSpec — active-model identity line', () => {
  beforeEach(() => {
    ceilingState.agentToolCeiling = null
    mcpState.toolNames = []
    planState.isPaid = true
    vi.clearAllMocks()
  })

  it('prepends the identity line for the model that runs as the FIRST line of the prompt', async () => {
    planState.isPaid = true
    const spec = await rebuildChatSpec(claims(), { route: turnRouteSignals('think hard') })
    // The line is derived from the tier's BARE id, states the real provider, and
    // leads the prompt (maximum salience for weaker models).
    expect(spec.systemPrompt.startsWith(modelIdentityNote(MAIN_MODEL))).toBe(true)
    expect(spec.systemPrompt).toContain('`anthropic/claude-haiku-5.5`')
    // Prepended AHEAD of the mocked base prompt (not replacing it).
    expect(spec.systemPrompt).toContain('SYSTEM_PROMPT')
  })

  it('uses the DEFAULT model identity when no model is requested', async () => {
    const spec = await rebuildChatSpec(claims(), {})
    expect(spec.systemPrompt).toContain(modelIdentityNote(MAIN_MODEL))
    expect(spec.systemPrompt).toContain('`anthropic/claude-haiku-5.5`')
  })

  it('is the same line on a Fast and a Think turn (one model on this thread, so the cache holds)', async () => {
    const fast = await rebuildChatSpec(claims(), { route: turnRouteSignals('yes') })
    const think = await rebuildChatSpec(claims(), { route: turnRouteSignals('think hard') })
    expect(fast.systemPrompt.split('\n\n')[0]).toBe(think.systemPrompt.split('\n\n')[0])
    expect(think.systemPrompt.split('\n\n')[0]).not.toContain('Sonnet')
  })

  it('is present on the includeSkills return path too, and stays the FIRST line (ahead of the skills section)', async () => {
    const spec = await rebuildChatSpec(claims(), {}, { includeSkills: true })
    expect(spec.systemPrompt.startsWith(THREAD)).toBe(true)
  })
})

describe('rebuildChatSpec — the split prompt (chat-ttft P3)', () => {
  beforeEach(() => {
    ceilingState.agentToolCeiling = null
    mcpState.toolNames = []
    planState.isPaid = true
    vi.clearAllMocks()
  })

  it('split: the identity line, then only the stable sections; the per-turn ones ride turnContext', async () => {
    const spec = await rebuildChatSpec(claims(), {}, { splitTurnContext: true })
    expect(spec.systemPrompt).toBe(`${THREAD}SYSTEM_PROMPT`)
    expect(spec.turnContext).toEqual([{ key: 'time', markdown: 'Current date and time: CLOCK' }])
    // Both return paths carry it.
    const withSkills = await rebuildChatSpec(claims(), {}, { includeSkills: true, splitTurnContext: true })
    expect(withSkills.turnContext).toEqual(spec.turnContext)
    expect(withSkills.systemPrompt).not.toContain('Current date and time')
    // No layer failed: no held list on the wire.
    expect(spec).not.toHaveProperty('turnContextHeld')
  })

  it('split: a layer that failed to load rides turnContextHeld, on both return paths', async () => {
    heldState.keys = ['live']
    try {
      const spec = await rebuildChatSpec(claims(), {}, { splitTurnContext: true })
      expect(spec.turnContextHeld).toEqual(['live'])
      const withSkills = await rebuildChatSpec(claims(), {}, { includeSkills: true, splitTurnContext: true })
      expect(withSkills.turnContextHeld).toEqual(['live'])
      // The legacy variant has no per-turn sections to hold.
      expect(await rebuildChatSpec(claims(), {})).not.toHaveProperty('turnContextHeld')
    } finally {
      heldState.keys = []
    }
  })

  it('without the split: no turnContext field, and the per-turn layers stay in the prompt as before', async () => {
    const spec = await rebuildChatSpec(claims(), {})
    expect(spec).not.toHaveProperty('turnContext')
    expect(spec.systemPrompt).toBe(
      `${THREAD}Current date and time: CLOCK\n\n---\n\nSYSTEM_PROMPT`,
    )
    const withSkills = await rebuildChatSpec(claims(), {}, { includeSkills: true })
    expect(withSkills).not.toHaveProperty('turnContext')
  })
})

describe('rebuildChatSpec — real input schemas on ceilingTools', () => {
  beforeEach(() => {
    ceilingState.agentToolCeiling = null
    mcpState.toolNames = []
    planState.isPaid = true
    vi.clearAllMocks()
  })

  it('registry tools carry their real JSON input schema when includeSchemas is set (the blank-proxy fix)', async () => {
    const spec = await rebuildChatSpec(claims(), {}, { includeSchemas: true })
    const find = spec.ceilingTools.find((t) => t.name === 'find')
    expect(find?.inputSchema).toBeDefined()
    const props = (find!.inputSchema as { properties: Record<string, Record<string, unknown>> }).properties
    // The exact params the incident model guessed wrong without a schema.
    expect(props.query).toMatchObject({ type: 'string' })
    expect(props.types).toMatchObject({ type: 'array' })
    expect(props.limit).toBeDefined()
  })

  it('the default fetch (search_tools / instructions / model resolvers) skips schemas', async () => {
    const spec = await rebuildChatSpec(claims(), {})
    for (const t of spec.ceilingTools) {
      expect(t.inputSchema, `unexpected schema on ${t.name}`).toBeUndefined()
    }
  })

  it('an unknown external tool without a convertible schema simply omits inputSchema', async () => {
    mcpState.toolNames = ['mcp__jira__create_issue'] // mock adapter ships no inputSchema
    const spec = await rebuildChatSpec(claims(), {}, { includeSchemas: true })
    const ext = spec.ceilingTools.find((t) => t.name === 'mcp__jira__create_issue')
    expect(ext).toBeDefined()
    expect(ext!.inputSchema).toBeUndefined()
  })
})

describe('rebuildChatSpec — coreToolNames (progressive disclosure)', () => {
  beforeEach(() => {
    ceilingState.agentToolCeiling = null
    mcpState.toolNames = []
    planState.isPaid = true
    vi.clearAllMocks()
  })

  it('inherit-all: core is the SMALL CORE_TOOL_NAMES subset, NOT the full registry', async () => {
    const spec = await rebuildChatSpec(claims(), {})
    const core = new Set(spec.coreToolNames)
    // Every registry CORE tool (excluding natives) is in core…
    for (const n of EXPECTED_INHERIT_CORE) expect(core.has(n), n).toBe(true)
    // …and core is strictly smaller than the full advertised surface.
    expect(spec.coreToolNames.length).toBeLessThan(spec.ceilingTools.length)
    expect(spec.coreToolNames.length).toBe(EXPECTED_INHERIT_CORE.length)
    // Natives are never in core (the resolver mints them itself).
    expect(core.has('search_tools')).toBe(false)
    expect(core.has('ask_user')).toBe(false)
    // core ⊆ the discoverable surface.
    const advertised = new Set(spec.ceilingTools.map((t) => t.name))
    for (const n of spec.coreToolNames) expect(advertised.has(n), n).toBe(true)
  })

  it('inherit-all + external tools: connected MCP tools are NOT in core, but stay discoverable in ceilingTools (chat-ttft P4)', async () => {
    mcpState.toolNames = ['mcp__jira__create_issue', 'mcp__jira__list_issues']
    const spec = await rebuildChatSpec(claims(), {})
    const core = new Set(spec.coreToolNames)
    expect(core.has('mcp__jira__create_issue')).toBe(false)
    expect(core.has('mcp__jira__list_issues')).toBe(false)
    // Core is exactly the registry core: no external tool rides every model call.
    expect(spec.coreToolNames.length).toBe(EXPECTED_INHERIT_CORE.length)
    for (const n of EXPECTED_INHERIT_CORE) expect(core.has(n), n).toBe(true)
    // search_tools can still find them, and the tool route still permits them.
    const surface = new Set(spec.ceilingTools.map((t) => t.name))
    expect(surface.has('mcp__jira__create_issue')).toBe(true)
    expect(surface.has('mcp__jira__list_issues')).toBe(true)
    expect(spec.ceiling).toBeNull()
  })

  it('scoped agent whose ceiling overlaps CORE: core = that overlap, ⊆ ceiling; external tools stay in the ceiling only', async () => {
    ceilingState.agentToolCeiling = new Set(['list_actions', 'create_action', 'update_action'])
    mcpState.toolNames = ['mcp__jira__create_issue']
    const spec = await rebuildChatSpec(claims({ agentId: 'a1' }), {})
    const core = new Set(spec.coreToolNames)
    // list_actions/create_action ARE in CORE_TOOL_NAMES → surfaced upfront.
    expect(core.has('list_actions')).toBe(true)
    expect(core.has('create_action')).toBe(true)
    // External tools load through search_tools, even under an agent.
    expect(core.has('mcp__jira__create_issue')).toBe(false)
    expect(spec.ceilingTools.map((t) => t.name)).toContain('mcp__jira__create_issue')
    // core ⊆ ceiling (never widens it).
    const ceilingSet = new Set(spec.ceiling!)
    for (const n of spec.coreToolNames) expect(ceilingSet.has(n), n).toBe(true)
  })

  it('mcp_confirm_call is in core when a tool is gated (the adapter registers it), and absent otherwise', async () => {
    // A gated tool makes the adapter register mcp_confirm_call beside it.
    mcpState.toolNames = ['mcp__jira__create_issue', 'mcp_confirm_call']
    const gated = await rebuildChatSpec(claims(), {})
    expect(gated.coreToolNames).toContain('mcp_confirm_call')
    expect(gated.coreToolNames).not.toContain('mcp__jira__create_issue')
    // Under an agent too: the confirm tool rides the external union into the ceiling.
    ceilingState.agentToolCeiling = new Set(['list_actions'])
    const scoped = await rebuildChatSpec(claims({ agentId: 'a1' }), {})
    expect(scoped.coreToolNames).toContain('mcp_confirm_call')
    expect(scoped.coreToolNames).not.toContain('mcp__jira__create_issue')

    // No gated tool → no confirm tool → nothing extra in core.
    ceilingState.agentToolCeiling = null
    mcpState.toolNames = ['mcp__jira__create_issue']
    const ungated = await rebuildChatSpec(claims(), {})
    expect(ungated.coreToolNames).not.toContain('mcp_confirm_call')
    expect(ungated.coreToolNames.length).toBe(EXPECTED_INHERIT_CORE.length)
  })

  it('a NARROW agent with connected servers still seeds its fallback from registry tools, never external ones', async () => {
    const narrow = ['list_milestones', 'create_milestone']
    ceilingState.agentToolCeiling = new Set(narrow)
    mcpState.toolNames = ['mcp__jira__create_issue', 'mcp_confirm_call']
    const spec = await rebuildChatSpec(claims({ agentId: 'a2' }), {})
    const core = new Set(spec.coreToolNames)
    for (const n of narrow) expect(core.has(n), n).toBe(true)
    expect(core.has('mcp__jira__create_issue')).toBe(false)
    expect(core.has('mcp_confirm_call')).toBe(true)
  })

  it('NARROW agent (ceiling shares nothing with CORE): falls back to the head of the ceiling', async () => {
    // A ceiling of purely non-core tools — no CORE_TOOL_NAMES member in it.
    const narrow = ['list_milestones', 'create_milestone', 'update_milestone', 'get_company_overview']
    ceilingState.agentToolCeiling = new Set(narrow)
    const spec = await rebuildChatSpec(claims({ agentId: 'a2' }), {})
    // Fallback kicks in: core is NON-empty (the model gets key tools upfront)…
    expect(spec.coreToolNames.length).toBeGreaterThan(0)
    // …drawn from the ceiling head, and strictly ⊆ ceiling.
    const ceilingSet = new Set(spec.ceiling!)
    for (const n of spec.coreToolNames) expect(narrow.includes(n) || ceilingSet.has(n), n).toBe(true)
  })

  it('coreToolNames is always ⊆ ceilingTools (advertised surface) in every mode', async () => {
    // scoped case
    ceilingState.agentToolCeiling = new Set(['list_actions'])
    const scoped = await rebuildChatSpec(claims({ agentId: 'a3' }), {})
    const scopedSurface = new Set(scoped.ceilingTools.map((t) => t.name))
    for (const n of scoped.coreToolNames) expect(scopedSurface.has(n), n).toBe(true)
  })

  it('@-mentioned contacts seed PERSON_MENTION_TOOL_NAMES into core (inherit-all)', async () => {
    const spec = await rebuildChatSpec(claims(), { systemContext: { attachedContactIds: ['c1'] } })
    const core = new Set(spec.coreToolNames)
    for (const n of PERSON_MENTION_TOOL_NAMES) expect(core.has(n), n).toBe(true)
    // Still ⊆ the advertised surface, and the base core is intact.
    const advertised = new Set(spec.ceilingTools.map((t) => t.name))
    for (const n of spec.coreToolNames) expect(advertised.has(n), n).toBe(true)
    for (const n of EXPECTED_INHERIT_CORE) expect(core.has(n), n).toBe(true)
  })

  it('no mentioned contacts → person tools are NOT in core', async () => {
    const spec = await rebuildChatSpec(claims(), { systemContext: { attachedProjectIds: ['p1'] } })
    const core = new Set(spec.coreToolNames)
    expect(core.has('get_contact_details')).toBe(false)
    expect(core.has('list_contact_captures')).toBe(false)
    expect(core.has('get_meeting_prep')).toBe(false)
  })

  it('scoped agent whose ceiling excludes get_contact_details: mentions do NOT widen core past the ceiling', async () => {
    ceilingState.agentToolCeiling = new Set(['list_actions', 'create_action', 'list_contact_captures'])
    const spec = await rebuildChatSpec(claims({ agentId: 'a4' }), { systemContext: { attachedContactIds: ['c1'] } })
    const core = new Set(spec.coreToolNames)
    // In the ceiling → seeded.
    expect(core.has('list_contact_captures')).toBe(true)
    // Outside the ceiling → never seeded.
    expect(core.has('get_contact_details')).toBe(false)
    expect(core.has('get_meeting_prep')).toBe(false)
    const ceilingSet = new Set(spec.ceiling!)
    for (const n of spec.coreToolNames) expect(ceilingSet.has(n), n).toBe(true)
  })

  it('@-mentioned companies seed COMPANY_MENTION_TOOL_NAMES into core (inherit-all)', async () => {
    const spec = await rebuildChatSpec(claims(), { systemContext: { attachedCompanyIds: ['co1'] } })
    const core = new Set(spec.coreToolNames)
    expect(core.has('get_company_overview')).toBe(true)
    for (const n of COMPANY_MENTION_TOOL_NAMES) expect(core.has(n), n).toBe(true)
    const advertised = new Set(spec.ceilingTools.map((t) => t.name))
    for (const n of spec.coreToolNames) expect(advertised.has(n), n).toBe(true)
  })

  it('no mentioned companies → get_company_overview is NOT in core', async () => {
    const spec = await rebuildChatSpec(claims(), { systemContext: { attachedContactIds: ['c1'] } })
    expect(new Set(spec.coreToolNames).has('get_company_overview')).toBe(false)
  })

  it('a turn with uploads advertises read_chat_file up front (how the model looks at a photo); any other turn does not', async () => {
    const chatFiles = [{ storagePath: 'user-1/chat-uploads/a.png', fileName: 'a.png', fileSize: 1000, mimeType: 'image/png' }]
    const withFiles = await rebuildChatSpec(claims(), { systemContext: { chatFiles } })
    expect(withFiles.coreToolNames).toContain('read_chat_file')
    expect(withFiles.ceilingTools.map((t) => t.name)).toContain('read_chat_file')
    const plain = await rebuildChatSpec(claims(), { systemContext: { attachedProjectIds: ['p1'] } })
    expect(plain.coreToolNames).not.toContain('read_chat_file')
    // Still reachable through search_tools on a later turn about the same photo.
    expect(plain.ceilingTools.map((t) => t.name)).toContain('read_chat_file')
  })

  it('a message setting a goal for a meeting advertises set_meeting_goal up front; any other message does not', async () => {
    const goal = await rebuildChatSpec(claims(), { route: turnRouteSignals('the goal of my 2:30 is to close the pilot') })
    expect(goal.coreToolNames).toContain('set_meeting_goal')
    const plain = await rebuildChatSpec(claims(), { route: turnRouteSignals('what are our Q4 goals?') })
    expect(plain.coreToolNames).not.toContain('set_meeting_goal')
    // Still reachable through search_tools.
    expect(plain.ceilingTools.map((t) => t.name)).toContain('set_meeting_goal')
  })

  it('a turn with cards on screen advertises read_card up front and carries the checked cards for its proxy; show is always core', async () => {
    const cards = [
      { n: 1, id: 'call_1', kind: 'list', title: 'Mine', entity: 'action', cur: { filters: [{ field: 'assignee_id', operator: 'is', value: '@me' }] } },
      { n: 2, id: 'call_2', kind: 'list', title: 'Bad', entity: 'action', cur: { filters: [{ field: 'nope', operator: 'is', value: 'x' }] } },
    ]
    const withCards = await rebuildChatSpec(claims(), { systemContext: { cards } })
    expect(withCards.coreToolNames).toContain('read_card')
    expect(withCards.coreToolNames).toContain('show')
    // The card whose spec does not parse comes without it (read_card then says it is too big).
    expect(withCards.cards?.map((c) => c.n)).toEqual([1, 2])
    expect(withCards.cards?.[1].cur).toBeUndefined()
    const plain = await rebuildChatSpec(claims(), { systemContext: { attachedProjectIds: ['p1'] } })
    expect(plain.coreToolNames).not.toContain('read_card')
    expect(plain.coreToolNames).toContain('show')
    expect(plain.cards).toBeUndefined()
  })

  it('drops calendar and mail cards, and their note lines, where the chat may not read them', async () => {
    const cards = [
      { n: 1, id: 'call_1', kind: 'list', title: 'Mine', entity: 'action', cur: { filters: [] }, u: true },
      { n: 2, id: 'opened-2', kind: 'mail', title: 'Inbox', mail: { cur: { folder: 'inbox' } }, count: 3, rows: [{ t: 'Dana: contract' }], u: true },
    ]
    cardsSectionState.markdown = 'NOTE WITH Dana: contract'
    try {
      // A persona whose tools leave out list_emails.
      ceilingState.agentToolCeiling = new Set(['list_actions', 'read_card', 'show'])
      const limited = await rebuildChatSpec(claims({ agentId: 'a1' }), { systemContext: { cards } }, { splitTurnContext: true })
      expect(limited.cards?.map((c) => c.n)).toEqual([1])
      const note = limited.turnContext?.find((s) => s.key === 'cards')?.markdown ?? ''
      expect(note).toContain('card 1 ')
      expect(note).not.toContain('Dana')
      expect(note).not.toContain('card 2 ')

      // The default assistant may read mail: the builder's note stands.
      ceilingState.agentToolCeiling = null
      const open = await rebuildChatSpec(claims(), { systemContext: { cards } }, { splitTurnContext: true })
      expect(open.cards?.map((c) => c.n)).toEqual([1, 2])
      expect(open.turnContext?.find((s) => s.key === 'cards')?.markdown).toBe('NOTE WITH Dana: contract')
    } finally {
      cardsSectionState.markdown = null
    }
  })

  it("carries the browser's zone for show and read_card only when it is a real IANA zone", async () => {
    expect((await rebuildChatSpec(claims(), { systemContext: { timeZone: 'America/New_York' } })).timeZone).toBe('America/New_York')
    expect((await rebuildChatSpec(claims(), { systemContext: { timeZone: 'Mars/Olympus' } })).timeZone).toBeUndefined()
    expect((await rebuildChatSpec(claims(), { systemContext: {} })).timeZone).toBeUndefined()
  })

  it('a turn in a live meeting advertises tell_note_taker up front; any other turn not at all', async () => {
    const live = await rebuildChatSpec(claims(), { systemContext: { liveCaptureId: 'cap-live' } })
    for (const n of LIVE_MEETING_TOOL_NAMES) expect(live.coreToolNames, n).toContain(n)
    const advertised = new Set(live.ceilingTools.map((t) => t.name))
    for (const n of live.coreToolNames) expect(advertised.has(n), n).toBe(true)
    const plain = await rebuildChatSpec(claims(), { systemContext: { attachedProjectIds: ['p1'] } })
    expect(plain.coreToolNames).not.toContain('tell_note_taker')
    // Not even through search_tools: the main chat's agent never passes things
    // to a call's note-taker (one-chat Slice 3); the live agent's chat does.
    expect(plain.ceilingTools.map((t) => t.name)).not.toContain('tell_note_taker')
  })

  it('a scoped agent whose ceiling excludes tell_note_taker: a live meeting does not widen core past it', async () => {
    ceilingState.agentToolCeiling = new Set(['list_actions', 'create_action'])
    const spec = await rebuildChatSpec(claims({ agentId: 'a6' }), { systemContext: { liveCaptureId: 'cap-live' } })
    expect(spec.coreToolNames).not.toContain('tell_note_taker')
  })

  it('people + companies attached → core is the union of both seed lists', async () => {
    const spec = await rebuildChatSpec(claims(), {
      systemContext: { attachedContactIds: ['c1'], attachedCompanyIds: ['co1'] },
    })
    const core = new Set(spec.coreToolNames)
    for (const n of [...PERSON_MENTION_TOOL_NAMES, ...COMPANY_MENTION_TOOL_NAMES]) expect(core.has(n), n).toBe(true)
  })

  it('scoped agent whose ceiling excludes get_company_overview: company mentions do NOT widen core past the ceiling', async () => {
    ceilingState.agentToolCeiling = new Set(['list_actions', 'create_action', 'list_contact_captures'])
    const spec = await rebuildChatSpec(claims({ agentId: 'a5' }), { systemContext: { attachedCompanyIds: ['co1'] } })
    const core = new Set(spec.coreToolNames)
    expect(core.has('list_contact_captures')).toBe(true)
    expect(core.has('get_company_overview')).toBe(false)
    expect(core.has('get_contact_details')).toBe(false)
    const ceilingSet = new Set(spec.ceiling!)
    for (const n of spec.coreToolNames) expect(ceilingSet.has(n), n).toBe(true)
  })

  it('browser tools ride every turn’s core, desktop or not (the browser runs in the cloud)', async () => {
    // The agent browser is on for everyone, so the edition ceiling allows them.
    for (const systemContext of [{}, { isDesktopClient: true }]) {
      const spec = await rebuildChatSpec(claims(), { systemContext })
      const core = new Set(spec.coreToolNames)
      for (const n of BROWSER_TOOL_NAMES) expect(core.has(n), n).toBe(true)
    }
  })

  it('isDesktopClient but the browser tools are outside the ceiling → NOT seeded (ceiling fences the seed)', async () => {
    // An agent ceiling without the browser stands in for a workspace that
    // switched the browser off. The seed must not widen the ceiling — the
    // exact bug that would advertise a tool the workspace can't run.
    ceilingState.agentToolCeiling = new Set(['list_actions', 'create_action'])
    const spec = await rebuildChatSpec(claims({ agentId: 'ab1' }), {
      systemContext: { isDesktopClient: true },
    })
    const core = new Set(spec.coreToolNames)
    for (const n of BROWSER_TOOL_NAMES) expect(core.has(n), n).toBe(false)
    const ceilingSet = new Set(spec.ceiling!)
    for (const n of spec.coreToolNames) expect(ceilingSet.has(n), n).toBe(true)
  })
})

describe('rebuildChatSpec — gatewayTelemetry (Phase A)', () => {
  beforeEach(() => {
    ceilingState.agentToolCeiling = null
    mcpState.toolNames = []
    planState.isPaid = true
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('flag off: gatewayTelemetry is absent (spec stays clean)', async () => {
    vi.stubEnv('GATEWAY_USER_TAGGING', '')
    const spec = await rebuildChatSpec(claims(), {})
    expect(spec.gatewayTelemetry).toBeUndefined()
  })

  it('flag on: carries the user + feature/env/ws/runtime tags', async () => {
    vi.stubEnv('GATEWAY_USER_TAGGING', 'all')
    vi.stubEnv('NODE_ENV', 'production')
    const spec = await rebuildChatSpec(claims({ userId: 'user-42', workspaceId: 'ws-9' }), {})
    expect(spec.gatewayTelemetry).toEqual({
      user: 'user-42',
      // feature 'ai_chat' matches the eve chat persist path's logUsage.
      tags: ['feature:ai_chat', 'env:production', 'ws:ws-9', 'runtime:eve'],
    })
  })

  it('flag on: present on the includeSkills return path too', async () => {
    vi.stubEnv('GATEWAY_USER_TAGGING', 'all')
    vi.stubEnv('NODE_ENV', 'production')
    const spec = await rebuildChatSpec(claims(), {}, { includeSkills: true })
    expect(spec.gatewayTelemetry?.tags).toContain('feature:ai_chat')
    expect(spec.gatewayTelemetry?.tags).toContain('runtime:eve')
  })
})

describe('rebuildChatSpec — live-capture talk-back', () => {
  beforeEach(() => {
    ceilingState.agentToolCeiling = null
    mcpState.toolNames = []
    vi.clearAllMocks()
  })

  it('a turn the server does not find live: no liveCaptureId reaches the prompt builder, no note-taker line', async () => {
    liveGate.live = false
    try {
      const spec = await rebuildChatSpec(claims(), { systemContext: { liveCaptureId: 'cap-1', timeZone: 'UTC' } })
      expect(buildChatSystemPrompt).toHaveBeenCalledWith(expect.objectContaining({ systemContext: { timeZone: 'UTC' } }))
      expect(spec.coreToolNames).not.toContain('tell_note_taker')
      expect(spec.ceilingTools.map((t) => t.name)).not.toContain('tell_note_taker')
    } finally {
      liveGate.live = true
    }
  })

  it('hands the turn’s liveCaptureId to the prompt builder under the TOKEN’s owner + workspace', async () => {
    // buildChatSystemPrompt → buildLiveCaptureContext(supabase, liveCaptureId,
    // workspaceId, userId) is what injects the live-meeting block, gated on the
    // capture's OWNER — so the ids it receives must come from the verified token.
    await rebuildChatSpec(claims({ userId: 'owner-1', workspaceId: 'ws-live' }), {
      systemContext: { liveCaptureId: 'cap-1' },
    })
    expect(buildChatSystemPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'owner-1',
        workspaceId: 'ws-live',
        systemContext: { liveCaptureId: 'cap-1' },
      }),
    )
  })
})

describe('rebuildChatSpec — the /api/device/ask surface', () => {
  beforeEach(() => {
    ceilingState.agentToolCeiling = null
    mcpState.toolNames = []
    planState.isPaid = true
    vi.clearAllMocks()
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  const device = () => claims({ surface: 'device_ask', conversationId: 'conv-dev' })

  it('runs the fixed device model (Flash, thinking off: its route has 60 s) whatever the question says, never the thread model', async () => {
    const spec = await rebuildChatSpec(device(), { route: turnRouteSignals('think hard, step by step') })
    expect(spec.model).toBe('deepseek/deepseek-v4-flash')
    expect(spec.modelPolicy).toEqual(deepseekSurfacePolicy('deepseek-v4-flash', 'off'))
    // No helpers on the device: no roster.
    expect(spec.systemPrompt).not.toContain('## Models for helpers')
    expect(spec.modelRoute).toEqual({ tier: 'fast', by: 'fixed', signals: ['device_ask'], reasoning: 'none' })
  })

  it('tags Gateway attribution with the device_ask feature key', async () => {
    vi.stubEnv('GATEWAY_USER_TAGGING', 'all')
    vi.stubEnv('NODE_ENV', 'production')
    const spec = await rebuildChatSpec(device(), {})
    expect(spec.gatewayTelemetry?.tags).toContain('feature:device_ask')
    expect(spec.gatewayTelemetry?.tags).not.toContain('feature:ai_chat')
    expect(spec.gatewayTelemetry?.tags).toContain('runtime:eve')
  })

  it('split variant: the device note stays under the identity line and the clock rides turnContext (the device ask still gets it)', async () => {
    const spec = await rebuildChatSpec(device(), {}, { includeSkills: true, splitTurnContext: true })
    const blocks = spec.systemPrompt.split('\n\n')
    expect(blocks[0]).toBe(modelIdentityNote('deepseek-v4-flash'))
    expect(blocks[1]).toBe(DEVICE_ASK_NOTE)
    expect(blocks[2]).toBe('SYSTEM_PROMPT')
    expect(spec.systemPrompt).not.toContain('Current date and time')
    expect(spec.turnContext).toEqual([{ key: 'time', markdown: 'Current date and time: CLOCK' }])
  })

  it('carries the no-picker device note under the identity line (both spec variants); chat never does', async () => {
    const spec = await rebuildChatSpec(device(), {})
    const lines = spec.systemPrompt.split('\n\n')
    expect(lines[0]).toBe(modelIdentityNote('deepseek-v4-flash'))
    expect(lines[1]).toBe(DEVICE_ASK_NOTE)
    expect(spec.systemPrompt).toContain('SYSTEM_PROMPT')
    const withSkills = await rebuildChatSpec(device(), {}, { includeSkills: true })
    expect(withSkills.systemPrompt.split('\n\n')[1]).toBe(DEVICE_ASK_NOTE)
    const chat = await rebuildChatSpec(claims(), {})
    expect(chat.systemPrompt).not.toContain(DEVICE_ASK_NOTE)
  })

  it('the same ceiling as chat (no agent → edition ∪ external) apart from the surface exclusion', async () => {
    mcpState.toolNames = ['mcp__jira__create_issue', 'mcp_confirm_call']
    const [d, c] = await Promise.all([rebuildChatSpec(device(), {}), rebuildChatSpec(claims(), {})])
    const minusConfirm = (names: readonly string[] | null) =>
      // The card tools too: the device draws no cards. And the ones its 60 s budget can't hold.
      names?.filter((n) => n !== 'mcp_confirm_call' && n !== 'show' && !isChatNativeTool(n) && !isAttendedOnlyTool(n) && !DEVICE_ONLY_EXCLUSIONS.includes(n)) ?? null
    expect(d.ceiling).toEqual(minusConfirm(c.ceiling))
    expect(c.coreToolNames).toContain('show')
    expect(d.coreToolNames).not.toContain('show')
    expect(d.ceilingTools.map((t) => t.name)).not.toContain('show')
    // The main agent's relay to the bots (bots-v4 Phase A3) is the main chat's, never the device's.
    for (const name of ['send_bot_message', 'wait_for_bot_reply']) {
      expect(c.ceilingTools.map((t) => t.name), name).toContain(name)
      expect(d.ceilingTools.map((t) => t.name), name).not.toContain(name)
    }
    expect(d.ceilingTools.map((t) => t.name)).toEqual(minusConfirm(c.ceilingTools.map((t) => t.name)))
    // get_tool_approval_result rides up front only beside mcp_confirm_call (GEN-1172): the device holds no calls.
    expect(c.coreToolNames).toContain('get_tool_approval_result')
    expect(d.coreToolNames).toEqual(minusConfirm(c.coreToolNames)?.filter((n) => n !== 'get_tool_approval_result'))
    // The gated external tool itself stays (it answers awaiting_user_approval).
    expect(d.ceilingTools.map((t) => t.name)).toContain('mcp__jira__create_issue')
  })

  it('mcp_confirm_call is STRUCTURALLY absent on the unattended device (ceiling, advertised tools, core); chat keeps it', async () => {
    mcpState.toolNames = ['mcp__jira__create_issue', 'mcp_confirm_call']
    const d = await rebuildChatSpec(device(), {})
    expect(d.ceiling ?? []).not.toContain('mcp_confirm_call')
    expect(d.ceilingTools.map((t) => t.name)).not.toContain('mcp_confirm_call')
    expect(d.coreToolNames).not.toContain('mcp_confirm_call')
    const c = await rebuildChatSpec(claims(), {})
    expect(c.ceilingTools.map((t) => t.name)).toContain('mcp_confirm_call')
  })

  it('never carries the strong hint (no helpers on the device)', async () => {
    const spec = await rebuildChatSpec(device(), { route: turnRouteSignals('Fix this: SELECT a, b FROM t') }, { splitTurnContext: true })
    expect(spec.turnContext?.map((s) => s.key)).not.toContain('route')
  })
})

describe('rebuildChatSpec — a text turn (surface sms, docs/plans/text-and-calling.md)', () => {
  beforeEach(() => {
    ceilingState.agentToolCeiling = null
    mcpState.toolNames = []
    planState.isPaid = true
    vi.clearAllMocks()
  })

  const text = () => claims({ server: 'channel_turn', surface: 'sms' })

  it('says the person is texting in its own turn-context section, never in the stable prompt; a chat turn has none', async () => {
    const spec = await rebuildChatSpec(text(), {}, { splitTurnContext: true })
    expect(spec.turnContext).toContainEqual({ key: 'channel', markdown: SMS_TURN_NOTE })
    expect(spec.systemPrompt).not.toContain('They are texting you')
    expect(SMS_TURN_NOTE).toMatch(/no markdown/)
    expect(SMS_TURN_NOTE).toMatch(/never call show or ask_user/)
    const chat = await rebuildChatSpec(claims(), {}, { splitTurnContext: true })
    expect(chat.turnContext?.map((s) => s.key)).not.toContain('channel')
  })

  it('runs Fast as a text turn, billed and tagged as ai_chat', async () => {
    const spec = await rebuildChatSpec(text(), {})
    expect(spec.modelRoute).toMatchObject({ tier: 'fast', signals: ['channel_turn'] })
    expect(spec.systemPrompt).not.toContain(DEVICE_ASK_NOTE)
  })

  it('advertises the person’s tools minus what needs a screen: no cards, no confirm, no relay', async () => {
    mcpState.toolNames = ['mcp__jira__create_issue', 'mcp_confirm_call']
    const [t, c] = await Promise.all([rebuildChatSpec(text(), {}), rebuildChatSpec(claims(), {})])
    const names = t.ceilingTools.map((x) => x.name)
    for (const name of ['show', 'mcp_confirm_call', 'send_bot_message']) expect([name, names.includes(name)]).toEqual([name, false])
    // A background helper stays: its report follows the person back by text (Liam, 2026-10-26).
    expect(names).toContain('start_helper')
    expect(names).toContain('mcp__jira__create_issue')
    // Everything else the in-app chat has, the text turn has.
    const excluded = new Set(c.ceilingTools.map((x) => x.name).filter((n) => !names.includes(n)))
    for (const name of excluded) expect([name, isChatNativeTool(name) || isAttendedOnlyTool(name) || ['show', 'read_card', 'mcp_confirm_call', 'generate_email_drafts', 'draft_followup_email'].includes(name) || BROWSER_TOOL_NAMES.includes(name)]).toEqual([name, true])
  })
})

describe('settleJevTier (the enforce path, shipped off behind JEV_TIER_MODE)', () => {
  const undecided = () => ({ ...routeChatTurn(turnRouteSignals('x'.repeat(300)), 'person'), undecided: true, askJev: true })
  afterEach(() => vi.useRealTimers())

  it('an accepted think replaces the rules\' Fast (by: jev); fast keeps Fast (by: jev); no answer keeps the rules', async () => {
    expect(await settleJevTier(undecided(), Promise.resolve('think'))).toMatchObject({ tier: 'think', by: 'jev', reasoning: 'high' })
    expect(await settleJevTier(undecided(), Promise.resolve('fast'))).toMatchObject({ tier: 'fast', by: 'jev' })
    expect(await settleJevTier(undecided(), Promise.resolve(null))).toMatchObject({ tier: 'fast', by: 'rule' })
  })

  it('waits at most the grace after the loads: a late answer is Fast, by: timeout', async () => {
    vi.useFakeTimers()
    const never = new Promise<'think' | 'fast' | null>(() => {})
    const settled = settleJevTier(undecided(), never)
    await vi.advanceTimersByTimeAsync(JEV_TIER_GRACE_MS)
    expect(await settled).toMatchObject({ tier: 'fast', by: 'timeout', signals: expect.arrayContaining(['jev_late']) })
  })
})

describe('rebuildChatSpec — the canon registry (canon documents D1)', () => {
  afterEach(() => {
    canonState.section = ''
  })

  it('rides the stable prompt right after the skills section, on both return paths', async () => {
    canonState.section = '\n\n## Canon documents\n- `product`: Product.'
    const withSkills = await rebuildChatSpec(claims(), {}, { includeSkills: true, splitTurnContext: true })
    expect(withSkills.systemPrompt.endsWith('## Canon documents\n- `product`: Product.')).toBe(true)
    const plain = await rebuildChatSpec(claims(), {}, { splitTurnContext: true })
    expect(plain.systemPrompt).toBe(`${THREAD}SYSTEM_PROMPT\n\n## Canon documents\n- \`product\`: Product.`)
  })

  it('adds nothing when the workspace has no canon (hide empty)', async () => {
    const plain = await rebuildChatSpec(claims(), {}, { splitTurnContext: true })
    expect(plain.systemPrompt).toBe(`${THREAD}SYSTEM_PROMPT`)
  })
})

describe('rebuildChatSpec — the product-facts rider and read_canon (canon D1)', () => {
  afterEach(() => {
    canonState.section = ''
  })

  it('a turn that needs product facts carries them as a turn-context section, outside the stable prompt', async () => {
    const spec = await rebuildChatSpec(claims(), { route: turnRouteSignals('what is our pricing?') }, { splitTurnContext: true })
    expect(spec.turnContext).toContainEqual({ key: 'product-facts', markdown: 'PRODUCT FACTS' })
    expect(spec.systemPrompt).not.toContain('PRODUCT FACTS')
  })

  it('a turn about something else carries none', async () => {
    const spec = await rebuildChatSpec(claims(), { route: turnRouteSignals('move ENG-42 to done') }, { splitTurnContext: true })
    expect(spec.turnContext?.some((s) => s.key === 'product-facts')).toBe(false)
  })

  it('read_canon is advertised up front only when the workspace has canon documents', async () => {
    const none = await rebuildChatSpec(claims(), {}, { splitTurnContext: true })
    expect(none.coreToolNames).not.toContain('read_canon')
    canonState.section = '\n\n## Canon documents\n- `product`: Product.'
    const some = await rebuildChatSpec(claims(), {}, { splitTurnContext: true })
    expect(some.coreToolNames).toContain('read_canon')
  })
})
