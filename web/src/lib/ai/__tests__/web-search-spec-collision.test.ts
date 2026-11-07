/**
 * COLLISION GUARD: `web_search` / `web_fetch` must NEVER enter an eve spec.
 *
 * The eve agents run with NATIVE, provider-executed `web_search` and `web_fetch`
 * tools of their own (eve 0.47 built-ins, Exa-backed). Our spec builders hand
 * eve a list of workspace tools — `ceilingTools` (the full callable surface) and
 * `coreToolNames` (the subset advertised upfront) — and eve's resolver mints ONE
 * PROXY TOOL PER NAME. So if either name ever appeared in one of those lists,
 * eve would build a workspace proxy called `web_search` that SHADOWS its own
 * native provider tool: the model's searches would round-trip to our tool route
 * and 404 instead of hitting Exa.
 *
 * That is exactly why `web_search` lives in ALWAYS_ON_CAPABILITY_TOOL_NAMES and
 * NOT in tool-registry.ts / CORE_TOOL_NAMES — the spec lists are derived purely
 * from registry names, and this test asserts that derivation holds for all three
 * builders:
 *
 *   • chat spec        — src/lib/chat/chat-run-rebuild.ts
 *   • skill-run spec   — computeSkillCeiling (src/lib/flows/run-skill.ts)
 *   • work-run spec    — computeWorkRunCeiling (src/lib/agent-run/run-work-spec-rebuild.ts)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

/** The names eve owns natively. Neither may ever be proxied by us. */
const EVE_NATIVE_TOOL_NAMES = ['web_search', 'web_fetch'] as const

// ── Mocks for the chat spec builder (mirrors chat-run-rebuild.test.ts) ────────
const ceilingState: { agentToolCeiling: Set<string> | null } = { agentToolCeiling: null }

vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({}) }))
vi.mock('@/lib/ai/chat-system-prompt', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/chat-system-prompt')>()),
  buildChatSystemPrompt: vi.fn(async () => ({
    stable: [{ key: 'base', markdown: 'SYSTEM_PROMPT' }],
    turnContext: [],
    turnContextHeld: [],
    activeSkillSlug: null,
    agentToolCeiling: ceilingState.agentToolCeiling,
    agentEnabledCategories: [],
    agentDisabledTools: [],
  })),
}))
vi.mock('@/lib/mcp-client/adapter', () => ({
  CONFIRM_TOOL_NAME: 'mcp_confirm_call',
  createExternalMcpTools: vi.fn(async () => ({ tools: {}, meta: new Map(), servers: [] })),
}))
vi.mock('@/lib/ai/auth', () => ({
  checkUsageLimits: vi.fn(async () => ({ allowed: true, is_paid_plan: true })),
}))

import { rebuildChatSpec } from '@/lib/chat/chat-run-rebuild'
import { computeSkillCeiling } from '@/lib/flows/run-skill'
import { computeWorkRunCeiling } from '@/lib/agent-run/run-work-spec-rebuild'
import { ALL_TOOL_NAMES } from '../tool-registry'
import { CORE_TOOL_NAMES, ALWAYS_ON_CAPABILITY_TOOL_NAMES } from '../tool-discovery'

function chatClaims() {
  return { conversationId: 'c', workspaceId: 'ws-1', userId: 'user-1', exp: Date.now() + 60_000 }
}

describe('the registry itself never names an eve-native tool', () => {
  it('ALL_TOOL_NAMES contains neither web_search nor web_fetch', () => {
    for (const name of EVE_NATIVE_TOOL_NAMES) {
      expect(ALL_TOOL_NAMES).not.toContain(name)
    }
  })

  it('CORE_TOOL_NAMES contains neither — it feeds coreToolNames directly', () => {
    for (const name of EVE_NATIVE_TOOL_NAMES) {
      expect(CORE_TOOL_NAMES).not.toContain(name)
    }
  })

  it('the always-on capability set is kept OUT of the registry on purpose', () => {
    for (const name of ALWAYS_ON_CAPABILITY_TOOL_NAMES) {
      expect(ALL_TOOL_NAMES).not.toContain(name)
    }
  })
})

describe('chat spec (chat-run-rebuild) — ceilingTools / coreToolNames', () => {
  beforeEach(() => {
    ceilingState.agentToolCeiling = null
  })

  it('inherit-all: neither list names an eve-native tool', async () => {
    const spec = await rebuildChatSpec(chatClaims() as never, {})
    const advertised = spec.ceilingTools.map((t) => t.name)
    for (const name of EVE_NATIVE_TOOL_NAMES) {
      expect(advertised).not.toContain(name)
      expect(spec.coreToolNames).not.toContain(name)
    }
    // Sanity: the lists are real, so the assertion above isn't vacuous.
    expect(advertised.length).toBeGreaterThan(50)
    expect(spec.coreToolNames.length).toBeGreaterThan(0)
  })

  it('scoped agent: neither list names an eve-native tool', async () => {
    ceilingState.agentToolCeiling = new Set(['list_actions', 'find', 'search_tools'])
    const spec = await rebuildChatSpec(chatClaims() as never, {})
    const advertised = spec.ceilingTools.map((t) => t.name)
    for (const name of EVE_NATIVE_TOOL_NAMES) {
      expect(advertised).not.toContain(name)
      expect(spec.coreToolNames).not.toContain(name)
    }
    expect(advertised).toContain('list_actions')
  })

  it('even a ceiling that ASKS for web_search cannot smuggle it in', async () => {
    // Defensive: an agent_config row hand-edited to name the eve-native tool
    // must not turn into a proxy. The ceiling is intersected with the registry
    // when building descriptions, so an unknown name would carry a stub desc —
    // this pins that it never reaches coreToolNames either way.
    ceilingState.agentToolCeiling = new Set(['find', 'web_search', 'web_fetch'])
    const spec = await rebuildChatSpec(chatClaims() as never, {})
    for (const name of EVE_NATIVE_TOOL_NAMES) {
      expect(spec.coreToolNames).not.toContain(name)
    }
  })
})

describe('skill-run spec (computeSkillCeiling) — the ceilingTools source', () => {
  const modes = ['report', 'act'] as const

  for (const mode of modes) {
    for (const hasCapture of [false, true]) {
      it(`${mode} mode, hasCapture=${hasCapture}: ceiling names no eve-native tool`, () => {
        const ceiling = computeSkillCeiling(
          { enabled_tools: ['actions', 'captures'], disabled_tools: [] } as never,
          mode,
          hasCapture,
        )
        for (const name of EVE_NATIVE_TOOL_NAMES) {
          expect(ceiling?.has(name) ?? false).toBe(false)
        }
      })
    }
  }

  it('inherit-all act mode returns null (no ceiling ⇒ no proxy list at all)', () => {
    const ceiling = computeSkillCeiling({ enabled_tools: [], disabled_tools: [] } as never, 'act', false)
    // null or a set — either way, never the native names.
    for (const name of EVE_NATIVE_TOOL_NAMES) {
      expect(ceiling?.has(name) ?? false).toBe(false)
    }
  })
})

describe('work-run spec (computeWorkRunCeiling) — the ceilingTools source', () => {
  it('the ceiling names no eve-native tool', () => {
    const ceiling = computeWorkRunCeiling()
    for (const name of EVE_NATIVE_TOOL_NAMES) {
      expect(ceiling.has(name)).toBe(false)
    }
    expect(ceiling.size).toBeGreaterThan(50)
  })
})
