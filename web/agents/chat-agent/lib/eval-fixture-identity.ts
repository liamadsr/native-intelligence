/**
 * Who the deterministic evals' fixture is, and where it may live. Shared by the
 * chat channel's eval door (./eval-auth.ts) and the fixture script
 * (scripts/eval-fixture.ts), so the two can never disagree. No imports: the
 * script loads this file outside eve's bundler.
 */

/** DEV's Supabase project ref. The eval door and the fixture script refuse any other database. */
export const EVAL_DEV_SUPABASE_REF = 'edrjddsxjoigpbecqgfb'
/** DEV's Supabase API host. */
export const EVAL_DEV_SUPABASE_HOST = `${EVAL_DEV_SUPABASE_REF}.supabase.co`
/** The fixture person: a reserved `.test` domain, so it can never be a real person's address. */
export const EVAL_USER_EMAIL = 'evals@dial8-evals.test'

/** True only when `url` is DEV's Supabase API (compared by hostname, never by substring). */
export function isDevSupabaseUrl(url: string | null | undefined): boolean {
  if (!url) return false
  try {
    return new URL(url).hostname === EVAL_DEV_SUPABASE_HOST
  } catch {
    return false
  }
}
