/**
 * AI visibility's caps and defaults, in one place. The core (./trackers.ts,
 * ./runs.ts, ./explore.ts) enforces every cap; the routes and the tools only
 * pass input through, so a cap holds however a tracker is changed. Client
 * safe: the UI reads the same numbers for its forms.
 *
 * AI answers are the most expensive calls of the SEO area: a queued answer
 * costs about a tenth of a cent, but an engine the provider can only reach
 * through the model's own API (Claude, Perplexity) costs cents per answer. A
 * check asks every active prompt on every engine, so the caps below bound
 * what one check can spend; the workspace's monthly ceiling bounds the month.
 *
 *   MAX_TRACKERS_PER_WORKSPACE   trackers a workspace may have (a brand in a
 *                                market each; every scheduled one spends).
 *   MAX_PROMPTS_PER_TRACKER      prompts one tracker holds, active or not.
 *                                Held under a lock by seo_ai_add_prompts
 *                                (migration 596). 50 prompts on all five
 *                                engines is 250 answers a check.
 *   MAX_PROMPT_LENGTH            characters in one prompt.
 *   MAX_PROMPTS_PER_ADD          prompts one add (a request, a tool call) may
 *                                carry.
 *   MAX_ENGINES                  engines a tracker may ask (all five).
 *   MAX_COMPETITORS              competitors a tracker compares with.
 *   MAX_ALIASES                  other names per brand.
 */
import type { AiEngine } from '@/lib/seo/shared/ai-visibility'

export const MAX_TRACKERS_PER_WORKSPACE = 10
export const MAX_PROMPTS_PER_TRACKER = 50
export const MAX_PROMPT_LENGTH = 500
export const MAX_PROMPTS_PER_ADD = 50
export const MAX_ENGINES = 5
export const MAX_COMPETITORS = 10
export const MAX_ALIASES = 10
export const MAX_BRAND_NAME_LENGTH = 100

export const ALL_AI_ENGINES: readonly AiEngine[] = [
  'chatgpt',
  'gemini',
  'google_ai_overview',
  'claude',
  'perplexity',
]

/** The engines a new tracker asks when none are chosen: the two cheapest assistants. */
export const DEFAULT_ENGINES: readonly AiEngine[] = ['chatgpt', 'gemini']

export const AI_SCHEDULE_INTERVALS = ['off', 'weekly', 'monthly'] as const
export type AiScheduleSetting = (typeof AI_SCHEDULE_INTERVALS)[number]
/** Off: creating a tracker never starts spending on its own. */
export const DEFAULT_SCHEDULE: AiScheduleSetting = 'off'

/** Anything that can spend more than this in one go shows its estimate first and needs the person's yes. */
export const CONFIRM_ABOVE_USD = 0.25

/** A check this far past its start is stuck (a full check takes well under an hour of work), and the next start replaces it. */
export const STUCK_RUN_AFTER_MS = 3 * 60 * 60_000
/** A check still queued this long never reached the background lane. */
export const STUCK_QUEUED_AFTER_MS = 30 * 60_000

/**
 * The background lane's pacing. Queued answers usually arrive within minutes:
 * the reads wait 2, 4, 7, 10, 14, 18, 22, 26, 30 minutes in all; anything
 * still missing is marked not collected and read again every half hour for
 * LATE_READS_FOR_MS (a late answer fills in, marked late).
 */
export const POLL_INTERVALS = [
  '2m',
  '2m',
  '3m',
  '3m',
  '4m',
  '4m',
  '4m',
  '4m',
  '4m',
] as const
export const LATE_READ_INTERVAL = '30m'
export const LATE_READ_ROUNDS = 12
/** Answers asked through a model's own API per step (each waits up to two minutes). */
export const MODEL_ANSWERS_PER_STEP = 6
/** Concurrent free task reads within one collect step. */
export const TASK_READS_AT_ONCE = 25

/** Rows per page in every AI visibility list. */
export const AI_PAGE_SIZE = 50
/** The longest an answer is kept (characters of markdown). */
export const MAX_ANSWER_LENGTH = 100_000
/** How much of an answer the agent reads at once. */
export const ANSWER_READ_LIMIT = 24_000

/** Trend windows a reader may ask for, in days. */
export const TREND_DAYS = [7, 30, 90] as const
export const DEFAULT_TREND_DAYS = 30
