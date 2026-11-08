import 'server-only'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { logUsage } from '@/lib/ai/auth'
import { CHATGPT_PLAN_PROVIDER, PLAN_HELPER_MODEL, planModelSlug } from '@/lib/chatgpt/plan-models'
import { chatgptPlanFor } from '@/lib/chatgpt/plan-route'
import {
  deepSearch,
  fieldKeyFromPath,
  type DeepSearchArgs,
  type DeepSearchGrounding,
  type DeepSearchResult,
  type DeepSearchResultItem,
} from '@/lib/exa/deep-search'
import type { WebSearchHit, WebSearchResult } from '@/lib/exa/web-search'
import { runUtilityTask, type UtilityUsageReport } from '@/lib/eve/utility/run-utility'

/**
 * Exa's deep search (src/lib/exa/deep-search.ts) on a free user's own ChatGPT
 * plan (docs/plans/chatgpt-free-tier-handoff.md, 3g). Exa bills Native Intelligence, so it
 * never runs for a person on their plan; for them prospecting, CRM
 * enrichment and the ICP card send the same query and card schema to the
 * web-research agent (agents/web-research, the `plan_web_search` kind), which
 * answers with OpenAI's own web search on their plan.
 *
 * Same signature, same result: a DeepSearchResult whose `content` is the card,
 * whose `grounding` cites each field in Exa's shape, and whose `results` are
 * the pages relied on, so every reader (groundedFields, sourcesOf,
 * groundedArray, the relevance gates) works unchanged. What differs:
 *   - the card's `required` lists are dropped: a field the model can't find
 *     stays out rather than being invented to satisfy the schema;
 *   - a citation must be an http(s) URL; with `includeDomains` it must be on
 *     one of them; a field left without a citation loses its grounding, so
 *     it reads as 'low' and fills no column;
 *   - an answer from a session that ran no web search is read as 'low'
 *     throughout: whatever it says came from the model, not the web;
 *   - no free firmographics (`results[].entities`): Exa's own data;
 *   - `costDollars` is 0: the person's plan pays.
 * The plan model's confidence is its own judgement, where Exa's comes from
 * Exa's grounding; the write-back's gates (fill-empty, high/medium only, the
 * relevance demotions) apply to both.
 *
 * Anchored by the pages the searches read, not by retrieval: the agent's
 * web_search slot takes no per-call `filters` (allowed domains), so
 * `onlySites` is an instruction and the citation filter checks each URL's
 * host. When the session's stream names the pages its searches read (a
 * search's sources, a page it opened: webSources), a citation must be one of
 * them; a search's sources aren't always returned, and then the host check
 * is all there is.
 *
 * It runs on the plan's helper model (Luna): background work on the lighter
 * model, as everywhere on the free tier, and a person's ChatGPT limits are
 * shared with their own use of ChatGPT.
 */

/** Who the search runs for: the person whose plan pays, and their workspace. */
export interface PlanSearcher {
  userId: string
  workspaceId: string | null
}

/** A deep search: Exa's, or the person's plan's (deepSearchForUser). */
export type DeepSearchFn = (args: DeepSearchArgs) => Promise<DeepSearchResult>

/** The usage row's feature for a plan deep search (the kind's Gateway-free twin of Exa's spend). */
export const PLAN_DEEP_SEARCH_FEATURE = 'web_research.plan'

// No hard maxima: a discovery list (20 companies, each field cited) is long,
// and an answer over a cap would throw away the whole call. The result is
// trimmed instead (planDeepSearchResult).
const citation = z.object({ url: z.string(), title: z.string().nullish() })
const planAnswer = z.object({
  content: z.record(z.string(), z.unknown()),
  grounding: z.array(z.object({ field: z.string(), citations: z.array(citation), confidence: z.enum(['low', 'medium', 'high']) })),
  sources: z.array(citation),
})

/** What a result keeps of an answer: enough for a 20-company list, each field cited. */
const MAX_GROUNDING = 300
const MAX_CITATIONS_PER_FIELD = 3
const MAX_RESULTS = 60
export type PlanDeepSearchAnswer = z.infer<typeof planAnswer>

/** A card schema with every `required` list dropped, deeply. Pure: never mutates `schema`. */
export function relaxedCardSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(relaxedCardSchema)
  if (!schema || typeof schema !== 'object') return schema
  return Object.fromEntries(
    Object.entries(schema as Record<string, unknown>)
      .filter(([key]) => key !== 'required')
      .map(([key, value]) => [key, relaxedCardSchema(value)]),
  )
}

/** The task message: everything Exa's request carries, for the model to act on. Pure. */
export function planDeepSearchMessage(args: DeepSearchArgs): string {
  return JSON.stringify({
    query: args.query,
    ...(args.category ? { subject: args.category === 'people' ? 'a person' : 'a company' } : {}),
    ...(args.additionalQueries?.length ? { extraSearches: args.additionalQueries } : {}),
    ...(args.includeDomains?.length ? { onlySites: args.includeDomains } : {}),
    ...(args.systemPrompt?.trim() ? { instructions: args.systemPrompt.trim() } : {}),
    ...(args.numResults ? { readAtLeast: `${args.numResults} pages` } : {}),
    card: relaxedCardSchema(args.outputSchema),
  })
}

/** A URL a citation may carry: http(s), on one of `domains` when there are any. */
function citable(raw: string, domains: readonly string[]): string | null {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  const host = url.hostname.toLowerCase().replace(/^www\./, '')
  if (domains.length && !domains.some((d) => host === d || host.endsWith(`.${d}`))) return null
  return url.href
}

/** A page's identity for matching a citation to a searched page: host and path (OpenAI appends `?utm_source=openai`). */
function pageKey(url: string): string {
  try {
    const u = new URL(url)
    return `${u.hostname.toLowerCase().replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}`
  } catch {
    return url
  }
}

/** The card's top-level field names (its `properties`), or null for a schema without them. */
function cardFields(schema: object): Set<string> | null {
  const properties = (schema as { properties?: unknown }).properties
  return properties && typeof properties === 'object' ? new Set(Object.keys(properties)) : null
}

/**
 * The plan's answer as Exa's result (see the header). `webSources`: the pages
 * the session's searches returned, when its stream carried them; a citation
 * must then be one of them. `searched`: whether the session ran a web search
 * at all (false: every field reads as low). Pure.
 */
export function planDeepSearchResult(
  answer: PlanDeepSearchAnswer,
  args: DeepSearchArgs,
  webSources: readonly string[] = [],
  searched = true,
): DeepSearchResult {
  const domains = (args.includeDomains ?? []).map((d) => d.trim().toLowerCase().replace(/^www\./, '')).filter(Boolean)
  const seen = new Set(webSources.map(pageKey))
  const keep = (raw: string) => {
    const url = citable(raw, domains)
    return url && (seen.size === 0 || seen.has(pageKey(url))) ? url : null
  }
  const fields = cardFields(args.outputSchema)

  const content: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(answer.content)) {
    if (fields && !fields.has(key)) continue
    if (value === null || value === undefined || (typeof value === 'string' && !value.trim())) continue
    content[key] = value
  }

  const grounding: DeepSearchGrounding[] = []
  for (const g of answer.grounding) {
    if (grounding.length >= MAX_GROUNDING) break
    // A path as Exa writes it: "industry", "content.industry" or "companies[0].industry".
    const root = g.field.replace(/^content\./, '').split(/[.[]/)[0]?.trim() ?? ''
    if (!fieldKeyFromPath(g.field) || !(root in content)) continue
    const citations = g.citations.flatMap((c) => {
      const url = keep(c.url)
      return url ? [{ url, title: c.title?.trim().slice(0, 400) || null }] : []
    }).slice(0, MAX_CITATIONS_PER_FIELD)
    if (citations.length) grounding.push({ field: g.field, citations, confidence: searched ? g.confidence : 'low' })
  }

  const results: DeepSearchResultItem[] = []
  const listed = new Set<string>()
  for (const s of [...answer.sources, ...grounding.flatMap((g) => g.citations), ...webSources.map((url) => ({ url, title: null }))]) {
    if (results.length >= MAX_RESULTS) break
    const url = keep(s.url)
    if (!url || listed.has(url)) continue
    listed.add(url)
    results.push({ url, title: s.title?.trim().slice(0, 400) || null, publishedDate: null })
  }

  return { requestId: null, content: Object.keys(content).length ? content : null, grounding, results, costDollars: 0 }
}

/**
 * One deep search on the person's plan. Throws when the session fails or its
 * answer can't be read, as deepSearch throws on an Exa failure (each caller
 * already treats that as transient). `args.signal` bounds it. Logs its usage
 * under the plan's provider, at no cost, failed attempts included.
 */
export async function planDeepSearch(args: DeepSearchArgs, searcher: PlanSearcher): Promise<DeepSearchResult> {
  const startedAt = Date.now()
  const usageKey = `web_research:${randomUUID()}`
  let report: UtilityUsageReport | null = null
  try {
    const result = await runUtilityTask({
      kind: 'plan_web_search',
      workspaceId: searcher.workspaceId,
      userId: searcher.userId,
      chatgptPlan: true,
      planModel: PLAN_HELPER_MODEL,
      message: planDeepSearchMessage(args),
      outputSchema: planAnswer,
      ...(args.signal ? { signal: args.signal } : {}),
      onUsage: (r) => { report = r },
    })
    const searched = result.webSearches === undefined || result.webSearches > 0
    if (!searched) console.warn('[plan-deep-search] the session ran no web search: every field reads as low')
    return planDeepSearchResult(result.object, args, result.webSources, searched)
  } catch (err) {
    // The caller's deadline (AbortSignal.timeout) as itself, so its timeout
    // reads as one (enrichment's isTimeoutError), not as a cancel.
    if (args.signal?.aborted && args.signal.reason !== undefined) throw args.signal.reason
    throw err
  } finally {
    // No session, nothing spent: only a dispatched session is logged.
    const usage = (report as UtilityUsageReport | null)?.usage
    if (report) await logUsage(searcher.userId, {
      provider: CHATGPT_PLAN_PROVIDER,
      model: planModelSlug(PLAN_HELPER_MODEL),
      feature: PLAN_DEEP_SEARCH_FEATURE,
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      durationMs: Date.now() - startedAt,
      idempotencyKey: usageKey,
      metadata: {
        workspace_id: searcher.workspaceId,
        category: args.category ?? null,
        complete: (report as UtilityUsageReport | null)?.complete ?? false,
        cost_source: 'chatgpt_plan',
      },
    }).catch((err) => console.error('[plan-deep-search] usage log failed:', err instanceof Error ? err.message : String(err)))
  }
}

/**
 * A plain web search on the person's plan, in Exa's search-result shape
 * (src/lib/exa/web-search.ts), for a tool that shows the model a list of
 * pages: the Mac body's `web_search` (src/lib/local-agent/web-tools.ts). A
 * plan deep search whose card is the result list. A hit is kept only with an
 * http(s) URL among the pages the answer relied on (its results, each checked
 * as planDeepSearchResult checks a citation). At no cost to Native Intelligence.
 */
export const PLAN_WEB_SEARCH_CARD = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      description: 'The pages that best answer the query, most relevant first.',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: "The page's title." },
          url: { type: 'string', description: "The page's URL." },
          snippet: { type: 'string', description: 'What the page says that answers the query, in a sentence or two, quoted or closely paraphrased.' },
        },
      },
    },
  },
} as const

export async function planWebSearch(
  args: { query: string; numResults?: number; signal?: AbortSignal },
  searcher: PlanSearcher,
): Promise<WebSearchResult> {
  const max = Math.max(1, Math.min(args.numResults ?? 5, 10))
  const res = await planDeepSearch(
    { query: args.query, outputSchema: PLAN_WEB_SEARCH_CARD, numResults: max, ...(args.signal ? { signal: args.signal } : {}) },
    searcher,
  )
  const relied = new Set(res.results.map((r) => pageKey(r.url)))
  const listed = Array.isArray(res.content?.results) ? (res.content.results as unknown[]) : []
  const hits: WebSearchHit[] = []
  for (const raw of listed) {
    const hit = raw as { title?: unknown; url?: unknown; snippet?: unknown }
    const url = typeof hit.url === 'string' ? citable(hit.url, []) : null
    if (!url || !relied.has(pageKey(url)) || hits.some((h) => h.url === url)) continue
    hits.push({
      title: typeof hit.title === 'string' && hit.title.trim() ? hit.title.trim().slice(0, 400) : null,
      url,
      publishedDate: null,
      author: null,
      highlights: typeof hit.snippet === 'string' && hit.snippet.trim() ? [hit.snippet.trim().slice(0, 1_000)] : [],
    })
    if (hits.length >= max) break
  }
  return { results: hits, costDollars: 0 }
}

/**
 * The deep search for work done for a person: their plan's when they run on
 * it, else Exa's. An unreadable plan check throws (read twice first): a job
 * that can't tell must not run a free user on Exa, which Native Intelligence pays for; the
 * callers treat the throw as transient and try again later. No person (an
 * unattributed job) is Exa, as before.
 */
export async function deepSearchForUser(userId: string | null | undefined, workspaceId: string | null): Promise<DeepSearchFn> {
  if (!userId) return deepSearch
  if (!(await chatgptPlanFor(userId, { attempts: 2, failClosed: true }))) return deepSearch
  return (args) => planDeepSearch(args, { userId, workspaceId })
}
