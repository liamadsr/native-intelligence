/**
 * The sites the user has blocked the in-app browser agent from.
 *
 * The agent may use any site by default. A blocked site is off-limits to it
 * entirely: no reading, no screenshot, no action, no navigating into it. The
 * list is the user's, in every workspace, kept on the server
 * (browser_agent_blocked_sites, migration 315).
 *
 * A site is a lowercase host ("linkedin.com", "mail.google.com") and covers
 * that host and every subdomain. Blocking from a page drops a leading "www.",
 * so blocking on www.linkedin.com covers m.linkedin.com too, while blocking on
 * mail.google.com leaves Google Search alone. Scheme and port never matter.
 *
 * Pure, shared by the server (claim + decision routes), the cloud browser's
 * relay and navigation guard (src/lib/cloud-browser), and Blocked sites in the
 * live view.
 */

/** More than anyone types by hand; bounds what a claim hands the relay. */
export const MAX_BLOCKED_SITES = 1000

/** A host as a site entry: lowercase, no trailing dot, no leading "www.". */
function siteOfHost(host: string): string | null {
  let h = host.trim().toLowerCase()
  if (h.endsWith('.')) h = h.slice(0, -1)
  if (h.startsWith('www.') && h.slice(4).includes('.')) h = h.slice(4)
  if (!h || h.length > 253 || /[\s/]/.test(h)) return null
  return h
}

/** The host of an http(s) page, or of the page a blob: URL belongs to. Other
 *  schemes (about:, data:, file:) are no site. */
function hostOf(url: string): string | null {
  try {
    let parsed = new URL(url)
    if (parsed.protocol === 'blob:') parsed = new URL(parsed.pathname)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    let host = parsed.hostname.toLowerCase()
    if (host.endsWith('.')) host = host.slice(0, -1)
    return host || null
  } catch {
    return null
  }
}

/** The site a Block on this page stores ("linkedin.com" on
 *  https://www.linkedin.com/feed). Null for a page that is no site. */
export function siteForUrl(url: string | null | undefined): string | null {
  if (!url) return null
  const host = hostOf(url)
  return host ? siteOfHost(host) : null
}

/** A site the user typed ("linkedin.com", "https://www.linkedin.com/in/me")
 *  as an entry, or null when it isn't one. A single word other than
 *  localhost is refused: "linkedin" is almost always a missing ".com". */
export function normalizeBlockedSite(input: string): string | null {
  const text = input.trim()
  if (!text || text.length > 2000) return null
  const site = siteForUrl(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`)
  if (!site) return null
  if (!site.includes('.') && !site.includes(':') && site !== 'localhost') return null
  return site
}

/** The entry that blocks this URL, or null when the agent may use it. */
export function blockedSiteForUrl(url: string | null | undefined, sites: readonly string[]): string | null {
  if (!url || sites.length === 0) return null
  const host = hostOf(url)
  if (!host) return null
  return sites.find((site) => host === site || host.endsWith(`.${site}`)) ?? null
}

/**
 * Native Intelligence's own app (A5 review): the browser agent never reads or acts on it,
 * whatever the user's list says, so it can never click Approve on an approval
 * card (or settle anything else) for the person. Production, local dev, and
 * the app's configured origin.
 */
export const NI_OWN_SITES: readonly string[] = ['dial8.ai', 'localhost', '127.0.0.1']

/** The app's own sites: NI_OWN_SITES plus the configured app origin's site. */
export function appOwnSites(appUrl: string | undefined = process.env.NEXT_PUBLIC_APP_URL): string[] {
  const configured = siteForUrl(appUrl)
  return [...new Set([...NI_OWN_SITES, ...(configured ? [configured] : [])])]
}

/** What the agent is told on Native Intelligence's own pages. */
export function appSiteBlockedMessage(): string {
  return "The agent can't read or act on Native Intelligence's own pages: approvals and settings there are the person's to click. Tell the user to do it themselves."
}

/** Only well-formed entries, deduplicated, at most MAX_BLOCKED_SITES. */
export function cleanBlockedSites(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const site = siteOfHost(entry)
    if (site) out.add(site)
    if (out.size >= MAX_BLOCKED_SITES) break
  }
  return [...out]
}

/** What the agent is told when a site is blocked. It names the site the user
 *  blocked, never the page's address or title. */
export function siteBlockedMessage(site: string): string {
  if (appOwnSites().includes(site)) return appSiteBlockedMessage()
  return `The user has blocked the agent on ${site}, so it can't read or act on that site. Don't try to reach it another way; tell the user it is blocked and that they can unblock it under Blocked sites in their agent's computer (its live view).`
}

/** A read or action reached a page on a blocked site. */
export class BrowserSiteBlockedError extends Error {
  readonly site: string
  constructor(site: string) {
    super('site_blocked')
    this.name = 'BrowserSiteBlockedError'
    this.site = site
  }
}
