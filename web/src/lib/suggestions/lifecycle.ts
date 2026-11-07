/**
 * The suggestion lifecycle's numbers, in one place (docs/plans/suggestions-everywhere.md,
 * "Lifecycle"). Client-safe.
 *
 *   pending ──accept──▶ applied (kept)
 *     │ dismiss
 *     ▼                    expires_at passes, or the target is already in
 *   dismissed              that state, or a twin was applied elsewhere
 *     │                         ▼
 *     └──────────────▶ purged ◀── expired
 *                  PURGE_AFTER_DAYS after resolved_at
 */

/** A pending suggestion nobody acts on expires after this (the DB trigger's default too). */
export const DEFAULT_TTL_DAYS = 30
/** The shortest and longest TTL a stager may ask for. */
export const MIN_TTL_DAYS = 1
export const MAX_TTL_DAYS = 90
/** Dismissed and expired suggestions are deleted this long after they resolved. */
export const PURGE_AFTER_DAYS = 60
/** A fingerprint dismissed this recently can't be staged again. */
export const RECENTLY_DISMISSED_DAYS = 14
/** A run's suggestion with no home this long after staging was never delivered. */
export const HOMELESS_GRACE_HOURS = 24
/** The most changes one suggest_changes call may stage. */
export const MAX_SUGGESTIONS_PER_CALL = 20

const DAY_MS = 24 * 60 * 60 * 1000

/** expires_at for a suggestion staged at `now` asking for `days` (clamped). */
export function expiresAtFor(now: Date, days?: number | null): string {
  const d = Number.isFinite(days as number) && (days as number) > 0 ? Math.round(days as number) : DEFAULT_TTL_DAYS
  const clamped = Math.min(MAX_TTL_DAYS, Math.max(MIN_TTL_DAYS, d))
  return new Date(now.getTime() + clamped * DAY_MS).toISOString()
}

export function daysAgoIso(now: Date, days: number): string {
  return new Date(now.getTime() - days * DAY_MS).toISOString()
}
