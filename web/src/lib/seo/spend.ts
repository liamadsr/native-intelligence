/**
 * What a workspace may spend on search data, and the record of what it has.
 *
 * Every paid call the SEO area makes (keyword research, rank checks, domain
 * and backlink lookups, AI answer checks) goes through the meter made here:
 *
 *   BEFORE the call   the month's spend so far is read from the ledger
 *                     (seo_spend, migration 592), and the call is refused when
 *                     its upper-bound estimate would take the workspace past
 *                     the monthly ceiling. A ledger that can't be read
 *                     refuses too: never spend blind.
 *   AFTER the call    the provider's own cost is written to the ledger, also
 *                     for a call that failed after being billed.
 *
 * The estimate (src/lib/seo/dataforseo/pricing.ts) is deliberately at or above
 * the real price, so for one call at a time the gate can only be slightly
 * early, never late. It is not a reservation: every call in flight at the
 * same moment reads the same month total before any of them is written, and
 * each is let through if it alone fits. So the month can overshoot the
 * ceiling by the calls that passed the check before the earlier ones were
 * written (a batch of SERP reads or rank grid points, a few people asking
 * together), not by one call. A call that passed waits for a request slot
 * (dataforseo/request-slots.ts) without checking again, so the slots do not
 * bound it either. Each call is cents to a few dimes against a ceiling in
 * dollars, and a large lookup needs the person's yes first; a reservation
 * written before the call would close the gap, and is not built.
 *
 * Mirrors prospecting's ceiling (src/lib/prospecting/spend.ts): a flat cap
 * per workspace per calendar month (UTC), the same for every workspace.
 */
import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { DataforseoChargedTaskError, type DataforseoMeter, type SeoSpendFeature } from './dataforseo'
import { SeoError } from './errors'

/**
 * The per-workspace monthly ceiling, in dollars. A FIRST GUESS, set equal to
 * prospecting's: about 470 keyword research calls, or 100 keywords rank
 * checked daily for a year's worth of months. Revisit it with a month of real
 * seo_spend rows: the signal is how often a workspace hits it.
 */
export const SEO_MONTHLY_CAP_DOLLARS = 20

/** The first instant of `now`'s calendar month, UTC. */
export function monthStart(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
}

/** The first instant of the next calendar month, UTC: when the ceiling resets. */
export function nextMonthStart(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
}

/** The workspace's spend this month, in USD. Throws when the ledger can't be read. */
export async function readMonthlySeoSpend(svc: SupabaseClient, workspaceId: string, now: Date = new Date()): Promise<number> {
  const { data, error } = await svc.rpc('seo_spend_since', { p_workspace: workspaceId, p_since: monthStart(now).toISOString() })
  if (error) throw new Error(`seo spend read failed: ${error.message}`)
  const spent = Number(data)
  if (!Number.isFinite(spent)) throw new Error('seo spend read failed: not a number')
  return spent
}

export interface SeoSpendSummary {
  spent_dollars: number
  cap_dollars: number
  /** ISO time the month's count starts over. */
  resets_at: string
}

/** The month's spend against the ceiling, for the SEO pages' quiet spend line. */
export async function seoSpendSummary(svc: SupabaseClient, workspaceId: string, now: Date = new Date()): Promise<SeoSpendSummary> {
  return {
    spent_dollars: await readMonthlySeoSpend(svc, workspaceId, now),
    cap_dollars: SEO_MONTHLY_CAP_DOLLARS,
    resets_at: nextMonthStart(now).toISOString(),
  }
}

export interface MeterDeps {
  now?: () => Date
  capDollars?: number
}

/**
 * The meter for one workspace's paid calls. `userId` is the person who
 * asked; null for a scheduled check nobody is watching.
 */
export function createWorkspaceMeter(svc: SupabaseClient, who: { workspaceId: string; userId: string | null }, deps: MeterDeps = {}): DataforseoMeter {
  const now = deps.now ?? (() => new Date())
  const cap = deps.capDollars ?? SEO_MONTHLY_CAP_DOLLARS

  const record = async (feature: SeoSpendFeature, estimateUsd: number, billing: { path: string[]; costUsd: number }) => {
    const { error } = await svc.from('seo_spend').insert({
      workspace_id: who.workspaceId,
      user_id: who.userId,
      feature,
      endpoint: billing.path.join('/').slice(0, 200) || 'unknown',
      cost_usd: Math.max(0, billing.costUsd),
      estimate_usd: Math.max(0, estimateUsd),
    })
    // The call is already made and paid for. A lost row undercounts the
    // month by one call; it must not turn a result the person paid for into
    // an error. It is logged loudly instead.
    if (error) console.error('[seo-spend] ledger write failed', { workspaceId: who.workspaceId, feature, costUsd: billing.costUsd, error: error.message })
  }

  return {
    async run({ feature, estimateUsd, exec }) {
      let spent: number
      try {
        spent = await readMonthlySeoSpend(svc, who.workspaceId, now())
      } catch (err) {
        console.error('[seo-spend] ledger read failed: refusing to spend', err)
        // Our own trouble, not the provider's: nothing was looked up, nothing was spent.
        throw new SeoError('INTERNAL_ERROR', 'The month’s search data spend could not be read, so nothing was looked up.')
      }
      if (spent + estimateUsd > cap) {
        throw new SeoError(
          'SPEND_LIMIT_REACHED',
          `This workspace has reached its search data limit for the month ($${cap}). It starts over on ${nextMonthStart(now()).toISOString().slice(0, 10)}.`,
        )
      }
      try {
        const { data, billing } = await exec()
        await record(feature, estimateUsd, billing)
        return data
      } catch (error) {
        // Billed by the provider even though it failed: still spend.
        if (error instanceof DataforseoChargedTaskError) await record(feature, estimateUsd, error.billing)
        throw error
      }
    },
  }
}
