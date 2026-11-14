/**
 * The researcher's model: chat's Light on the Gateway for everyone, or, for
 * a person on their own ChatGPT plan (the free tier), the plan's search
 * model through the app's plan proxy, so their research runs on their plan,
 * its web_search as OpenAI's own (./chatgpt-plan-model.ts).
 *
 * The kickoff route (src/app/api/account/onboarding/research/route.ts) puts a
 * free user on their plan: it mints an agent-run token for them, which the
 * plan proxy verifies (src/lib/chatgpt/plan-caller.ts, the agent_run family)
 * and pays with their plan, and sends it with the vouched session create; the
 * channel (../channels/eve.ts) stamps it on the session principal
 * (planTokenFrom). Everyone else has none, and runs exactly as before.
 */
import { defineDynamic } from 'eve'
import { defineState, type SessionAuth } from 'eve/context'
import { appBaseUrl, internalSecret } from './app-client.js'
import { planSearchStepSelection, planTurnSelection, type ChatGptPlan, type PlanProxy } from './chatgpt-plan-model.js'

/**
 * The Gateway selection: DeepSeek at chat's Light, thinking off, on the
 * private hosts. The user watches this run in the onboarding wizard, and
 * reasoning would spend the 32K output cap. A literal copy of
 * deepseekSurfacePolicy('deepseek-v4-flash', 'off') (src/lib/ai/models.ts);
 * agents/chat-agent/lib/__tests__/model-policy-drift.test.ts fails when they
 * drift. UNTAGGED by choice (Phase A, docs/plans/gateway-usage-tracking.md):
 * no per-user run token or spec, so no gateway user/tags attribution.
 */
export const GATEWAY_SELECTION = {
  model: 'deepseek/deepseek-v4-flash',
  reasoning: 'none' as const,
  modelContextWindowTokens: 1_000_000,
  modelOptions: {
    providerOptions: {
      deepseek: { thinking: { type: 'disabled' } },
      gateway: { only: ['baseten', 'wafer', 'deepinfra', 'alibaba'], sort: 'ttft' },
    },
  },
}

/** A free user's research: the plan's helper model at Light's reasoning (backgroundPlanSpec('fast') in src/lib/chatgpt/plan-models.ts). */
export const RESEARCH_PLAN: ChatGptPlan = { model: 'gpt-6-luna', helperModel: 'gpt-6-luna', reasoning: 'low' }

/** The principal attribute carrying a free user's plan token (../channels/eve.ts). */
export const PLAN_TOKEN_ATTRIBUTE = 'planToken'

/** Kept in sync with AGENT_RUN_TOKEN_HEADER in src/lib/agent-run/agent-run-token.ts. */
export const AGENT_RUN_TOKEN_HEADER = 'x-agent-run-token'
const AGENT_RUN_SECRET_HEADER = 'x-agent-run-secret'

/** The session's plan token, or null: a person who isn't on their plan. */
export function planTokenFrom(auth: SessionAuth): string | null {
  const raw = auth.current?.attributes?.[PLAN_TOKEN_ATTRIBUTE]
  return typeof raw === 'string' && raw ? raw : null
}

/**
 * The plan proxy for a free user's research: the base URL the plan model
 * calls, and a fetch adding the internal secret and their plan token to each
 * request. They ride the fetch, never a provider's `headers`, which the AI
 * SDK's workflow serializer would write out.
 */
export function researcherPlanProxy(planToken: string): PlanProxy {
  return {
    baseURL: `${appBaseUrl()}/api/internal/chatgpt-plan/v1`,
    fetch: (input, init) => {
      const headers = new Headers(init?.headers)
      // The SDK's placeholder key: the proxy authenticates the plan token.
      headers.delete('authorization')
      headers.set(AGENT_RUN_SECRET_HEADER, internalSecret())
      headers.set(AGENT_RUN_TOKEN_HEADER, planToken)
      return fetch(input, { ...init, headers })
    },
  }
}

/**
 * A plan session's token, kept in durable session state from its start. The
 * session's principal is the create's, but a later message (the owning
 * browser may send one) brings a principal without it: the session stays on
 * the plan, never moves to Native Intelligence's models.
 */
const sessionPlanToken = defineState<string | null>('onboarding-research.plan-token', () => null)

/**
 * The researcher's model events. eve accepts a live model only at
 * step.started, so session.started holds the plan's guard (the Gateway
 * serves it from no host) and every step runs on the plan's search model;
 * without a plan token, both hand back the Gateway selection unchanged.
 */
export const researcherModel = defineDynamic({
  events: {
    'session.started': (_event, ctx) => {
      const planToken = planTokenFrom(ctx.session.auth)
      if (!planToken) return GATEWAY_SELECTION
      sessionPlanToken.update(() => planToken)
      return planTurnSelection(RESEARCH_PLAN)
    },
    'step.started': (_event, ctx) => {
      const planToken = sessionPlanToken.get() ?? planTokenFrom(ctx.session.auth)
      return planToken ? planSearchStepSelection(RESEARCH_PLAN, researcherPlanProxy(planToken)) : GATEWAY_SELECTION
    },
  },
})
