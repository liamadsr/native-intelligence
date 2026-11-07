/**
 * A plain Exa web search, run by the server: the Mac body's `web_search`
 * (docs/plans/teammate-agent.md C1). The Mac's model relay refuses
 * provider-executed tools (its network is off), so the search the cloud body
 * gets from the Gateway's Exa tool inside a model step
 * (src/lib/ai/tools/web-search.ts, eve's web_search) runs here as a function
 * tool instead, with the same parameters: 10 results, 1,000-character
 * highlights, a 10 s live crawl, a week's cache.
 *
 * Not a model call: Exa's search endpoint, straight, with `EXA_API_KEY`, as
 * deep-search.ts does (the one Exa client's errors and URL are reused).
 * PURE + INJECTABLE: `fetchImpl` is a parameter, like deepSearch's.
 */
import { EXA_SEARCH_URL, ExaNotConfiguredError, ExaRequestError } from './deep-search'

/** Results per search: eve's and the Gateway tool's default. */
export const WEB_SEARCH_NUM_RESULTS = 10
/** Highlight budget per result, as the cloud's search. */
export const WEB_SEARCH_HIGHLIGHT_MAX_CHARACTERS = 1000
/** One slow page costs one result, not the call. */
export const WEB_SEARCH_LIVECRAWL_TIMEOUT_MS = 10_000
/** A week of cache: fast and cheap; chat questions are rarely hour-sensitive. */
export const WEB_SEARCH_MAX_AGE_HOURS = 168
/** The whole request's bound. */
export const WEB_SEARCH_TIMEOUT_MS = 30_000

export interface WebSearchHit {
  title: string | null
  url: string
  publishedDate: string | null
  author: string | null
  highlights: string[]
}

export interface WebSearchResult {
  results: WebSearchHit[]
  /** Exa's `costDollars.total`, or null when it reported none. */
  costDollars: number | null
}

export interface WebSearchArgs {
  query: string
  numResults?: number
  apiKey?: string
  fetchImpl?: typeof fetch
  signal?: AbortSignal
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

/** Exa's response, mapped; anything unusable is dropped, never thrown. */
export function parseWebSearchResponse(json: unknown): WebSearchResult {
  const root = json && typeof json === 'object' ? (json as Record<string, unknown>) : {}
  const results: WebSearchHit[] = []
  for (const raw of Array.isArray(root.results) ? root.results : []) {
    const item = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
    const url = text(item.url)
    if (!url) continue
    results.push({
      title: text(item.title),
      url,
      publishedDate: text(item.publishedDate),
      author: text(item.author),
      highlights: Array.isArray(item.highlights) ? item.highlights.filter((h): h is string => typeof h === 'string') : [],
    })
  }
  const cost = (root.costDollars && typeof root.costDollars === 'object' ? (root.costDollars as Record<string, unknown>) : {}).total
  return { results, costDollars: typeof cost === 'number' && Number.isFinite(cost) ? cost : null }
}

/** Run one search. Throws ExaNotConfiguredError before any fetch without a key, ExaRequestError on a non-2xx. */
export async function exaWebSearch(args: WebSearchArgs): Promise<WebSearchResult> {
  const apiKey = args.apiKey ?? process.env.EXA_API_KEY
  if (!apiKey) throw new ExaNotConfiguredError()
  const fetchImpl = args.fetchImpl ?? fetch
  const timeout = AbortSignal.timeout(WEB_SEARCH_TIMEOUT_MS)
  const res = await fetchImpl(EXA_SEARCH_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({
      query: args.query,
      type: 'auto',
      numResults: Math.max(1, Math.min(args.numResults ?? WEB_SEARCH_NUM_RESULTS, WEB_SEARCH_NUM_RESULTS)),
      contents: {
        highlights: { maxCharacters: WEB_SEARCH_HIGHLIGHT_MAX_CHARACTERS },
        livecrawlTimeout: WEB_SEARCH_LIVECRAWL_TIMEOUT_MS,
        maxAgeHours: WEB_SEARCH_MAX_AGE_HOURS,
      },
    }),
    signal: args.signal ? AbortSignal.any([args.signal, timeout]) : timeout,
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new ExaRequestError(`Exa search failed (${res.status})${body ? `: ${body.slice(0, 300)}` : ''}`, res.status)
  }
  return parseWebSearchResponse(await res.json().catch(() => null))
}
