import { checkSeoDataAccess, type SeoDataRefusal } from '@/lib/seo/access'
import { isDataforseoConfigured } from '@/lib/seo/dataforseo'
import { findSerpCompetitors } from '@/lib/seo/domain/competitors'
import { getDomainOverview } from '@/lib/seo/domain/overview'
import { getRankedKeywords } from '@/lib/seo/domain/ranked-keywords'
import {
  RANKED_KEYWORD_SORTS,
  RESEARCH_SCOPES,
  SERP_COMPETITOR_RESULT_TYPES,
  SERP_COMPETITOR_SORTS,
  type DomainKeywordRow,
} from '@/lib/seo/domain/view'
import {
  getKeywordMetrics,
  KEYWORD_METRICS_MAX,
} from '@/lib/seo/keywords/metrics'
import {
  estimateResearchUsd,
  readStoredResearch,
  researchKeywords,
  resolveResearch,
  type ResolvedResearch,
} from '@/lib/seo/keywords/research'
import {
  addSavedKeywords,
  listSavedKeywords,
  removeSavedKeywords,
  savedKeywordTagCounts,
} from '@/lib/seo/keywords/saved'
import {
  estimateSerpUsd,
  getSerpResults,
  hasCollectingSerp,
  hasStoredSerp,
  resolveSerp,
  SERP_COLLECT_MS,
  type ResolvedSerp,
} from '@/lib/seo/keywords/serp'
import {
  filterAndSortKeywordRows,
  KEYWORD_INTENTS,
  KEYWORD_RESEARCH_MODES,
  KEYWORD_SORTS,
  type KeywordRow,
  type SerpResult,
} from '@/lib/seo/keywords/view'
import { seoFailureForTool, type SeoPaidDeps } from '@/lib/seo/paid'
import { seoSpendSummary } from '@/lib/seo/spend'
import type { SupabaseClient } from '@supabase/supabase-js'
import { tool } from 'ai'
import { z } from 'zod'
import { webText } from './web-derived'

/**
 * SEO: keyword research, saved keywords, live search results and domain
 * data (src/lib/seo/keywords, src/lib/seo/domain).
 *
 *   find_keywords          keyword ideas around 1-5 seeds, with volume,
 *                          difficulty, CPC, competition and intent.
 *   get_keyword_metrics    the same metrics for keywords already in hand.
 *   list_saved_keywords    the workspace's saved keywords (free).
 *   add_saved_keywords     save keywords, with their metrics and tags (free).
 *   remove_saved_keywords  delete saved keywords by id (free).
 *   get_serp_results       live Google results for 1-10 keywords, each read
 *                          three times and merged.
 *   get_domain_overview    a domain's estimated organic traffic, keyword
 *                          count, top keywords and pages.
 *   get_ranked_keywords    the keywords a domain or page ranks for.
 *   find_serp_competitors  who competes in Google for a set of keywords.
 *   get_seo_spend          the month's search data spend and ceiling (free).
 *
 * The paid ones buy search data, but only when nothing fresh is stored: a
 * stored lookup answers for free (the lookup store, src/lib/seo/
 * lookup-cache.ts). Before buying, the access check refuses a server without
 * the provider's key, a person on the free plan, and an unattended turn
 * (`opts.unattended`): nothing is bought that nobody asked for. A large
 * lookup (over about $0.25 of provider cost: many seeds at a high limit, many
 * deep SERPs) also takes `confirmed_with_user` and refuses without it. The
 * monthly ceiling is checked at each call. Tools never talk about money
 * except a spend-limit refusal's own words and get_seo_spend.
 *
 * Page titles and snippets in search results come from other websites:
 * whoever wrote them can put instructions in them, so they reach the model
 * inside the WEB fence (web-derived.ts). Keywords, domains, URLs and numbers
 * stay plain: the model needs them verbatim to call the next tool.
 */

/** A lookup that would cost more than this (provider USD) needs the person's go-ahead. */
export const CONFIRM_ABOVE_USD = 0.25

const marketFields = {
  location_code: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Country as the provider’s location code (2840 United States, 2826 United Kingdom, 2124 Canada, 2036 Australia, 2276 Germany). Default the United States',
    ),
  language_code: z
    .string()
    .trim()
    .min(2)
    .max(10)
    .optional()
    .describe(
      'Language code ("en", "es", "de"). Default the country’s main language',
    ),
}

const refreshField = z
  .boolean()
  .optional()
  .describe(
    'Buy fresh data even when a recent stored lookup exists. Only when the person asks for fresh numbers',
  )

const confirmedField = z
  .boolean()
  .optional()
  .describe(
    'Set true only after the person said yes to THIS lookup in their last message. Needed only when a call refused with needs_go_ahead',
  )

function refusal(out: SeoDataRefusal) {
  return { success: false as const, code: out.code, error: out.message }
}

function goAhead(what: string) {
  return {
    success: false as const,
    code: 'NEEDS_GO_AHEAD',
    needs_go_ahead: true,
    error: `Refused, nothing was looked up: ${what} is a large lookup. Tell the person what you would look up, wait for their yes, then call again with confirmed_with_user: true (or look up less at once).`,
  }
}

/** A keyword row for the model: short names, no trend. */
function compactRow(row: KeywordRow) {
  return {
    keyword: row.keyword,
    volume: row.search_volume,
    kd: row.keyword_difficulty,
    cpc: row.cpc,
    competition: row.competition,
    intent: row.intent,
  }
}

function compactDomainKeyword(row: DomainKeywordRow) {
  return {
    keyword: row.keyword,
    position: row.position,
    volume: row.search_volume,
    traffic: row.traffic,
    kd: row.keyword_difficulty,
    cpc: row.cpc,
    url: row.url,
  }
}

const KEYWORD_COLUMNS_NOTE =
  'volume = average monthly searches; kd = keyword difficulty, 0-100; cpc in USD; competition = paid-search competition, 0-1; null = no data. Close variants can share one volume: never add their volumes together.'

const SERP_READING_NOTE =
  'Each keyword was read 3 times and merged: the sites the reads agree on come first. `rank` only numbers this list; quote `best_position` as a site’s Google position, and treat seen_in 1 as weak evidence. `url` can be a google.com redirect: `domain` is the reliable field.'

function serpForModel(result: SerpResult, maxItems: number) {
  const items = result.items.slice(0, maxItems)
  return {
    keyword: result.keyword,
    status: result.status,
    reads_in: result.reads_in,
    reads_total: result.reads_total,
    device: result.device,
    items: items.map((item) => ({
      rank: item.rank,
      type: item.type,
      best_position: item.best_position,
      seen_in: item.seen_in,
      domain: item.domain,
      url: item.url,
      title: webText(item.title),
      snippet: webText(
        item.description ? item.description.slice(0, 200) : item.description,
      ),
    })),
    more: Math.max(0, result.items.length - items.length),
    fetched_at: result.fetched_at,
    from_cache: result.from_cache,
    ...(result.status !== 'complete'
      ? {
          message:
            'Some reads are still coming. Call get_serp_results again with the same keyword and WITHOUT refresh in about a minute to collect them (collecting is free).',
        }
      : result.items.length === 0
        ? {
            message:
              'Nothing found for this search yet. This answer is kept for a few hours; refresh looks again only when the person asks.',
          }
        : {}),
  }
}

export function createSeoKeywordTools(
  userId: string,
  supabase: SupabaseClient,
  workspaceId: string,
  opts: { unattended?: boolean } = {},
) {
  const who = { workspaceId, userId, unattended: opts.unattended === true }
  // Once a tool has run the access check itself (because it is about to
  // buy), the services skip theirs. Never passed when it did not run.
  const checked: SeoPaidDeps = { checkAccess: async () => ({ ok: true }) }

  return {
    find_keywords: tool({
      description:
        'Find keyword ideas for 1-5 seed keywords: what people search around a topic, each keyword with monthly search volume, keyword difficulty (kd, 0-100), CPC, paid competition and search intent. Use it to plan pages or content, or to find which searches a business can win. ' +
        'A seed may use * for any words ("best * for dogs"). Each seed is researched on its own; one bad seed does not fail the others. Rows can be filtered (min_volume, max_difficulty, intents, include, exclude) and sorted before they are shown. Countries served from Google Ads data (Iceland and others) have no difficulty or intent. ' +
        'Results are stored for a day: asking again is free. Next: get_keyword_metrics for keywords already in hand, get_serp_results to see who ranks for the best ones, add_saved_keywords to keep them (copy their metrics).',
      inputSchema: z.object({
        seeds: z
          .array(z.string().trim().min(1).max(120))
          .min(1)
          .max(5)
          .describe(
            '1-5 seed keywords, e.g. ["running shoes", "trail running"]',
          ),
        ...marketFields,
        mode: z
          .enum(KEYWORD_RESEARCH_MODES)
          .optional()
          .describe(
            'auto (default): a blend of keywords containing the seed and keywords in its category. related: "people also search for". suggestions: keywords containing the seed. ideas: keywords in the same category',
          ),
        result_limit: z
          .union([z.literal(150), z.literal(300), z.literal(500)])
          .optional()
          .describe(
            'How many keywords to fetch per seed (default 150). Ask for more only when the person needs a long list',
          ),
        group_keywords: z
          .boolean()
          .optional()
          .describe(
            'Also include close variants that share one search volume (default false: core keywords only)',
          ),
        clickstream: z
          .boolean()
          .optional()
          .describe(
            'Refined search volumes, a twice-as-large lookup. Default false. Only when the person asks for it',
          ),
        min_volume: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Show only keywords with at least this monthly volume'),
        max_difficulty: z
          .number()
          .int()
          .min(0)
          .max(100)
          .optional()
          .describe('Show only keywords with at most this difficulty'),
        intents: z
          .array(z.enum(KEYWORD_INTENTS))
          .max(5)
          .optional()
          .describe('Show only these intents'),
        include: z
          .array(z.string().trim().min(1).max(60))
          .max(10)
          .optional()
          .describe('Show only keywords containing every one of these words'),
        exclude: z
          .array(z.string().trim().min(1).max(60))
          .max(10)
          .optional()
          .describe(
            'Hide keywords containing any of these words (a brand name)',
          ),
        sort_by: z
          .enum(KEYWORD_SORTS)
          .optional()
          .describe('Sort (default search_volume, highest first)'),
        max_rows: z
          .number()
          .int()
          .min(1)
          .max(150)
          .optional()
          .describe(
            'Rows to show per seed (default 50); the rest are counted in `more`',
          ),
        refresh: refreshField,
        confirmed_with_user: confirmedField,
      }),
      execute: async (args) => {
        try {
          const seeds = [...new Set(args.seeds.map((seed) => seed.trim()))]
          const resolved: Array<{
            seed: string
            r: ResolvedResearch | null
            error?: string
          }> = seeds.map((seed) => {
            try {
              return {
                seed,
                r: resolveResearch({
                  seed,
                  location_code: args.location_code,
                  language_code: args.language_code,
                  mode: args.mode,
                  result_limit: args.result_limit,
                  clickstream: args.clickstream,
                  group_keywords: args.group_keywords,
                }),
              }
            } catch (err) {
              return {
                seed,
                r: null,
                error: seoFailureForTool(err, 'find_keywords').error,
              }
            }
          })
          const now = new Date()
          const toBuy: ResolvedResearch[] = []
          for (const entry of resolved) {
            if (!entry.r) continue
            if (
              args.refresh ||
              !(await readStoredResearch(supabase, workspaceId, entry.r, now))
            )
              toBuy.push(entry.r)
          }
          if (toBuy.length > 0) {
            const access = await checkSeoDataAccess({
              userId,
              workspaceId,
              unattended: who.unattended,
            })
            if (!access.ok) return refusal(access)
            const estimate = toBuy.reduce(
              (sum, r) => sum + estimateResearchUsd(r),
              0,
            )
            if (
              estimate > CONFIRM_ABOVE_USD &&
              args.confirmed_with_user !== true
            )
              return goAhead(
                `researching ${toBuy.length} seed${toBuy.length === 1 ? '' : 's'} at up to ${toBuy[0]?.resultLimit ?? 150} keywords each`,
              )
          }
          const maxRows = args.max_rows ?? 50
          const filters = {
            min_volume: args.min_volume,
            max_difficulty: args.max_difficulty,
            intents: args.intents,
            include: args.include,
            exclude: args.exclude,
          }
          const results = await Promise.all(
            resolved.map(async (entry) => {
              if (!entry.r)
                return {
                  seed: entry.seed,
                  ok: false as const,
                  error: entry.error ?? 'That seed can’t be researched.',
                }
              try {
                const out = await researchKeywords(
                  supabase,
                  who,
                  {
                    seed: entry.seed,
                    location_code: args.location_code,
                    language_code: args.language_code,
                    mode: args.mode,
                    result_limit: args.result_limit,
                    clickstream: args.clickstream,
                    group_keywords: args.group_keywords,
                    refresh: args.refresh,
                  },
                  toBuy.length > 0 ? checked : {},
                )
                if (!out.ok)
                  return {
                    seed: entry.seed,
                    ok: false as const,
                    code: out.code,
                    error: out.message,
                  }
                const rows = filterAndSortKeywordRows(
                  out.result.rows,
                  filters,
                  { by: args.sort_by },
                )
                const shown = rows.slice(0, maxRows)
                return {
                  seed: out.result.seed,
                  ok: true as const,
                  source: out.result.source,
                  used_fallback: out.result.used_fallback,
                  data_provider: out.result.data_provider,
                  keywords_found: out.result.rows.length,
                  matching_filters: rows.length,
                  rows: shown.map(compactRow),
                  more: rows.length - shown.length,
                  fetched_at: out.result.fetched_at,
                  from_cache: out.result.from_cache,
                  ...(out.result.partial
                    ? { partial: out.result.partial.note }
                    : {}),
                  ...(out.result.rows.length === 0
                    ? {
                        hint: 'No keywords came back. Try a shorter, broader seed, or get_keyword_metrics for this seed’s own volume.',
                      }
                    : {}),
                }
              } catch (err) {
                const failed = seoFailureForTool(err, 'find_keywords')
                return {
                  seed: entry.seed,
                  ok: false as const,
                  code: failed.code,
                  error: failed.error,
                }
              }
            }),
          )
          const okCount = results.filter((result) => result.ok).length
          if (okCount === 0 && results.length > 0) {
            const first = results[0] as { code?: string; error?: string }
            return {
              success: false,
              code: first.code,
              error: first.error ?? 'Nothing could be researched.',
              results,
            }
          }
          return { success: true, results, columns: KEYWORD_COLUMNS_NOTE }
        } catch (err) {
          return seoFailureForTool(err, 'find_keywords')
        }
      },
    }),

    get_keyword_metrics: tool({
      description:
        `Get search volume, keyword difficulty, intent, CPC, paid competition and the last 3 months' trend for up to ${KEYWORD_METRICS_MAX} keywords already in hand (a page's targets, a list the person pasted, saved keywords). Use it to score known keywords by demand and difficulty; to find NEW keyword ideas use find_keywords. ` +
        'Saved keywords in the same country get the fresh numbers too, so this is also how to refresh the saved list. Stored for a day: asking again is free. Keywords with too little search to measure come back in `missing`.',
      inputSchema: z.object({
        keywords: z
          .array(z.string().trim().min(1).max(200))
          .min(1)
          .max(KEYWORD_METRICS_MAX)
          .describe('The keywords'),
        ...marketFields,
        clickstream: z
          .boolean()
          .optional()
          .describe(
            'Refined search volumes, a twice-as-large lookup. Default false. Only when the person asks for it',
          ),
        max_rows: z
          .number()
          .int()
          .min(1)
          .max(300)
          .optional()
          .describe(
            'Rows to show, highest volume first (default 100); the rest are counted in `more`',
          ),
        refresh: refreshField,
      }),
      execute: async (args) => {
        try {
          const out = await getKeywordMetrics(supabase, who, args)
          if (!out.ok) return refusal(out)
          const rows = filterAndSortKeywordRows(
            out.result.rows,
            {},
            { by: 'search_volume' },
          )
          const shown = rows.slice(0, args.max_rows ?? 100)
          return {
            success: true,
            data_provider: out.result.data_provider,
            rows: shown.map((row) => ({
              ...compactRow(row),
              trend_3mo: row.trend
                .slice(-3)
                .map((point) => point.search_volume),
            })),
            more: rows.length - shown.length,
            missing: out.result.missing.slice(0, 50),
            missing_count: out.result.missing.length,
            fetched_at: out.result.fetched_at,
            from_cache: out.result.from_cache,
            columns: `${KEYWORD_COLUMNS_NOTE} trend_3mo = the last three months' volumes, oldest first.`,
          }
        } catch (err) {
          return seoFailureForTool(err, 'get_keyword_metrics')
        }
      },
    }),

    list_saved_keywords: tool({
      description:
        'The workspace’s saved keywords, newest first, with their last known volume, difficulty, CPC and intent, tags, note and saved-keyword ids. Filter by text or by tags (any of them). Free. To delete some, pass their ids to remove_saved_keywords; for fresh numbers, get_keyword_metrics on them.',
      inputSchema: z.object({
        search: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .optional()
          .describe('Text the keyword contains'),
        tags: z
          .array(z.string().trim().min(1).max(40))
          .max(20)
          .optional()
          .describe('Keywords carrying ANY of these tags'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('How many (default 50)'),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('next_offset from the previous call'),
      }),
      execute: async (args) => {
        try {
          const [page, tags] = await Promise.all([
            listSavedKeywords(supabase, workspaceId, {
              search: args.search,
              tags: args.tags,
              limit: args.limit ?? 50,
              offset: args.offset,
            }),
            savedKeywordTagCounts(supabase, workspaceId),
          ])
          return {
            success: true,
            total: page.total,
            keywords: page.rows.map((row) => ({
              id: row.id,
              keyword: row.keyword,
              location_code: row.location_code,
              language_code: row.language_code,
              volume: row.search_volume,
              kd: row.keyword_difficulty,
              cpc: row.cpc,
              intent: row.intent,
              tags: row.tags,
              note: row.note,
              metrics_from: row.metrics_fetched_at,
            })),
            next_offset: page.next_offset,
            tags: tags.slice(0, 30),
            ...(page.total === 0
              ? {
                  message:
                    args.search || args.tags?.length
                      ? 'No saved keywords match. Call again without the filter to see them all.'
                      : 'No saved keywords yet.',
                }
              : {}),
          }
        } catch (err) {
          return seoFailureForTool(err, 'list_saved_keywords')
        }
      },
    }),

    add_saved_keywords: tool({
      description:
        'Save keywords to the workspace’s saved keywords, in one country, with their metrics (copy keyword, volume, kd, cpc, competition and intent from find_keywords or get_keyword_metrics rows) and optional tags for grouping them by topic or page. Re-saving a keyword keeps its one row and adds the tags. Free. Use tags only as the person asked, and confirm before tagging many keywords at once.',
      inputSchema: z.object({
        keywords: z
          .array(z.string().trim().min(1).max(200))
          .min(1)
          .max(100)
          .describe('Keywords to save (1-100)'),
        ...marketFields,
        metrics: z
          .array(
            z.object({
              keyword: z.string().trim().min(1).max(200),
              volume: z.number().min(0).nullish(),
              kd: z.number().min(0).max(100).nullish(),
              cpc: z.number().min(0).nullish(),
              competition: z.number().min(0).max(1).nullish(),
              intent: z.enum(KEYWORD_INTENTS).nullish(),
            }),
          )
          .max(100)
          .optional()
          .describe('Metrics for these keywords, matched by keyword'),
        tags: z
          .array(z.string().trim().min(1).max(40))
          .max(20)
          .optional()
          .describe(
            'Tags for every keyword in this call, e.g. ["pricing page"]',
          ),
        note: z
          .string()
          .trim()
          .max(2000)
          .optional()
          .describe('A note kept with each of them'),
      }),
      execute: async (args) => {
        try {
          const out = await addSavedKeywords(
            supabase,
            { workspaceId, userId },
            {
              keywords: args.keywords,
              location_code: args.location_code,
              language_code: args.language_code,
              tags: args.tags,
              note: args.note ?? null,
              metrics: args.metrics?.map((metric) => ({
                keyword: metric.keyword,
                search_volume: metric.volume ?? null,
                keyword_difficulty: metric.kd ?? null,
                cpc: metric.cpc ?? null,
                competition: metric.competition ?? null,
                intent: metric.intent ?? 'unknown',
                trend: [],
              })),
            },
          )
          if (!out.ok)
            return { success: false, code: out.code, error: out.message }
          return {
            success: true,
            added: out.added,
            already_saved: out.already_saved,
            saved: out.rows.map((row) => ({
              id: row.id,
              keyword: row.keyword,
              tags: row.tags,
            })),
          }
        } catch (err) {
          return seoFailureForTool(err, 'add_saved_keywords')
        }
      },
    }),

    remove_saved_keywords: tool({
      description:
        'Delete saved keywords by their saved-keyword ids (from list_saved_keywords or add_saved_keywords). Permanent; ids that don’t exist are ignored. Free. Only the keywords the person asked to remove.',
      inputSchema: z.object({
        ids: z
          .array(z.string().uuid())
          .min(1)
          .max(500)
          .describe('Saved-keyword ids'),
      }),
      execute: async ({ ids }) => {
        try {
          const out = await removeSavedKeywords(supabase, workspaceId, ids)
          return { success: true, requested: ids.length, removed: out.removed }
        } catch (err) {
          return seoFailureForTool(err, 'remove_saved_keywords')
        }
      },
    }),

    get_serp_results: tool({
      description:
        'Get live Google results for 1-10 keywords: who ranks, in which order, with which SERP features (featured snippet, people also ask, local pack). Use it to see who a keyword’s real competitors are, check where a site ranks right now, or gather sources before planning content. ' +
        'Google varies what it shows automated readers, so each keyword is read 3 times and merged into one row per site; it takes 10-40 seconds. Quote best_position as a site’s position, never `rank`. If a keyword says it is still collecting, call again with the same keyword in about a minute, without refresh: collecting is free. Stored for 12 hours.',
      inputSchema: z.object({
        keywords: z
          .array(z.string().trim().min(1).max(120))
          .min(1)
          .max(10)
          .describe('1-10 keywords'),
        ...marketFields,
        device: z
          .enum(['desktop', 'mobile'])
          .optional()
          .describe('Default desktop'),
        depth: z
          .number()
          .int()
          .min(10)
          .max(100)
          .multipleOf(10)
          .optional()
          .describe(
            'How many results to read per keyword, 10 (default, page one) to 100. Deeper is a larger lookup: only when ranks past page one matter',
          ),
        max_items: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe('Rows to show per keyword (default 20)'),
        refresh: refreshField,
        confirmed_with_user: confirmedField,
      }),
      execute: async (args) => {
        try {
          const keywords = [
            ...new Set(
              args.keywords.map((keyword) => keyword.trim().toLowerCase()),
            ),
          ]
          const resolved: Array<{
            keyword: string
            r: ResolvedSerp | null
            error?: string
          }> = keywords.map((keyword) => {
            try {
              return {
                keyword,
                r: resolveSerp({
                  keyword,
                  location_code: args.location_code,
                  language_code: args.language_code,
                  device: args.device,
                  depth: args.depth,
                }),
              }
            } catch (err) {
              return {
                keyword,
                r: null,
                error: seoFailureForTool(err, 'get_serp_results').error,
              }
            }
          })
          const toBuy: ResolvedSerp[] = []
          for (const entry of resolved)
            if (
              entry.r &&
              !(await (args.refresh
                ? // A refresh while the reads are still out collects them.
                  hasCollectingSerp(supabase, workspaceId, entry.r)
                : hasStoredSerp(supabase, workspaceId, entry.r)))
            )
              toBuy.push(entry.r)
          if (toBuy.length > 0) {
            const access = await checkSeoDataAccess({
              userId,
              workspaceId,
              unattended: who.unattended,
            })
            if (!access.ok) return refusal(access)
            const estimate = toBuy.reduce(
              (sum, r) => sum + estimateSerpUsd(r),
              0,
            )
            if (
              estimate > CONFIRM_ABOVE_USD &&
              args.confirmed_with_user !== true
            )
              return goAhead(
                `reading ${toBuy.length} search result pages ${args.depth ?? 10} results deep`,
              )
          }
          // One deadline for the whole batch, so the call answers in about a minute.
          const deps = {
            ...(toBuy.length > 0 ? checked : {}),
            deadline: Date.now() + SERP_COLLECT_MS,
          }
          const maxItems = args.max_items ?? 20
          const results = await Promise.all(
            resolved.map(async (entry) => {
              if (!entry.r)
                return {
                  keyword: entry.keyword,
                  ok: false as const,
                  error: entry.error ?? 'That keyword can’t be looked up.',
                }
              try {
                const out = await getSerpResults(
                  supabase,
                  who,
                  {
                    keyword: entry.keyword,
                    location_code: args.location_code,
                    language_code: args.language_code,
                    device: args.device,
                    depth: args.depth,
                    refresh: args.refresh,
                  },
                  deps,
                )
                if (!out.ok)
                  return {
                    keyword: entry.keyword,
                    ok: false as const,
                    code: out.code,
                    error: out.message,
                  }
                return {
                  ok: true as const,
                  ...serpForModel(out.result, maxItems),
                }
              } catch (err) {
                const failed = seoFailureForTool(err, 'get_serp_results')
                return {
                  keyword: entry.keyword,
                  ok: false as const,
                  code: failed.code,
                  error: failed.error,
                }
              }
            }),
          )
          const okCount = results.filter((result) => result.ok).length
          if (okCount === 0) {
            const first = results[0] as
              | { code?: string; error?: string }
              | undefined
            return {
              success: false,
              code: first?.code,
              error: first?.error ?? 'Nothing could be looked up.',
              results,
            }
          }
          return { success: true, results, reading: SERP_READING_NOTE }
        } catch (err) {
          return seoFailureForTool(err, 'get_serp_results')
        }
      },
    }),

    get_domain_overview: tool({
      description:
        'A domain’s overview in one country: its estimated monthly organic traffic from Google, how many keywords it ranks for, the keywords bringing it the most traffic and its best pages. Use it first when looking at a domain, the workspace’s own (the default, with no domain named) or a competitor’s. ' +
        'Figures are the provider’s estimates, not the site’s analytics: say so. Stored for 12 hours. Next: get_ranked_keywords for more of its keywords (filtered, paged), find_serp_competitors for who else competes.',
      inputSchema: z.object({
        domain: z
          .string()
          .trim()
          .min(1)
          .max(2048)
          .optional()
          .describe(
            'A domain or URL, e.g. "example.com". Default the workspace’s own website',
          ),
        ...marketFields,
        refresh: refreshField,
      }),
      execute: async (args) => {
        try {
          const out = await getDomainOverview(supabase, who, args)
          if (!out.ok) return refusal(out)
          const o = out.result
          const keywords = o.top_keywords.slice(0, 20)
          const pages = o.top_pages.slice(0, 10)
          return {
            success: true,
            domain: o.domain,
            is_own_site: o.is_own_site,
            location_code: o.location_code,
            organic_traffic: o.organic_traffic,
            organic_keywords: o.organic_keywords,
            has_data: o.has_data,
            top_keywords: keywords.map(compactDomainKeyword),
            more_keywords: Math.max(0, o.top_keywords.length - keywords.length),
            top_pages: pages.map((page) => ({
              url: page.url,
              traffic: page.organic_traffic,
              keywords: page.keywords,
            })),
            caveats: o.caveats,
            fetched_at: o.fetched_at,
            from_cache: o.from_cache,
            ...(o.partial ? { partial: o.partial.note } : {}),
            ...(o.has_data
              ? {}
              : {
                  hint: 'No rankings found for this domain in this country yet. Check the domain and the country; for a new site, find_keywords on its main topics finds keywords to target. This answer is kept for a few hours; refresh looks again only when the person asks.',
                }),
          }
        } catch (err) {
          return seoFailureForTool(err, 'get_domain_overview')
        }
      },
    }),

    get_ranked_keywords: tool({
      description:
        'The keywords a domain, folder or page ranks for in Google in one country, each with its position, search volume, estimated traffic, difficulty, CPC and the ranking URL: evidence for which keywords and pages earn a site its search traffic. Filter by min_search_volume, max_rank (e.g. 10 for page one) or exclude_terms (a brand name); page with offset. Default target: the workspace’s own website. Stored for 12 hours. For the domain’s totals, use get_domain_overview.',
      inputSchema: z.object({
        target: z
          .string()
          .trim()
          .min(1)
          .max(2048)
          .optional()
          .describe(
            'A domain ("example.com") or a page or folder URL. Default the workspace’s own website',
          ),
        scope: z
          .enum(RESEARCH_SCOPES)
          .optional()
          .describe(
            "'subdomains' (default for a domain), 'domain' (without subdomains), 'subfolder' (default for a URL with a path), 'exact_url' (one page)",
          ),
        ...marketFields,
        sort_by: z
          .enum(RANKED_KEYWORD_SORTS)
          .optional()
          .describe('Default search_volume'),
        min_search_volume: z.number().int().min(0).optional(),
        max_rank: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Only keywords ranking at this position or better'),
        exclude_terms: z
          .array(z.string().trim().min(1).max(80))
          .max(10)
          .optional()
          .describe('Leave out keywords containing these (brand terms)'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('How many (default 50)'),
        offset: z
          .number()
          .int()
          .min(0)
          .max(1000)
          .optional()
          .describe('next_offset from the previous call'),
        refresh: refreshField,
      }),
      execute: async (args) => {
        try {
          const out = await getRankedKeywords(supabase, who, args)
          if (!out.ok) return refusal(out)
          const p = out.result
          return {
            success: true,
            target: p.target,
            scope: p.scope,
            is_own_site: p.is_own_site,
            total_count: p.total_count,
            keywords: p.rows.map(compactDomainKeyword),
            next_offset: p.next_offset,
            caveats: p.caveats,
            fetched_at: p.fetched_at,
            from_cache: p.from_cache,
            columns:
              'position = place on the results page; traffic = estimated monthly visits from that keyword; kd = difficulty 0-100.',
          }
        } catch (err) {
          return seoFailureForTool(err, 'get_ranked_keywords')
        }
      },
    }),

    find_serp_competitors: tool({
      description:
        'Find the domains that compete in Google for a set of 1-100 keywords in one country: how many of the keywords each ranks for, its average position, visibility and estimated traffic from them. Use it to learn who a site’s real search competitors are for a topic. The workspace’s own site is marked own_site. Sorting and excluding domains reuse the stored result for free. Stored for 12 hours. For who ranks on one keyword right now, use get_serp_results.',
      inputSchema: z.object({
        keywords: z
          .array(z.string().trim().min(1).max(200))
          .min(1)
          .max(100)
          .describe('1-100 keywords'),
        ...marketFields,
        result_types: z
          .array(z.enum(SERP_COMPETITOR_RESULT_TYPES))
          .min(1)
          .max(4)
          .optional()
          .describe('Which results count (default organic and local_pack)'),
        exclude_domains: z
          .array(z.string().trim().min(1).max(255))
          .max(50)
          .optional()
          .describe('Domains to leave out (marketplaces, directories)'),
        sort_by: z
          .enum(SERP_COMPETITOR_SORTS)
          .optional()
          .describe('Default visibility'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('How many competitors (default 20)'),
        refresh: refreshField,
      }),
      execute: async (args) => {
        try {
          const out = await findSerpCompetitors(supabase, who, {
            ...args,
            limit: args.limit ?? 20,
          })
          if (!out.ok) return refusal(out)
          return {
            success: true,
            keywords_compared: out.result.keywords.length,
            own_domain: out.result.own_domain,
            competitors: out.result.rows.map((row) => ({
              domain: row.domain,
              keywords: row.keywords_count,
              avg_position: row.avg_position,
              visibility: row.visibility,
              traffic: row.etv,
              own_site: row.own_site,
            })),
            caveats: out.result.caveats,
            fetched_at: out.result.fetched_at,
            from_cache: out.result.from_cache,
            ...(out.result.rows.length === 0
              ? {
                  hint: 'No competitor data for these keywords in this country. get_keyword_metrics shows whether they have search volume; get_serp_results reads one keyword live.',
                }
              : {}),
          }
        } catch (err) {
          return seoFailureForTool(err, 'find_serp_competitors')
        }
      },
    }),

    get_seo_spend: tool({
      description:
        'How much of this month’s search data allowance the workspace has used, the ceiling, when it starts over, and whether search data lookups are available to this person at all. Free. Use it only when the person asks about it, or to explain why a lookup was refused.',
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const [summary, access] = await Promise.all([
            seoSpendSummary(supabase, workspaceId),
            checkSeoDataAccess({ userId, workspaceId, unattended: false }),
          ])
          return {
            success: true,
            spent_dollars: Math.round(summary.spent_dollars * 100) / 100,
            cap_dollars: summary.cap_dollars,
            resets_at: summary.resets_at,
            configured: isDataforseoConfigured(),
            available: access.ok,
            ...(access.ok ? {} : { why_not: access.message }),
          }
        } catch (err) {
          return seoFailureForTool(err, 'get_seo_spend')
        }
      },
    }),
  }
}
