'use client'

import { memo, useId, useState } from 'react'
import { Globe, ChevronDown, ExternalLink } from 'lucide-react'
import { ShimmerText } from '@/components/ui/shimmer-text'
import { cn } from '@/lib/utils'

/**
 * The "Searched the web" card for a `web_search` tool call.
 *
 * `web_search` is eve's PROVIDER-EXECUTED built-in (Exa via the AI Gateway), not
 * one of our own workspace tools — so it never appears in the tool registry and
 * has no entity links. Its result is a bag of external URLs, which the generic
 * `Tool` chip would render as a wall of collapsed JSON. This card renders it the
 * way the rest of the chat renders tool work: ONE line, collapsed by default.
 * "Searching the web" shimmers while it runs (ShimmerText); settled, it reads
 * "Searched the web · N sources", and the chevron opens the clickable sources
 * (or a failure's message). Nothing chunky sits in the thread unless asked for.
 *
 * ── One renderer, both runtimes ─────────────────────────────────────────────
 * The classic Vercel-AI-SDK path emits a static `tool-web_search` UI part
 * (providerExecuted: true). The eve path emits a DYNAMIC tool part with
 * toolName 'web_search' — eve's harness surfaces provider-executed calls on the
 * session stream as ordinary actions (`emission.js` → `collectProviderToolCall`
 * → `actions.requested` with `kind: 'tool-call'`, then `action.result` with
 * `kind: 'tool-result'`), which `eve-chat-transport` already maps through its
 * normal announce/result rail. Both therefore reach `chat-message`'s
 * `renderToolPart` with the same toolName and the same Exa output object, so
 * this single component serves both with no transport change.
 *
 * Everything here treats titles/URLs as UNTRUSTED text from the open web: text
 * nodes only (never dangerouslySetInnerHTML), links forced through
 * `target="_blank" rel="noopener noreferrer"`, and non-http(s) schemes dropped
 * so a `javascript:` result can never become a clickable href.
 */

/**
 * The tool name on BOTH runtimes. Matches eve's built-in framework name
 * (`WEB_SEARCH_TOOL_NAME` in eve/dist/src/harness/provider-tool-schemas.js), so
 * a static `tool-web_search` part and an eve dynamic part both key to this.
 */
export const WEB_SEARCH_TOOL_NAME = 'web_search'

/** How many results render before the "+N more" expander. */
export const WEB_SEARCH_VISIBLE_RESULTS = 5

/** One normalized search hit, safe to render. */
export interface WebSearchResult {
  /** Absolute http(s) URL. Never a javascript:/data: scheme (filtered out). */
  url: string
  /** Display title — falls back to the URL's hostname when Exa returns none. */
  title: string
  /** First highlight/snippet line, clipped. Absent when the hit carried none. */
  snippet?: string
}

/** The normalized view of a web_search output the card renders from. */
export type WebSearchOutcome =
  | { status: 'success'; results: WebSearchResult[] }
  /** The Exa error branch ({ error, message }) — surfaced plainly, not alarmingly. */
  | { status: 'error'; message: string }
  /** Output missing, truncated to a string, or in a shape we don't recognize. */
  | { status: 'unknown' }

/** Longest snippet we render before eliding — one line, not a paragraph. */
const MAX_SNIPPET_CHARS = 140

/** Longest query we echo in the header line. */
const MAX_QUERY_CHARS = 80

function clip(text: string, max: number): string {
  const t = text.trim()
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t
}

/**
 * Keep only URLs the browser can safely open from a link. Exa returns absolute
 * http(s) URLs, but the result bag is external data — an unexpected scheme
 * (`javascript:`, `data:`) must never reach an href.
 */
function isSafeHttpUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string' || !raw) return false
  try {
    const proto = new URL(raw).protocol
    return proto === 'http:' || proto === 'https:'
  } catch {
    return false
  }
}

/** Bare hostname for display (`https://www.acme.com/x` → `acme.com`). */
export function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/**
 * Normalize a raw `web_search` output into the shape the card renders.
 *
 * Handles every branch eve's Exa output schema declares
 * (node_modules/eve/dist/src/harness/provider-tool-schemas.js →
 * WEB_SEARCH_EXA_OUTPUT_SCHEMA):
 *   - success: `{ requestId, results: [{ url, id, title?, highlights?, text?, … }] }`
 *   - error:   `{ error: 'rate_limit' | …, message, statusCode? }`
 * plus the defensive cases the transport can produce: a missing output (the call
 * is still running), and an output truncated to a STRING by
 * `truncateToolOutput` when a 10-result crawl exceeds the 64KB display cap.
 *
 * Pure and total — never throws, whatever shape it is handed.
 */
export function parseWebSearchOutput(output: unknown): WebSearchOutcome {
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    return { status: 'unknown' }
  }
  const bag = output as Record<string, unknown>

  // Error branch first: it is the only branch carrying `error`, and a bag with
  // both would be malformed — surfacing the error is the safer read.
  if (typeof bag.error === 'string') {
    const message = typeof bag.message === 'string' && bag.message.trim()
      ? bag.message.trim()
      : bag.error
    return { status: 'error', message }
  }

  if (!Array.isArray(bag.results)) return { status: 'unknown' }

  const results: WebSearchResult[] = []
  // Exa can return the same URL twice (e.g. a livecrawl hit and a cached hit).
  // One source line per URL keeps the list honest and keeps `key={r.url}`
  // unique in the renderer.
  const seenUrls = new Set<string>()
  for (const raw of bag.results) {
    if (!raw || typeof raw !== 'object') continue
    const hit = raw as Record<string, unknown>
    if (!isSafeHttpUrl(hit.url)) continue
    if (seenUrls.has(hit.url)) continue
    seenUrls.add(hit.url)

    const rawTitle = typeof hit.title === 'string' ? hit.title.trim() : ''
    const title = rawTitle || hostLabel(hit.url)

    // Prefer a highlight (Exa's per-result relevant excerpt) over the raw page
    // text, which is the full crawl and reads as noise in a one-line snippet.
    const highlight = Array.isArray(hit.highlights)
      ? hit.highlights.find((h): h is string => typeof h === 'string' && h.trim().length > 0)
      : undefined
    const fallback = typeof hit.text === 'string' && hit.text.trim() ? hit.text : undefined
    const snippetSource = highlight ?? fallback

    results.push({
      url: hit.url,
      title: clip(title, 120),
      // Collapse the whitespace a crawled excerpt carries so it stays one line.
      ...(snippetSource
        ? { snippet: clip(snippetSource.replace(/\s+/g, ' '), MAX_SNIPPET_CHARS) }
        : {}),
    })
  }

  // An empty `results` array is a legitimate success (the query found nothing),
  // distinct from an unrecognized shape — the card says "No results".
  return { status: 'success', results }
}

/**
 * Pull the human-readable query out of a web_search input bag.
 *
 * The Exa gateway tool takes `{ query }`, but the same framework tool name is
 * backed by OpenAI/Anthropic web search on other model routes, whose inputs use
 * `queries: string[]` or a nested `{ action: { query } }`. Read every shape
 * best-effort; a miss degrades to no query line, never a throw.
 */
export function readWebSearchQuery(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null
  const bag = input as Record<string, unknown>

  const direct = bag.query ?? bag.q ?? bag.search
  if (typeof direct === 'string' && direct.trim()) return clip(direct, MAX_QUERY_CHARS)

  // Multi-query variants: join so the chip reflects everything asked for.
  if (Array.isArray(bag.queries)) {
    const joined = bag.queries
      .filter((q): q is string => typeof q === 'string' && q.trim().length > 0)
      .map((q) => q.trim())
      .join(', ')
    if (joined) return clip(joined, MAX_QUERY_CHARS)
  }

  // OpenAI's provider tool nests the query under `action`.
  if (bag.action && typeof bag.action === 'object') {
    return readWebSearchQuery(bag.action)
  }
  return null
}

/**
 * The header line: what the card says it is doing / did. Pure so the label is
 * testable without mounting, and so the running and settled copy stay in one
 * place ("Searching the web" → "Searched the web").
 */
export function webSearchHeadline(
  running: boolean,
  outcome: WebSearchOutcome,
): string {
  if (running) return 'Searching the web'
  if (outcome.status === 'error') return 'Web search unavailable'
  if (outcome.status === 'success' && outcome.results.length === 0) {
    return 'Searched the web — no results'
  }
  return 'Searched the web'
}

export interface WebSearchCardProps {
  /** True while the call is in flight (input-streaming / input-available). */
  running: boolean
  /** The tool call's input bag, for the query line. */
  input?: unknown
  /** The tool call's raw output (Exa bag, error bag, or absent while running). */
  output?: unknown
  /** Set when the part settled as output-error — rendered as the error message. */
  errorText?: string
}

function WebSearchCardImpl({ running, input, output, errorText }: WebSearchCardProps) {
  // Two disclosures: the row opens the sources, and a long list then opens
  // past its first few ("N more results").
  const [open, setOpen] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const panelId = useId()

  const query = readWebSearchQuery(input)
  // A transport-level failure (output-error) outranks the payload: there is no
  // Exa bag to parse in that case, only the error text.
  const outcome: WebSearchOutcome = errorText
    ? { status: 'error', message: errorText }
    : parseWebSearchOutput(output)

  const results = !running && outcome.status === 'success' ? outcome.results : []
  const visible = showAll ? results : results.slice(0, WEB_SEARCH_VISIBLE_RESULTS)
  const hiddenCount = results.length - visible.length
  const errorMessage = !running && outcome.status === 'error' ? outcome.message : null
  const expandable = results.length > 0 || errorMessage !== null
  const headline = webSearchHeadline(running, outcome)

  const rowContent = (
    <>
      <Globe className="h-4 w-4 shrink-0 text-muted-foreground" />
      {running ? (
        <ShimmerText active className="shrink-0 text-sm font-medium">{headline}</ShimmerText>
      ) : (
        <span className="shrink-0 text-sm font-medium">{headline}</span>
      )}
      {query && (
        <span className="min-w-0 truncate text-xs text-muted-foreground">
          {query}
        </span>
      )}
      {results.length > 0 && (
        <span className="shrink-0 text-xs text-muted-foreground/70">
          · {results.length} {results.length === 1 ? 'source' : 'sources'}
        </span>
      )}
      {expandable && (
        <ChevronDown
          className={cn(
            'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-180',
          )}
        />
      )}
    </>
  )

  return (
    <div className="my-0.5 flex flex-col gap-1.5">
      {expandable ? (
        <button
          type="button"
          data-web-search-toggle=""
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 max-w-full items-center gap-2 py-1 text-left"
        >
          {rowContent}
        </button>
      ) : (
        <div className="flex min-w-0 items-center gap-2 py-1">{rowContent}</div>
      )}

      {open && (
        <div id={panelId} className="flex flex-col gap-1.5">
          {errorMessage !== null && (
            // Deliberately plain: a failed web lookup is a normal degradation the
            // model routes around, not an app error worth a red alarm state.
            <p className="pl-6 text-xs text-muted-foreground">{errorMessage}</p>
          )}

          {visible.length > 0 && (
            <ul className="flex flex-col gap-1.5 pl-6">
              {visible.map((r) => (
                <li key={r.url} className="min-w-0">
                  <a
                    href={r.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="group/src inline-flex max-w-full items-center gap-1 text-xs font-medium text-primary hover:underline"
                  >
                    <span className="truncate">{r.title}</span>
                    <ExternalLink className="h-3 w-3 shrink-0 opacity-60" />
                  </a>
                  <div className="truncate text-[11px] text-muted-foreground">
                    {hostLabel(r.url)}
                    {r.snippet ? ` · ${r.snippet}` : ''}
                  </div>
                </li>
              ))}
            </ul>
          )}

          {hiddenCount > 0 && (
            <button
              type="button"
              data-web-search-more=""
              onClick={() => setShowAll(true)}
              className="ml-6 inline-flex w-fit items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              <ChevronDown className="h-3 w-3" />
              {hiddenCount} more {hiddenCount === 1 ? 'result' : 'results'}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Memoized for the same reason `Tool` is: the parent re-walks every part on each
 * streamed token, and a settled search's props are referentially stable (the AI
 * SDK clones only the actively-streaming part), so shallow compare bails.
 */
export const WebSearchCard = memo(WebSearchCardImpl)
