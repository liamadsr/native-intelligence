import { blockedSiteForUrl, BrowserSiteBlockedError } from './blocked-sites'

/**
 * How a browser engine's answers become command results, shared by the
 * desktop's command relay (use-browser-command-relay.ts) and the cloud
 * browser's (src/lib/cloud-browser/cdp/commands.ts), so both report a page the
 * same way.
 */

export const UNCONFIRMED_SITE = 'The browser did not report which site the page is on, so the agent did not use it.'

/** The agent's screenshot is at most this many pixels wide, as a JPEG at this
 *  quality. A full retina capture is ~600 KB (~830K base64 characters), and the
 *  tool result carries it into the model's history; this is ~50–100 KB. */
export const AGENT_SCREENSHOT_MAX_WIDTH = 1024
export const AGENT_SCREENSHOT_QUALITY = 0.6

/** An engine's JSON answer. The desktop's eval-and-block path can answer "ERR: …"
 *  (a timed-out or failed evaluateJavaScript) instead of JSON: that, and an empty
 *  answer, become a thrown Error with the real message rather than a cryptic
 *  "Unexpected identifier ERR" from JSON.parse. */
export function parseNative(raw: string): unknown {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error('the browser returned no result (the tab may be mid-load or gone)')
  }
  if (raw.startsWith('ERR:')) {
    throw new Error(raw.slice(4).trim() || 'browser eval failed')
  }
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error(`unexpected browser result: ${raw.slice(0, 120)}`)
  }
}

/** Throw unless `result` (a page read) came from a page the agent may use. The
 *  page reports its own address with every read, so this is the page the
 *  data came from, even if it navigated after the command's first look. */
export function checkReadSite(result: unknown, sites: readonly string[]): void {
  if (sites.length === 0) return
  const url = typeof result === 'object' && result !== null ? (result as Record<string, unknown>).url : undefined
  if (typeof url !== 'string') throw new Error(UNCONFIRMED_SITE)
  const site = blockedSiteForUrl(url, sites)
  if (site) throw new BrowserSiteBlockedError(site)
}
