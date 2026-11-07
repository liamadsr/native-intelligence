import { blockedSiteForUrl } from '@/lib/browser-agent/blocked-sites'

/**
 * The agent's navigation guard, the cloud twin of the desktop's
 * browser_set_agent_guard (docs/plans/cloud-browser.md, C1). While a task
 * drives a page, a main-frame navigation, server redirect or popup into one of
 * the blocked sites is cancelled before it loads, and the page announces the
 * matched entry ("linkedin.com"), never the URL. Subframes are left alone: the
 * web side drops a blocked site's frames from what the agent sees.
 * PRIVACY: the list and the URLs are the person's browsing; never logged.
 */

/** The longest lease: 10 minutes, as the desktop caps it. */
export const MAX_GUARD_LEASE_MS = 10 * 60 * 1000
/** A second notice for the same site within this long is the same navigation. */
export const GUARD_NOTICE_DEDUPE_MS = 1000

export interface GuardLease { sites: readonly string[]; until: number }

/** A lease from a list and a duration; null clears the guard (no lease, or no sites). */
export function guardLease(sites: readonly string[], leaseMs: number, now = Date.now()): GuardLease | null {
  const clean = sites.filter(site => typeof site === 'string' && site.length > 0).map(site => site.toLowerCase())
  const lease = Math.min(Math.max(Math.floor(leaseMs) || 0, 0), MAX_GUARD_LEASE_MS)
  return lease > 0 && clean.length > 0 ? { sites: clean, until: now + lease } : null
}

/** The entry blocking `url` under `lease` right now, or null (no guard, an expired lease, an allowed site). */
export function guardBlocks(lease: GuardLease | null, url: string, now = Date.now()): string | null {
  if (!lease || now >= lease.until) return null
  return blockedSiteForUrl(url, lease.sites)
}
