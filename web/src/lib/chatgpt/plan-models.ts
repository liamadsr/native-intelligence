/**
 * The models a free user's AI runs on: their own ChatGPT plan, straight to
 * OpenAI (docs/plans/chatgpt-free-tier.md §4). The chat-agent keeps a copy
 * (agents/chat-agent/lib/chatgpt-plan-model.ts; agent code can't import src/),
 * and a drift test pins the two.
 */

/**
 * The provider name a plan model runs under in eve (createOpenAI's `name`).
 * eve names its steps `chatgpt-plan/<model>` (the usage meter reads that),
 * and gives a provider it doesn't know none of its Gateway or OpenAI extras:
 * no Exa web search (Gateway-billed), no hosted OpenAI tools, no
 * `safetyIdentifier` (the plan route refuses the last two).
 */
export const CHATGPT_PLAN_PROVIDER = 'chatgpt-plan'

/** The main chat (Fast and Think) and strong helpers. */
export const PLAN_MAIN_MODEL = 'gpt-6.1-sol'
/** Quick helpers. */
export const PLAN_HELPER_MODEL = 'gpt-6-luna'

export const PLAN_MODELS: ReadonlySet<string> = new Set([PLAN_MAIN_MODEL, PLAN_HELPER_MODEL])

const PLAN_MODEL_LABELS: Record<string, string> = {
  [PLAN_MAIN_MODEL]: 'GPT-6.1 Sol',
  [PLAN_HELPER_MODEL]: 'GPT-6 Luna',
}

/** Both plan models' context window (the AI Gateway catalog's, 10-20). */
export const PLAN_CONTEXT_WINDOW_TOKENS = 1_050_000

/**
 * What a chat spec carries for a turn on the person's ChatGPT plan
 * (ChatSpec.chatgptPlan): the models and the reasoning. Ids only, no
 * credential: the plan proxy finds the person's token from the run token.
 */
export interface ChatGptPlanSpec {
  model: string
  helperModel: string
  reasoning: 'low' | 'medium'
}

/** The plan spec for a turn's tier: Sol always, thinking harder on Think. */
export function chatGptPlanSpec(tier: string): ChatGptPlanSpec {
  return { model: PLAN_MAIN_MODEL, helperModel: PLAN_HELPER_MODEL, reasoning: tier === 'think' ? 'medium' : 'low' }
}

/**
 * The plan spec for an agent's background work on the person's plan (a work
 * run, a loop's skill run, a live meeting turn): Luna, the lighter model
 * (Liam 10-20: "helpers and background work run on the lighter" one),
 * thinking harder unless the run's tier is Fast.
 */
export function backgroundPlanSpec(tier: string): ChatGptPlanSpec {
  return { model: PLAN_HELPER_MODEL, helperModel: PLAN_HELPER_MODEL, reasoning: tier === 'fast' ? 'low' : 'medium' }
}

/** A plan model's name for people, e.g. "GPT-6.1 Sol". */
export function planModelLabel(model: string): string {
  return PLAN_MODEL_LABELS[model] ?? model
}

/**
 * The model id a plan run carries and logs, `chatgpt-plan/<model>`, as eve
 * names a plan step: usageProviderLabel bills it to the plan (nothing to
 * Native Intelligence), and a utility token signed with it runs on the plan.
 */
export function planModelSlug(model: string): string {
  return `${CHATGPT_PLAN_PROVIDER}/${model}`
}

/** The plan model a step's model id names (`chatgpt-plan/<model>`), or null for any other model. */
export function planModelFromSlug(slug: string | null | undefined): string | null {
  const prefix = `${CHATGPT_PLAN_PROVIDER}/`
  if (typeof slug !== 'string' || !slug.startsWith(prefix)) return null
  const model = slug.slice(prefix.length)
  return model || null
}

/**
 * The plan model a reported step ran on: `chatgpt-plan/<model>`, or
 * `openai/<model>`, as eve names a plan step on the search model (the chat's,
 * CHATGPT_PLAN_SEARCH_PROVIDER in agents/chat-agent/lib/chatgpt-plan-model.ts,
 * which maps it back before reporting; this is the backstop). Never a Gateway
 * step: no Gateway model Native Intelligence runs is a plan model (plan-models.test.ts pins
 * it). Null for any other id.
 */
export function planModelOfStep(modelId: string | null | undefined): string | null {
  const named = planModelFromSlug(modelId)
  if (named) return named
  if (typeof modelId !== 'string' || !modelId.startsWith('openai/')) return null
  const model = modelId.slice('openai/'.length)
  return PLAN_MODELS.has(model) ? model : null
}

/**
 * Whether a usage check (check_ai_usage_limit with the opt-in, migration 409)
 * put this person on their ChatGPT plan: active, or out of credits and
 * allowed to try again.
 */
export function isChatGptPlanUsage(row: { reason?: string | null } | null | undefined): boolean {
  return row?.reason === 'chatgpt_plan' || row?.reason === 'chatgpt_plan_exhausted'
}

/**
 * Why a coding run doesn't start for a person on their own ChatGPT plan: it
 * runs Sonnet in a cloud sandbox, which Native Intelligence pays for (the free tier costs
 * Native Intelligence nothing). Shown on the run and returned by Start.
 */
export const CHATGPT_PLAN_NO_CODING_REASON =
  "Coding agents aren't included when you use Native Intelligence on your ChatGPT plan: they run on Native Intelligence's own models in a cloud sandbox."

