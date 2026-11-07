import type { SupabaseClient } from '@supabase/supabase-js'
import { appOwnSites, cleanBlockedSites, MAX_BLOCKED_SITES } from './blocked-sites'

/**
 * The user's blocked sites, oldest first. Throws when they can't be read: a
 * caller must not treat an unreadable list as an empty one (that would open
 * every blocked site to the agent).
 */
export async function loadBlockedSites(db: SupabaseClient, userId: string): Promise<string[]> {
  const { data, error } = await db
    .from('browser_agent_blocked_sites')
    .select('site')
    .eq('user_id', userId)
    .order('created_at', { ascending: true })
    .limit(MAX_BLOCKED_SITES)
  if (error) throw new Error('blocked sites unavailable')
  return cleanBlockedSites((data ?? []).map((row: { site: unknown }) => row.site))
}

/**
 * The sites the browser agent may not use: the user's own list plus Dial8's
 * own app (appOwnSites), always. What the command claim and the decision route
 * enforce and hand the relay; the list in Blocked sites stays the user's alone.
 * Throws like loadBlockedSites.
 */
export async function loadAgentBlockedSites(db: SupabaseClient, userId: string): Promise<string[]> {
  const own = appOwnSites()
  const mine = await loadBlockedSites(db, userId)
  return cleanBlockedSites([...own, ...mine.filter((site) => !own.includes(site))])
}
