/**
 * A free user's model: their own ChatGPT plan, straight to OpenAI
 * (docs/plans/chatgpt-free-tier.md §4–5). When a run's spec carries
 * `chatgptPlan` (the app put the person on their plan), every step runs on a
 * live AI SDK OpenAI Responses model whose base URL is the app's plan proxy
 * (src/app/api/internal/chatgpt-plan/v1/responses). The proxy checks the
 * agent's own run credentials, swaps in the person's plan token and applies
 * the plan route's rules. Nothing goes through the AI Gateway, so nothing is
 * billed to Native Intelligence, and a spent plan is only an error.
 *
 * ONE FILE, COPIED: every eve agent that runs on a plan keeps a byte-identical
 * copy at lib/chatgpt-plan-model.ts (an agent bundles only its own folder);
 * agents/chat-agent/lib/__tests__/chatgpt-plan-model-drift.test.ts keeps them
 * equal. So it imports nothing agent-specific: each agent passes its own
 * proxy connection (its spec-client's chatGptPlanProxy: the base URL, and a
 * fetch carrying that agent's run secret and token).
 *
 * The only provider-package import in the agents: the eve-everywhere
 * tripwire's PROVIDER_IMPORT_ALLOWLIST names each copy (a founder decision,
 * 10-20).
 *
 * Scopes, as eve allows (a live model only at step.started):
 *   - a turn or session selection: planTurnSelection, durable and
 *     serializable, naming OpenAI's catalog slug, with the Gateway allowed
 *     only a host that doesn't exist (`only: [CHATGPT_PLAN_PROVIDER]`). It is
 *     never called: every step runs on the step model, and eve's compaction
 *     runs on the step model too. Were anything ever to call it, the Gateway
 *     would find no host and refuse rather than bill (checked live 10-20).
 *   - step.started: planStepSelection, the live plan model.
 * An agent that picks its model once per session (work, skill and live)
 * takes all three from planAwareSessionModelEvents, below.
 *
 * The provider is named CHATGPT_PLAN_PROVIDER, not `openai`: eve names the
 * steps `chatgpt-plan/<model>` (the app logs those at no cost), and adds none
 * of its extras for a provider it doesn't know: no Exa web_search
 * (Gateway-billed), no hosted OpenAI tools, no safetyIdentifier (the plan
 * route refuses the last two). A step that should search the web runs on the
 * search model instead (planSearchStepSelection, below).
 *
 * Secrets: the run token and the internal secret ride the proxy's custom
 * `fetch`, never the provider's `headers`, which the SDK's workflow serializer
 * would write out with the model. The API key is a placeholder the fetch drops.
 *
 * Mirrors src/lib/chatgpt/plan-models.ts (agent code can't import src/);
 * the drift test pins the two.
 */
import { createOpenAI } from '@ai-sdk/openai'
import { defineState, type SessionAuth } from 'eve/context'

/** createOpenAI's `name`: eve's step model ids are `chatgpt-plan/<model>`. */
export const CHATGPT_PLAN_PROVIDER = 'chatgpt-plan'

/** The plan models (PLAN_MODELS in src/lib/chatgpt/plan-models.ts). */
export const PLAN_MODELS: ReadonlySet<string> = new Set(['gpt-6.1-sol', 'gpt-6-luna'])

/**
 * The window handed to eve: the plan models' real 1.05M capped at the chat's
 * compaction window, so eve compacts at 225K whichever agent runs it.
 */
export const PLAN_WINDOW_TOKENS = 250_000

type PlanReasoning = 'none' | 'minimal' | 'low' | 'medium' | 'high'
const PLAN_REASONING: ReadonlySet<string> = new Set<PlanReasoning>(['none', 'minimal', 'low', 'medium', 'high'])

/** A run on the person's plan: the models and the reasoning (a spec's `chatgptPlan`). */
export type ChatGptPlan = { model: string; helperModel: string; reasoning: PlanReasoning }

/** Where an agent's plan model calls: the proxy's base URL and a fetch carrying the agent's run credentials. */
export type PlanProxy = { baseURL: string; fetch: typeof fetch }

/**
 * The plan a chat spec outage falls back to, for a person whose chat run
 * token says they run on their plan (chatgptPlanFromRunToken): Sol at Fast's
 * reasoning, chatGptPlanSpec('fast') in src/lib/chatgpt/plan-models.ts.
 */
export const FALLBACK_CHATGPT_PLAN: ChatGptPlan = { model: 'gpt-6.1-sol', helperModel: 'gpt-6-luna', reasoning: 'low' }

/** The usage row's model_route when a chat spec failed to arrive on a plan turn. */
export const FALLBACK_CHATGPT_PLAN_ROUTE = { tier: 'fast', by: 'fixed', signals: ['spec_unavailable', 'chatgpt_plan'], reasoning: 'low' }

/** Shape-guard a spec's `chatgptPlan`: plan models and a known reasoning, or null. */
export function validChatGptPlan(value: unknown): ChatGptPlan | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  if (typeof v.model !== 'string' || !PLAN_MODELS.has(v.model)) return null
  if (typeof v.helperModel !== 'string' || !PLAN_MODELS.has(v.helperModel)) return null
  if (typeof v.reasoning !== 'string' || !PLAN_REASONING.has(v.reasoning)) return null
  return { model: v.model, helperModel: v.helperModel, reasoning: v.reasoning as PlanReasoning }
}

/**
 * Whether a CHAT run token says its person runs on their ChatGPT plan (the
 * browser mint's `chatgptPlan` claim, src/lib/chat/chat-run-token.ts). Read
 * without the secret: the token came through the authenticated channel, and
 * it only picks the fallback model; the plan proxy verifies the token before
 * any call.
 */
export function chatgptPlanFromRunToken(runToken: string): boolean {
  const dot = runToken.indexOf('.')
  if (dot <= 0) return false
  try {
    const claims: unknown = JSON.parse(Buffer.from(runToken.slice(0, dot), 'base64url').toString('utf8'))
    return !!claims && typeof claims === 'object' && (claims as { chatgptPlan?: unknown }).chatgptPlan === true
  } catch {
    return false
  }
}

/**
 * A chat turn's plan: the spec's when it carries a valid one; else, when the
 * spec failed (or carried one that didn't validate) and the run token says
 * the person runs on their plan, the fallback plan, so a spec outage never
 * lands a free user on a Gateway model Native Intelligence pays for; else null.
 */
export function chatGptPlanForTurn(spec: { chatgptPlan?: unknown } | null, runToken: string): ChatGptPlan | null {
  const plan = validChatGptPlan(spec?.chatgptPlan)
  if (plan) return plan
  if (spec && spec.chatgptPlan === undefined) return null
  return chatgptPlanFromRunToken(runToken) ? FALLBACK_CHATGPT_PLAN : null
}

/** This turn's or session's plan, or null: durable session state (ids only, no credential), so step.started reads it after a process change. */
export const turnChatGptPlan = defineState<ChatGptPlan | null>('chatgpt-plan.plan', () => null)

/** The step's model id for a plan model, as eve names a live model. */
export function planStepModelId(model: string): string {
  return `${CHATGPT_PLAN_PROVIDER}/${model}`
}

/**
 * The turn- or session-scope selection: serializable, never called (see the
 * header). The Gateway may serve it only from a host that doesn't exist.
 */
export function planTurnSelection(plan: ChatGptPlan) {
  return {
    model: `openai/${plan.model}`,
    reasoning: plan.reasoning,
    modelContextWindowTokens: PLAN_WINDOW_TOKENS,
    modelOptions: { providerOptions: { gateway: { only: [CHATGPT_PLAN_PROVIDER] } } },
  }
}

/** The live plan model itself, for an agent that wraps it (the utility agent's middleware). */
export function planLanguageModel(model: string, proxy: PlanProxy) {
  const provider = createOpenAI({ name: CHATGPT_PLAN_PROVIDER, baseURL: proxy.baseURL, apiKey: CHATGPT_PLAN_PROVIDER, fetch: proxy.fetch })
  return provider.responses(model)
}

/**
 * createOpenAI's `name` for the plan model with OpenAI's own web search. eve
 * picks a direct model's extras by its provider name up to the first dot, so
 * this one gets OpenAI's: the agent's `web_search` slot becomes OpenAI's
 * hosted search, which the plan proxy lets through (bare,
 * src/lib/chatgpt/plan-request.ts; tested on a real plan 10-22), and a safety
 * identifier, which the proxy strips. The cost: eve names its steps
 * `openai/<model>`, which the app reads as the plan's (planModelOfStep in
 * src/lib/chatgpt/plan-models.ts: no Gateway model Native Intelligence runs is a plan
 * model); the chat's usage meter maps them back first (planReportModelId).
 * eve reports a cost only for a Gateway call, so a plan step never has one.
 */
export const CHATGPT_PLAN_SEARCH_PROVIDER = 'openai.chatgpt-plan'

/** The plan model eve sees as OpenAI's own (see CHATGPT_PLAN_SEARCH_PROVIDER). */
export function planSearchLanguageModel(model: string, proxy: PlanProxy) {
  const provider = createOpenAI({ name: CHATGPT_PLAN_SEARCH_PROVIDER, baseURL: proxy.baseURL, apiKey: CHATGPT_PLAN_PROVIDER, fetch: proxy.fetch })
  return provider.responses(model)
}

/**
 * A step's model id as the plan's own: eve names a plan search step
 * `openai/<model>`, and the app logs only `chatgpt-plan/<model>` at no cost.
 * Mapped only for the run's own plan models; any other id is unchanged.
 */
export function planReportModelId(modelId: string | null, plan: ChatGptPlan | null): string | null {
  if (!modelId || !plan || !modelId.startsWith('openai/')) return modelId
  const model = modelId.slice('openai/'.length)
  return model === plan.model || model === plan.helperModel ? planStepModelId(model) : modelId
}

/**
 * The step's live plan model: `model` for the agent's own steps,
 * `helperModel` in a quick helper. `store: false` makes the SDK carry the
 * run's reasoning forward itself (encrypted), since the plan route stores
 * nothing.
 */
export function planStepSelection(plan: ChatGptPlan, proxy: PlanProxy, role: 'main' | 'helper' = 'main') {
  return planSelection(plan, planLanguageModel(role === 'helper' ? plan.helperModel : plan.model, proxy))
}

/** planStepSelection on the search model: the step can search the web with OpenAI's own search. */
export function planSearchStepSelection(plan: ChatGptPlan, proxy: PlanProxy, role: 'main' | 'helper' = 'main') {
  return planSelection(plan, planSearchLanguageModel(role === 'helper' ? plan.helperModel : plan.model, proxy))
}

function planSelection(plan: ChatGptPlan, model: ReturnType<typeof planLanguageModel>) {
  return {
    model,
    reasoning: plan.reasoning,
    modelContextWindowTokens: PLAN_WINDOW_TOKENS,
    modelOptions: { providerOptions: { openai: { store: false } } },
  }
}

/**
 * A session-scoped agent's Gateway selection (a run not on a plan), kept when
 * the session picks it, so step.started can hand it back unchanged: a step
 * resolver must always return a model (returning undefined kills the
 * session). Serializable: an id or a selection object.
 */
export const sessionModelSelection = defineState<unknown>('chatgpt-plan.session-selection', () => null)

/** What a session-scoped agent's spec says it runs on: the person's plan, or a Gateway selection. */
export type SessionModelChoice<S> = { plan: ChatGptPlan } | { selection: S }

/** How a session-scoped agent finds its model: its run token, its spec, and its own proxy. */
export interface PlanAwareSessionModel<S> {
  /** The run token off the verified session principal (the agent's spec-client runTokenFromAuth). */
  runToken: (auth: SessionAuth) => string
  /**
   * The session's model, from its spec. Throws when there is none, so the
   * session fails closed; a spec that names a plan this module can't read
   * must throw too, never fall back to a Gateway model Native Intelligence pays for.
   */
  choose: (runToken: string) => Promise<SessionModelChoice<S>>
  /** This agent's proxy connection (its spec-client's chatGptPlanProxy). */
  proxy: (runToken: string) => PlanProxy
  /** Whether a token drives a later turn on the session (a resume, a follow-up chat). */
  isLaterTurn?: (runToken: string) => boolean
}

/**
 * The model events of an agent that picks its model once per session (the
 * work, skill and live agents; docs/plans/chatgpt-free-tier-handoff.md 3b-2):
 *   - session.started: the spec's choice, kept in session state;
 *   - turn.started: the kept choice. A later turn (a resume or a follow-up
 *     chat) reads the spec again first, so a person who is on their plan by
 *     now moves onto it. A plan session never moves back: it costs Native Intelligence
 *     nothing as it is;
 *   - step.started: on a plan, the live plan model through this agent's own
 *     proxy (the search model: the agent's web_search is OpenAI's own on the
 *     person's plan, as Exa is on the Gateway); otherwise the kept Gateway
 *     selection, exactly as the session picked it. A session older than this
 *     resolver (nothing kept) reads its spec once.
 */
export function planAwareSessionModelEvents<S>(m: PlanAwareSessionModel<S>) {
  type Ctx = { session: { auth: SessionAuth } }
  const keep = (choice: SessionModelChoice<S>): S | ReturnType<typeof planTurnSelection> => {
    if ('plan' in choice) {
      turnChatGptPlan.update(() => choice.plan)
      return planTurnSelection(choice.plan)
    }
    sessionModelSelection.update(() => choice.selection)
    return choice.selection
  }
  const kept = (): S | ReturnType<typeof planTurnSelection> | null => {
    const plan = turnChatGptPlan.get()
    if (plan) return planTurnSelection(plan)
    const selection = sessionModelSelection.get()
    return selection === null ? null : (selection as S)
  }
  return {
    'session.started': async (_event: unknown, ctx: Ctx) => keep(await m.choose(m.runToken(ctx.session.auth))),
    'turn.started': async (_event: unknown, ctx: Ctx) => {
      const runToken = m.runToken(ctx.session.auth)
      if (!turnChatGptPlan.get() && m.isLaterTurn?.(runToken)) {
        // A spec that can't be read here keeps the session's own model.
        const choice = await m.choose(runToken).catch(() => null)
        if (choice && 'plan' in choice) return keep(choice)
      }
      return kept() ?? keep(await m.choose(runToken))
    },
    'step.started': async (_event: unknown, ctx: Ctx) => {
      const runToken = m.runToken(ctx.session.auth)
      const plan = turnChatGptPlan.get()
      if (plan) return planSearchStepSelection(plan, m.proxy(runToken))
      const selection = sessionModelSelection.get()
      if (selection !== null) return selection as S
      const choice = await m.choose(runToken)
      keep(choice)
      return 'plan' in choice ? planSearchStepSelection(choice.plan, m.proxy(runToken)) : choice.selection
    },
  }
}
