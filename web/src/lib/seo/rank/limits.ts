/**
 * The rank tracker's caps and defaults, in one place. The core
 * (./trackers.ts, ./runs.ts) enforces every cap; the routes and the tools only
 * pass input through, so a cap holds however a tracker is changed. Client
 * safe: the UI reads the same numbers for its form.
 *
 *   MAX_TRACKERS_PER_WORKSPACE   trackers a workspace may have. Each is a site
 *                                in one market; a few per workspace is the
 *                                real use, and every scheduled one spends.
 *   MAX_KEYWORDS_PER_TRACKER     keywords one tracker follows. Held under a
 *                                lock by seo_rank_add_keywords (migration
 *                                593), so two adds at once can't pass it. At
 *                                the deepest settings a check of this many
 *                                keywords on both devices costs more than the
 *                                monthly ceiling allows, so the ceiling, not
 *                                this cap, is what usually stops a big
 *                                tracker; the cap bounds what one check asks
 *                                of the provider and of our own background
 *                                lane (a post per 100 searches, a read of up
 *                                to 500 results per step).
 *   MAX_KEYWORD_LENGTH           characters in one keyword.
 *   depth                        Google results read per search, in pages of
 *                                ten (the provider bills per page).
 */
export const MAX_TRACKERS_PER_WORKSPACE = 20
export const MAX_KEYWORDS_PER_TRACKER = 500
export const MAX_KEYWORD_LENGTH = 200
/** Keywords one add (a request, a tool call) may carry. */
export const MAX_KEYWORDS_PER_ADD = 200

export const MIN_SERP_DEPTH = 10
export const MAX_SERP_DEPTH = 100
/** Two pages: enough to see a site moving onto page one, at a fifth of the deepest price. */
export const DEFAULT_SERP_DEPTH = 20
export const DEFAULT_DEVICES = 'mobile' as const
/** Off: creating a tracker never starts spending on its own. */
export const DEFAULT_SCHEDULE_INTERVAL = 'manual' as const

/** A check this far past its start is stuck (a full check takes about two hours), and the next start replaces it. */
export const STUCK_RUN_AFTER_MS = 6 * 60 * 60_000
/** A check still queued this long never reached the background lane. */
export const STUCK_QUEUED_AFTER_MS = 24 * 60 * 60_000

/** A manual check estimated above this needs the person's yes before the agent starts it. */
export const CONFIRM_ABOVE_USD = 0.25

/** Rows per page in every rank list. */
export const RANK_PAGE_SIZE = 100
