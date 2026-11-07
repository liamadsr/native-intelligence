import 'server-only'
import { cleanBlockedSites, siteForUrl } from '@/lib/browser-agent/blocked-sites'
import { getServiceClient } from '@/lib/supabase/service'

/**
 * What the agent's browser has learned about sites, per person (migration 424;
 * docs/plans/cloud-browser.md, C4): those it reaches only through the Mac, and
 * those it never uses. The relay gets both with each claim.
 */

/**
 * Sites whose terms forbid AI agents, never used whatever the person's rows
 * say. Amazon shows "Continued access by an unauthorized AI agent violates
 * Amazon's Conditions of Use" even with a person driving (the exit spike).
 */
export const NEVER_AUTOMATE_SEED = [
  'amazon.com', 'amazon.ca', 'amazon.com.mx', 'amazon.com.br', 'amazon.co.uk', 'amazon.de', 'amazon.fr', 'amazon.it', 'amazon.es',
  'amazon.nl', 'amazon.se', 'amazon.pl', 'amazon.com.be', 'amazon.com.tr', 'amazon.ae', 'amazon.sa', 'amazon.eg', 'amazon.in',
  'amazon.co.jp', 'amazon.sg', 'amazon.com.au',
]

export interface SiteMemory {
  needsHome: string[]
  neverAutomate: string[]
}

export type SiteFlag = 'needs_home' | 'never_automate'

export async function readSiteMemory(userId: string): Promise<SiteMemory> {
  const { data, error } = await getServiceClient().from('browser_site_memory').select('site, needs_home, never_automate').eq('user_id', userId).limit(1000)
  if (error) throw new Error(`browser_site_memory read: ${error.message}`)
  const rows = (data ?? []) as { site: string; needs_home: boolean; never_automate: boolean }[]
  return {
    needsHome: cleanBlockedSites(rows.filter(row => row.needs_home).map(row => row.site)),
    neverAutomate: cleanBlockedSites([...NEVER_AUTOMATE_SEED, ...rows.filter(row => row.never_automate).map(row => row.site)]),
  }
}

/** Remember `flag` for the site of `url` (or a bare site), with what set it. False when it isn't a site. */
export async function markSite(userId: string, siteOrUrl: string, flag: SiteFlag, reason: string): Promise<boolean> {
  const site = siteOrUrl.includes('/') ? siteForUrl(siteOrUrl) : cleanBlockedSites([siteOrUrl])[0] ?? null
  if (!site) return false
  const { error } = await getServiceClient().from('browser_site_memory')
    .upsert({ user_id: userId, site, [flag]: true, reason: reason.slice(0, 64) }, { onConflict: 'user_id,site' })
  if (error) throw new Error(`browser_site_memory write: ${error.message}`)
  return true
}

/** The person forgets what their browser learned about a site (both flags). */
export async function forgetSite(userId: string, siteOrUrl: string): Promise<void> {
  const site = siteOrUrl.includes('/') ? siteForUrl(siteOrUrl) : cleanBlockedSites([siteOrUrl])[0] ?? null
  if (!site) return
  const { error } = await getServiceClient().from('browser_site_memory').delete().eq('user_id', userId).eq('site', site)
  if (error) throw new Error(`browser_site_memory delete: ${error.message}`)
}
