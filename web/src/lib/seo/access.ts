/**
 * Who may make a paid search-data call, checked before any is made. The
 * site audit is not one (it is our own crawl); everything that goes to the
 * data provider is.
 *
 *   - The server must have the provider's key (DATAFORSEO_API_KEY). Without
 *     it the SEO data pages say so plainly instead of failing a call.
 *   - Only a person whose plan pays for it (./plan.ts): someone on their own
 *     ChatGPT plan (the free tier) never spends a paid API of ours (the rule
 *     web research follows, src/lib/web-research/plan-deep-search.ts), and
 *     neither does someone with no subscription and no running trial. A plan
 *     we can't read is refused too: nothing is bought on an answer we don't
 *     have.
 *   - Only a full member of the workspace spends its budget (./membership.ts):
 *     a workspace guest reads what is already there. A membership we can't
 *     read is refused.
 *   - A turn nobody is in (a loop, a scheduled skill run) never starts a paid
 *     lookup on its own: search data is bought only when a person asks, or by
 *     a schedule a person set up themselves (a rank tracker's checks, which do
 *     not come through here). The lesson of the enrichment drain: nothing
 *     spends in the background that nobody asked for.
 *
 * The workspace's monthly ceiling is the meter's job (./spend.ts), at the call.
 */
import 'server-only'
import { getServiceClient } from '@/lib/supabase/service'
import { isDataforseoConfigured } from './dataforseo'
import { isFullMemberRole, memberRole } from './membership'
import { onFreePlan } from './plan'
import type { SeoRefusalCode } from './spend-view'

export type SeoDataRefusal = { ok: false; code: SeoRefusalCode; message: string }
export type SeoDataAccess = { ok: true } | SeoDataRefusal

export const SEO_NOT_CONFIGURED_MESSAGE = 'Search data isn’t set up on this server yet, so keyword, ranking and backlink lookups are off. The site audit works without it.'

const CHECK_FAILED: SeoDataRefusal = {
  ok: false,
  code: 'CHECK_FAILED',
  message: 'We couldn’t check your plan just now, so nothing was looked up. Try again in a moment.',
}

/**
 * `workspaceId` is the workspace whose budget would be spent: with it and a
 * person, the person must be a full member there. A schedule's own run
 * (userId null) is not checked here; its gate is (rank/gate.ts,
 * ai-visibility/gate.ts).
 */
export async function checkSeoDataAccess(who: {
  userId: string | null
  workspaceId?: string | null
  unattended?: boolean
}): Promise<SeoDataAccess> {
  if (!isDataforseoConfigured()) return { ok: false, code: 'SEO_NOT_CONFIGURED', message: SEO_NOT_CONFIGURED_MESSAGE }
  if (who.unattended) {
    return { ok: false, code: 'UNATTENDED', message: 'Search data is looked up only when the person asks for it themselves. Tell them what you would look up, and let them ask.' }
  }
  if (who.userId && who.workspaceId) {
    let role: string | null
    try {
      role = await memberRole(getServiceClient(), who.workspaceId, who.userId)
    } catch (err) {
      console.error('[seo] access: member check failed', err)
      return CHECK_FAILED
    }
    if (!isFullMemberRole(role)) {
      return {
        ok: false,
        code: 'NOT_A_MEMBER',
        message: 'Search data lookups spend the workspace’s budget, so they are for its members. A guest can read what the workspace already has; ask a member to run this.',
      }
    }
  }
  // Nobody to ask about: a schedule's own run, checked by its gate.
  if (!who.userId) return { ok: true }
  let free: boolean
  try {
    // An unreadable plan throws, so the call is refused instead of bought.
    free = await onFreePlan(who.userId)
  } catch (err) {
    console.error('[seo] access: plan check failed', err)
    return CHECK_FAILED
  }
  if (free) {
    return { ok: false, code: 'FREE_PLAN', message: 'Keyword, ranking and backlink data is part of the paid plan. The site audit is free.' }
  }
  return { ok: true }
}
