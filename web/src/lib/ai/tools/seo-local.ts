import { isSeoError } from '@/lib/seo/errors'
import { seoToolError } from '@/lib/seo/http'
import {
  readGoogleBusinessQuestions,
  readGoogleBusinessReviews,
  readGoogleBusinessUpdates,
} from '@/lib/seo/local/business-data'
import {
  addTrackedBusiness,
  findLocalBusinesses,
  readGoogleBusinessProfile,
  removeTrackedBusiness,
  resolveBusinessRef,
  type BusinessRefInput,
} from '@/lib/seo/local/businesses'
import {
  createLocalGrid,
  deleteLocalGrid,
  estimateLocalScan,
  getLocalGridDetail,
  listLocalGrids,
} from '@/lib/seo/local/grids'
import {
  CONFIRM_ABOVE_USD,
  DEFAULT_GRID_SIZE,
  DEFAULT_RADIUS_KM,
  GRID_SIZES,
  MAX_KEYWORDS_PER_GRID,
  MAX_LOCAL_KEYWORD_LENGTH,
  MAX_RADIUS_KM,
  MAX_REVIEWS_DEPTH,
  MAX_SEARCH_LIMIT,
  MAX_UPDATES_DEPTH,
  MIN_RADIUS_KM,
  MIN_REVIEWS_DEPTH,
  MIN_UPDATES_DEPTH,
} from '@/lib/seo/local/limits'
import { readLocalMapResults } from '@/lib/seo/local/map-results'
import { getScan, listTrackedBusinesses } from '@/lib/seo/local/queries'
import {
  cancelLocalScan,
  getLocalScanResult,
  startLocalScan,
} from '@/lib/seo/local/scans'
import {
  isLiveScan,
  type GoogleBusinessProfile,
  type LocalBusinessListing,
  type LocalGridCell,
  type LocalGridSummary,
  type LocalRankGridDetail,
  type LocalScanEstimate,
  type LocalScanResult,
  type LocalScanView,
  type TrackedBusinessView,
} from '@/lib/seo/local/view'
import type { SupabaseClient } from '@supabase/supabase-js'
import { tool } from 'ai'
import { z } from 'zod'
import { webText } from './web-derived'

/**
 * SEO: local search (src/lib/seo/local). A business's Google Business Profile
 * and where it shows on Google Maps across its town.
 *
 *   find_local_businesses              find a business by name in a town, or
 *                                      businesses near a coordinate. Paid.
 *   list_tracked_businesses            the places the workspace follows, with
 *                                      their rank grids.
 *   add_tracked_business               follow a place found by a search.
 *   remove_tracked_business            stop following one (its grids and
 *                                      scans go with it).
 *   get_google_business_profile        a profile: categories, rating, hours,
 *                                      contact, claimed. Paid.
 *   get_google_business_reviews        its reviews, newest first, with the
 *                                      owner's replies. Paid, queued.
 *   get_google_business_updates        its posts. Paid, queued.
 *   get_google_business_questions      its questions and answers. Paid.
 *   get_local_map_results              the Google Maps list for a search at
 *                                      one spot. Paid.
 *   list_local_rank_grids              the workspace's rank grids.
 *   get_local_rank_grid                one grid with its latest scan as a
 *                                      square of positions. Free.
 *   get_local_rank_grid_cost_estimate  what a scan costs. Free maths.
 *   create_local_rank_grid             a square of points around a place,
 *                                      with keywords. Free.
 *   start_local_rank_scan              search every point for every keyword,
 *                                      in the background. Paid.
 *   cancel_local_rank_scan             stop a scan.
 *   delete_local_rank_grid             delete a grid and its scans.
 *
 * MONEY. Every paid read checks access first (the server has search data,
 * the person is not on the free plan, a person is actually there) and is kept
 * as a snapshot, so asking again is free until it is stale; `refresh` buys
 * again. A turn nobody is in (a loop, a scheduled run) never buys: it can
 * still read what was already bought. A scan is a few to a few hundred
 * searches: one estimated above CONFIRM_ABOVE_USD takes
 * `confirmed_with_user: true`, given only after the person heard the cost in
 * the agent's words and said yes; a turn nobody is in never starts one.
 *
 * OUTSIDE TEXT. Review text, owner replies, business descriptions, posts,
 * and questions and answers are written by other people and go to the model
 * inside the WEB fence (web-derived.ts). Names, addresses, categories, ids,
 * coordinates, URLs and numbers stay plain: the model needs them verbatim.
 */

const confirmedSchema = z
  .boolean()
  .describe(
    'Set true ONLY after the person heard what this scan costs (the estimate, in your own words) and said yes to it in their last message. False, or omitted, refuses and starts nothing.',
  )

const businessRefSchema = {
  business_id: z
    .string()
    .uuid()
    .optional()
    .describe(
      'A tracked business (from list_tracked_businesses). The usual choice',
    ),
  cid: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .optional()
    .describe(
      'Or any Google place by its cid (from find_local_businesses or get_local_map_results): a competitor',
    ),
  place_id: z
    .string()
    .trim()
    .min(1)
    .max(256)
    .optional()
    .describe('Or any Google place by its place id'),
  name: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe(
      'Or a name, only together with latitude and longitude (a name alone can match the wrong branch)',
    ),
  latitude: z
    .number()
    .min(-90)
    .max(90)
    .optional()
    .describe('Where the business is, for a cid, place id or name'),
  longitude: z.number().min(-180).max(180).optional(),
  country: z
    .string()
    .regex(/^[a-zA-Z]{2}$/)
    .optional()
    .describe(
      'Two-letter country code for a cid, place id or name (default "us")',
    ),
}

const refreshSchema = z
  .boolean()
  .optional()
  .describe(
    'Buy a fresh read even though a stored one is still current. Only when the person asks for fresh data',
  )

function usd(n: number): string {
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`
}

/** A tool never throws: a failure becomes words the agent can relay. */
async function guarded<T>(where: string, fn: () => Promise<T>) {
  try {
    return await fn()
  } catch (err) {
    if (isSeoError(err)) return seoToolError(err, where)
    console.error(`[seo-local] ${where} failed`, err)
    return {
      success: false as const,
      error: 'Could not do that just now. Try again in a moment.',
    }
  }
}

function failure(out: { code: string; message: string }) {
  return { success: false as const, code: out.code, error: out.message }
}

const UNATTENDED_SCAN = {
  success: false as const,
  code: 'UNATTENDED',
  error:
    'Only on the person’s own turn: they start paid scans themselves. Tell them which grid you would scan.',
}

function listingForModel(
  row: LocalBusinessListing,
  trackedId: string | null = null,
) {
  return {
    title: row.title,
    cid: row.cid,
    place_id: row.place_id,
    address: row.address,
    latitude: row.latitude,
    longitude: row.longitude,
    category: row.category,
    other_categories: row.additional_categories,
    rating: row.rating,
    reviews: row.review_count,
    claimed: row.is_claimed,
    phone: row.phone,
    website: row.website,
    tracked_business_id: trackedId,
  }
}

function trackedForModel(b: TrackedBusinessView) {
  return {
    business_id: b.id,
    title: b.title,
    cid: b.cid,
    place_id: b.place_id,
    address: b.address,
    latitude: b.latitude,
    longitude: b.longitude,
    category: b.category,
    other_categories: b.additional_categories,
    rating: b.rating,
    reviews: b.review_count,
    claimed: b.is_claimed,
    phone: b.phone,
    website: b.website,
    profile_read_at: b.profile_fetched_at,
  }
}

function profileForModel(p: GoogleBusinessProfile) {
  return {
    title: p.title,
    description: webText(p.description),
    category: p.category,
    other_categories: p.additional_categories,
    rating: p.rating,
    reviews: p.review_count,
    reviews_by_star: p.rating_distribution,
    address: p.address,
    phone: p.phone,
    website: p.website,
    claimed: p.is_claimed,
    open_now: p.current_status,
    hours:
      p.hours?.map(
        (day) =>
          `${day.day.slice(0, 3)} ${day.spans.length ? day.spans.join(', ') : 'closed'}`,
      ) ?? null,
    photos: p.total_photos,
    price_level: p.price_level,
    cid: p.cid,
    place_id: p.place_id,
    maps_url: p.check_url,
  }
}

function summaryForModel(s: LocalGridSummary) {
  return {
    points: s.points_total,
    points_read: s.points_collected,
    found_at: s.points_found,
    top3: s.top3,
    top10: s.top10,
    top3_percent: s.top3_percent,
    average_position: s.average_position,
  }
}

function scanForModel(scan: LocalScanView | null) {
  if (!scan) return null
  return {
    scan_id: scan.id,
    status: scan.status,
    keywords: scan.keywords,
    grid: `${scan.size}x${scan.size}`,
    radius_km: scan.radius_km,
    spacing_km: scan.spacing_km,
    points_total: scan.points_total,
    points_read: scan.points_collected,
    found_at: scan.points_found,
    error: scan.error,
    started_at: scan.started_at ?? scan.created_at,
    completed_at: scan.completed_at,
  }
}

function gridForModel(detail: LocalRankGridDetail) {
  const g = detail.grid
  return {
    grid_id: g.id,
    business_id: g.business_id,
    keywords: g.keywords,
    grid: `${g.size}x${g.size}`,
    searches_per_scan: g.size * g.size * g.keywords.length,
    center: { latitude: g.center_latitude, longitude: g.center_longitude },
    radius_km: g.radius_km,
    spacing_km: g.spacing_km,
    device: g.device,
    latest_scan: scanForModel(detail.latest_scan),
  }
}

function estimateForModel(e: LocalScanEstimate) {
  return {
    keywords: e.keywords,
    points: e.points,
    searches: e.searches,
    estimate_usd: e.estimate_usd,
    needs_go_ahead: e.needs_confirmation,
  }
}

/** A cell as one short token: its position, "-" not found, "x" not read, "…" still running. */
function cellToken(cell: LocalGridCell): string {
  if (cell.status === 'found') return String(cell.position)
  if (cell.status === 'not_found') return '-'
  if (cell.status === 'not_collected') return 'x'
  return '…'
}

/** The scan as the model reads it: per keyword a square of positions, north row first, plus the numbers and who wins. */
function scanResultForModel(result: LocalScanResult) {
  return {
    scan: scanForModel(result.scan),
    legend:
      'Each row is a line of points, north row first, west to east; the middle point is the grid’s centre. A number is the business’s position on the map there; "-" = not among the businesses listed there; "x" = that search did not come back; "…" = still running.',
    keywords: result.keywords.map((entry) => ({
      keyword: entry.keyword,
      rows: entry.rows.map((row) => row.map(cellToken).join(' ')),
      summary: summaryForModel(entry.summary),
      // Who led where the business was not first: the names behind the "-".
      first_at_points: entry.rows
        .flat()
        .filter((cell) => cell.top_result && cell.position !== 1)
        .slice(0, 12)
        .map((cell) => ({
          row: cell.row,
          col: cell.col,
          first: cell.top_result?.title ?? null,
          listed: cell.results_count,
        })),
    })),
    summary: summaryForModel(result.summary),
    competitors_seen_most: result.competitors.map((c) => ({
      title: c.title,
      cid: c.cid,
      place_id: c.place_id,
      rating: c.rating,
      reviews: c.review_count,
      first_at: c.points_first,
      top3_at: c.points_top3,
      best_position: c.best_position,
      average_position: c.average_position,
    })),
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const WAIT_POLL_MS = 5_000
const WAIT_MAX_MS = 90_000

export function createSeoLocalTools(
  userId: string,
  supabase: SupabaseClient,
  workspaceId: string,
  opts: { unattended?: boolean } = {},
) {
  const who = { workspaceId, userId, unattended: opts.unattended === true }

  async function ref(input: BusinessRefInput) {
    return resolveBusinessRef(supabase, workspaceId, input)
  }

  return {
    find_local_businesses: tool({
      description:
        'Find a business on Google Maps: by its name (or a trade word) in a town, which returns every match with its cid, coordinate, category, rating and review count; or businesses near a coordinate, optionally filtered by category, minimum rating or reviews, or unclaimed listings. Use it first to identify the person’s own business (then add_tracked_business) or its local competitors. Paid; a repeat of the same search within a day is free. ' +
        'Several matches for a name usually means a chain: ask which branch. Next: add_tracked_business with the chosen row.',
      inputSchema: z.object({
        query: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .optional()
          .describe(
            'The business name or a trade word, e.g. "Fernhill Studio" or "dentist". Needed with place',
          ),
        place: z
          .string()
          .trim()
          .min(1)
          .max(120)
          .optional()
          .describe(
            'The town or city, as a person writes it, e.g. "Portland OR"',
          ),
        country: z
          .string()
          .regex(/^[a-zA-Z]{2}$/)
          .optional()
          .describe('Two-letter country code (default "us")'),
        near: z
          .object({
            latitude: z.number().min(-90).max(90),
            longitude: z.number().min(-180).max(180),
            radius_km: z
              .number()
              .min(1)
              .max(100)
              .optional()
              .describe('Default 10'),
          })
          .optional()
          .describe(
            'Search around a coordinate instead of a town (then query is optional and the filters apply)',
          ),
        categories: z
          .array(z.string().trim().min(1).max(120))
          .max(10)
          .optional()
          .describe(
            'Google categories, e.g. "dentist", "pizza_restaurant" (near searches only)',
          ),
        min_rating: z
          .number()
          .min(1)
          .max(5)
          .optional()
          .describe('Near searches only'),
        min_reviews: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Near searches only'),
        is_claimed: z
          .boolean()
          .optional()
          .describe(
            'false: only listings no owner has claimed (near searches only)',
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_SEARCH_LIMIT)
          .optional()
          .describe('How many (default 20)'),
        refresh: refreshSchema,
      }),
      execute: (args) =>
        guarded('find_local_businesses', async () => {
          const out = await findLocalBusinesses(supabase, who, args)
          if (!out.ok) return failure(out)
          const tracked = await listTrackedBusinesses(supabase, workspaceId)
          const trackedId = (row: LocalBusinessListing) =>
            tracked.find(
              (b) =>
                (row.cid && b.cid === row.cid) ||
                (row.place_id && b.place_id === row.place_id),
            )?.id ?? null
          return {
            success: true,
            place: out.result.place,
            country: out.result.country,
            businesses: out.result.rows.map((row) =>
              listingForModel(row, trackedId(row)),
            ),
            read_at: out.result.fetched_at,
            ...(out.result.rows.length === 0
              ? {
                  message:
                    'Nothing matched. Try the name alone, a nearby town, or a near search with a wider radius.',
                }
              : {}),
          }
        }),
    }),

    list_tracked_businesses: tool({
      description:
        'The Google places this workspace follows for local SEO, each with its rating and reviews as last read and its rank grids (keywords, size, latest scan). Free. Use it before reading a profile, reviews or a grid, to get the business_id and grid_id.',
      inputSchema: z.object({}),
      execute: () =>
        guarded('list_tracked_businesses', async () => {
          const [businesses, grids] = await Promise.all([
            listTrackedBusinesses(supabase, workspaceId),
            listLocalGrids(supabase, workspaceId),
          ])
          return {
            success: true,
            businesses: businesses.map((b) => ({
              ...trackedForModel(b),
              grids: grids
                .filter((g) => g.grid.business_id === b.id)
                .map(gridForModel),
            })),
            ...(businesses.length === 0
              ? {
                  message:
                    'No business is tracked yet. Find it with find_local_businesses, then add_tracked_business.',
                }
              : {}),
          }
        }),
    }),

    add_tracked_business: tool({
      description:
        'Follow a Google place in this workspace: pass the row find_local_businesses returned (title, cid or place_id, latitude, longitude and what else it had, plus the search’s country). Free. Then read its profile and reviews, or create_local_rank_grid to see where it shows on the map across town.',
      inputSchema: z.object({
        title: z.string().trim().min(1).max(300),
        cid: z.string().trim().min(1).max(64).optional(),
        place_id: z.string().trim().min(1).max(256).optional(),
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
        address: z.string().max(300).optional(),
        category: z.string().max(120).optional(),
        other_categories: z.array(z.string().max(120)).max(20).optional(),
        phone: z.string().max(60).optional(),
        website: z.string().max(2048).optional(),
        rating: z.number().min(0).max(5).optional(),
        reviews: z.number().int().min(0).optional(),
        claimed: z.boolean().optional(),
        country: z
          .string()
          .regex(/^[a-zA-Z]{2}$/)
          .optional()
          .describe('The search’s country (default "us")'),
      }),
      execute: (args) =>
        guarded('add_tracked_business', async () => {
          const out = await addTrackedBusiness(supabase, who, {
            title: args.title,
            cid: args.cid ?? null,
            place_id: args.place_id ?? null,
            latitude: args.latitude,
            longitude: args.longitude,
            address: args.address ?? null,
            category: args.category ?? null,
            additional_categories: args.other_categories ?? [],
            phone: args.phone ?? null,
            website: args.website ?? null,
            rating: args.rating ?? null,
            review_count: args.reviews ?? null,
            is_claimed: args.claimed ?? null,
            country: args.country ?? null,
          })
          if (!out.ok)
            return {
              ...failure(out),
              ...(out.code === 'ALREADY_TRACKED'
                ? { business: trackedForModel(out.business) }
                : {}),
            }
          return { success: true, business: trackedForModel(out.business) }
        }),
    }),

    remove_tracked_business: tool({
      description:
        'Stop following a Google place: it is removed with its rank grids and their scans (the stored profile and review reads stay until they age out). Only when the person asks. Refused while one of its scans runs.',
      inputSchema: z.object({ business_id: z.string().uuid() }),
      execute: ({ business_id }) =>
        guarded('remove_tracked_business', async () => {
          const out = await removeTrackedBusiness(
            supabase,
            { workspaceId },
            business_id,
          )
          if (!out.ok) return failure(out)
          return {
            success: true,
            removed: {
              business_id: out.business.id,
              title: out.business.title,
            },
          }
        }),
    }),

    get_google_business_profile: tool({
      description:
        'Read a Google Business Profile: primary and other categories, rating and review count with the split by star, address, phone, website, claimed or not, opening hours, photo count. Use it to audit the person’s own profile or compare a competitor’s (by cid). Paid; stored for a day, so asking again is free. Category and claim problems outrank everything else. For reviews and posts, use get_google_business_reviews and get_google_business_updates.',
      inputSchema: z.object({ ...businessRefSchema, refresh: refreshSchema }),
      execute: ({ refresh, ...input }) =>
        guarded('get_google_business_profile', async () => {
          const resolved = await ref(input)
          if (!resolved.ok) return failure(resolved)
          const out = await readGoogleBusinessProfile(
            supabase,
            who,
            resolved.ref,
            { refresh },
          )
          if (!out.ok) return failure(out)
          const result = out.result
          if (!result?.profile) {
            return {
              success: true,
              profile: null,
              message:
                'Google has no Business Profile for that place. Check the cid with find_local_businesses.',
            }
          }
          return {
            success: true,
            profile: profileForModel(result.profile),
            read_at: result.fetched_at,
          }
        }),
    }),

    get_google_business_reviews: tool({
      description:
        'Read a business’s Google reviews, newest first: each with its stars, text, author, when, and the owner’s reply. Also the stars counted and how many got no reply. Use it for review gaps against a competitor and to find reviews to answer. Paid (by the number read); stored for a day. ' +
        'Google gathers them in the background: usually within the call, but when status is "collecting", call again in about a minute with the same business, depth and other_sources and WITHOUT refresh; that collects the same read and costs nothing more.',
      inputSchema: z.object({
        ...businessRefSchema,
        depth: z
          .number()
          .int()
          .min(MIN_REVIEWS_DEPTH)
          .max(MAX_REVIEWS_DEPTH)
          .optional()
          .describe(
            `How many of the newest reviews (default 20, up to ${MAX_REVIEWS_DEPTH}). More costs more`,
          ),
        other_sources: z
          .boolean()
          .optional()
          .describe(
            'Also the reviews Google shows from other sites. Costs more',
          ),
        refresh: refreshSchema,
      }),
      execute: ({ depth, other_sources, refresh, ...input }) =>
        guarded('get_google_business_reviews', async () => {
          const resolved = await ref(input)
          if (!resolved.ok) return failure(resolved)
          const out = await readGoogleBusinessReviews(
            supabase,
            who,
            resolved.ref,
            { depth, other_sources, refresh },
          )
          if (!out.ok) return failure(out)
          const { status, data } = out.result
          if (status === 'collecting' || !data) {
            return {
              success: true,
              status: 'collecting',
              message:
                'Google is still gathering the reviews. Call again in about a minute with the same business, depth and other_sources, without refresh: that collects these same reviews and costs nothing more.',
            }
          }
          return {
            success: true,
            status: 'completed',
            total_reviews: data.total_reviews,
            rating: data.rating,
            read: data.reviews.length,
            stars_of_those_read: data.rating_distribution,
            owner_replied: data.replied,
            unanswered: data.unreplied,
            reviews: data.reviews.map((r) => ({
              stars: r.rating,
              when: r.time_ago ?? r.timestamp,
              author: r.author,
              local_guide: r.author_is_local_guide,
              source: r.source,
              text: webText(r.text),
              owner_reply: webText(r.owner_reply),
              review_id: r.review_id,
            })),
            read_at: out.result.fetched_at,
          }
        }),
    }),

    get_google_business_updates: tool({
      description:
        'Read the posts (updates, offers, events) a business has put on its Google Business Profile, newest first, with their links. Use it to check how recently and how often the person, or a competitor, posts. Paid; stored for a day. When status is "collecting", call again in about a minute with the same business and depth and WITHOUT refresh; that collects the same read and costs nothing more.',
      inputSchema: z.object({
        ...businessRefSchema,
        depth: z
          .number()
          .int()
          .min(MIN_UPDATES_DEPTH)
          .max(MAX_UPDATES_DEPTH)
          .optional()
          .describe('How many posts (default 10)'),
        refresh: refreshSchema,
      }),
      execute: ({ depth, refresh, ...input }) =>
        guarded('get_google_business_updates', async () => {
          const resolved = await ref(input)
          if (!resolved.ok) return failure(resolved)
          const out = await readGoogleBusinessUpdates(
            supabase,
            who,
            resolved.ref,
            { depth, refresh },
          )
          if (!out.ok) return failure(out)
          const { status, data } = out.result
          if (status === 'collecting' || !data) {
            return {
              success: true,
              status: 'collecting',
              message:
                'Google is still gathering the posts. Call again in about a minute with the same business and depth, without refresh: that collects these same posts and costs nothing more.',
            }
          }
          return {
            success: true,
            status: 'completed',
            posts: data.posts.map((p) => ({
              posted: p.posted_at,
              text: webText(p.text),
              url: p.url,
              links: p.links,
            })),
            ...(data.posts.length === 0
              ? { message: 'This profile has no posts.' }
              : {}),
            read_at: out.result.fetched_at,
          }
        }),
    }),

    get_google_business_questions: tool({
      description:
        'Read the questions people asked on a business’s Google profile, with the answers (newest first) and how many are unanswered. Use it when the profile basics are already competitive and the gap is engagement. Paid; stored for a day. Needs where the business is: a tracked business, or latitude and longitude with its cid.',
      inputSchema: z.object({
        ...businessRefSchema,
        depth: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('How many questions (default 20)'),
        refresh: refreshSchema,
      }),
      execute: ({ depth, refresh, ...input }) =>
        guarded('get_google_business_questions', async () => {
          const resolved = await ref(input)
          if (!resolved.ok) return failure(resolved)
          const out = await readGoogleBusinessQuestions(
            supabase,
            who,
            resolved.ref,
            { depth, refresh },
          )
          if (!out.ok) return failure(out)
          return {
            success: true,
            unanswered: out.result.unanswered,
            questions: out.result.questions.map((q) => ({
              question: webText(q.text),
              asked_by: q.author,
              when: q.time_ago ?? q.timestamp,
              answers: q.answers.map((a) => ({
                answer: webText(a.text),
                by: a.author,
                when: a.time_ago ?? a.timestamp,
              })),
            })),
            read_at: out.result.fetched_at,
          }
        }),
    }),

    get_local_map_results: tool({
      description:
        'The Google Maps list for one search from one spot: each business’s position, name, cid, rating, reviews, category and contact. From a tracked business (business_id: searched from its own coordinate, and its position given), a coordinate, or across a town. Use it to see who wins a search and to collect competitors’ cids. Paid; stored for 12 hours. To see how the position changes across the town, use a rank grid.',
      inputSchema: z.object({
        keyword: z
          .string()
          .trim()
          .min(1)
          .max(MAX_LOCAL_KEYWORD_LENGTH)
          .describe(
            'What customers search, e.g. "emergency plumber", not the brand name',
          ),
        business_id: z.string().uuid().optional(),
        latitude: z.number().min(-90).max(90).optional(),
        longitude: z.number().min(-180).max(180).optional(),
        place: z
          .string()
          .trim()
          .min(1)
          .max(120)
          .optional()
          .describe('Or a town, e.g. "Portland OR"'),
        country: z
          .string()
          .regex(/^[a-zA-Z]{2}$/)
          .optional(),
        zoom: z
          .number()
          .int()
          .min(4)
          .max(18)
          .optional()
          .describe(
            'Map zoom at a coordinate (default 12, a city; higher is a neighbourhood)',
          ),
        device: z
          .enum(['mobile', 'desktop'])
          .optional()
          .describe('Default mobile'),
        depth: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('How many businesses (default 20)'),
        refresh: refreshSchema,
      }),
      execute: (args) =>
        guarded('get_local_map_results', async () => {
          const out = await readLocalMapResults(supabase, who, args)
          if (!out.ok) return failure(out)
          const r = out.result
          return {
            success: true,
            keyword: r.keyword,
            searched_from: r.place ?? {
              latitude: r.latitude,
              longitude: r.longitude,
              zoom: r.zoom,
            },
            tracked_business_position: args.business_id
              ? r.target_position
              : undefined,
            results: r.rows.map((row) => ({
              position: row.position,
              ...listingForModel(row),
              is_tracked_business: row.is_target || undefined,
            })),
            read_at: r.fetched_at,
          }
        }),
    }),

    list_local_rank_grids: tool({
      description:
        'The workspace’s local rank grids (of one tracked business, or all), each with its keywords, size and latest scan. Free.',
      inputSchema: z.object({ business_id: z.string().uuid().optional() }),
      execute: ({ business_id }) =>
        guarded('list_local_rank_grids', async () => {
          const grids = await listLocalGrids(
            supabase,
            workspaceId,
            business_id ?? null,
          )
          return { success: true, grids: grids.map(gridForModel) }
        }),
    }),

    get_local_rank_grid: tool({
      description:
        'Read a local rank grid and its latest scan: per keyword, a square of the business’s Google Maps positions across the area (north row first), the share of points in the top 3, the average position where it shows, who is first where it is not, and the competitors seen most. Free. wait: true waits up to 90 seconds for a running scan (call again if it still runs). ' +
        'Read a "-" against how many businesses were listed there: a full list means outranked, a short one a thin market. Say where visibility drops off by direction and name who wins there.',
      inputSchema: z.object({
        grid_id: z.string().uuid(),
        wait: z
          .boolean()
          .optional()
          .describe('Wait (up to 90 seconds) for a running scan to finish'),
      }),
      execute: ({ grid_id, wait }) =>
        guarded('get_local_rank_grid', async () => {
          const detail = await getLocalGridDetail(
            supabase,
            workspaceId,
            grid_id,
          )
          if (!detail)
            return {
              success: false,
              code: 'NOT_FOUND',
              error: 'That rank grid doesn’t exist.',
            }
          let scan = detail.latest_scan
          if (!scan)
            return {
              success: true,
              grid: gridForModel(detail),
              scan: null,
              message:
                'This grid has not been scanned yet. Start one with start_local_rank_scan.',
            }
          if (wait && isLiveScan(scan.status)) {
            const deadline = Date.now() + WAIT_MAX_MS
            while (scan && isLiveScan(scan.status) && Date.now() < deadline) {
              await sleep(WAIT_POLL_MS)
              scan = (await getScan(supabase, workspaceId, scan.id)) ?? scan
            }
          }
          const result = await getLocalScanResult(
            supabase,
            workspaceId,
            scan.id,
          )
          if (!result)
            return { success: true, grid: gridForModel(detail), scan: null }
          return {
            success: true,
            grid: gridForModel({ ...detail, latest_scan: result.scan }),
            ...scanResultForModel(result),
            ...(isLiveScan(result.scan.status)
              ? {
                  message:
                    'Still running. Call get_local_rank_grid again (wait: true) in a moment.',
                }
              : {}),
          }
        }),
    }),

    get_local_rank_grid_cost_estimate: tool({
      description: `What one scan costs, free: of a grid (grid_id) or of one you are about to create (business_id, keywords, size, radius_km). A scan is one Google Maps search per point per keyword: a 7x7 grid is 49 searches per keyword. Above ${usd(CONFIRM_ABOVE_USD)}, tell the person the cost and get their yes before start_local_rank_scan.`,
      inputSchema: z.object({
        grid_id: z.string().uuid().optional(),
        business_id: z.string().uuid().optional(),
        keywords: z
          .array(z.string().trim().min(1).max(MAX_LOCAL_KEYWORD_LENGTH))
          .min(1)
          .max(MAX_KEYWORDS_PER_GRID)
          .optional(),
        size: z.union([z.literal(3), z.literal(5), z.literal(7)]).optional(),
        radius_km: z.number().min(MIN_RADIUS_KM).max(MAX_RADIUS_KM).optional(),
      }),
      execute: (args) =>
        guarded('get_local_rank_grid_cost_estimate', async () => {
          if (!args.grid_id && !args.keywords)
            return {
              success: false,
              error:
                'Give a grid_id, or the keywords of the grid you mean to create.',
            }
          const out = await estimateLocalScan(supabase, workspaceId, {
            grid_id: args.grid_id,
            business_id: args.business_id,
            keywords: args.keywords,
            size: args.size,
            radius_km: args.radius_km,
          })
          if (!out.ok) return failure(out)
          return { success: true, estimate: estimateForModel(out.estimate) }
        }),
    }),

    create_local_rank_grid: tool({
      description:
        `Create a rank grid for a tracked business: a square of points around it (${GRID_SIZES.map((s) => `${s}x${s}`).join(', ')}; default ${DEFAULT_GRID_SIZE}x${DEFAULT_GRID_SIZE}) reaching radius_km to each side (default ${DEFAULT_RADIUS_KM} km), and up to ${MAX_KEYWORDS_PER_GRID} keywords customers search ("emergency plumber", never the brand name). Free: creating spends nothing. ` +
        'Size it to the service area: a 3x3 is enough for a storefront that serves its neighbourhood. Confirm the centre is the storefront before scanning. Then start_local_rank_scan.',
      inputSchema: z.object({
        business_id: z.string().uuid(),
        keywords: z
          .array(z.string().trim().min(1).max(MAX_LOCAL_KEYWORD_LENGTH))
          .min(1)
          .max(MAX_KEYWORDS_PER_GRID),
        size: z.union([z.literal(3), z.literal(5), z.literal(7)]).optional(),
        radius_km: z.number().min(MIN_RADIUS_KM).max(MAX_RADIUS_KM).optional(),
        center: z
          .object({
            latitude: z.number().min(-85).max(85),
            longitude: z.number().min(-180).max(180),
          })
          .optional()
          .describe('Default: the business’s own coordinate'),
        device: z
          .enum(['mobile', 'desktop'])
          .optional()
          .describe('Default mobile'),
      }),
      execute: (args) =>
        guarded('create_local_rank_grid', async () => {
          const out = await createLocalGrid(supabase, who, args.business_id, {
            keywords: args.keywords,
            size: args.size,
            radius_km: args.radius_km,
            center_latitude: args.center?.latitude,
            center_longitude: args.center?.longitude,
            device: args.device,
          })
          if (!out.ok) return failure(out)
          return {
            success: true,
            grid: gridForModel({ grid: out.grid, latest_scan: null }),
            message: `Created. A scan is ${out.grid.size * out.grid.size * out.grid.keywords.length} Google Maps searches. Start it with start_local_rank_scan.`,
          }
        }),
    }),

    start_local_rank_scan: tool({
      description:
        'Scan a local rank grid: one Google Maps search at every point for every keyword, run in the background (usually a few minutes). Paid: a 7x7 grid is 49 searches per keyword. ' +
        `A scan estimated above ${usd(CONFIRM_ABOVE_USD)} needs confirmed_with_user: true, after the person heard the cost in your words and said yes. One scan per grid at a time. Then read it with get_local_rank_grid (wait: true).`,
      inputSchema: z.object({
        grid_id: z.string().uuid(),
        confirmed_with_user: confirmedSchema.optional(),
      }),
      execute: ({ grid_id, confirmed_with_user }) =>
        guarded('start_local_rank_scan', async () => {
          if (who.unattended) return UNATTENDED_SCAN
          // The core holds the line: above the threshold it refuses without the person's yes.
          const out = await startLocalScan(supabase, who, grid_id, {
            confirmed: confirmed_with_user === true,
          })
          if (!out.ok) {
            if (out.code === 'CONFIRMATION_REQUIRED')
              return {
                success: false,
                code: 'NEEDS_GO_AHEAD',
                needs_go_ahead: true,
                error: `Refused, nothing started: this scan is ${out.estimate.searches} searches and costs about ${usd(out.estimate.estimate_usd)} from the workspace’s search data budget. Tell the person that in your own words, wait for a yes, then call again with confirmed_with_user: true.`,
                estimate: estimateForModel(out.estimate),
              }
            return {
              ...failure(out),
              ...(out.code === 'SCAN_ALREADY_RUNNING'
                ? { running: scanForModel(out.scan) }
                : {}),
            }
          }
          return {
            success: true,
            scan: scanForModel(out.scan),
            message:
              'The scan started. It usually takes a few minutes. Read it with get_local_rank_grid (grid_id, wait: true).',
          }
        }),
    }),

    cancel_local_rank_scan: tool({
      description:
        'Stop a local rank scan that is queued or running. The points it already read stay; searches already sent may still have been charged.',
      inputSchema: z.object({ scan_id: z.string().uuid() }),
      execute: ({ scan_id }) =>
        guarded('cancel_local_rank_scan', async () => {
          const out = await cancelLocalScan(supabase, { workspaceId }, scan_id)
          if (!out.ok) return failure(out)
          return { success: true, scan: scanForModel(out.scan) }
        }),
    }),

    delete_local_rank_grid: tool({
      description:
        'Delete a local rank grid with all its scans. Only when the person asks. Refused while its scan runs (cancel it first).',
      inputSchema: z.object({ grid_id: z.string().uuid() }),
      execute: ({ grid_id }) =>
        guarded('delete_local_rank_grid', async () => {
          const out = await deleteLocalGrid(supabase, { workspaceId }, grid_id)
          if (!out.ok) return failure(out)
          return {
            success: true,
            deleted: { grid_id: out.grid.id, keywords: out.grid.keywords },
          }
        }),
    }),
  }
}
