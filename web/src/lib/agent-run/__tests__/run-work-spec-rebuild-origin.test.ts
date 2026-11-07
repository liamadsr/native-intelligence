/**
 * Sequence step 3: a work run's tool profile and loop-guard depth come from its
 * ROW (`agent_run.origin`, `origin_depth`). An attempted run is advertised and
 * enforced the drafting ceiling (plan A.3); a person-started run keeps today's.
 */
import { describe, it, expect, vi } from 'vitest'

const row: { origin: string | null; model_tier?: string | null; helper_model?: string | null; server_helper?: string | null } = { origin: null }
vi.mock('@/lib/admin', () => ({
  getServiceClient: () => ({
    from: () => {
      const api: Record<string, unknown> = {
        select: () => api,
        eq: () => api,
        maybeSingle: async () => ({
          data: { id: 'run-1', kind: 'workspace', origin: row.origin, model_tier: row.model_tier ?? null, helper_model: row.helper_model ?? null, server_helper: row.server_helper ?? null },
          error: null,
        }),
      }
      return api
    },
  }),
}))
const buildSystemPrompt = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => 'base prompt'))
vi.mock('@/lib/ai/system-prompt', () => ({ buildSystemPrompt }))
vi.mock('@/lib/ai/gateway-telemetry', () => ({ gatewayTelemetryValues: () => null }))
// Whether the run's person is on their own ChatGPT plan (the free tier).
const chatgptPlanFor = vi.hoisted(() => vi.fn(async (_userId: unknown) => false))
vi.mock('@/lib/chatgpt/plan-route', () => ({ chatgptPlanFor }))

import {
  ceilingForWorkRun,
  computeDraftingCeiling,
  computeWorkRunCeiling,
  rebuildWorkRunSpec,
  statusChangeDepthForWorkRun,
} from '../run-work-spec-rebuild'
import { chatModelPolicy } from '@/lib/ai/models'
import { toolGuide, withToolGuide } from '@/lib/ai/tool-guides'
import { getToolDefinition } from '@/lib/ai/tool-registry'

const CLAIMS = { agentRunId: 'run-1', workspaceId: 'ws-1', userId: 'user-1', exp: Date.now() + 600_000 }

describe('ceilingForWorkRun', () => {
  it('a person-started run (user, or a row with no origin) keeps the work-run ceiling', () => {
    expect([...ceilingForWorkRun('user')].sort()).toEqual([...computeWorkRunCeiling()].sort())
    expect([...ceilingForWorkRun(null)].sort()).toEqual([...computeWorkRunCeiling()].sort())
    expect(ceilingForWorkRun(undefined).has('create_action')).toBe(true)
  })

  it('an attempted run — and any origin nobody has decided on — gets the drafting ceiling (fails closed)', () => {
    const drafting = [...computeDraftingCeiling()].sort()
    for (const origin of ['attempt', 'delegation', 'loop', 'something-new']) {
      expect([...ceilingForWorkRun(origin)].sort(), origin).toEqual(drafting)
    }
    // Chat work is drafting bounded by its chat (migration 299): an unrestricted
    // chat's snapshot is the whole drafting ceiling; no recorded bound is none.
    expect([...ceilingForWorkRun('chat', null, drafting)].sort()).toEqual(drafting)
    expect(ceilingForWorkRun('chat').size).toBe(0)
    const attempt = ceilingForWorkRun('attempt')
    expect(attempt.has('create_document')).toBe(true)
    expect(attempt.has('create_email_draft')).toBe(true)
    for (const board of ['create_action', 'update_action', 'complete_action', 'add_comment', 'create_contact', 'archive_capture']) {
      expect(attempt.has(board), board).toBe(false)
    }
  })
})

describe('statusChangeDepthForWorkRun', () => {
  it('1 for a person-started root, 2 for an attempted root, plus the delegation chain depth', () => {
    expect(statusChangeDepthForWorkRun({ origin: 'user', origin_depth: 0 })).toBe(1)
    expect(statusChangeDepthForWorkRun({})).toBe(1)
    expect(statusChangeDepthForWorkRun({ origin: 'attempt', origin_depth: 0 })).toBe(2)
    expect(statusChangeDepthForWorkRun({ origin: 'delegation', origin_depth: 1 })).toBe(3)
    expect(statusChangeDepthForWorkRun({ origin: 'user', origin_depth: 2 })).toBe(3)
  })

  it('a malformed chain depth counts as 0, never lowers the base', () => {
    expect(statusChangeDepthForWorkRun({ origin: 'attempt', origin_depth: -3 })).toBe(2)
    expect(statusChangeDepthForWorkRun({ origin: 'user', origin_depth: 1.5 })).toBe(1)
    expect(statusChangeDepthForWorkRun({ origin: 'user', origin_depth: null })).toBe(1)
  })
})

describe('rebuildWorkRunSpec advertises the row\'s profile', () => {
  it('an attempted run is advertised the drafting set, a person-started run the full one', async () => {
    row.origin = 'attempt'
    const attempted = await rebuildWorkRunSpec(CLAIMS)
    expect(attempted?.ceilingTools.map((t) => t.name).sort()).toEqual([...computeDraftingCeiling()].sort())
    row.origin = 'user'
    const started = await rebuildWorkRunSpec(CLAIMS)
    expect(started?.ceilingTools.map((t) => t.name).sort()).toEqual([...computeWorkRunCeiling()].sort())
    // A registry tool's usage notes ride its description (src/lib/ai/tool-guides.ts).
    const guided = started!.ceilingTools.filter((t) => toolGuide(t.name))
    expect(guided.length).toBeGreaterThan(0)
    for (const t of guided) expect(t.description, t.name).toBe(withToolGuide(t.name, getToolDefinition(t.name)!.description))
  })
})

describe('rebuildWorkRunSpec — the base prompt', () => {
  it("is built for the run's workspace, so the member row and key contacts are that workspace's", async () => {
    row.origin = 'user'
    buildSystemPrompt.mockClear()
    await rebuildWorkRunSpec(CLAIMS)
    expect(buildSystemPrompt).toHaveBeenCalledTimes(1)
    expect(buildSystemPrompt.mock.calls[0][0]).toBe(CLAIMS.userId)
    expect(buildSystemPrompt.mock.calls[0][3]).toEqual({ workspaceId: CLAIMS.workspaceId, webAccess: 'always' })
  })
})

describe('rebuildWorkRunSpec — how the model is called', () => {
  it('a run with no stored tier thinks (Flash at DeepSeek\'s own effort, on private hosts), as every work run did before', async () => {
    row.origin = 'user'
    row.model_tier = null
    const spec = await rebuildWorkRunSpec(CLAIMS)
    expect(spec?.model).toBe('deepseek/deepseek-v4-flash')
    expect(spec?.modelPolicy).toEqual(chatModelPolicy('deepseek-v4-flash', 'standard'))
    expect(spec?.modelTier).toBe('think')
  })

  it('runs the tier the start stored on agent_run.model_tier (migration 345): Fast, or Strong on STRONG_MODEL', async () => {
    row.origin = 'chat'
    row.model_tier = 'strong'
    const strong = await rebuildWorkRunSpec(CLAIMS)
    expect(strong?.model).toBe('anthropic/claude-sonnet-5.5')
    expect(strong?.modelPolicy).toEqual({ contextWindowTokens: 1_000_000 })
    expect(strong?.modelTier).toBe('strong')
    row.model_tier = 'fast'
    const fast = await rebuildWorkRunSpec(CLAIMS)
    expect(fast?.model).toBe('deepseek/deepseek-v4-flash')
    expect(fast?.modelPolicy).toEqual(chatModelPolicy('deepseek-v4-flash', 'light'))
    // Junk in the column reads as the default.
    row.model_tier = 'max'
    expect((await rebuildWorkRunSpec(CLAIMS))?.modelTier).toBe('think')
    row.model_tier = null
  })

  it('runs the roster model the start stored on agent_run.helper_model (migration 439), over its tier\'s', async () => {
    row.origin = 'chat'
    row.model_tier = 'strong'
    row.helper_model = 'opus'
    const opus = await rebuildWorkRunSpec(CLAIMS)
    expect(opus?.model).toBe('anthropic/claude-opus-5.5')
    expect(opus?.modelPolicy).toEqual({ contextWindowTokens: 1_000_000 })
    expect(opus?.modelTier).toBe('strong')
    row.model_tier = 'fast'
    row.helper_model = 'gpt-luna'
    const luna = await rebuildWorkRunSpec(CLAIMS)
    expect(luna?.model).toBe('openai/gpt-5.6-luna')
    expect(luna?.modelPolicy).toEqual({ contextWindowTokens: 1_000_000, reasoning: 'low' })
    // An unknown key reads as the tier's model.
    row.helper_model = 'gpt-99'
    expect((await rebuildWorkRunSpec(CLAIMS))?.model).toBe('deepseek/deepseek-v4-flash')
    row.model_tier = null
    row.helper_model = null
  })

  it('a check-in’s helper (server_helper check_in, migration 443) runs light whatever its row says: a light roster model, else Flash', async () => {
    row.origin = 'chat'
    row.server_helper = 'check_in'
    for (const [tier, model, slug] of [['strong', 'opus', 'deepseek/deepseek-v4-flash'], [null, null, 'deepseek/deepseek-v4-flash'], ['think', 'flash-thinking', 'deepseek/deepseek-v4-flash'], ['fast', 'gpt-luna', 'openai/gpt-5.6-luna']] as const) {
      row.model_tier = tier
      row.helper_model = model
      const spec = await rebuildWorkRunSpec(CLAIMS)
      expect([tier, model, spec?.model, spec?.modelTier]).toEqual([tier, model, slug, 'fast'])
    }
    // Flash with thinking off (the light level), never Think's effort.
    row.helper_model = null
    expect((await rebuildWorkRunSpec(CLAIMS))?.modelPolicy).toEqual(chatModelPolicy('deepseek-v4-flash', 'light'))
    row.server_helper = null
    row.model_tier = null
  })
})

describe("rebuildWorkRunSpec on the person's own ChatGPT plan (the free tier)", () => {
  it('a person on their plan: the plan model (Luna, thinking by the tier), no Gateway attribution or host routing', async () => {
    row.origin = 'user'
    row.model_tier = null
    chatgptPlanFor.mockResolvedValueOnce(true)
    const spec = await rebuildWorkRunSpec(CLAIMS)
    expect(chatgptPlanFor).toHaveBeenLastCalledWith('user-1')
    expect(spec).toMatchObject({ model: 'openai/gpt-6-luna', modelTier: 'think', chatgptPlan: { model: 'gpt-6-luna', helperModel: 'gpt-6-luna', reasoning: 'medium' } })
    expect(spec).not.toHaveProperty('modelPolicy')
    expect(spec).not.toHaveProperty('gatewayTelemetry')
    // The prompt and tools are the run's own, as for anyone.
    expect(spec!.ceilingTools.length).toBeGreaterThan(0)

    row.model_tier = 'fast'
    chatgptPlanFor.mockResolvedValueOnce(true)
    expect((await rebuildWorkRunSpec(CLAIMS))!.chatgptPlan).toEqual({ model: 'gpt-6-luna', helperModel: 'gpt-6-luna', reasoning: 'low' })
    row.model_tier = null
  })

  it('everyone else runs as before, with no plan on the spec', async () => {
    chatgptPlanFor.mockResolvedValueOnce(false)
    const spec = await rebuildWorkRunSpec(CLAIMS)
    expect(spec).not.toHaveProperty('chatgptPlan')
    expect(spec!.model).not.toMatch(/gpt-6/)
    expect(spec!.modelPolicy).toBeDefined()
  })
})

