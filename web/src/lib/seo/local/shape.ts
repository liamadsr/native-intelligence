/**
 * Turning the provider's Google Business and Maps records into the shapes
 * local SEO stores and shows (./view.ts). Pure: no I/O. Every reader
 * tolerates a missing or oddly typed field (the provider's rows are loose
 * records), and keeps only what the product reads: full rows carry image
 * URLs, xpaths and tracking blobs nobody uses.
 *
 * Text in these records (business names, descriptions, review and post text,
 * questions and answers) is written by other people: data, never
 * instructions. It is clipped here so one record can't bloat a snapshot.
 *
 * Adapted from OpenSEO (MIT, see ../THIRD_PARTY_NOTICES.md).
 */
import { COMPETITORS_PER_POINT } from './limits'
import type {
  GoogleBusinessAnswer,
  GoogleBusinessHours,
  GoogleBusinessPost,
  GoogleBusinessProfile,
  GoogleBusinessQuestion,
  GoogleBusinessReview,
  GoogleBusinessReviewsData,
  LocalBusinessListing,
  LocalMapResultRow,
  LocalPointCompetitor,
} from './view'

const TITLE_MAX = 300
const TEXT_MAX = 5_000
const SHORT_MAX = 300
const URL_MAX = 2_048

/** The value at a path of nested records, or undefined. */
export function readPath(source: unknown, ...keys: string[]): unknown {
  let current: unknown = source
  for (const key of keys) {
    if (!current || typeof current !== 'object' || Array.isArray(current))
      return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

function clip(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value
}

function str(value: unknown, max = SHORT_MAX): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? clip(trimmed, max) : null
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function int(value: unknown): number | null {
  const n = num(value)
  return n === null ? null : Math.round(n)
}

function bool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

/** A cid or place id: the provider sometimes sends a cid as a number. */
function id(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return str(value, 256)
}

function url(value: unknown): string | null {
  const text = str(value, URL_MAX)
  return text && /^https?:\/\//i.test(text) ? text : null
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const text = str(entry, 120)
    return text ? [text] : []
  })
}

function domainOf(website: string | null): string | null {
  if (!website) return null
  try {
    return new URL(website).hostname.replace(/^www\./, '')
  } catch {
    return null
  }
}

/** One Google place from a Maps result or a business listings row; null when it has no name. */
export function listingFromItem(item: unknown): LocalBusinessListing | null {
  const title = str(readPath(item, 'title'), TITLE_MAX)
  if (!title) return null
  const website =
    url(readPath(item, 'url')) ?? url(readPath(item, 'contact_url'))
  return {
    title,
    cid: id(readPath(item, 'cid')),
    place_id: id(readPath(item, 'place_id')),
    address: str(readPath(item, 'address')),
    latitude: num(readPath(item, 'latitude')),
    longitude: num(readPath(item, 'longitude')),
    category: str(readPath(item, 'category'), 120),
    additional_categories: strings(readPath(item, 'additional_categories')),
    rating: num(readPath(item, 'rating', 'value')),
    review_count: int(readPath(item, 'rating', 'votes_count')),
    is_claimed: bool(readPath(item, 'is_claimed')),
    phone: str(readPath(item, 'phone'), 60),
    website,
    domain: str(readPath(item, 'domain'), 253) ?? domainOf(website),
  }
}

/** Who a place is, for de-duplicating rows and matching a tracked business. */
export function listingIdentity(listing: {
  cid: string | null
  place_id: string | null
  title: string
}): string {
  if (listing.cid) return `cid:${listing.cid}`
  if (listing.place_id) return `place:${listing.place_id}`
  return `title:${listing.title.toLowerCase()}`
}

/** The business a grid or a map read looks for. */
export interface TargetBusiness {
  cid: string | null
  place_id: string | null
  title: string
}

/**
 * Whether a row is the target. An id matches exactly; a name only counts
 * when the target has no id at all, because with an id a similar name is a
 * different business (a chain's other branch, a namesake).
 */
export function isTargetRow(
  row: { cid: string | null; place_id: string | null; title: string },
  target: TargetBusiness,
): boolean {
  if (target.cid && row.cid === target.cid) return true
  if (target.place_id && row.place_id === target.place_id) return true
  if (target.cid || target.place_id) return false
  const name = target.title.trim().toLowerCase()
  return !!name && row.title.toLowerCase().includes(name)
}

/**
 * A Maps result list in position order, de-duplicated by identity. A row's
 * position is the provider's absolute rank, else its group rank, else its
 * place in the list.
 */
export function mapResultRows(
  items: readonly unknown[],
  target: TargetBusiness | null,
): LocalMapResultRow[] {
  const seen = new Set<string>()
  const rows: LocalMapResultRow[] = []
  items.forEach((item, index) => {
    // Paid placements are not positions: they are left out.
    const type = readPath(item, 'type')
    if (typeof type === 'string' && type.includes('paid')) return
    const listing = listingFromItem(item)
    if (!listing) return
    const key = listingIdentity(listing)
    if (seen.has(key)) return
    seen.add(key)
    const position =
      int(readPath(item, 'rank_absolute')) ??
      int(readPath(item, 'rank_group')) ??
      index + 1
    rows.push({
      ...listing,
      position,
      is_target: target ? isTargetRow(listing, target) : false,
    })
  })
  return rows.sort((a, b) => a.position - b.position)
}

/** What one grid point keeps: the target's position, how many businesses were listed, and the first few. */
export function pointOutcome(
  items: readonly unknown[],
  target: TargetBusiness,
): {
  position: number | null
  results_count: number
  competitors: LocalPointCompetitor[]
} {
  const rows = mapResultRows(items, target)
  const match = rows.find((row) => row.is_target)
  return {
    position: match?.position ?? null,
    results_count: rows.length,
    competitors: rows.slice(0, COMPETITORS_PER_POINT).map((row) => ({
      position: row.position,
      title: row.title,
      cid: row.cid,
      place_id: row.place_id,
      rating: row.rating,
      review_count: row.review_count,
      is_target: row.is_target,
    })),
  }
}

const WEEKDAYS = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
] as const

function clock(span: unknown, key: 'open' | 'close'): string {
  const hour = num(readPath(span, key, 'hour'))
  const minute = num(readPath(span, key, 'minute')) ?? 0
  if (hour === null) return '?'
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

function hoursOf(record: unknown): GoogleBusinessHours[] | null {
  const timetable = readPath(record, 'work_time', 'work_hours', 'timetable')
  if (!timetable || typeof timetable !== 'object') return null
  return WEEKDAYS.map((day) => {
    const spans = readPath(timetable, day)
    return {
      day,
      spans: Array.isArray(spans)
        ? spans.map((span) => `${clock(span, 'open')}-${clock(span, 'close')}`)
        : [],
    }
  })
}

function distributionOf(value: unknown): Record<string, number> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const out: Record<string, number> = {}
  for (const star of ['5', '4', '3', '2', '1'])
    out[star] = int((value as Record<string, unknown>)[star]) ?? 0
  return out
}

/** A Google Business Profile read (my_business_info), or null when Google has none. */
export function profileFromInfo(
  record: Record<string, unknown> | null,
): GoogleBusinessProfile | null {
  if (!record) return null
  const website = url(readPath(record, 'url'))
  return {
    title: str(readPath(record, 'title'), TITLE_MAX),
    description: str(readPath(record, 'description'), TEXT_MAX),
    category: str(readPath(record, 'category'), 120),
    additional_categories: strings(readPath(record, 'additional_categories')),
    rating: num(readPath(record, 'rating', 'value')),
    review_count: int(readPath(record, 'rating', 'votes_count')),
    rating_distribution: distributionOf(
      readPath(record, 'rating_distribution'),
    ),
    address: str(readPath(record, 'address')),
    phone: str(readPath(record, 'phone'), 60),
    website,
    domain: str(readPath(record, 'domain'), 253) ?? domainOf(website),
    is_claimed: bool(readPath(record, 'is_claimed')),
    current_status: str(
      readPath(record, 'work_time', 'work_hours', 'current_status'),
      60,
    ),
    hours: hoursOf(record),
    total_photos: int(readPath(record, 'total_photos')),
    price_level: str(readPath(record, 'price_level'), 20),
    cid: id(readPath(record, 'cid')),
    place_id: id(readPath(record, 'place_id')),
    latitude: num(readPath(record, 'latitude')),
    longitude: num(readPath(record, 'longitude')),
    check_url: url(readPath(record, 'check_url')),
  }
}

function itemsOf(result: Record<string, unknown> | null): unknown[] {
  const items = result?.items
  return Array.isArray(items) ? items : []
}

function sourceOf(row: unknown): string {
  const source = readPath(row, 'source')
  if (typeof source === 'string' && source.trim())
    return clip(source.trim(), 60)
  return str(readPath(source, 'title'), 60) ?? 'Google'
}

/** Newest first when both carry a timestamp; otherwise the provider's order. */
function byTimestampDesc<
  T extends { timestamp: string | null; position: number | null },
>(a: T, b: T): number {
  const at = a.timestamp ? Date.parse(a.timestamp) : NaN
  const bt = b.timestamp ? Date.parse(b.timestamp) : NaN
  if (Number.isFinite(at) && Number.isFinite(bt) && at !== bt) return bt - at
  return (
    (a.position ?? Number.MAX_SAFE_INTEGER) -
    (b.position ?? Number.MAX_SAFE_INTEGER)
  )
}

/** A collected reviews task: the reviews newest first, with the stars and the owner's replies counted. */
export function reviewsFromResult(
  result: Record<string, unknown> | null,
): GoogleBusinessReviewsData {
  const reviews: GoogleBusinessReview[] = itemsOf(result)
    .map((row) => ({
      review_id: str(readPath(row, 'review_id'), 200),
      position: int(readPath(row, 'rank_absolute')),
      rating: num(readPath(row, 'rating', 'value')),
      time_ago: str(readPath(row, 'time_ago'), 60),
      timestamp: str(readPath(row, 'timestamp'), 60),
      text:
        str(readPath(row, 'review_text'), TEXT_MAX) ??
        str(readPath(row, 'original_review_text'), TEXT_MAX),
      original_language: str(readPath(row, 'original_language'), 20),
      author: str(readPath(row, 'profile_name'), 120),
      author_is_local_guide: bool(readPath(row, 'local_guide')),
      author_review_count: int(readPath(row, 'reviews_count')),
      photos: int(readPath(row, 'photos_count')),
      source: sourceOf(row),
      owner_reply: str(readPath(row, 'owner_answer'), TEXT_MAX),
      owner_reply_time_ago: str(readPath(row, 'owner_time_ago'), 60),
      owner_reply_timestamp: str(readPath(row, 'owner_timestamp'), 60),
    }))
    .sort(byTimestampDesc)
  const distribution: Record<string, number> = {
    '5': 0,
    '4': 0,
    '3': 0,
    '2': 0,
    '1': 0,
  }
  let replied = 0
  for (const review of reviews) {
    const star =
      review.rating === null
        ? null
        : String(Math.min(5, Math.max(1, Math.round(review.rating))))
    if (star) distribution[star] += 1
    if (review.owner_reply) replied++
  }
  return {
    reviews,
    total_reviews: int(result?.reviews_count),
    rating: num(readPath(result, 'rating', 'value')),
    rating_distribution: distribution,
    replied,
    unreplied: reviews.length - replied,
  }
}

function linksOf(value: unknown): GoogleBusinessPost['links'] {
  if (!Array.isArray(value)) return []
  return value.flatMap((link) => {
    const target = url(readPath(link, 'url'))
    if (!target) return []
    return [
      {
        title:
          str(readPath(link, 'title'), 120) ?? str(readPath(link, 'type'), 120),
        url: target,
      },
    ]
  })
}

/** A collected posts task: the business's Google posts (updates, offers, events), newest first. */
export function postsFromResult(result: Record<string, unknown> | null): {
  posts: GoogleBusinessPost[]
} {
  const posts = itemsOf(result)
    .map((row) => ({
      position: int(readPath(row, 'rank_absolute')),
      author: str(readPath(row, 'author'), 120),
      posted_at:
        str(readPath(row, 'post_date'), 60) ??
        str(readPath(row, 'timestamp'), 60),
      timestamp: str(readPath(row, 'timestamp'), 60),
      text:
        str(readPath(row, 'post_text'), TEXT_MAX) ??
        str(readPath(row, 'snippet'), TEXT_MAX),
      url: url(readPath(row, 'url')),
      links: linksOf(readPath(row, 'links')),
    }))
    .sort(byTimestampDesc)
    .map(({ timestamp: _timestamp, ...post }) => post)
  return { posts }
}

function answerOf(row: unknown): GoogleBusinessAnswer {
  return {
    answer_id: str(readPath(row, 'answer_id'), 200),
    text:
      str(readPath(row, 'answer_text'), TEXT_MAX) ??
      str(readPath(row, 'original_answer_text'), TEXT_MAX),
    author: str(readPath(row, 'profile_name'), 120),
    time_ago: str(readPath(row, 'time_ago'), 60),
    timestamp: str(readPath(row, 'timestamp'), 60),
  }
}

/** Questions and answers on a profile, each question with its answers newest first. */
export function questionsFromRows(
  rows: readonly unknown[],
): GoogleBusinessQuestion[] {
  return rows.map((row) => {
    const answers = readPath(row, 'items')
    return {
      question_id: str(readPath(row, 'question_id'), 200),
      text:
        str(readPath(row, 'question_text'), TEXT_MAX) ??
        str(readPath(row, 'original_question_text'), TEXT_MAX),
      author: str(readPath(row, 'profile_name'), 120),
      time_ago: str(readPath(row, 'time_ago'), 60),
      timestamp: str(readPath(row, 'timestamp'), 60),
      answers: (Array.isArray(answers) ? answers.map(answerOf) : []).sort(
        (a, b) => {
          const at = a.timestamp ? Date.parse(a.timestamp) : NaN
          const bt = b.timestamp ? Date.parse(b.timestamp) : NaN
          return Number.isFinite(at) && Number.isFinite(bt) ? bt - at : 0
        },
      ),
    }
  })
}
