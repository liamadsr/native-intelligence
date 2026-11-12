/**
 * Sub-country SERP locations (cities, counties, regions) for one country, from
 * DataForSEO's free locations list.
 *
 * Adapted from OpenSEO (MIT, see ../THIRD_PARTY_NOTICES.md).
 */
import 'server-only'

import { dataforseoGet } from '@/lib/seo/dataforseo/core'
import { assertOk } from '@/lib/seo/dataforseo/envelope'
import { formatLocationLabel } from '@/lib/seo/shared/keyword-locations'
import { z } from 'zod'

export interface SerpLocationResult {
  locationCode: number
  locationName: string
  locationType: string
  displayLabel: string
}

// Sub-country granularities users actually target. Deliberately excludes
// Postal Code (~32k extra rows for the US alone), State (national-ish), and
// long-tail types like Airport / University.
const INCLUDED_LOCATION_TYPES = new Set([
  'City',
  'County',
  'Municipality',
  'DMA Region',
  'Region',
])

const locationItemSchema = z.object({
  location_code: z.number(),
  location_name: z.string(),
  location_type: z.string().nullable().optional(),
})

/**
 * Google refreshes geotargets roughly quarterly; a day in memory keeps a
 * long-running process current without refetching on every search.
 */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000

const cache = new Map<
  string,
  { locations: SerpLocationResult[]; fetchedAt: number }
>()

/**
 * Full sub-country location list for one country. `countryCode` is ISO
 * 3166-1 alpha-2 ("us", "gb") — the endpoint rejects country *names* with a
 * task-level Invalid Field error, which assertOk surfaces.
 *
 * The DataForSEO response is ~9.5MB for the US and the endpoint has no search
 * parameter, so the slimmed list (~1.5MB) is kept in this process's memory for
 * a day; only a miss pays the origin fetch. The endpoint is free (cost 0), so
 * it is not metered and has no billing envelope.
 */
export async function fetchSerpLocationsForCountry(
  countryCode: string,
): Promise<SerpLocationResult[]> {
  const iso = countryCode.toLowerCase()
  const hit = cache.get(iso)
  if (hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS) return hit.locations
  return fillFromOrigin(iso)
}

// Coalesce concurrent cold fills: two searches right after one another would
// otherwise both miss the cache and each fetch + parse the ~9.5MB origin
// payload. Entries are deleted on settle so a failed fill isn't sticky.
const inflightFills = new Map<string, Promise<SerpLocationResult[]>>()

function fillFromOrigin(iso: string): Promise<SerpLocationResult[]> {
  const inflight = inflightFills.get(iso)
  if (inflight) return inflight

  const fill = fetchFromDataforseo(iso)
    .then((fresh) => {
      cache.set(iso, { locations: fresh, fetchedAt: Date.now() })
      return fresh
    })
    .finally(() => inflightFills.delete(iso))
  inflightFills.set(iso, fill)
  return fill
}

async function fetchFromDataforseo(iso: string): Promise<SerpLocationResult[]> {
  const response = await dataforseoGet(
    `/v3/serp/google/locations/${encodeURIComponent(iso)}`,
  )
  const task = assertOk(response)
  return (task.result ?? [])
    .map((item) => locationItemSchema.safeParse(item))
    .flatMap((parsed) => (parsed.success ? [parsed.data] : []))
    .filter((item) => INCLUDED_LOCATION_TYPES.has(item.location_type ?? ''))
    .map((item) => ({
      locationCode: item.location_code,
      locationName: item.location_name,
      displayLabel: formatLocationLabel(item.location_name),
      locationType: item.location_type ?? '',
    }))
}
