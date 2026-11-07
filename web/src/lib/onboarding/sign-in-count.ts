/**
 * Sign-in counting — the gate that keeps first-run nudges out of a brand-new
 * user's way.
 *
 * Signing up already fires a lot at once: the onboarding wizard, the guide, the
 * arrival dashboard. Piling a "teach Dial8 your voice" card on top of that
 * competes with the flow the user is actually in. So the nudge waits until
 * they've come back a couple of times and the app is no longer brand new.
 *
 * The counter lives in the auth user's `user_metadata`, matching how the voice
 * nudge already stores its dismissal — user-global, no table, no migration.
 * It's incremented in POST /api/analytics/auth-session, the one choke-point
 * EVERY auth method passes through (OAuth, password, magic link), deduped by
 * the same once-per-sign-in cookie the analytics event uses, so a token refresh
 * or a reload doesn't inflate it.
 *
 * Counting semantics: the value is the number of sign-ins COMPLETED, so it is
 * 1 during the very first session (signup), 2 on the next, and so on.
 */

/** `user_metadata` key holding the completed-sign-in count. */
export const SIGN_IN_COUNT_METADATA_KEY = 'sign_in_count'

/**
 * Sign-ins required before first-run nudges may appear.
 *
 * 3 = the user has signed up, come back once, and come back again — the nudge
 * shows on that third visit. Their first two sessions stay clear.
 */
export const MIN_SIGN_INS_FOR_NUDGES = 3

/**
 * Stop incrementing past this. Once the count clears the threshold the exact
 * value carries no extra signal, and the counter writes to the auth user on
 * every sign-in — no reason to keep churning that row forever.
 */
export const SIGN_IN_COUNT_CEILING = MIN_SIGN_INS_FOR_NUDGES + 1

/**
 * Whether first-run nudges may show for this metadata value.
 *
 * Treats a MISSING count as eligible. Existing users predate the counter and
 * would otherwise be silenced forever by a value that will never arrive; the
 * people this gate protects are new signups, who get a count from their very
 * first session.
 */
export function hasEnoughSignIns(rawCount: unknown): boolean {
  if (rawCount === undefined || rawCount === null) return true
  if (typeof rawCount !== 'number' || !Number.isFinite(rawCount)) return true
  return rawCount >= MIN_SIGN_INS_FOR_NUDGES
}
