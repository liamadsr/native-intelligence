/**
 * The scope a workspace search ran over: its time window, and whether it read
 * transcript passages and attachments. The agent picks it on every call (`find`
 * and `deep_search` take `since` / `until` / `all_time`, `include_transcripts`
 * on deep_search, attachments through `types`), so the person never sets it.
 *
 * What a search with no window covers depends on the toolset
 * (SearchDefaultWindow): the main chat's starts at the past 4 weeks, where its
 * prompt tells the model when to widen; every other surface (runs, flows, MCP,
 * the live meeting agent, device ask) searches all time, as it always did.
 * Claims, the workspace's durable facts, and documents are never windowed by
 * default: only an explicit `since` / `until` filters them (a document by when
 * its text last changed, documents phase 1).
 *
 * Client-safe on purpose (no server imports): the tools stamp `scope` on their
 * result, and the chat's tool row reads it back (readSearchScope) to show a
 * short line such as "Past 4 weeks" or "All time · transcripts".
 */

/** What a search with no `since` / `until` / `all_time` covers, per toolset. */
export type SearchDefaultWindow = 'past_4_weeks' | 'all_time'

/** The main chat's first-pass window: the past 4 weeks. */
export const DEFAULT_SEARCH_WINDOW_DAYS = 28
export const DEFAULT_SEARCH_WINDOW_MS = DEFAULT_SEARCH_WINDOW_DAYS * 24 * 60 * 60 * 1000

/**
 * - `past_4_weeks`: the default window (nothing named).
 * - `range`: the agent named `since` and/or `until`.
 * - `all_time`: the agent asked for all history.
 */
export type SearchWindowKind = 'past_4_weeks' | 'range' | 'all_time'

export interface SearchScope {
  /** The window over captures, attachments and emails (documents only when the agent named one). */
  window: SearchWindowKind
  /** Lower bound actually applied to them (ISO), or null for none. */
  since: string | null
  /** Upper bound actually applied to them (ISO), or null for none. */
  until: string | null
  /** Claims were filtered by time: only ever by an explicit `since` / `until`. */
  claims_windowed: boolean
  /** Documents were filtered by time: only ever by an explicit `since` / `until`. Absent on an older result. */
  documents_windowed?: boolean
  /** Transcript passages (what was said) were searched and can come back. */
  transcripts: boolean
  /** Attachments (PDFs, images) were searched. */
  attachments: boolean
}

export interface ResolvedSearchWindow {
  window: SearchWindowKind
  since: string | null
  until: string | null
}

/**
 * The window a search runs over, from the agent's options. `sinceISO` /
 * `untilISO` are the already-resolved presets (resolveSince / resolveUntil;
 * null when absent or unparseable).
 *
 * - `all_time` drops the lower bound (an `until` still applies: "everything
 *   before X").
 * - A `since` or an `until` is the agent's own range. An `until` alone gets no
 *   default lower bound: "before last March" under a 4-week floor would be
 *   empty.
 * - Nothing named (or a `since` that does not parse): the toolset's default,
 *   the past 4 weeks in the main chat, all time everywhere else.
 */
export function resolveSearchWindow(
  opts: { sinceISO: string | null; untilISO: string | null; allTime?: boolean; defaultWindow?: SearchDefaultWindow },
  now: number = Date.now(),
): ResolvedSearchWindow {
  if (opts.allTime) return { window: 'all_time', since: null, until: opts.untilISO }
  if (opts.sinceISO || opts.untilISO) return { window: 'range', since: opts.sinceISO, until: opts.untilISO }
  if (opts.defaultWindow !== 'past_4_weeks') return { window: 'all_time', since: null, until: null }
  return { window: 'past_4_weeks', since: new Date(now - DEFAULT_SEARCH_WINDOW_MS).toISOString(), until: null }
}

/** A tool result's `scope`, or null when it carries none (an older result, an error). */
export function readSearchScope(output: unknown): SearchScope | null {
  if (!output || typeof output !== 'object') return null
  const scope = (output as { scope?: unknown }).scope
  if (!scope || typeof scope !== 'object') return null
  const s = scope as Record<string, unknown>
  if (s.window !== 'past_4_weeks' && s.window !== 'range' && s.window !== 'all_time') return null
  return {
    window: s.window,
    since: typeof s.since === 'string' ? s.since : null,
    until: typeof s.until === 'string' ? s.until : null,
    claims_windowed: s.claims_windowed === true,
    documents_windowed: s.documents_windowed === true,
    transcripts: s.transcripts === true,
    attachments: s.attachments === true,
  }
}

function shortDate(iso: string, now: Date): string {
  const d = new Date(iso)
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
  })
}

/**
 * The scope as a short line for the chat's tool row: "Past 4 weeks",
 * "All time · transcripts · attachments", "Since Sep 1", "Sep 1 – Sep 30",
 * "Before Jan 5, 2025".
 */
export function describeSearchScope(scope: SearchScope, now: Date = new Date()): string {
  let when: string
  if (scope.window === 'past_4_weeks') when = 'Past 4 weeks'
  else if (scope.window === 'all_time') when = scope.until ? `All time to ${shortDate(scope.until, now)}` : 'All time'
  else if (scope.since && scope.until) when = `${shortDate(scope.since, now)} – ${shortDate(scope.until, now)}`
  else if (scope.since) when = `Since ${shortDate(scope.since, now)}`
  else if (scope.until) when = `Before ${shortDate(scope.until, now)}`
  else when = 'All time'
  return [when, scope.transcripts ? 'transcripts' : null, scope.attachments ? 'attachments' : null]
    .filter(Boolean)
    .join(' · ')
}
