/**
 * The run_skill executor runs every fire on eve (runViaEve — a durable task
 * session on the skill-runner agent). There is no other runtime: no workspace
 * policy, no env flag and no per-action config.runtime (removed, migration 204)
 * choosing one. A stray legacy config.runtime value changes nothing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { FlowAction, RunSkillActionConfig } from '../types'

// ── Module mocks (hoisted spies so vi.mock factories can close over them) ────

const h = vi.hoisted(() => ({
  runViaEve: vi.fn(async (_arg: unknown) => ({
    text: 'eve output',
    usage: { inputTokens: 1, outputTokens: 1 },
    costUsd: null,
    toolCalls: 0,
    steps: 1,
    verdict: null,
    empty: false,
  })),
  grant: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ tier: 'strong', by: 'rule', signals: ['skill_tier'], reasoning: 'adaptive' })),
}))
const runViaEve = h.runViaEve
vi.mock('@/lib/ai/model-escalation-budget', () => ({ grantStrong: (...a: unknown[]) => h.grant(...a) }))

vi.mock('../run-skill-eve', () => ({
  runViaEve: (arg: unknown) => h.runViaEve(arg),
  EveRunTimeoutError: class EveRunTimeoutError extends Error {},
  EveSessionFailedError: class EveSessionFailedError extends Error {},
}))

// Assembly collaborators — stubbed so assembleSkillRun returns a spec without
// exercising the real prompt/tool machinery (covered by their own tests).
vi.mock('@/lib/ai/system-prompt', () => ({ buildSystemPrompt: vi.fn(async () => 'BASE') }))
vi.mock('../context-pack', () => ({ buildContextPack: vi.fn(async () => '') }))
vi.mock('@/lib/ai/auth', () => ({ logUsage: vi.fn(async () => {}) }))
vi.mock('@/lib/notifications', () => ({ createNotification: vi.fn(async () => {}) }))

// A supabase stub: recipe select returns a skill; member select returns a member;
// document insert returns an id. Enough for assembleSkillRun → deliverSkillOutput.
function makeServiceClient(recipe: Record<string, unknown>) {
  return {
    from(table: string) {
      const chain: Record<string, unknown> = {}
      const self = () => chain
      chain.select = self
      chain.eq = self
      chain.or = self
      chain.contains = self
      chain.limit = self
      chain.insert = self
      chain.update = self
      chain.maybeSingle = async () => {
        if (table === 'recipe') return { data: recipe, error: null }
        if (table === 'member') return { data: { id: 'mem-1' }, error: null }
        if (table === 'document') return { data: { id: 'doc-1' }, error: null }
        return { data: null, error: null }
      }
      chain.single = async () => {
        if (table === 'document') return { data: { id: 'doc-1' }, error: null }
        return { data: null, error: null }
      }
      chain.rpc = async () => ({ data: null, error: null })
      return chain
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      usageCalls.push({ name, args })
      return { data: [usageRow], error: null }
    },
  }
}

/** The usage gate's answer (check_ai_usage_limit) and what it was asked. */
let usageRow: Record<string, unknown> = { allowed: true }
const usageCalls: Array<{ name: string; args: Record<string, unknown> }> = []

let currentRecipe: Record<string, unknown>
vi.mock('@/lib/admin', () => ({
  getServiceClient: () => makeServiceClient(currentRecipe),
}))

// Import the SUT AFTER the mocks.
import { createRunSkillExecutor } from '../run-skill'
import { buildSystemPrompt } from '@/lib/ai/system-prompt'

const PROSE_RECIPE = {
  id: 'skill-1',
  name: 'Brief',
  system_prompt: 'you are a brief writer',
  updated_at: null,
  agent_config: { output_contract: 'prose' },
}
const VERDICT_RECIPE = {
  id: 'skill-2',
  name: 'Triage',
  system_prompt: 'you are triage',
  updated_at: null,
  agent_config: { output_contract: 'verdict' },
}

function action(skillId: string, extra: Partial<RunSkillActionConfig> = {}): FlowAction {
  return {
    id: 'act-1',
    type: 'run_skill',
    config: { skill_id: skillId, mode: 'report', ...extra } as RunSkillActionConfig,
    condition: null,
    parent_id: null,
    enabled: true,
    bearer_token_encrypted: null,
  }
}

const ctx = {
  entity: null,
  trigger: { type: 'schedule' as const, entity_type: null, from_status_id: null, to_status_id: null, fired_at: '2026-07-18T00:00:00Z' },
  appBaseUrl: 'https://nativeintelligence.dev',
  capture: null,
}

function makeExecutor() {
  return createRunSkillExecutor({
    workspaceId: 'ws-1',
    runAsUserId: 'user-1',
    flowId: 'flow-1',
    fireId: 'fire-1',
    flowRunId: 'frun-1',
  })
}

beforeEach(() => {
  runViaEve.mockClear()
})

describe('run_skill executor', () => {
  it('runs a PROSE fire on eve (runViaEve) and delivers its document', async () => {
    currentRecipe = PROSE_RECIPE
    const result = await makeExecutor()(action('skill-1'), ctx)
    expect(runViaEve).toHaveBeenCalledTimes(1)
    // The fire's facts: no capture (schedule fire) and the 240s prose wall.
    // The dispatch origin is runViaEve's own (this deployment), never the
    // template's public appBaseUrl.
    expect(runViaEve.mock.calls[0][0]).toMatchObject({
      hasCapture: false,
      timeoutMs: 240_000,
    })
    expect(runViaEve.mock.calls[0][0]).not.toHaveProperty('appBaseUrl')
    // eve output is delivered through the shared deliverSkillOutput.
    expect(result.status).toBe('success')
    expect(result.output_document_id).toBe('doc-1')
  })

  it("builds the run's base prompt for the flow's workspace, so the runner's member row and contacts are that workspace's", async () => {
    currentRecipe = PROSE_RECIPE
    vi.mocked(buildSystemPrompt).mockClear()
    await makeExecutor()(action('skill-1'), ctx)
    expect(vi.mocked(buildSystemPrompt)).toHaveBeenCalledTimes(1)
    const [userId, , context, options] = vi.mocked(buildSystemPrompt).mock.calls[0]
    expect(userId).toBe('user-1')
    expect(context).toBeUndefined()
    expect(options).toEqual({ workspaceId: 'ws-1' })
  })

  it('runs a VERDICT fire on eve on the 480s verdict wall', async () => {
    currentRecipe = VERDICT_RECIPE
    await makeExecutor()(action('skill-2'), ctx)
    expect(runViaEve).toHaveBeenCalledTimes(1)
    const arg = runViaEve.mock.calls[0][0] as { timeoutMs: number; spec: { outputContract: string } }
    expect(arg.timeoutMs).toBe(480_000)
    expect(arg.spec.outputContract).toBe('verdict')
  })

  // eve exposes NO submit_run_verdict tool (its structured result is the
  // outputSchema → eve's eve__reply), so the user message must not tell the
  // model to call one; the triage policy's headline rule rides in it.
  it('a VERDICT spec message carries the dismiss-by-default policy and no call to submit_run_verdict', async () => {
    currentRecipe = VERDICT_RECIPE
    await makeExecutor()(action('skill-2'), ctx)
    const { userMessage } = (runViaEve.mock.calls[0][0] as { spec: { userMessage: string } }).spec
    expect(userMessage).toContain('Default to dismiss')
    expect(userMessage).toContain('final structured result')
    expect(userMessage).not.toMatch(/call submit_run_verdict/)
  })

  // The seeded verdict skills (migrations 166/194) tell the model to "call
  // submit_run_verdict" in their system prompt and context_rules. eve has no
  // tool by that name, so the message maps the name onto eve__reply.
  it('a VERDICT spec message maps submit_run_verdict onto eve’s eve__reply', async () => {
    currentRecipe = VERDICT_RECIPE
    await makeExecutor()(action('skill-2'), ctx)
    const { userMessage } = (runViaEve.mock.calls[0][0] as { spec: { userMessage: string } }).spec
    expect(userMessage).toContain('Where your instructions say submit_run_verdict: that is the eve__reply tool')
    expect(userMessage).toContain('EXACTLY ONCE')
    // The bare name appears once, inside the mapping, never as an instruction to call it.
    expect(userMessage.match(/submit_run_verdict/g)?.length).toBe(1)
  })

  it('a PROSE spec message carries no verdict instructions', async () => {
    currentRecipe = PROSE_RECIPE
    await makeExecutor()(action('skill-1'), ctx)
    const { userMessage } = (runViaEve.mock.calls[0][0] as { spec: { userMessage: string } }).spec
    expect(userMessage).not.toContain('Default to dismiss')
    expect(userMessage).not.toContain('submit_run_verdict')
  })

  // The secret check itself lives in runViaEve and is covered against the real
  // module in run-skill-eve.test.ts ('throws when the internal secret is unset').
  // This pins the executor half: an eve throw fails the run with its message.
  it('an eve throw (e.g. the missing-secret refusal) fails the run with its message', async () => {
    currentRecipe = PROSE_RECIPE
    runViaEve.mockRejectedValueOnce(
      new Error('eve runtime requested but RUN_SKILL_INTERNAL_SECRET is not set'),
    )
    const result = await makeExecutor()(action('skill-1'), ctx)
    expect(result.status).toBe('failed')
    expect(result.error_message).toMatch(/RUN_SKILL_INTERNAL_SECRET/)
  })

  it('the executor NEVER reads config.runtime — a stray legacy value changes nothing', async () => {
    currentRecipe = PROSE_RECIPE
    // @ts-expect-error — `runtime` is removed from the type; we're proving it's ignored at runtime.
    await makeExecutor()(action('skill-1', { runtime: 'local' }), ctx)
    expect(runViaEve).toHaveBeenCalledTimes(1)
  })
})

describe('the run\'s tier (auto model selection: recipe.agent_config.model_tier)', () => {
  const specOf = () => (runViaEve.mock.calls[0][0] as { spec: { model: string; modelRoute: unknown } }).spec

  it('a skill with no tier runs Flash at Think; an old flow config.model pin is ignored', async () => {
    currentRecipe = PROSE_RECIPE
    await makeExecutor()(action('skill-1', { model: 'claude-sonnet-4-5-20250929' } as Partial<RunSkillActionConfig>), ctx)
    expect(specOf().model).toBe('deepseek-v4-flash')
    expect(specOf().modelRoute).toEqual({ tier: 'think', by: 'fixed', signals: ['skill_default'], reasoning: 'high' })
    expect(h.grant).not.toHaveBeenCalled()
  })

  it('a Fast skill runs Flash, thinking (DeepSeek always thinks in chat)', async () => {
    currentRecipe = { ...PROSE_RECIPE, agent_config: { output_contract: 'prose', model_tier: 'fast' } }
    await makeExecutor()(action('skill-1'), ctx)
    expect(specOf().model).toBe('deepseek-v4-flash')
    expect(specOf().modelRoute).toEqual({ tier: 'fast', by: 'fixed', signals: ['skill_tier'], reasoning: 'high' })
  })

  it('a Strong skill asks for it (the plan, the daily cap); granted it runs STRONG_MODEL, refused it thinks on Flash', async () => {
    currentRecipe = { ...PROSE_RECIPE, agent_config: { output_contract: 'prose', model_tier: 'strong' } }
    h.grant.mockClear()
    await makeExecutor()(action('skill-1'), ctx)
    expect(specOf().model).toBe('claude-sonnet-5-5')
    expect(h.grant).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      userId: 'user-1', workspaceId: 'ws-1', isPaidPlan: true, surface: 'skill_run', signals: ['skill_tier'],
      // Stable per fire (the flow run and the action), so a retried assembly counts once.
      key: 'skill:frun-1:act-1',
    }))
    runViaEve.mockClear()
    h.grant.mockResolvedValueOnce({ tier: 'think', by: 'cap', signals: ['skill_tier', 'daily_cap'], reasoning: 'high' })
    await makeExecutor()(action('skill-1'), ctx)
    expect(specOf().model).toBe('deepseek-v4-flash')
    expect(specOf().modelRoute).toMatchObject({ tier: 'think', by: 'cap' })
  })
})

describe("a person on their own ChatGPT plan (the free tier)", () => {
  const specOf = () => (runViaEve.mock.calls[0][0] as { spec: { model: string; modelRoute: unknown; systemPrompt: string } }).spec

  it('the usage gate opts in, and a free user\'s run carries the plan model, thinking by its tier', async () => {
    currentRecipe = PROSE_RECIPE
    usageRow = { allowed: true, reason: 'chatgpt_plan', is_paid_plan: false }
    usageCalls.length = 0
    try {
      await makeExecutor()(action('skill-1'), ctx)
      expect(usageCalls[0]).toEqual({ name: 'check_ai_usage_limit', args: { p_user_id: 'user-1', p_chatgpt_plan: true } })
      expect(specOf().model).toBe('chatgpt-plan/gpt-6-luna')
      expect(specOf().modelRoute).toMatchObject({ tier: 'think', reasoning: 'medium' })
      // Its prompt carries no web guidance: a plan run has no web.
      expect(vi.mocked(buildSystemPrompt).mock.calls.at(-1)?.[3]).toMatchObject({ webAccess: 'never' })
    } finally {
      usageRow = { allowed: true }
    }
  })

  it('a refused person still gets no run, and everyone else keeps their own model', async () => {
    currentRecipe = PROSE_RECIPE
    usageRow = { allowed: false, reason: 'chatgpt_plan_unsupported' }
    try {
      await makeExecutor()(action('skill-1'), ctx)
      expect(runViaEve).not.toHaveBeenCalled()
    } finally {
      usageRow = { allowed: true }
    }
    await makeExecutor()(action('skill-1'), ctx)
    expect(specOf().model).toBe('deepseek-v4-flash')
  })
})

