/**
 * The prompt explorer: which questions people put to AI assistants mention a
 * domain or a brand, from the search data provider's dataset of recorded AI
 * answers (no model is called on our side). It is how prompts worth tracking
 * are found, beside the ones the person or the agent writes.
 *
 *   questions  the recorded questions whose answers mention the target, the
 *              most asked first, each with the pages its answer cited and
 *              the brands it named.
 *   pages      the target's pages AI answers cite most.
 *   totals     how many recorded answers mention the target, and the AI
 *              search volume behind them.
 *
 * One platform per lookup: Google's AI answers (any market) or ChatGPT (the
 * provider has ChatGPT data for the United States in English only). Each part
 * is a paid call (about 10 cents and up); the estimate is shown first, and a
 * lookup above CONFIRM_ABOVE_USD needs `confirmed`. Results are stored
 * (../lookup-cache.ts, kind ai_mentions) and answer the same question for a
 * day. The parts are bought one after the other; when a later one fails, the
 * parts already bought are stored and returned with `partial` naming what is
 * missing, and nothing more is bought (only a failure of the first part fails
 * the lookup). The questions come mostly from search engines' "people also ask"
 * data, not from logged assistant conversations: never a count of real
 * prompts.
 *
 * Adapted from OpenSEO (MIT, see ../THIRD_PARTY_NOTICES.md).
 */
import type { SeoDataRefusal } from '@/lib/seo/access'
import {
  buildLlmTarget,
  CHATGPT_LANGUAGE_CODE,
  CHATGPT_LOCATION_CODE,
  dataforseoPricing,
  type DataforseoClient,
} from '@/lib/seo/dataforseo'
import type {
  LlmAggregatedTotal,
  LlmMentionItem,
  LlmTopPagesItem,
} from '@/lib/seo/dataforseo/llm-schemas'
import type { PartialAnswer } from '@/lib/seo/keywords/view'
import { HOUR_MS, readLookup, writeLookup } from '@/lib/seo/lookup-cache'
import { paidSeoClient, type SeoPaidDeps, type SeoWho } from '@/lib/seo/paid'
import { normalizeDomain } from '@/lib/seo/shared/domain'
import {
  isSupportedLanguageCode,
  isSupportedLocationCode,
} from '@/lib/seo/shared/keyword-locations'
import { isValidDomainHost } from '@/lib/seo/shared/researchScope'
import type { SupabaseClient } from '@supabase/supabase-js'
import 'server-only'
import { formatUsd } from './cost'
import { safeHttpUrl } from './evidence'
import { CONFIRM_ABOVE_USD } from './limits'
import { normalizePrompt } from './trackers'
import type {
  AiExploredQuestion,
  AiExplorePart,
  AiExplorePlatform,
  AiMentionsExplore,
} from './view'

export const AI_MENTIONS_KIND = 'ai_mentions'
export const AI_MENTIONS_MAX_AGE_MS = 24 * HOUR_MS
const VERSION = 1
export const EXPLORE_PARTS: readonly AiExplorePart[] = [
  'questions',
  'pages',
  'totals',
]
export const DEFAULT_EXPLORE_LIMIT = 50
export const MAX_EXPLORE_LIMIT = 100
const MAX_QUESTION = 500
const MAX_TITLE = 300

export interface ExploreInput {
  target: string
  platform?: AiExplorePlatform
  parts?: AiExplorePart[]
  location_code?: number
  language_code?: string
  /** Questions to read (questions part only). */
  limit?: number
  refresh?: boolean
  confirmed?: boolean
}

export interface ResolvedExplore {
  target: string
  targetType: 'domain' | 'keyword'
  platform: AiExplorePlatform
  parts: AiExplorePart[]
  locationCode: number
  languageCode: string
  limit: number
}

export type ExploreFailure =
  | { ok: false; code: 'VALIDATION_ERROR'; message: string }
  | {
      ok: false
      code: 'CONFIRMATION_REQUIRED'
      message: string
      estimate_usd: number
    }

/** A domain when it reads as one (example.com, https://example.com/x), otherwise a brand keyword. */
export function resolveExplore(
  input: ExploreInput,
): ResolvedExplore | ExploreFailure {
  const raw = (input.target ?? '').replace(/\s+/g, ' ').trim()
  if (raw.length < 2)
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      message: 'Give a domain or a brand name to explore.',
    }
  if (raw.length > 200)
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      message: 'Keep the brand or domain under 200 characters.',
    }
  let target = raw.toLowerCase()
  let targetType: 'domain' | 'keyword' = 'keyword'
  if (!/\s/.test(raw) && raw.includes('.')) {
    try {
      const host = normalizeDomain(raw)
      if (isValidDomainHost(host)) {
        target = host
        targetType = 'domain'
      }
    } catch {
      // Not a domain: a keyword.
    }
  }
  const platform: AiExplorePlatform =
    input.platform === 'chat_gpt' ? 'chat_gpt' : 'google'
  const parts = EXPLORE_PARTS.filter((p) =>
    (input.parts?.length ? input.parts : ['questions']).includes(p),
  )
  if (parts.length === 0)
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      message: 'Choose what to look up: questions, pages or totals.',
    }
  let locationCode = input.location_code ?? CHATGPT_LOCATION_CODE
  let languageCode = (
    input.language_code ?? CHATGPT_LANGUAGE_CODE
  ).toLowerCase()
  if (platform === 'chat_gpt') {
    // The provider has ChatGPT answers for the United States in English only.
    locationCode = CHATGPT_LOCATION_CODE
    languageCode = CHATGPT_LANGUAGE_CODE
  } else if (
    !isSupportedLocationCode(locationCode) ||
    !isSupportedLanguageCode(languageCode)
  ) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      message: 'That market isn’t one we can look up.',
    }
  }
  const limit = Math.min(
    Math.max(Math.floor(input.limit ?? DEFAULT_EXPLORE_LIMIT), 1),
    MAX_EXPLORE_LIMIT,
  )
  return {
    target,
    targetType,
    platform,
    parts,
    locationCode,
    languageCode,
    limit,
  }
}

function isFailure(
  value: ResolvedExplore | ExploreFailure,
): value is ExploreFailure {
  return (value as ExploreFailure).ok === false
}

function callInputs(r: ResolvedExplore) {
  const base = {
    target: buildLlmTarget({ type: r.targetType, value: r.target }),
    platform: r.platform,
    locationCode: r.locationCode,
    languageCode: r.languageCode,
  }
  return {
    totals: { ...base, internalListLimit: 10 },
    pages: { ...base, itemsListLimit: 10 },
    questions: { ...base, limit: r.limit, orderBy: ['ai_search_volume,desc'] },
  }
}

/** The most this lookup can cost, in USD (the meter's own estimates). Free. */
export function estimateExploreUsd(r: ResolvedExplore): number {
  const inputs = callInputs(r)
  const p = dataforseoPricing.aiSearch
  let usd = 0
  if (r.parts.includes('totals')) usd += p.aggregatedMetrics(inputs.totals)
  if (r.parts.includes('pages')) usd += p.topPages(inputs.pages)
  if (r.parts.includes('questions')) usd += p.mentionsSearch(inputs.questions)
  return Math.round(usd * 1e6) / 1e6
}

function sumPlatform(
  groups:
    | Array<{ mentions?: number | null; ai_search_volume?: number | null }>
    | null
    | undefined,
  field: 'mentions' | 'ai_search_volume',
): number | null {
  if (!groups?.length) return null
  let total = 0
  let any = false
  for (const g of groups) {
    const value = g[field]
    if (typeof value === 'number' && Number.isFinite(value)) {
      total += value
      any = true
    }
  }
  return any ? Math.round(total) : null
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

export function shapeQuestions(
  items: LlmMentionItem[],
): Omit<AiExploredQuestion, 'tracked'>[] {
  return items
    .filter(
      (item): item is LlmMentionItem & { question: string } =>
        typeof item.question === 'string' && item.question.trim().length > 0,
    )
    .map((item) => ({
      question: item.question.trim().slice(0, MAX_QUESTION),
      ai_search_volume:
        typeof item.ai_search_volume === 'number'
          ? Math.round(item.ai_search_volume)
          : null,
      last_seen_at: item.last_response_at ?? null,
      cited_sources: (item.sources ?? [])
        .map((s) => {
          const url = safeHttpUrl(s.url ?? null)
          if (!url || url.length > 2048) return null
          return {
            url,
            domain: hostOf(url),
            title:
              typeof s.title === 'string' ? s.title.slice(0, MAX_TITLE) : null,
          }
        })
        .filter((s): s is NonNullable<typeof s> => s !== null)
        .slice(0, 10),
      brands_named: (item.brand_entities ?? [])
        .map((e) => (e.title ?? '').trim())
        .filter(Boolean)
        .map((t) => t.slice(0, 200))
        .slice(0, 20),
    }))
    .sort((a, b) => (b.ai_search_volume ?? 0) - (a.ai_search_volume ?? 0))
}

export function shapePages(
  items: LlmTopPagesItem[],
): AiMentionsExplore['top_pages'] {
  return items
    .map((item) => {
      const url = safeHttpUrl(item.key ?? null)
      return url
        ? {
            url,
            domain: hostOf(url),
            mentions: sumPlatform(item.platform, 'mentions'),
          }
        : null
    })
    .filter((p): p is NonNullable<typeof p> => p !== null)
}

/**
 * An explore answer. `partial` is set when a part asked for could not be
 * looked up after earlier parts were bought (missing: the part names, which
 * are then null); the parts that came back are whole.
 */
export type AiMentionsExploreResult = AiMentionsExplore & {
  partial?: PartialAnswer | null
}

type StoredExplore = Omit<
  AiMentionsExplore,
  'lookup_id' | 'fetched_at' | 'from_cache' | 'questions'
> & {
  questions: Omit<AiExploredQuestion, 'tracked'>[] | null
  partial?: PartialAnswer | null
}

/** The order the parts are bought in. */
const BUY_ORDER: readonly AiExplorePart[] = ['totals', 'pages', 'questions']

const PART_WORDS: Record<AiExplorePart, string> = {
  totals: 'the mention totals',
  pages: 'the most cited pages',
  questions: 'the questions',
}

/** The partial marker for these missing parts, in plain words. */
export function explorePartial(missing: AiExplorePart[]): PartialAnswer | null {
  if (missing.length === 0) return null
  const words = missing.map((part) => PART_WORDS[part])
  const list =
    words.length === 1
      ? words[0]
      : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`
  return {
    missing,
    note: `${list.charAt(0).toUpperCase()}${list.slice(1)} could not be looked up this time. What came back is shown; a refresh looks the whole lookup up again.`,
  }
}

/**
 * Buys the parts asked for, one after the other (each metered on what is
 * left). A part that fails after an earlier one was bought does not lose the
 * earlier ones: it and the parts after it (not bought) are marked missing.
 * A failure of the first part throws. Exposed for tests.
 */
export async function fetchExplore(
  client: Pick<DataforseoClient, 'aiSearch'>,
  r: ResolvedExplore,
): Promise<StoredExplore> {
  const inputs = callInputs(r)
  let totals: AiMentionsExplore['totals'] = null
  let pages: AiMentionsExplore['top_pages'] = null
  let questions: StoredExplore['questions'] = null
  const buy: Record<AiExplorePart, () => Promise<void>> = {
    totals: async () => {
      const total: LlmAggregatedTotal =
        await client.aiSearch.aggregatedMetrics(inputs.totals)
      totals = {
        mentions: sumPlatform(total.platform, 'mentions'),
        ai_search_volume: sumPlatform(total.platform, 'ai_search_volume'),
      }
    },
    pages: async () => {
      pages = shapePages(await client.aiSearch.topPages(inputs.pages))
    },
    questions: async () => {
      questions = shapeQuestions(
        await client.aiSearch.mentionsSearch(inputs.questions),
      )
    },
  }
  const missing: AiExplorePart[] = []
  let bought = 0
  for (const part of BUY_ORDER.filter((p) => r.parts.includes(p))) {
    // After a failure, buy nothing more: the rest is missing too.
    if (missing.length > 0) {
      missing.push(part)
      continue
    }
    try {
      await buy[part]()
      bought += 1
    } catch (err) {
      if (bought === 0) throw err
      console.warn('[seo-ai] explore: part failed, keeping the parts bought', {
        part,
        err: err instanceof Error ? err.message : String(err),
      })
      missing.push(part)
    }
  }
  const partial = explorePartial(missing)
  return {
    target: r.target,
    target_type: r.targetType,
    platform: r.platform,
    location_code: r.locationCode,
    language_code: r.languageCode,
    parts: r.parts,
    totals,
    top_pages: pages,
    questions,
    ...(partial ? { partial } : {}),
  }
}

async function trackedKeys(
  svc: SupabaseClient,
  workspaceId: string,
): Promise<Set<string>> {
  const { data, error } = await svc
    .from('seo_ai_prompt')
    .select('text_key')
    .eq('workspace_id', workspaceId)
    .range(0, 999)
  if (error) {
    console.error('[seo-ai] explore: tracked prompts unread', error.message)
    return new Set()
  }
  return new Set(
    ((data ?? []) as Array<{ text_key: string }>).map((r) => r.text_key),
  )
}

/**
 * Explore a domain or brand. A fresh stored lookup answers for free;
 * otherwise the access check runs first (its refusal is returned as is),
 * then above the confirmation line it needs `confirmed`, then the parts are
 * bought and the result is stored.
 */
export async function exploreAiMentions(
  svc: SupabaseClient,
  who: SeoWho,
  input: ExploreInput,
  deps: SeoPaidDeps = {},
): Promise<
  | { ok: true; result: AiMentionsExploreResult; estimate_usd: number }
  | ExploreFailure
  | SeoDataRefusal
> {
  const resolved = resolveExplore(input)
  if (isFailure(resolved)) return resolved
  const estimate = estimateExploreUsd(resolved)
  const now = deps.now?.() ?? new Date()
  const request = {
    v: VERSION,
    target: resolved.target,
    target_type: resolved.targetType,
    platform: resolved.platform,
    parts: resolved.parts,
    location_code: resolved.locationCode,
    language_code: resolved.languageCode,
    limit: resolved.limit,
  }
  const withTracked = async (
    stored: StoredExplore,
    meta: { lookup_id: string | null; fetched_at: string; from_cache: boolean },
  ): Promise<AiMentionsExploreResult> => {
    const keys = stored.questions
      ? await trackedKeys(svc, who.workspaceId)
      : new Set<string>()
    return {
      ...stored,
      ...meta,
      questions:
        stored.questions?.map((q) => ({
          ...q,
          tracked: keys.has(normalizePrompt(q.question).key),
        })) ?? null,
    }
  }
  if (!input.refresh) {
    const hit = await readLookup<StoredExplore>(
      svc,
      who.workspaceId,
      AI_MENTIONS_KIND,
      request,
      { maxAgeMs: AI_MENTIONS_MAX_AGE_MS, now },
    )
    if (hit?.result?.parts)
      return {
        ok: true,
        result: await withTracked(hit.result, {
          lookup_id: hit.id,
          fetched_at: hit.fetched_at,
          from_cache: true,
        }),
        estimate_usd: 0,
      }
  }
  // The access check comes before the yes: a guest, a person whose plan
  // does not pay or a turn nobody is in is refused outright, never shown a
  // price and asked to confirm something it could not buy.
  const opened = await paidSeoClient(svc, who, deps)
  if (!opened.ok) return opened
  if (estimate > CONFIRM_ABOVE_USD && !input.confirmed) {
    return {
      ok: false,
      code: 'CONFIRMATION_REQUIRED',
      message: `This lookup costs about ${formatUsd(estimate)}. Confirm to run it, or ask for fewer parts.`,
      estimate_usd: estimate,
    }
  }
  const body = await fetchExplore(opened.client, resolved)
  const saved = await writeLookup(
    svc,
    { workspaceId: who.workspaceId, userId: who.userId },
    {
      kind: AI_MENTIONS_KIND,
      request,
      result: body,
      label: `${resolved.target} · ${resolved.platform === 'chat_gpt' ? 'ChatGPT' : 'Google AI'} · ${resolved.parts.join(', ')}`,
    },
    { now },
  )
  return {
    ok: true,
    result: await withTracked(body, {
      lookup_id: saved?.id ?? null,
      fetched_at: saved?.fetched_at ?? now.toISOString(),
      from_cache: false,
    }),
    estimate_usd: estimate,
  }
}
