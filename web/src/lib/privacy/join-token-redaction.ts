/**
 * A workspace join link (/join/<token>, migration 644) lets anyone holding it
 * into the workspace, so its token must never reach analytics or error
 * reports. These helpers blank it in any string, plain or URL-encoded (as it
 * appears in a `redirect=` value, once or twice encoded), and walk an event
 * object to blank it wherever a URL lands: PostHog's $current_url,
 * $pathname, $referrer, their $initial_* copies, pageleave and autocapture
 * properties (href attributes included), and Sentry's request URL, query
 * string, headers, breadcrumbs, transaction name and tags.
 *
 * `/join/team` (the join-by-domain page) carries no secret and is kept.
 */

const REDACTED = 'redacted'

// /join/<token> as a page's path (not /join/team): at the start, after a
// host (`//app.example/join/…`), or after a delimiter (`redirect=/join/…`,
// `href="/join/…"`); never a deeper segment such as /api/…/workspace/join/accept.
const PLAIN = /((?:^|[=&?"'\s(,]|\/\/[^/\s?#"']+))(\/join\/)(?!team(?![A-Za-z0-9_-]))[A-Za-z0-9_-]+/g
// The same encoded once or twice (%2Fjoin%2F…, %252Fjoin%252F…), any case:
// a redirect= value holding the path, or a whole encoded URL.
const ENCODED = /((?:^|[=&?"'\s(,]|%(?:25)*2F%(?:25)*2F[^%/\s?#&"']+))(%(?:25)*2Fjoin%(?:25)*2F)(?!team(?![A-Za-z0-9_-]))[A-Za-z0-9_-]+/gi

/** The string with every join-link token blanked. Cheap when there is nothing to do. */
export function redactJoinTokens(value: string): string {
  if (!/join/i.test(value)) return value
  return value.replace(PLAIN, `$1$2${REDACTED}`).replace(ENCODED, `$1$2${REDACTED}`)
}

const MAX_DEPTH = 12

/**
 * Blank join-link tokens in every string inside `value`, in place, and hand
 * it back. Arrays and plain objects are walked (to a fixed depth); anything
 * else is left alone.
 */
export function scrubJoinTokens<T>(value: T, depth = 0): T {
  if (depth > MAX_DEPTH || value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const item = value[i]
      value[i] = typeof item === 'string' ? redactJoinTokens(item) : scrubJoinTokens(item, depth + 1)
    }
    return value
  }
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return value
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    const item = record[key]
    record[key] = typeof item === 'string' ? redactJoinTokens(item) : scrubJoinTokens(item, depth + 1)
  }
  return value
}

/** posthog-js `before_send`: the event with every join-link token blanked. */
export function scrubPostHogEvent<T extends { properties?: unknown; $set?: unknown; $set_once?: unknown } | null>(event: T): T {
  if (!event) return event
  scrubJoinTokens(event as unknown as Record<string, unknown>)
  return event
}

/** Sentry `beforeSend` / `beforeSendTransaction` / `beforeBreadcrumb`: the same, for its event shapes. */
export function scrubSentryEvent<T>(event: T): T {
  return scrubJoinTokens(event)
}

/** A join link's own page (/join/<token>), not the join-by-domain page (/join/team). */
export function isJoinLinkPage(pathname: string): boolean {
  return pathname.startsWith('/join/') && pathname !== '/join/team' && !pathname.startsWith('/join/team/')
}
