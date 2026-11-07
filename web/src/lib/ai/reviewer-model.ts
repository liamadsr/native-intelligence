/**
 * The reviewer is always a different vendor from the writer (eve-alignment.md
 * §6 decision 13, Liam 2026-10-19; the pattern is Foreman's cross-vendor
 * review). A model judging its own family's writing shares its blind spots:
 * the tells one vendor's models write are the ones they miss on review.
 *
 * Only models the app already runs and prices are candidates (CHAT_MODELS,
 * each with an ai_model_costs row), cheapest first, thinking off where that
 * applies. Today that is two vendors: DeepSeek writes nearly everything
 * (SURFACE_MODELS: Flash), so Haiku 4.5 reviews it; an Anthropic writer (a
 * strong helper, a coding run) is reviewed by Flash.
 *
 * The utility spec route checks the same rule again on the signed token
 * (draft_review's validate in src/lib/eve/utility/spec.ts), so a caller that
 * skipped this helper is refused rather than run.
 */
import { CHAT_MODELS, DEFAULT_MODEL } from './models'
import { PLAN_HELPER_MODEL, PLAN_MAIN_MODEL, PLAN_MODELS, planModelFromSlug } from '@/lib/chatgpt/plan-models'

/** Reviewer candidates, in order of preference (cheapest, fastest first). */
export const REVIEWER_CANDIDATES = ['claude-haiku-4-5-20251001', DEFAULT_MODEL] as const

/**
 * Name prefixes for model ids outside CHAT_MODELS, so an unknown writer still
 * gets a vendor. getModelProvider would call any unknown id 'anthropic'; for
 * this rule a wrong guess could pair a writer with its own vendor, so the
 * guess is by name and unknown stays unknown.
 */
const NAME_VENDORS: ReadonlyArray<readonly [string, string]> = [
  ['claude', 'anthropic'],
  ['deepseek', 'deepseek'],
  ['gpt', 'openai'],
  ['o1', 'openai'],
  ['o3', 'openai'],
  ['o4', 'openai'],
  ['gemini', 'google'],
  ['kimi', 'moonshotai'],
  ['grok', 'xai'],
  ['mistral', 'mistral'],
  ['llama', 'meta'],
  ['qwen', 'alibaba'],
]

/**
 * The vendor behind a model: a Gateway slug's provider prefix, a CHAT_MODELS
 * entry's provider, else a guess from the name. Null when nothing says.
 */
export function modelVendor(model: string | null | undefined): string | null {
  if (typeof model !== 'string') return null
  const id = model.trim().toLowerCase()
  if (!id) return null
  const slash = id.indexOf('/')
  if (slash > 0) return id.slice(0, slash)
  const known = CHAT_MODELS.find((m) => m.id === id || m.gatewayId === id)
  if (known) return known.provider
  for (const [prefix, vendor] of NAME_VENDORS) if (id.startsWith(prefix)) return vendor
  return null
}

/**
 * The model that reviews what `writerModel` wrote: the first candidate from
 * another vendor. Always differs in vendor from a known writer; for an unknown
 * one (no vendor to compare), the first candidate.
 */
export function pickReviewerModel(writerModel: string | null | undefined): string {
  const writer = modelVendor(writerModel)
  return REVIEWER_CANDIDATES.find((candidate) => modelVendor(candidate) !== writer) ?? REVIEWER_CANDIDATES[0]
}

/**
 * Code review's candidates (P10 F6, Liam's Q4 call): a frontier model, since
 * reading a diff for correctness is harder than judging prose. DeepSeek V4
 * Pro (thinking on, src/lib/eve/utility/spec.ts) reviews an Anthropic coder;
 * Haiku is only the fallback for a coder of DeepSeek's own vendor.
 */
export const CODE_REVIEWER_CANDIDATES = ['deepseek-v4-pro', 'claude-haiku-4-5-20251001'] as const

/** The model that reviews code `coderModel` wrote: the first code candidate from another vendor. */
export function pickCodeReviewerModel(coderModel: string | null | undefined): string {
  const coder = modelVendor(coderModel)
  return CODE_REVIEWER_CANDIDATES.find((candidate) => modelVendor(candidate) !== coder) ?? CODE_REVIEWER_CANDIDATES[0]
}

/** Whether two models come from different vendors (false when either is unknown). */
export function differentVendors(a: string | null | undefined, b: string | null | undefined): boolean {
  const va = modelVendor(a)
  const vb = modelVendor(b)
  return va !== null && vb !== null && va !== vb
}

/**
 * The plan model a writer id names, or null for any other model: the step id
 * (`chatgpt-plan/<model>`), the bare id, or OpenAI's Gateway slug for it
 * (`openai/<model>`), which is what a chat turn on the plan names its model as
 * (the turn selection, agents/chat-agent/lib/chatgpt-plan-model.ts
 * planTurnSelection) and so what review_post receives as its writer.
 */
function planModelOf(model: string | null | undefined): string | null {
  if (typeof model !== 'string') return null
  const trimmed = model.trim()
  const named = planModelFromSlug(trimmed) ?? (trimmed.startsWith('openai/') ? trimmed.slice('openai/'.length) : trimmed)
  return PLAN_MODELS.has(named) ? named : null
}

/**
 * The reviewer for a person on their own ChatGPT plan (the free tier): the
 * plan's other model, since the plan has only OpenAI's. Liam (10-22): a free
 * user gets the same reviewed drafts and posts, on their own tokens, so on
 * the plan decision 13's "another vendor" becomes "another model" (Sol
 * reviews Luna's drafts, Luna reviews Sol's posts).
 */
export function planReviewerModel(writerModel: string | null | undefined): string {
  return planModelOf(writerModel) === PLAN_MAIN_MODEL ? PLAN_HELPER_MODEL : PLAN_MAIN_MODEL
}

/** Two different plan models (the plan's form of decision 13, planReviewerModel). */
export function differentPlanModels(a: string | null | undefined, b: string | null | undefined): boolean {
  const pa = planModelOf(a)
  const pb = planModelOf(b)
  return pa !== null && pb !== null && pa !== pb
}
