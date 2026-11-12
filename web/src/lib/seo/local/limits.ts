/**
 * Local SEO's caps, defaults and timings, in one place. The core
 * (./businesses.ts, ./grids.ts, ./scans.ts, ./business-data.ts) enforces
 * every cap; the routes and the tools only pass input through, so a cap holds
 * however a row is changed. Client safe: the UI reads the same numbers for
 * its forms.
 *
 *   MAX_TRACKED_BUSINESSES     Google places a workspace follows. A business
 *                              and its handful of branches is the real use.
 *   MAX_GRIDS_PER_BUSINESS     rank grids per tracked business (one per
 *                              service area or keyword set).
 *   GRID_SIZES                 points across a grid: 3x3 (9 searches per
 *                              keyword), 5x5 (25) or 7x7 (49).
 *   MAX_KEYWORDS_PER_GRID      keywords one grid searches. A scan of a 7x7
 *                              grid with every keyword is 245 paid searches.
 *   radius                     km from the grid's centre to its edge; the
 *                              spacing between points follows from it.
 */

export const MAX_TRACKED_BUSINESSES = 10
export const MAX_GRIDS_PER_BUSINESS = 5

export const GRID_SIZES = [3, 5, 7] as const
export type LocalGridSize = (typeof GRID_SIZES)[number]
export const DEFAULT_GRID_SIZE: LocalGridSize = 5

export const MAX_KEYWORDS_PER_GRID = 5
export const MAX_LOCAL_KEYWORD_LENGTH = 120

export const MIN_RADIUS_KM = 0.5
export const MAX_RADIUS_KM = 20
/** 3 km: a 5x5 grid then has a point every 1.5 km, a neighbourhood-sized step. */
export const DEFAULT_RADIUS_KM = 3
/** Points closer than this read the same map; farther than this skip whole towns. */
export const MIN_SPACING_KM = 0.15
export const MAX_SPACING_KM = 10

export const LOCAL_DEVICES = ['mobile', 'desktop'] as const
export type LocalDevice = (typeof LOCAL_DEVICES)[number]
/** Most local searches happen on a phone. */
export const DEFAULT_LOCAL_DEVICE: LocalDevice = 'mobile'

/** Map results read at each point: the provider's queued Maps search, two pages. */
export const LOCAL_RANK_DEPTH = 20
/** Businesses kept per grid point (the target among them when it shows). */
export const COMPETITORS_PER_POINT = 5
/** Businesses the "seen most" list keeps. */
export const COMPETITORS_LISTED = 10

/** A scan estimated above this needs the person's yes before the agent starts it. */
export const CONFIRM_ABOVE_USD = 0.25

/** A scan this far past its start is stuck (a real one takes minutes), and the next start replaces it. */
export const STUCK_SCAN_AFTER_MS = 2 * 60 * 60_000

/**
 * The scan's waits between free reads of its queued searches, in order. The
 * searches run at high priority and usually come back in 5 to 40 seconds,
 * so the first reads come quickly; the tail gives a slow provider about
 * twenty minutes in all before a point is written as not collected.
 */
export const SCAN_COLLECT_WAITS = [
  '15s',
  '15s',
  '20s',
  '30s',
  '45s',
  '1m',
  '2m',
  '3m',
  '5m',
  '10m',
] as const

// Snapshot ages: a stored read answers the same question for this long.
const HOUR_MS = 60 * 60 * 1000
export const PROFILE_MAX_AGE_MS = 24 * HOUR_MS
export const REVIEWS_MAX_AGE_MS = 24 * HOUR_MS
export const UPDATES_MAX_AGE_MS = 24 * HOUR_MS
export const QUESTIONS_MAX_AGE_MS = 24 * HOUR_MS
export const MAP_RESULTS_MAX_AGE_MS = 12 * HOUR_MS
export const BUSINESS_SEARCH_MAX_AGE_MS = 24 * HOUR_MS

/** How long a request waits for a queued reviews or posts read before it answers "still collecting". */
export const TASK_WAIT_MS = 40_000
export const TASK_POLL_MS = 4_000
/**
 * A `refresh` of reviews or posts still collects, rather than buys again, a
 * read of the same question that was bought this recently and has not come
 * back yet: asking twice in a row never pays twice for one answer.
 */
export const REFRESH_REUSES_COLLECTING_MS = 5 * 60_000

export const DEFAULT_REVIEWS_DEPTH = 20
export const MIN_REVIEWS_DEPTH = 10
export const MAX_REVIEWS_DEPTH = 200
export const DEFAULT_UPDATES_DEPTH = 10
export const MIN_UPDATES_DEPTH = 10
export const MAX_UPDATES_DEPTH = 100
export const DEFAULT_QUESTIONS_DEPTH = 20
export const MAX_QUESTIONS_DEPTH = 100
export const DEFAULT_MAP_RESULTS_DEPTH = 20
export const MAX_MAP_RESULTS_DEPTH = 100
export const DEFAULT_SEARCH_LIMIT = 20
export const MAX_SEARCH_LIMIT = 50

/**
 * The map zoom a one-off map read uses when none is given: a city-sized
 * viewport (about 12 km at mid latitudes). Without one the provider guesses a
 * zoom far too tight for a town-level search and returns a near-empty list.
 */
export const DEFAULT_MAP_ZOOM = 12
/** The radius around a business's own coordinate that its profile reads search in, km. */
export const PROFILE_SEARCH_RADIUS_KM = 10
