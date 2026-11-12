/**
 * Local SEO's free reference data: Google business categories, the places
 * (cities, counties, regions) of a country a search can be made in, and the
 * country markets. The provider's endpoints behind the first two cost
 * nothing, so they are called directly (never through the meter, which would
 * refuse a workspace at its ceiling), but they still need the server's
 * provider key.
 *
 * Adapted from OpenSEO (MIT, see ../THIRD_PARTY_NOTICES.md).
 */
import {
  fetchBusinessListingsCategories,
  fetchSerpLocationsForCountry,
  type SerpLocationResult,
} from '@/lib/seo/dataforseo'
import {
  DEFAULT_LOCATION_CODE,
  getIsoCountryCode,
  LOCATION_OPTIONS,
} from '@/lib/seo/shared/keyword-locations'
import 'server-only'
import { rankPlaces } from './place-search'
import type { LocalPlaceOption } from './view'

/** A country as local SEO searches it. */
export interface CountryMarket {
  /** ISO 3166-1 alpha-2, lowercase ("us"). */
  iso: string
  location_code: number
  language_code: string
  label: string
}

/** The market of a two-letter country code, or null when search data doesn't cover it. */
export function countryMarket(iso: unknown): CountryMarket | null {
  if (typeof iso !== 'string' || !/^[a-z]{2}$/i.test(iso.trim())) return null
  const code = iso.trim().toLowerCase()
  const option = LOCATION_OPTIONS.find(
    (entry) => getIsoCountryCode(entry.code) === code,
  )
  return option
    ? {
        iso: code,
        location_code: option.code,
        language_code: option.languageCode,
        label: option.label,
      }
    : null
}

/** The market of a provider location code (a tracked business's country), the United States when unknown. */
export function marketOfLocation(locationCode: number): CountryMarket {
  const option =
    LOCATION_OPTIONS.find((entry) => entry.code === locationCode) ??
    LOCATION_OPTIONS.find((entry) => entry.code === DEFAULT_LOCATION_CODE)
  const code = option?.code ?? DEFAULT_LOCATION_CODE
  return {
    iso: getIsoCountryCode(code),
    location_code: code,
    language_code: option?.languageCode ?? 'en',
    label: option?.label ?? 'United States',
  }
}

export interface ReferenceDeps {
  fetchCategories?: typeof fetchBusinessListingsCategories
  fetchLocations?: (iso: string) => Promise<SerpLocationResult[]>
  now?: () => number
}

/** The category list changes rarely and the endpoint takes no parameters: one copy per process, for a week. */
const CATEGORIES_TTL_MS = 7 * 24 * 60 * 60 * 1000
let categoriesCache: {
  rows: Array<{ category: string; business_count: number | null }>
  at: number
} | null = null

/** Google business categories ranked by how many businesses use them, optionally those containing `query`. */
export async function listBusinessCategories(
  query: string | null,
  limit: number,
  deps: ReferenceDeps = {},
): Promise<{
  categories: Array<{ category: string; business_count: number | null }>
  matched: number
}> {
  const now = deps.now?.() ?? Date.now()
  if (!categoriesCache || now - categoriesCache.at > CATEGORIES_TTL_MS) {
    const fetched = await (
      deps.fetchCategories ?? fetchBusinessListingsCategories
    )()
    categoriesCache = {
      rows: fetched.data.map((row) => ({
        category: row.category,
        business_count: row.businessCount,
      })),
      at: now,
    }
  }
  const needle = query?.trim().toLowerCase().replace(/\s+/g, '_') ?? ''
  const matched = needle
    ? categoriesCache.rows.filter((row) =>
        row.category.toLowerCase().includes(needle),
      )
    : categoriesCache.rows
  return {
    categories: matched.slice(0, Math.min(Math.max(Math.floor(limit), 1), 200)),
    matched: matched.length,
  }
}

/** For tests: forget the cached category list. */
export function resetCategoriesCache(): void {
  categoriesCache = null
}

/** The places of a country matching what a person typed, best first. */
export async function searchPlaces(
  iso: string,
  query: string,
  limit: number,
  deps: ReferenceDeps = {},
): Promise<LocalPlaceOption[]> {
  const market = countryMarket(iso)
  if (!market || !query.trim()) return []
  const all = await (deps.fetchLocations ?? fetchSerpLocationsForCountry)(
    market.iso,
  )
  return rankPlaces(
    query,
    all,
    market.iso,
    Math.min(Math.max(Math.floor(limit), 1), 50),
  ).map((place) => ({
    location_name: place.locationName,
    location_code: place.locationCode,
    location_type: place.locationType,
    label: place.displayLabel,
  }))
}
