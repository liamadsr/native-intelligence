/**
 * The request bodies of the AI visibility routes, as zod schemas. Client
 * safe: the UI builds its requests against the same shapes. The schemas only
 * check types and sizes; the rules (caps, valid domains and markets, engines
 * a country supports, confirmations) are the core's (./trackers.ts,
 * ./runs.ts, ./explore.ts).
 */
import { z } from 'zod'
import {
  AI_SCHEDULE_INTERVALS,
  ALL_AI_ENGINES,
  MAX_ALIASES,
  MAX_BRAND_NAME_LENGTH,
  MAX_COMPETITORS,
  MAX_PROMPT_LENGTH,
  MAX_PROMPTS_PER_ADD,
  MAX_PROMPTS_PER_TRACKER,
} from './limits'

export const aiEngineSchema = z.enum([
  'chatgpt',
  'gemini',
  'google_ai_overview',
  'claude',
  'perplexity',
])
export const aiScheduleSchema = z.enum(AI_SCHEDULE_INTERVALS)

const name = z.string().max(MAX_BRAND_NAME_LENGTH)
const domain = z.string().trim().min(1).max(253)

export const competitorSchema = z.object({
  name: name.optional().nullable(),
  domain,
  aliases: z.array(name).max(MAX_ALIASES).optional(),
})

export const trackerFieldsSchema = z.object({
  brand_name: name.optional(),
  brand_aliases: z.array(name).max(MAX_ALIASES).optional(),
  domain: domain.optional().nullable(),
  competitors: z.array(competitorSchema).max(MAX_COMPETITORS).optional(),
  location_code: z.number().int().positive().optional(),
  language_code: z.string().min(2).max(10).optional(),
  engines: z.array(aiEngineSchema).min(1).max(ALL_AI_ENGINES.length).optional(),
  schedule_interval: aiScheduleSchema.optional(),
  paused: z.boolean().optional(),
})

const promptText = z.string().min(1).max(MAX_PROMPT_LENGTH)
export const promptInputSchema = z.union([
  promptText.transform((text) => ({ text, source: 'typed' as const })),
  z.object({
    text: promptText,
    source: z.enum(['typed', 'suggested']).optional(),
  }),
])

/** POST /api/account/seo/ai-visibility/trackers */
export const createTrackerRequestSchema = trackerFieldsSchema.extend({
  prompts: z.array(promptInputSchema).max(MAX_PROMPTS_PER_TRACKER).optional(),
  /** The person saw the estimate (a schedule spends every period) and said yes. */
  confirmed: z.boolean().optional(),
})

/** PATCH /api/account/seo/ai-visibility/[id] */
export const updateTrackerRequestSchema = trackerFieldsSchema.extend({
  confirmed: z.boolean().optional(),
})

const promptIds = z.array(z.uuid()).min(1).max(MAX_PROMPTS_PER_TRACKER)

/** POST /api/account/seo/ai-visibility/[id]/prompts */
export const addPromptsRequestSchema = z.object({
  prompts: z.array(promptInputSchema).min(1).max(MAX_PROMPTS_PER_ADD),
  confirmed: z.boolean().optional(),
})

/** PATCH /api/account/seo/ai-visibility/[id]/prompts */
export const togglePromptsRequestSchema = z.object({
  prompt_ids: promptIds,
  active: z.boolean(),
  confirmed: z.boolean().optional(),
})

/** DELETE /api/account/seo/ai-visibility/[id]/prompts */
export const removePromptsRequestSchema = z.object({ prompt_ids: promptIds })

/** POST /api/account/seo/ai-visibility/[id]/runs */
export const startRunRequestSchema = z.object({
  confirmed: z.boolean().optional(),
})

/** POST /api/account/seo/ai-visibility/estimate: a saved tracker (with changes laid over it), or settings not saved yet. */
export const estimateRequestSchema = z.object({
  tracker_id: z.uuid().optional(),
  prompt_count: z.number().int().min(0).max(MAX_PROMPTS_PER_TRACKER).optional(),
  engines: z.array(aiEngineSchema).min(1).max(ALL_AI_ENGINES.length).optional(),
  schedule_interval: aiScheduleSchema.optional(),
  location_code: z.number().int().positive().optional(),
  language_code: z.string().min(2).max(10).optional(),
})

/** POST /api/account/seo/ai-visibility/explore */
export const exploreRequestSchema = z.object({
  target: z.string().min(1).max(200),
  platform: z.enum(['google', 'chat_gpt']).optional(),
  parts: z
    .array(z.enum(['questions', 'pages', 'totals']))
    .min(1)
    .max(3)
    .optional(),
  location_code: z.number().int().positive().optional(),
  language_code: z.string().min(2).max(10).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  refresh: z.boolean().optional(),
  confirmed: z.boolean().optional(),
})
