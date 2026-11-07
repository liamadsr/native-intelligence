/**
 * The web-research agent's model: the person's own ChatGPT plan, and nothing
 * else. Pinned:
 *   - a plan spec for this agent: the plan's guard at session scope, and the
 *     plan's search model (eve reads it as OpenAI's own, so web_search is
 *     OpenAI's) at every step, through the plan proxy with the call's token;
 *   - a spec for another agent, a spec off the plan, a missing spec: both
 *     resolvers throw (eve fails the session), never a Gateway model;
 *   - the kind's step ceiling holds.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { WebResearchSpec } from '../spec-client'

const fetchWebResearchSpec = vi.fn<(t: string) => Promise<WebResearchSpec | null>>()
vi.mock('../spec-client', async () => {
  const actual = await vi.importActual<typeof import('../spec-client')>('../spec-client')
  return { ...actual, fetchWebResearchSpec: (t: string) => fetchWebResearchSpec(t), runTokenFromAuth: () => 'tok.sig' }
})

import agent from '../../agent'
import { webResearchPlan } from '../spec-client'

type Resolver = { events: Record<string, (e: unknown, ctx: { session: { auth: unknown }; messages?: unknown[] }) => Promise<unknown>> }
const events = () => (agent as unknown as { model: Resolver }).model.events
const ctx = { session: { auth: {} }, messages: [{ role: 'user' }] }
const step = (stepIndex: number) => ({ type: 'step.started', data: { sequence: 0, stepIndex, turnId: 't' } })
const plan = { model: 'gpt-6-luna', helperModel: 'gpt-6-luna', reasoning: 'low' }
const spec = (over: Partial<WebResearchSpec> = {}): WebResearchSpec => ({
  kind: 'plan_web_search', model: 'openai/gpt-6-luna', systemPrompt: 'research', maxSteps: 4, chatgptPlan: plan, agent: 'web-research', ...over,
})

beforeEach(() => fetchWebResearchSpec.mockReset())

describe('web-research model', () => {
  it("runs a plan spec for this agent on the plan's guard, then the plan's search model at every step", async () => {
    fetchWebResearchSpec.mockResolvedValue(spec())
    expect(await events()['session.started']({}, ctx)).toMatchObject({
      model: 'openai/gpt-6-luna',
      modelOptions: { providerOptions: { gateway: { only: ['chatgpt-plan'] } } },
    })
    const selected = (await events()['step.started'](step(0), ctx)) as { model: { provider: string; modelId: string }; modelOptions: unknown }
    expect(selected.model.provider).toBe('openai.chatgpt-plan.responses')
    expect(selected.model.modelId).toBe('gpt-6-luna')
    expect(selected.modelOptions).toEqual({ providerOptions: { openai: { store: false } } })
  })

  it('refuses a spec for another agent, a spec off the plan, and no spec, at both resolvers', async () => {
    for (const bad of [
      spec({ agent: undefined }),
      spec({ agent: 'utility' }),
      spec({ chatgptPlan: undefined, model: 'deepseek/deepseek-v4-flash' }),
      spec({ chatgptPlan: { model: 'gpt-4o', helperModel: 'gpt-4o', reasoning: 'low' } }),
      null,
    ]) {
      fetchWebResearchSpec.mockResolvedValue(bad)
      await expect(events()['session.started']({}, ctx)).rejects.toThrow(/web-research/)
      await expect(events()['step.started'](step(0), ctx)).rejects.toThrow(/web-research/)
    }
  })

  it("holds the kind's step ceiling", async () => {
    fetchWebResearchSpec.mockResolvedValue(spec({ maxSteps: 2 }))
    await expect(events()['step.started'](step(1), ctx)).resolves.toBeTruthy()
    await expect(events()['step.started'](step(2), ctx)).rejects.toThrow(/2-step ceiling/)
    fetchWebResearchSpec.mockResolvedValue(spec({ maxSteps: undefined }))
    await expect(events()['step.started'](step(1), ctx)).rejects.toThrow(/1-step ceiling/)
  })

  it('reads only a valid plan', () => {
    expect(webResearchPlan(spec())).toEqual(plan)
    expect(webResearchPlan(spec({ chatgptPlan: 'yes' }))).toBeInstanceOf(Error)
  })
})
