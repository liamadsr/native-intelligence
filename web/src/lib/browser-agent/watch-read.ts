/**
 * `watch_read`: the one browser command a page watch queues (page watches,
 * phase 2; src/lib/flows/page-watch/read-browser.ts). The relay opens the
 * address in a tab of its own, reads the page's visible text and closes the
 * tab again. No model is involved, nothing is clicked or typed, and the
 * agent's own tab is left as it was.
 *
 * Pure and shared: the server queues the command and reads its result, and the
 * relay in the person's sandbox (src/lib/cloud-browser/relay/runner.ts) runs it.
 */

export const WATCH_READ_COMMAND = 'watch_read'

/** The most text one read brings back (the page's innerText, cut here). */
export const WATCH_READ_MAX_CHARS = 200_000

/** Why a read brought back no text. */
export type WatchReadStop =
  /** The person has the browser (Take over): nothing runs for anyone else. */
  | 'taken_over'
  /** The person blocked the agent on this site, or the page led to one they blocked. */
  | 'site_blocked'
  /** The site's terms forbid agents. */
  | 'never_automate'
  /** The site only answers through the person's Mac, and the Mac is not connected. */
  | 'needs_your_mac'
  /** The page did not load, or showed nothing that could be read. */
  | 'load_failed'

export type WatchReadResult =
  | { ok: true; /** Where the browser ended up (a redirect to a sign-in page shows here). */ url: string; text: string }
  | { ok: false; code: WatchReadStop; site?: string }

const STOPS: readonly WatchReadStop[] = ['taken_over', 'site_blocked', 'never_automate', 'needs_your_mac', 'load_failed']

/** A settled command's result as a WatchReadResult, or null when it is not one (an older relay, a malformed row). */
export function parseWatchReadResult(raw: unknown): WatchReadResult | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (r.ok === true) {
    if (typeof r.url !== 'string' || typeof r.text !== 'string') return null
    return { ok: true, url: r.url, text: r.text.slice(0, WATCH_READ_MAX_CHARS) }
  }
  if (r.ok === false && typeof r.code === 'string' && (STOPS as readonly string[]).includes(r.code)) {
    return { ok: false, code: r.code as WatchReadStop, ...(typeof r.site === 'string' ? { site: r.site.slice(0, 253) } : {}) }
  }
  return null
}
