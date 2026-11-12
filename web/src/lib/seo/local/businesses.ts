/**
 * Tracked Google places and the reads about one place: finding a business,
 * adding it to the workspace, removing it, and reading its Google Business
 * Profile. The one core behind the routes and the tools.
 *
 *   - Finding a business is paid. By name and place (a town the free places
 *     list resolves): a Google Maps search there, which gives every match's
 *     coordinate and id. Near a coordinate: the business listings database,
 *     which filters by category, rating, review count and claimed status.
 *   - Adding one is free: the place's details come from a search the person
 *     just made. At most MAX_TRACKED_BUSINESSES per workspace; the same
 *     place (cid or place id) twice is refused with the one already there.
 *   - A profile read is paid and kept as a snapshot (../lookup-cache.ts) for
 *     a day; `refresh` buys it again. A tracked place's rating, review count,
 *     categories and contact details are updated from it.
 *   - Every paid read checks access first (../paid.ts) after looking for a
 *     stored snapshot: reading what was already bought is free.
 *
 * Adapted from OpenSEO (MIT, see ../THIRD_PARTY_NOTICES.md).
 */
import type { SeoDataRefusal } from '@/lib/seo/access'
import { readLookup, writeLookup } from '@/lib/seo/lookup-cache'
import { paidSeoClient, type SeoPaidDeps, type SeoWho } from '@/lib/seo/paid'
import type { SupabaseClient } from '@supabase/supabase-js'
import 'server-only'
import {
  businessDataCoordinate,
  isLatitude,
  isLongitude,
  listingsCoordinate,
} from './geometry'
import {
  BUSINESS_SEARCH_MAX_AGE_MS,
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  MAX_TRACKED_BUSINESSES,
  PROFILE_MAX_AGE_MS,
  PROFILE_SEARCH_RADIUS_KM,
} from './limits'
import {
  BUSINESS_FIELDS,
  businessHasLiveScan,
  businessView,
  getTrackedBusiness,
  type BusinessRow,
} from './queries'
import {
  countryMarket,
  marketOfLocation,
  searchPlaces,
  type ReferenceDeps,
} from './reference'
import { listingFromItem, mapResultRows, profileFromInfo } from './shape'
import type {
  GoogleBusinessProfile,
  GoogleBusinessProfileResult,
  LocalBusinessListing,
  LocalBusinessSearchResult,
  TrackedBusinessView,
} from './view'

export const LOCAL_BUSINESS_SEARCH_KIND = 'local_business_search'
export const GBP_PROFILE_KIND = 'gbp_profile'
const SEARCH_VERSION = 1
const PROFILE_VERSION = 1

export type LocalDeps = SeoPaidDeps & ReferenceDeps

export type NotFound = { ok: false; code: 'NOT_FOUND'; message: string }
export type Invalid = {
  ok: false
  code: 'INVALID' | 'PLACE_NOT_FOUND'
  message: string
}

// ---------------------------------------------------------------------------
// Finding a business
// ---------------------------------------------------------------------------

export interface FindBusinessesInput {
  /** A name or trade word ("Fernhill Studio", "plumber"). */
  query?: string | null
  /** A town or region as a person writes it ("Portland OR"), searched with `country`. */
  place?: string | null
  /** ISO country code, default "us". */
  country?: string | null
  /** Or: a coordinate and a radius in km, searched in the business listings database. */
  near?: { latitude: number; longitude: number; radius_km?: number } | null
  categories?: string[] | null
  min_rating?: number | null
  min_reviews?: number | null
  is_claimed?: boolean | null
  limit?: number | null
  refresh?: boolean
}

function clampLimit(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(Math.max(Math.floor(value), 1), MAX_SEARCH_LIMIT)
    : DEFAULT_SEARCH_LIMIT
}

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const text = value.replace(/\s+/g, ' ').trim()
  return text ? text.slice(0, max) : null
}

type StoredSearch = Omit<
  LocalBusinessSearchResult,
  'lookup_id' | 'fetched_at' | 'from_cache'
>

/**
 * Find businesses by name in a place, or near a coordinate. A fresh stored
 * search answers for free; otherwise the access check runs and the search is
 * bought and stored.
 */
export async function findLocalBusinesses(
  svc: SupabaseClient,
  who: SeoWho,
  input: FindBusinessesInput,
  deps: LocalDeps = {},
): Promise<
  { ok: true; result: LocalBusinessSearchResult } | Invalid | SeoDataRefusal
> {
  const query = cleanText(input.query, 200)
  const limit = clampLimit(input.limit)
  const near = input.near ?? null
  const now = deps.now?.() ?? new Date()

  if (near) {
    if (!isLatitude(near.latitude) || !isLongitude(near.longitude))
      return {
        ok: false,
        code: 'INVALID',
        message: 'That coordinate isn’t a place on the map.',
      }
    const radius =
      typeof near.radius_km === 'number' && near.radius_km > 0
        ? Math.min(near.radius_km, 100)
        : 10
    const categories = (input.categories ?? [])
      .flatMap((entry) => {
        const text = cleanText(entry, 120)
        return text ? [text.toLowerCase().replace(/\s+/g, '_')] : []
      })
      .slice(0, 10)
    const filters: unknown[] = []
    if (typeof input.min_rating === 'number')
      filters.push([
        'rating.value',
        '>=',
        Math.min(Math.max(input.min_rating, 1), 5),
      ])
    if (typeof input.min_reviews === 'number') {
      if (filters.length) filters.push('and')
      filters.push([
        'rating.votes_count',
        '>=',
        Math.max(Math.floor(input.min_reviews), 0),
      ])
    }
    const coordinate = listingsCoordinate(near, radius)
    const request = {
      v: SEARCH_VERSION,
      mode: 'near',
      title: query?.toLowerCase() ?? null,
      coordinate,
      categories,
      filters,
      is_claimed:
        typeof input.is_claimed === 'boolean' ? input.is_claimed : null,
      limit,
    }
    if (!input.refresh) {
      const hit = await readLookup<StoredSearch>(
        svc,
        who.workspaceId,
        LOCAL_BUSINESS_SEARCH_KIND,
        request,
        { maxAgeMs: BUSINESS_SEARCH_MAX_AGE_MS, now },
      )
      if (hit && Array.isArray(hit.result?.rows))
        return {
          ok: true,
          result: {
            ...hit.result,
            lookup_id: hit.id,
            fetched_at: hit.fetched_at,
            from_cache: true,
          },
        }
    }
    const opened = await paidSeoClient(svc, who, deps)
    if (!opened.ok) return opened
    const items = await opened.client.business.businessListings({
      title: query ?? undefined,
      categories: categories.length ? categories : undefined,
      locationCoordinate: coordinate,
      isClaimed:
        typeof input.is_claimed === 'boolean' ? input.is_claimed : undefined,
      filters: filters.length ? filters : undefined,
      limit,
    })
    const body: StoredSearch = {
      query,
      place: null,
      country: null,
      rows: items.flatMap((item) => {
        const listing = listingFromItem(item)
        return listing ? [listing] : []
      }),
    }
    const label = `${query ?? (categories.join(', ') || 'businesses')} near ${coordinate}`
    const saved = await writeLookup(
      svc,
      { workspaceId: who.workspaceId, userId: who.userId },
      { kind: LOCAL_BUSINESS_SEARCH_KIND, request, result: body, label },
      { now },
    )
    return {
      ok: true,
      result: {
        ...body,
        lookup_id: saved?.id ?? null,
        fetched_at: saved?.fetched_at ?? now.toISOString(),
        from_cache: false,
      },
    }
  }

  if (!query)
    return {
      ok: false,
      code: 'INVALID',
      message:
        'Give the business’s name (or a trade word) and the town it is in.',
    }
  const placeText = cleanText(input.place, 120)
  if (!placeText)
    return {
      ok: false,
      code: 'INVALID',
      message: 'Which town or city is the business in?',
    }
  const market = countryMarket(input.country ?? 'us')
  if (!market)
    return {
      ok: false,
      code: 'INVALID',
      message:
        'That country isn’t covered. Give a two-letter country code, like “us” or “gb”.',
    }
  const request = {
    v: SEARCH_VERSION,
    mode: 'place',
    query: query.toLowerCase(),
    place: placeText.toLowerCase(),
    country: market.iso,
    limit,
  }
  if (!input.refresh) {
    const hit = await readLookup<StoredSearch>(
      svc,
      who.workspaceId,
      LOCAL_BUSINESS_SEARCH_KIND,
      request,
      { maxAgeMs: BUSINESS_SEARCH_MAX_AGE_MS, now },
    )
    if (hit && Array.isArray(hit.result?.rows))
      return {
        ok: true,
        result: {
          ...hit.result,
          lookup_id: hit.id,
          fetched_at: hit.fetched_at,
          from_cache: true,
        },
      }
  }
  const opened = await paidSeoClient(svc, who, deps)
  if (!opened.ok) return opened
  // The free places list turns "Portland OR" into the canonical name the search needs.
  const [place] = await searchPlaces(market.iso, placeText, 1, deps)
  if (!place)
    return {
      ok: false,
      code: 'PLACE_NOT_FOUND',
      message: `No town called “${placeText}” was found in ${market.label}. Try the town’s name alone.`,
    }
  const items = await opened.client.serp.local({
    keyword: query,
    locationName: place.location_name,
    languageCode: market.language_code,
    searchType: 'maps',
    device: 'desktop',
    depth: limit,
  })
  const body: StoredSearch = {
    query,
    place: place.label,
    country: market.iso,
    rows: mapResultRows(items, null).map(
      ({ position: _position, is_target: _target, ...listing }) => listing,
    ),
  }
  const saved = await writeLookup(
    svc,
    { workspaceId: who.workspaceId, userId: who.userId },
    {
      kind: LOCAL_BUSINESS_SEARCH_KIND,
      request,
      result: body,
      label: `${query} · ${place.label}`,
    },
    { now },
  )
  return {
    ok: true,
    result: {
      ...body,
      lookup_id: saved?.id ?? null,
      fetched_at: saved?.fetched_at ?? now.toISOString(),
      from_cache: false,
    },
  }
}

// ---------------------------------------------------------------------------
// Tracking a business
// ---------------------------------------------------------------------------

export interface AddBusinessInput extends Partial<LocalBusinessListing> {
  /** ISO country code of the business (from the search), default "us". */
  country?: string | null
  language_code?: string | null
}

export type AddBusinessResult =
  | { ok: true; business: TrackedBusinessView }
  | {
      ok: false
      code: 'ALREADY_TRACKED'
      message: string
      business: TrackedBusinessView
    }
  | { ok: false; code: 'LIMIT_REACHED'; message: string }
  | Invalid

function textOrNull(value: unknown, max: number): string | null {
  return cleanText(value, max)
}

/** Add a Google place to the workspace's tracked businesses. Free. */
export async function addTrackedBusiness(
  svc: SupabaseClient,
  who: { workspaceId: string; userId: string },
  input: AddBusinessInput,
): Promise<AddBusinessResult> {
  const title = textOrNull(input.title, 300)
  const cid = textOrNull(input.cid, 64)
  const placeId = textOrNull(input.place_id, 256)
  if (!title)
    return {
      ok: false,
      code: 'INVALID',
      message: 'The business needs its name.',
    }
  if (!cid && !placeId)
    return {
      ok: false,
      code: 'INVALID',
      message:
        'The business needs its Google id (cid or place id): pick it from a search.',
    }
  if (!isLatitude(input.latitude) || !isLongitude(input.longitude))
    return {
      ok: false,
      code: 'INVALID',
      message: 'The business needs its coordinate: pick it from a search.',
    }
  const market = countryMarket(input.country ?? 'us')
  if (!market)
    return {
      ok: false,
      code: 'INVALID',
      message:
        'That country isn’t covered. Give a two-letter country code, like “us”.',
    }

  const existing = await listByIdentity(svc, who.workspaceId, cid, placeId)
  if (existing)
    return {
      ok: false,
      code: 'ALREADY_TRACKED',
      message: `${existing.title} is already tracked.`,
      business: existing,
    }
  const { count, error: countError } = await svc
    .from('seo_local_business')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', who.workspaceId)
  if (countError)
    throw new Error(`seo local business count failed: ${countError.message}`)
  if ((count ?? 0) >= MAX_TRACKED_BUSINESSES) {
    return {
      ok: false,
      code: 'LIMIT_REACHED',
      message: `A workspace tracks at most ${MAX_TRACKED_BUSINESSES} businesses. Remove one first.`,
    }
  }

  const website =
    typeof input.website === 'string' && /^https?:\/\//i.test(input.website)
      ? input.website.slice(0, 2048)
      : null
  const rating =
    typeof input.rating === 'number' && input.rating >= 0 && input.rating <= 5
      ? input.rating
      : null
  const reviews =
    typeof input.review_count === 'number' && input.review_count >= 0
      ? Math.floor(input.review_count)
      : null
  const language =
    typeof input.language_code === 'string' &&
    /^[a-z]{2,3}(-[a-z0-9]{2,4})?$/i.test(input.language_code)
      ? input.language_code.toLowerCase()
      : market.language_code
  const { data, error } = await svc
    .from('seo_local_business')
    .insert({
      workspace_id: who.workspaceId,
      added_by: who.userId,
      title,
      cid,
      place_id: placeId,
      address: textOrNull(input.address, 300),
      latitude: input.latitude,
      longitude: input.longitude,
      category: textOrNull(input.category, 120),
      additional_categories: (input.additional_categories ?? [])
        .flatMap((entry) => {
          const text = textOrNull(entry, 120)
          return text ? [text] : []
        })
        .slice(0, 20),
      phone: textOrNull(input.phone, 60),
      website,
      domain: textOrNull(input.domain, 253),
      rating,
      review_count: reviews,
      is_claimed:
        typeof input.is_claimed === 'boolean' ? input.is_claimed : null,
      location_code: market.location_code,
      language_code: language,
    })
    .select(BUSINESS_FIELDS)
    .single()
  if (error || !data)
    throw new Error(`seo local business insert failed: ${error?.message}`)
  return { ok: true, business: businessView(data as BusinessRow) }
}

async function listByIdentity(
  svc: SupabaseClient,
  workspaceId: string,
  cid: string | null,
  placeId: string | null,
): Promise<TrackedBusinessView | null> {
  // Two plain filters, not one .or(): an id is never spliced into a filter string.
  for (const [column, value] of [
    ['cid', cid],
    ['place_id', placeId],
  ] as const) {
    if (!value) continue
    const { data, error } = await svc
      .from('seo_local_business')
      .select(BUSINESS_FIELDS)
      .eq('workspace_id', workspaceId)
      .eq(column, value)
      .limit(1)
    if (error)
      throw new Error(`seo local business read failed: ${error.message}`)
    const row = ((data ?? []) as BusinessRow[])[0]
    if (row) return businessView(row)
  }
  return null
}

/** Stop tracking a place: its grids and their scans go with it. Refused while one of its scans runs. */
export async function removeTrackedBusiness(
  svc: SupabaseClient,
  who: { workspaceId: string },
  businessId: string,
): Promise<
  | { ok: true; business: TrackedBusinessView }
  | NotFound
  | { ok: false; code: 'STILL_RUNNING'; message: string }
> {
  const business = await getTrackedBusiness(svc, who.workspaceId, businessId)
  if (!business)
    return {
      ok: false,
      code: 'NOT_FOUND',
      message: 'That business isn’t tracked here.',
    }
  if (await businessHasLiveScan(svc, who.workspaceId, businessId)) {
    return {
      ok: false,
      code: 'STILL_RUNNING',
      message:
        'A scan of this business is running. Stop it, or let it finish, first.',
    }
  }
  const { error } = await svc
    .from('seo_local_business')
    .delete()
    .eq('workspace_id', who.workspaceId)
    .eq('id', businessId)
  if (error)
    throw new Error(`seo local business delete failed: ${error.message}`)
  return { ok: true, business }
}

// ---------------------------------------------------------------------------
// Which business a read is about
// ---------------------------------------------------------------------------

/** The business a profile, reviews, posts or questions read is about. */
export interface BusinessRef {
  trackedId: string | null
  title: string | null
  cid: string | null
  placeId: string | null
  latitude: number | null
  longitude: number | null
  locationCode: number
  languageCode: string
}

export interface BusinessRefInput {
  business_id?: string | null
  cid?: string | null
  place_id?: string | null
  /** A name, only with a coordinate (a name alone matches the wrong branch). */
  name?: string | null
  latitude?: number | null
  longitude?: number | null
  country?: string | null
}

/** A tracked business by id, or any Google place by cid, place id, or name near a coordinate. */
export async function resolveBusinessRef(
  svc: SupabaseClient,
  workspaceId: string,
  input: BusinessRefInput,
): Promise<{ ok: true; ref: BusinessRef } | NotFound | Invalid> {
  if (input.business_id) {
    const business = await getTrackedBusiness(
      svc,
      workspaceId,
      input.business_id,
    )
    if (!business)
      return {
        ok: false,
        code: 'NOT_FOUND',
        message: 'That business isn’t tracked here.',
      }
    return {
      ok: true,
      ref: {
        trackedId: business.id,
        title: business.title,
        cid: business.cid,
        placeId: business.place_id,
        latitude: business.latitude,
        longitude: business.longitude,
        locationCode: business.location_code,
        languageCode: business.language_code,
      },
    }
  }
  const cid = cleanText(input.cid, 64)
  const placeId = cleanText(input.place_id, 256)
  const name = cleanText(input.name, 200)
  const given = [cid, placeId, name].filter(Boolean).length
  if (given !== 1)
    return {
      ok: false,
      code: 'INVALID',
      message:
        'Name the business one way: a tracked business, its cid, its place id, or its name with where it is.',
    }
  const hasPoint = isLatitude(input.latitude) && isLongitude(input.longitude)
  if (name && !hasPoint)
    return {
      ok: false,
      code: 'INVALID',
      message:
        'A name alone can match the wrong branch: give the business’s coordinate too, or its cid.',
    }
  const market = input.country
    ? countryMarket(input.country)
    : marketOfLocation(2840)
  if (!market)
    return {
      ok: false,
      code: 'INVALID',
      message:
        'That country isn’t covered. Give a two-letter country code, like “us”.',
    }
  return {
    ok: true,
    ref: {
      trackedId: null,
      title: name,
      cid,
      placeId,
      latitude: hasPoint ? (input.latitude as number) : null,
      longitude: hasPoint ? (input.longitude as number) : null,
      locationCode: market.location_code,
      languageCode: market.language_code,
    },
  }
}

/** The `keyword` the profile, posts and questions reads take: the cid: and place_id: prefixes carry an id. */
export function refKeyword(ref: BusinessRef): string {
  if (ref.cid) return `cid:${ref.cid}`
  if (ref.placeId) return `place_id:${ref.placeId}`
  return ref.title ?? ''
}

/** Where the read searches: around the business's coordinate when known, else its whole country. */
export function refLocation(ref: BusinessRef): {
  locationCoordinate?: string
  locationCode?: number
} {
  if (ref.latitude !== null && ref.longitude !== null) {
    return {
      locationCoordinate: businessDataCoordinate(
        { latitude: ref.latitude, longitude: ref.longitude },
        PROFILE_SEARCH_RADIUS_KM,
      ),
    }
  }
  return { locationCode: ref.locationCode }
}

/** A short line for a stored lookup's label. */
export function refLabel(ref: BusinessRef): string {
  return ref.title ?? (ref.cid ? `cid ${ref.cid}` : `place ${ref.placeId}`)
}

// ---------------------------------------------------------------------------
// The Google Business Profile
// ---------------------------------------------------------------------------

type StoredProfile = { profile: GoogleBusinessProfile | null }

/** Copy what a read says about a tracked place onto its row (rating, reviews, categories, contact). Logged, never thrown. */
export async function updateTrackedFromRead(
  svc: SupabaseClient,
  workspaceId: string,
  businessId: string,
  read: Partial<
    Pick<
      GoogleBusinessProfile,
      | 'rating'
      | 'review_count'
      | 'category'
      | 'additional_categories'
      | 'phone'
      | 'website'
      | 'domain'
      | 'address'
      | 'is_claimed'
    >
  >,
  profileFetchedAt: string | null,
): Promise<void> {
  const patch: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  }
  if (typeof read.rating === 'number' && read.rating >= 0 && read.rating <= 5)
    patch.rating = read.rating
  if (typeof read.review_count === 'number' && read.review_count >= 0)
    patch.review_count = read.review_count
  if (read.category) patch.category = read.category.slice(0, 120)
  if (read.additional_categories)
    patch.additional_categories = read.additional_categories.slice(0, 20)
  if (read.phone) patch.phone = read.phone.slice(0, 60)
  if (read.website) patch.website = read.website.slice(0, 2048)
  if (read.domain) patch.domain = read.domain.slice(0, 253)
  if (read.address) patch.address = read.address.slice(0, 300)
  if (typeof read.is_claimed === 'boolean') patch.is_claimed = read.is_claimed
  if (profileFetchedAt) patch.profile_fetched_at = profileFetchedAt
  const { error } = await svc
    .from('seo_local_business')
    .update(patch)
    .eq('workspace_id', workspaceId)
    .eq('id', businessId)
  if (error)
    console.error('[seo-local] tracked business update failed', {
      businessId,
      error: error.message,
    })
}

/**
 * Read a business's Google Business Profile. A stored read younger than a
 * day answers for free (`storedOnly` answers only from storage, never
 * buying); `refresh` buys it again.
 */
export async function readGoogleBusinessProfile(
  svc: SupabaseClient,
  who: SeoWho,
  ref: BusinessRef,
  opts: { refresh?: boolean; storedOnly?: boolean } = {},
  deps: LocalDeps = {},
): Promise<
  { ok: true; result: GoogleBusinessProfileResult | null } | SeoDataRefusal
> {
  const now = deps.now?.() ?? new Date()
  const location = refLocation(ref)
  const request = {
    v: PROFILE_VERSION,
    keyword: refKeyword(ref),
    language_code: ref.languageCode,
    ...location,
  }
  if (!opts.refresh) {
    // A stored-only read takes any age: it is what the page shows until someone refreshes.
    const hit = await readLookup<StoredProfile>(
      svc,
      who.workspaceId,
      GBP_PROFILE_KIND,
      request,
      {
        maxAgeMs: opts.storedOnly
          ? 365 * 24 * 60 * 60 * 1000
          : PROFILE_MAX_AGE_MS,
        now,
      },
    )
    if (hit && hit.result && 'profile' in hit.result) {
      return {
        ok: true,
        result: {
          profile: hit.result.profile,
          lookup_id: hit.id,
          fetched_at: hit.fetched_at,
          from_cache: true,
        },
      }
    }
    if (opts.storedOnly) return { ok: true, result: null }
  }
  const opened = await paidSeoClient(svc, who, deps)
  if (!opened.ok) return opened
  const record = await opened.client.business.myBusinessInfo({
    keyword: refKeyword(ref),
    ...location,
    languageCode: ref.languageCode,
  })
  const profile = profileFromInfo(record)
  const saved = await writeLookup(
    svc,
    { workspaceId: who.workspaceId, userId: who.userId },
    {
      kind: GBP_PROFILE_KIND,
      request,
      result: { profile },
      label: refLabel(ref),
    },
    { now },
  )
  const fetchedAt = saved?.fetched_at ?? now.toISOString()
  if (ref.trackedId && profile)
    await updateTrackedFromRead(
      svc,
      who.workspaceId,
      ref.trackedId,
      profile,
      fetchedAt,
    )
  return {
    ok: true,
    result: {
      profile,
      lookup_id: saved?.id ?? null,
      fetched_at: fetchedAt,
      from_cache: false,
    },
  }
}
