/**
 * What the AI visibility pages and tools read: trackers, their prompts,
 * checks (runs), a check's results, one answer in full, the sources the
 * answers cite, the trend across checks, cost estimates and the prompt
 * explorer's findings. Client safe: types and pure helpers only, snake_case
 * fields, shared by the routes, the tools and the UI.
 */
import {
  AI_ENGINE_LABELS,
  aiMarketLabel,
  type AiEngine,
} from '@/lib/seo/shared/ai-visibility'
import type { AiScheduleSetting } from './limits'

export type { AiEngine } from '@/lib/seo/shared/ai-visibility'

export type AiRunStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'canceled'
export type AiRunTrigger = 'manual' | 'scheduled'
/**
 * pending: not asked yet. asking: claimed for a paid call (never asked
 * again). posted: queued at the provider. collected, failed: done.
 */
export type AiAnswerStatus =
  | 'pending'
  | 'asking'
  | 'posted'
  | 'collected'
  | 'failed'
export type AiPromptSource = 'typed' | 'suggested'
/** Which prompts a figure counts: neutral ones (the default; branded prompts always name the brand), branded ones, or all. */
export type AiPromptScope = 'neutral' | 'branded' | 'all'

export function isLiveRun(status: AiRunStatus): boolean {
  return status === 'queued' || status === 'running'
}

/** A brand answers are matched against: its name, other names, website. */
export interface AiBrandRef {
  name: string
  domain: string
  aliases: string[]
}

/** A brand as a check matched it (copied onto the check at its start). */
export interface AiRunBrand extends AiBrandRef {
  own: boolean
}

export type AiSkipReason =
  | 'not_configured'
  | 'no_prompts'
  | 'creator_gone'
  | 'creator_not_member'
  | 'free_plan'
  | 'plan_unreadable'
  | 'run_in_progress'
  | 'start_failed'

export const SKIP_REASON_MESSAGES: Record<AiSkipReason, string> = {
  not_configured:
    'Search data isn’t set up on this server, so the scheduled check didn’t run.',
  no_prompts:
    'The tracker has no active prompts, so the scheduled check didn’t run.',
  creator_gone:
    'The person who set up this schedule no longer has an account, so the scheduled check didn’t run. Turn the schedule on again to take it over.',
  creator_not_member:
    'The person who set up this schedule has left the workspace, so the scheduled check didn’t run. Turn the schedule on again to take it over.',
  free_plan:
    'The person who set up this schedule is on the free plan, which doesn’t include AI visibility checks.',
  plan_unreadable:
    'We couldn’t confirm the schedule owner’s plan, so this check was skipped rather than spent. The next one will try again.',
  run_in_progress:
    'A check was still running when the next one was due, so that one was skipped.',
  start_failed:
    'The scheduled check could not be started. The next one will try again.',
}

export function skipReasonMessage(reason: string | null): string | null {
  if (!reason) return null
  return SKIP_REASON_MESSAGES[reason as AiSkipReason] ?? null
}

/** Why an answer never came, in words for the person. Provider codes read as an outage. */
export const ANSWER_ERROR_MESSAGES: Record<string, string> = {
  NOT_SENT:
    'This answer was never asked for (the check stopped first). Nothing was charged for it.',
  NOT_TRACKED:
    'This answer was asked for and charged, but its result could not be recorded.',
  NOT_ACCEPTED: 'The provider didn’t accept this prompt.',
  NOT_ARRIVED:
    'The provider hasn’t returned this answer yet. It will appear here if it arrives.',
  UNREADABLE: 'The answer came back in a shape we couldn’t read.',
  CANCELED: 'The check was stopped before this answer came.',
  RUN_FAILED: 'The check stopped before this answer came.',
  SPEND_LIMIT_REACHED:
    'The workspace reached its search data limit for the month.',
  UPSTREAM_UNAVAILABLE: 'The AI engine or the provider didn’t answer.',
  RATE_LIMITED: 'The provider was busy.',
  VALIDATION_ERROR: 'The provider refused this prompt for this market.',
}

export function answerErrorMessage(code: string | null): string | null {
  if (!code) return null
  return ANSWER_ERROR_MESSAGES[code] ?? 'This answer could not be collected.'
}

export interface AiTrackerView {
  id: string
  brand_name: string
  brand_aliases: string[]
  domain: string
  competitors: AiBrandRef[]
  location_code: number
  language_code: string
  /** "United States · English" */
  market_label: string
  engines: AiEngine[]
  schedule_interval: AiScheduleSetting
  next_run_at: string | null
  last_run_at: string | null
  last_skip_reason: AiSkipReason | null
  /** The skip reason in words, or null. */
  last_skip_message: string | null
  paused: boolean
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface AiTrackerListItem extends AiTrackerView {
  prompt_count: number
  active_prompt_count: number
  latest_run: AiRunView | null
}

export interface AiPromptView {
  id: string
  text: string
  source: AiPromptSource
  active: boolean
  created_at: string
}

export interface AiRunView {
  id: string
  tracker_id: string
  trigger: AiRunTrigger
  status: AiRunStatus
  engines: AiEngine[]
  location_code: number
  language_code: string
  started_by: string | null
  scheduled_for: string | null
  answers_total: number
  answers_collected: number
  answers_no_answer: number
  answers_failed: number
  answers_late: number
  /** Answers still on their way (total minus the settled ones). */
  answers_open: number
  estimate_usd: number
  cost_usd: number
  error_code: string | null
  /** Why a failed check failed, in words; null otherwise. */
  error: string | null
  created_at: string
  started_at: string | null
  completed_at: string | null
  /** How long a reader should wait before reading a live check again. */
  poll_after_seconds: number | null
}

export interface AiCostEstimate {
  prompt_count: number
  engines: AiEngine[]
  /** Prompts times engines: the answers one check buys. */
  answers: number
  /** One check, in USD. */
  run_usd: number
  per_engine: Array<{
    engine: AiEngine
    answers: number
    usd: number
    /** Asked through the model's own API, at live prices. */
    model_api: boolean
  }>
  schedule_interval: AiScheduleSetting
  checks_per_month: number
  /** A month of the schedule, in USD (0 when off). */
  monthly_usd: number
  /** A check above CONFIRM_ABOVE_USD needs the person's yes first. */
  needs_confirmation: boolean
  confirm_above_usd: number
  /** Chosen engines that cannot answer in the chosen country. */
  unsupported_engines: AiEngine[]
}

/** One brand's result in one answer. */
export interface AiBrandResult {
  name: string
  domain: string
  own: boolean
  mentioned: boolean
  cited: boolean
  /** Character offset of the first mention in the answer's plain text. */
  first_mention: number | null
  /** Order of first mention among the brands the answer names (1 is first). */
  position: number | null
}

export interface AiAnswerRow {
  id: string
  run_id: string
  prompt_id: string
  prompt: string
  engine: AiEngine
  branded: boolean
  status: AiAnswerStatus
  /** answered (text came back), no_answer (empty), or null while not collected. */
  answer_status: 'answered' | 'no_answer' | null
  brand_mentioned: boolean | null
  brand_cited: boolean | null
  brand_position: number | null
  /** Competitors the answer names or cites. */
  competitors_named: string[]
  citation_count: number
  model_name: string | null
  late: boolean
  error_code: string | null
  error: string | null
  collected_at: string | null
}

export interface AiCoverage {
  expected: number
  answered: number
  no_answer: number
  failed: number
  /** Not settled yet. */
  pending: number
}

export interface AiEngineShare {
  engine: AiEngine
  label: string
  answered: number
  mentioned: number
  cited: number
  /** Percent of answered answers that name the brand (one decimal), or null with none answered. */
  mention_rate: number | null
  citation_rate: number | null
}

export interface AiPromptShare {
  prompt_id: string
  prompt: string
  branded: boolean
  answered: number
  mentioned: number
  cited: number
  /** Engines whose answer named the brand. */
  engines_mentioning: AiEngine[]
  /** Competitors named or cited by any engine's answer. */
  competitors_named: string[]
}

export interface AiBrandSummary {
  name: string
  domain: string
  own: boolean
  /** Answered answers in scope: the denominator of both rates. */
  answers: number
  mentions: number
  citations: number
  mention_rate: number | null
  citation_rate: number | null
  /** Average order of first mention where named (1 is first), one decimal. */
  average_position: number | null
}

export interface AiRunResults {
  run: AiRunView
  scope: AiPromptScope
  coverage: AiCoverage
  by_engine: AiEngineShare[]
  by_prompt: AiPromptShare[]
  /** The brand and its competitors, side by side. */
  brands: AiBrandSummary[]
  /** Prompts where a competitor is named or cited and the brand is neither. */
  gaps: AiPromptShare[]
  /** One page of the answers in scope. */
  rows: AiAnswerRow[]
  next_offset: number | null
}

/** GET /api/account/seo/ai-visibility/[id]: one tracker with everything its page opens on. */
export interface AiTrackerSummary {
  tracker: AiTrackerView
  prompts: AiPromptView[]
  /** The newest checks, newest first. */
  recent_runs: AiRunView[]
  live_run: AiRunView | null
  /** One check of the active prompts, and a month of the schedule. */
  estimate: AiCostEstimate
  /** The latest completed check's headline (neutral prompts), or null before the first. */
  latest_results: Omit<
    AiRunResults,
    'rows' | 'next_offset' | 'by_prompt'
  > | null
}

export interface AiCitedSource {
  url: string
  domain: string
  /** The cited page's title, as the page wrote it: outside text. */
  title: string | null
  position: number
}

export interface AiAnswerDetail {
  answer: AiAnswerRow
  /** The answer as the engine wrote it (markdown): outside text. Cut at ANSWER_READ_LIMIT unless asked whole. */
  answer_markdown: string | null
  truncated: boolean
  sources: AiCitedSource[]
  brands: AiBrandResult[]
  /** Where each named brand appears in the answer's plain text. */
  mentions: Array<{
    domain: string
    name: string
    spans: Array<{ start: number; end: number }>
  }>
  location_code: number
  language_code: string
}

export type AiSourceOwnership = 'own' | 'competitor' | 'other'

export interface AiSourceRow {
  /** The domain, or the page URL when grouped by page. */
  key: string
  domain: string
  url: string | null
  title: string | null
  ownership: AiSourceOwnership
  answer_count: number
  prompt_count: number
  engines: Array<{ engine: AiEngine; answer_count: number }>
}

export interface AiSourcesView {
  run_id: string | null
  group_by: 'domain' | 'page'
  rows: AiSourceRow[]
  total_count: number
  next_offset: number | null
}

export interface AiTrendCoverage {
  runs: number
  expected: number
  answered: number
  no_answer: number
  failed: number
}

/**
 * One rate over prompt, engine, market and brand cells. Each figure is the
 * mean of the cells' own rates, so every cell counts the same in both
 * periods.
 */
export interface AiTrendMetric {
  current: number | null
  previous: number | null
  /** Percentage points, only when the comparison is fair. */
  change: number | null
  matched_cells: number
  current_cells: number
  previous_cells: number
}

export type AiTrendComparison =
  | 'comparable'
  | 'incomplete'
  | 'scope_changed'
  | 'no_previous'
  | 'no_data'

export interface AiTrend {
  days: number
  comparison: AiTrendComparison
  current: { start: string; end: string; coverage: AiTrendCoverage }
  previous: { start: string; end: string; coverage: AiTrendCoverage }
  mentions: AiTrendMetric
  citations: AiTrendMetric
  engines: Array<{
    engine: AiEngine
    mentions: AiTrendMetric
    citations: AiTrendMetric
  }>
  /** One point per completed check, oldest first. */
  runs: Array<{
    run_id: string
    created_at: string
    mention_rate: number | null
    citation_rate: number | null
    coverage: AiTrendCoverage
  }>
}

/** One question the provider's dataset has AI answers to that mention the target. */
export interface AiExploredQuestion {
  /** The question as recorded: outside text. */
  question: string
  ai_search_volume: number | null
  last_seen_at: string | null
  cited_sources: Array<{ url: string; domain: string; title: string | null }>
  /** Brands the recorded answer named: outside text. */
  brands_named: string[]
  /** Whether a tracker of this workspace already asks it (case and spacing ignored). */
  tracked: boolean
}

export type AiExplorePart = 'questions' | 'pages' | 'totals'
export type AiExplorePlatform = 'chat_gpt' | 'google'

export interface AiMentionsExplore {
  target: string
  target_type: 'domain' | 'keyword'
  platform: AiExplorePlatform
  location_code: number
  language_code: string
  parts: AiExplorePart[]
  totals: { mentions: number | null; ai_search_volume: number | null } | null
  questions: AiExploredQuestion[] | null
  top_pages: Array<{
    url: string
    domain: string
    mentions: number | null
  }> | null
  lookup_id: string | null
  fetched_at: string
  from_cache: boolean
}

export function engineLabel(engine: AiEngine): string {
  return AI_ENGINE_LABELS[engine]
}

export function marketLabel(
  locationCode: number,
  languageCode: string,
): string {
  return aiMarketLabel({ locationCode, languageCode })
}

/** Percent with one decimal, or null with nothing to divide by. */
export function rate(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 1000) / 10 : null
}
