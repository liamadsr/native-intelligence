import type { SupabaseClient } from '@supabase/supabase-js'
import { daysAgoIso, PURGE_AFTER_DAYS } from './lifecycle'

/**
 * The lifecycle's two sweeps, run from the flow-schedule cron's hygiene pass
 * (every 5 minutes, service-role client). Both are bounded per tick; the next
 * tick picks up where this one stopped, since swept rows leave the set.
 *
 *   expire: pending past expires_at → expired ('ttl'); a run's suggestion that
 *           never got a home a day on → expired ('run_undelivered').
 *   purge:  dismissed and expired rows PURGE_AFTER_DAYS after they resolved
 *           are deleted. Applied rows stay.
 *
 * The rules (and the guards: nothing with a trace of an apply, nothing from a
 * demo or eval capture) live in the RPCs, migration 313.
 */

/** Per-tick caps, so one tick can't churn the table. */
export const EXPIRE_BATCH = 500
export const PURGE_BATCH = 1000

export async function expireStaleSuggestions(
  supabase: SupabaseClient,
  now: Date,
  limit = EXPIRE_BATCH,
): Promise<{ expired: number }> {
  const { data, error } = await supabase.rpc('expire_stale_suggestions', { p_now: now.toISOString(), p_limit: limit })
  if (error) throw new Error(`expire_stale_suggestions failed: ${error.message}`)
  return { expired: ((data as unknown[] | null) ?? []).length }
}

export async function purgeResolvedSuggestions(
  supabase: SupabaseClient,
  now: Date,
  limit = PURGE_BATCH,
): Promise<{ purged: number }> {
  const { data, error } = await supabase.rpc('purge_resolved_suggestions', {
    p_before: daysAgoIso(now, PURGE_AFTER_DAYS),
    p_limit: limit,
  })
  if (error) throw new Error(`purge_resolved_suggestions failed: ${error.message}`)
  return { purged: typeof data === 'number' ? data : 0 }
}
