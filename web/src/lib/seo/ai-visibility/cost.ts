/**
 * What AI visibility checks cost, worked out from the provider's prices
 * before anything is saved or asked. Free: no call is made.
 *
 *   - ChatGPT, Gemini and Google's AI Overviews are queued at the provider:
 *     AI_RECORD_COST_USD an answer (about a tenth of a cent).
 *   - Claude and Perplexity have no queue: every answer is asked live through
 *     the model's own API with web search, at the provider's estimate for a
 *     long answer (cents an answer).
 *
 * One check buys one answer per active prompt per engine. A schedule buys a
 * check every period: weekly is counted as 4 a month, monthly as 1. These
 * are the meter's own upper bounds, so a check never costs more than its
 * estimate (a queued answer the provider never returns is refunded by it).
 *
 * Adapted from OpenSEO (MIT, see ../THIRD_PARTY_NOTICES.md).
 */
import { llmResponseUsd } from '@/lib/seo/dataforseo/pricing'
import {
  AI_RECORD_COST_USD,
  aiEngineUsesModelApi,
  aiEnginesWithoutLocation,
  type AiEngine,
} from '@/lib/seo/shared/ai-visibility'
import 'server-only'
import { CONFIRM_ABOVE_USD, type AiScheduleSetting } from './limits'
import type { AiCostEstimate } from './view'

/** USD for one answer on this engine. */
export function aiAnswerUsd(engine: AiEngine): number {
  return aiEngineUsesModelApi(engine)
    ? llmResponseUsd(engine, true)
    : AI_RECORD_COST_USD
}

/** Checks a schedule buys in a month (a planning figure, not a calendar count). */
export function checksPerMonth(interval: AiScheduleSetting): number {
  return interval === 'weekly' ? 4 : interval === 'monthly' ? 1 : 0
}

const round6 = (value: number) => Math.round(value * 1e6) / 1e6

/** One check of `promptCount` prompts on these engines, and a month of the schedule. */
export function estimateAiCost(input: {
  promptCount: number
  engines: readonly AiEngine[]
  scheduleInterval: AiScheduleSetting
  locationCode: number
}): AiCostEstimate {
  const engines = [...new Set(input.engines)]
  const prompts = Math.max(0, Math.floor(input.promptCount))
  const perEngine = engines.map((engine) => ({
    engine,
    answers: prompts,
    usd: round6(prompts * aiAnswerUsd(engine)),
    model_api: aiEngineUsesModelApi(engine),
  }))
  const runUsd = round6(perEngine.reduce((sum, row) => sum + row.usd, 0))
  const perMonth = checksPerMonth(input.scheduleInterval)
  return {
    prompt_count: prompts,
    engines,
    answers: prompts * engines.length,
    run_usd: runUsd,
    per_engine: perEngine,
    schedule_interval: input.scheduleInterval,
    checks_per_month: perMonth,
    monthly_usd: round6(runUsd * perMonth),
    needs_confirmation: runUsd > CONFIRM_ABOVE_USD,
    confirm_above_usd: CONFIRM_ABOVE_USD,
    unsupported_engines: aiEnginesWithoutLocation(engines, input.locationCode),
  }
}

/** USD as people read it: "$0.0144", "$1.20". */
export function formatUsd(value: number): string {
  if (value === 0) return '$0'
  if (value < 0.1) return `$${value.toFixed(4)}`
  return `$${value.toFixed(2)}`
}
