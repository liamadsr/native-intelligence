/**
 * Parity test: the eve internal spec REBUILD produces the SAME system prompt and
 * ceiling that assembleSkillRun would, because both call the extracted shared
 * helpers (buildSkillSystemPrompt / computeSkillCeiling) over the same skill row.
 *
 * We mock the DB read + base-prompt build to a fixed recipe, run rebuildEveSpec
 * for a set of {mode, hasCapture} cases, and assert its systemPrompt/ceiling
 * equal what the shared helpers produce directly for that recipe — the guarantee
 * that a run assembled on the dispatch and rebuilt on the internal route match.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { chatModelPolicy, gatewayModelSlug } from '@/lib/ai/models'

const BASE_PROMPT = 'BASE SYSTEM PROMPT'

// A fixed recipe the mocked getServiceClient returns for any skill lookup.
const RECIPE = {
  name: 'Weekly Digest',
  system_prompt: 'Summarize the week.',
  agent_config: {
    enabled_tools: ['documents', 'actions'],
    disabled_tools: ['delete_action'],
    context_rules: ['Be concise', 'Cite sources'],
    response_style: { format: 'markdown', tone: 'warm', always_cite_sources: true },
    output_contract: 'prose' as const,
    model_tier: undefined as 'fast' | 'think' | 'strong' | undefined,
  },
}

vi.mock('@/lib/admin', () => ({
  getServiceClient: () => {
    const chain = () => {
      const c: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'or', 'limit']) c[m] = () => c
      c.maybeSingle = async () => ({ data: RECIPE, error: null })
      return c
    }
    return { from: () => chain() }
  },
}))

const buildSystemPromptSpy = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => 'BASE SYSTEM PROMPT'))
vi.mock('@/lib/ai/system-prompt', () => ({
  buildSystemPrompt: buildSystemPromptSpy,
}))

import { rebuildEveSpec } from '../skill-run-rebuild'
import { buildSkillSystemPrompt, computeSkillCeiling } from '../run-skill'
import { ALL_CATEGORY_IDS, ALL_TOOL_NAMES, ATTENDED_ONLY_TOOL_NAMES, CHAT_NATIVE_TOOL_NAMES, getToolDefinition } from '@/lib/ai/tool-registry'
import { withToolGuide } from '@/lib/ai/tool-guides'
import type { RunTokenClaims } from '../skill-run-token'

function claims(over: Partial<RunTokenClaims> = {}): RunTokenClaims {
  return {
    workspaceId: 'ws-1',
    runAsUserId: 'user-1',
    skillId: 'skill-1',
    mode: 'report',
    hasCapture: false,
    outputContract: 'prose',
    model: 'claude-haiku-4-5-20251001',
    exp: Date.now() + 60_000,
    ...over,
  }
}

describe('rebuildEveSpec parity with assembleSkillRun helpers', () => {
  const CASES: Array<Partial<RunTokenClaims>> = [
    { mode: 'report', hasCapture: false },
    { mode: 'report', hasCapture: true },
    { mode: 'act', hasCapture: false },
    { mode: 'act', hasCapture: true },
  ]

  for (const over of CASES) {
    it(`mode=${over.mode} hasCapture=${over.hasCapture}: prompt + ceiling match the shared helpers`, async () => {
      const c = claims(over)
      const rebuilt = await rebuildEveSpec(c)
      expect(rebuilt).not.toBeNull()

      // System prompt: identical to buildSkillSystemPrompt over the same recipe.
      const expectedPrompt = buildSkillSystemPrompt(
        RECIPE.name,
        RECIPE.system_prompt,
        RECIPE.agent_config,
        BASE_PROMPT,
      )
      expect(rebuilt!.systemPrompt).toBe(expectedPrompt)

      // Ceiling: identical to computeSkillCeiling over the same recipe. null
      // (inherit-all) is PRESERVED as null, never collapsed to []. (This recipe
      // enables specific categories so it's always a non-null set here; the
      // inherit-all case has its own test below.)
      const expectedCeiling = computeSkillCeiling(RECIPE.agent_config, c.mode!, c.hasCapture!)
      if (expectedCeiling === null) {
        expect(rebuilt!.ceiling).toBeNull()
      } else {
        expect(rebuilt!.ceiling).not.toBeNull()
        expect([...rebuilt!.ceiling!].sort()).toEqual([...expectedCeiling].sort())
      }

      // ceilingTools: one {name, description} per ceiling tool (minus the verdict
      // terminating tool), descriptions from the same registry, each with its
      // usage notes after it (src/lib/ai/tool-guides.ts).
      for (const t of rebuilt!.ceilingTools) {
        expect(t.name).not.toBe('submit_run_verdict')
        const def = getToolDefinition(t.name)
        expect(t.description).toBe(def ? withToolGuide(t.name, def.description) : `Workspace tool: ${t.name}`)
      }
      // Model is resolved to its Gateway CATALOG slug server-side (mirrors
      // chat-run-rebuild.ts): the claims' bare app id becomes gatewayModelSlug(id).
      expect(rebuilt!.model).toBe(gatewayModelSlug(c.model))
    })
  }

  it('provider-qualifies the model server-side for anthropic / deepseek ids', async () => {
    // The eve agent passes spec.model through verbatim, so the qualification MUST
    // happen here — a bare DeepSeek id would otherwise get 'anthropic/'
    // prefixed and misroute. Each bare claims.model → its real gateway slug.
    const cases: Array<[string, string]> = [
      ['claude-haiku-4-5-20251001', 'anthropic/claude-haiku-4.5'],
      ['deepseek-v4-flash', 'deepseek/deepseek-v4-flash'],
      ['claude-sonnet-5-5', 'anthropic/claude-sonnet-5.5'],
    ]
    for (const [bare, slug] of cases) {
      const rebuilt = await rebuildEveSpec(claims({ model: bare }))
      expect(rebuilt, bare).not.toBeNull()
      expect(rebuilt!.model, bare).toBe(slug)
    }
  })

  it('a skill run thinks by default (the Think tier: Flash at DeepSeek\'s own effort, on private hosts)', async () => {
    for (const id of ['deepseek-v4-flash', 'deepseek-v4-pro'] as const) {
      const rebuilt = await rebuildEveSpec(claims({ model: id }))
      expect(rebuilt!.modelPolicy, id).toEqual(chatModelPolicy(id, 'standard'))
      expect(rebuilt!.modelPolicy?.providerOptions, id).toEqual({ deepseek: { thinking: { type: 'enabled' } } })
    }
    // A model off the catalog is called as before (no policy).
    expect(await rebuildEveSpec(claims({ model: 'acme-1' }))).not.toHaveProperty('modelPolicy')
  })

  it('the skill\'s own model_tier: Fast turns thinking off; a Strong token runs STRONG_MODEL\'s policy', async () => {
    RECIPE.agent_config.model_tier = 'fast'
    try {
      expect((await rebuildEveSpec(claims({ model: 'deepseek-v4-flash' })))!.modelPolicy).toEqual(chatModelPolicy('deepseek-v4-flash', 'light'))
    } finally {
      RECIPE.agent_config.model_tier = undefined
    }
    expect((await rebuildEveSpec(claims({ model: 'claude-sonnet-5-5' })))!.modelPolicy).toEqual({ contextWindowTokens: 1_000_000 })
  })

  it('inherit-all (act + all categories): ceiling is null and ceilingTools enumerates the FULL registry', async () => {
    // A skill that enables EVERY category in act mode → computeSkillCeiling
    // returns null (inherit-all). The rebuild MUST preserve null AND advertise the
    // full workspace tool surface (the gateway path's pickPermittedTools(null)
    // grants the whole createTools() map). Regression guard for the bug where null
    // collapsed to [] and the eve session got ZERO tools.
    const inheritAllRecipe = {
      name: 'Do Anything',
      system_prompt: 'You can use every tool.',
      agent_config: { enabled_tools: [...ALL_CATEGORY_IDS] },
    }
    const mod = await import('@/lib/admin')
    vi.spyOn(mod, 'getServiceClient').mockReturnValueOnce({
      from: () => {
        const cc: Record<string, unknown> = {}
        for (const m of ['select', 'eq', 'or', 'limit']) cc[m] = () => cc
        cc.maybeSingle = async () => ({ data: inheritAllRecipe, error: null })
        return cc
      },
    } as never)

    const rebuilt = await rebuildEveSpec(claims({ mode: 'act', hasCapture: false }))
    expect(rebuilt).not.toBeNull()

    // Sanity: this config really is inherit-all.
    expect(computeSkillCeiling(inheritAllRecipe.agent_config, 'act', false)).toBeNull()

    // ceiling is the PRESERVED null sentinel — not [].
    expect(rebuilt!.ceiling).toBeNull()

    // ceilingTools enumerates the full registry minus the chat-native tools
    // (only the main chat runs start_helper), the attended-only ones (bots v3
    // Phase 5: nobody is in an unattended run to have asked) and the verdict
    // terminating tool, which is never a registry tool. NOT empty.
    expect(rebuilt!.ceilingTools.length).toBe(ALL_TOOL_NAMES.length - CHAT_NATIVE_TOOL_NAMES.size - ATTENDED_ONLY_TOOL_NAMES.size)
    const advertised = new Set(rebuilt!.ceilingTools.map((t) => t.name))
    for (const name of ALL_TOOL_NAMES) {
      expect(advertised.has(name), name).toBe(!CHAT_NATIVE_TOOL_NAMES.has(name) && !ATTENDED_ONLY_TOOL_NAMES.has(name))
    }
    expect(advertised.has('start_helper')).toBe(false)
    expect(advertised.has('submit_run_verdict')).toBe(false)
    // Descriptions come from the same registry.
    for (const t of rebuilt!.ceilingTools) {
      const def = getToolDefinition(t.name)
      expect(t.description).toBe(def ? withToolGuide(t.name, def.description) : `Workspace tool: ${t.name}`)
    }
  })

  it('returns null when the skill row is missing', async () => {
    // Re-mock getServiceClient to return no row for this one case.
    const mod = await import('@/lib/admin')
    vi.spyOn(mod, 'getServiceClient').mockReturnValueOnce({
      from: () => {
        const c: Record<string, unknown> = {}
        for (const m of ['select', 'eq', 'or', 'limit']) c[m] = () => c
        c.maybeSingle = async () => ({ data: null, error: null })
        return c
      },
    } as never)
    const rebuilt = await rebuildEveSpec(claims())
    expect(rebuilt).toBeNull()
  })
})

describe('rebuildEveSpec — gatewayTelemetry (Phase A)', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('flag off: gatewayTelemetry is absent (spec stays clean)', async () => {
    vi.stubEnv('GATEWAY_USER_TAGGING', '')
    const rebuilt = await rebuildEveSpec(claims())
    expect(rebuilt).not.toBeNull()
    expect(rebuilt!.gatewayTelemetry).toBeUndefined()
  })

  it('flag on: carries the run-as user + feature/env/ws/runtime/skill tags', async () => {
    vi.stubEnv('GATEWAY_USER_TAGGING', 'all')
    vi.stubEnv('NODE_ENV', 'production')
    const rebuilt = await rebuildEveSpec(
      claims({ runAsUserId: 'user-77', workspaceId: 'ws-3', skillId: 'skill-abc' }),
    )
    expect(rebuilt!.gatewayTelemetry).toEqual({
      user: 'user-77',
      // feature 'flow_run_skill' matches the gateway path's logUsage in run-skill.ts.
      tags: ['feature:flow_run_skill', 'env:production', 'ws:ws-3', 'runtime:eve', 'skill:skill-abc'],
    })
  })
})

describe('rebuildEveSpec — web access honors the USE_GATEWAY kill switch (WS-3a)', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    buildSystemPromptSpy.mockClear()
  })

  it("the prompt is built for the run's workspace with webAccess 'auto' (tracks the switch, like the retired gateway path)", async () => {
    await rebuildEveSpec(claims())
    const opts = buildSystemPromptSpy.mock.calls.at(-1)?.[3]
    // The workspace scopes the member row and key contacts: a runner with rows
    // in several workspaces must not get another workspace's.
    expect(opts).toEqual({ workspaceId: claims().workspaceId, webAccess: 'auto' })
  })

  it('Gateway ON (default): spec.webAccess is true — the skill-runner keeps its web tools', async () => {
    vi.stubEnv('USE_GATEWAY', '')
    const rebuilt = await rebuildEveSpec(claims())
    expect(rebuilt!.webAccess).toBe(true)
  })

  it('USE_GATEWAY=false: spec.webAccess is false — the skill-runner stubs out web_search/web_fetch', async () => {
    vi.stubEnv('USE_GATEWAY', 'false')
    const rebuilt = await rebuildEveSpec(claims())
    expect(rebuilt!.webAccess).toBe(false)
  })
})

describe("rebuildEveSpec on the person's own ChatGPT plan (the free tier)", () => {
  it("a token signed with the plan model: the plan spec, web on the person's plan, no Gateway attribution or host routing", async () => {
    buildSystemPromptSpy.mockClear()
    const rebuilt = await rebuildEveSpec(claims({ model: 'chatgpt-plan/gpt-6-luna' }))
    expect(rebuilt).toMatchObject({
      model: 'openai/gpt-6-luna',
      webAccess: true,
      chatgptPlan: { model: 'gpt-6-luna', helperModel: 'gpt-6-luna', reasoning: 'medium' },
    })
    expect(rebuilt).not.toHaveProperty('modelPolicy')
    expect(rebuilt).not.toHaveProperty('gatewayTelemetry')
    // OpenAI's own web search on the plan: the prompt carries the web guidance, whatever the Gateway switch says.
    expect(buildSystemPromptSpy.mock.calls.at(-1)?.[3]).toMatchObject({ webAccess: 'always' })
    // The run's own prompt and tools, as for anyone.
    expect(rebuilt!.ceilingTools.length).toBeGreaterThan(0)
  })

  it('a Fast skill thinks less on the plan, as it does on Native Intelligence', async () => {
    RECIPE.agent_config.model_tier = 'fast'
    try {
      expect((await rebuildEveSpec(claims({ model: 'chatgpt-plan/gpt-6-luna' })))!.chatgptPlan!.reasoning).toBe('low')
    } finally {
      RECIPE.agent_config.model_tier = undefined
    }
  })

  it('any other token runs as before', async () => {
    const rebuilt = await rebuildEveSpec(claims())
    expect(rebuilt).not.toHaveProperty('chatgptPlan')
    expect(buildSystemPromptSpy.mock.calls.at(-1)?.[3]).toMatchObject({ webAccess: 'auto' })
  })
})
