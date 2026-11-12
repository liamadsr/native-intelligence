/**
 * One Google Maps result list: a keyword searched from one spot (a tracked
 * business's own coordinate, any coordinate, or across a whole town). Paid,
 * live, kept as a snapshot (../lookup-cache.ts) for twelve hours; `refresh`
 * buys it again. When it is read for a tracked business, that business's row
 * is marked and its position given.
 *
 * Adapted from OpenSEO (MIT, see ../THIRD_PARTY_NOTICES.md).
 */
import type { SeoDataRefusal } from '@/lib/seo/access'
import { readLookup, writeLookup } from '@/lib/seo/lookup-cache'
import { paidSeoClient, type SeoWho } from '@/lib/seo/paid'
import type { SupabaseClient } from '@supabase/supabase-js'
import 'server-only'
import type { LocalDeps } from './businesses'
import { formatCoordinate, isLatitude, isLongitude } from './geometry'
import {
  DEFAULT_LOCAL_DEVICE,
  DEFAULT_MAP_RESULTS_DEPTH,
  DEFAULT_MAP_ZOOM,
  LOCAL_DEVICES,
  MAP_RESULTS_MAX_AGE_MS,
  MAX_LOCAL_KEYWORD_LENGTH,
  MAX_MAP_RESULTS_DEPTH,
  type LocalDevice,
} from './limits'
import { getTrackedBusiness } from './queries'
import { countryMarket, marketOfLocation, searchPlaces } from './reference'
import { isTargetRow, mapResultRows, type TargetBusiness } from './shape'
import type { LocalMapResults } from './view'

export const LOCAL_MAP_RESULTS_KIND = 'local_map_results'
const VERSION = 1

export interface MapResultsInput {
  keyword?: unknown
  /** A tracked business: searched from its coordinate, and found in the list. */
  business_id?: string | null
  latitude?: unknown
  longitude?: unknown
  /** Or a whole town, as a person writes it, with `country`. */
  place?: string | null
  country?: string | null
  zoom?: unknown
  device?: unknown
  depth?: unknown
  refresh?: boolean
}

type StoredMap = Omit<
  LocalMapResults,
  'lookup_id' | 'fetched_at' | 'from_cache'
>

export async function readLocalMapResults(
  svc: SupabaseClient,
  who: SeoWho,
  input: MapResultsInput,
  deps: LocalDeps = {},
): Promise<
  | { ok: true; result: LocalMapResults }
  | {
      ok: false
      code: 'NOT_FOUND' | 'INVALID' | 'PLACE_NOT_FOUND'
      message: string
    }
  | SeoDataRefusal
> {
  const keyword =
    typeof input.keyword === 'string'
      ? input.keyword.replace(/\s+/g, ' ').trim().toLowerCase()
      : ''
  if (!keyword)
    return {
      ok: false,
      code: 'INVALID',
      message: 'Give the search, like “emergency plumber”.',
    }
  if (keyword.length > MAX_LOCAL_KEYWORD_LENGTH)
    return {
      ok: false,
      code: 'INVALID',
      message: `Keep the search under ${MAX_LOCAL_KEYWORD_LENGTH} characters.`,
    }
  const device: LocalDevice =
    typeof input.device === 'string' &&
    (LOCAL_DEVICES as readonly string[]).includes(input.device)
      ? (input.device as LocalDevice)
      : DEFAULT_LOCAL_DEVICE
  const depth =
    typeof input.depth === 'number' && Number.isFinite(input.depth)
      ? Math.min(Math.max(Math.round(input.depth), 1), MAX_MAP_RESULTS_DEPTH)
      : DEFAULT_MAP_RESULTS_DEPTH
  const zoom =
    typeof input.zoom === 'number' &&
    Number.isInteger(input.zoom) &&
    input.zoom >= 4 &&
    input.zoom <= 18
      ? input.zoom
      : DEFAULT_MAP_ZOOM

  let target: TargetBusiness | null = null
  let latitude: number | null = null
  let longitude: number | null = null
  let language = 'en'
  let placeText: string | null = null
  let iso = 'us'
  if (input.business_id) {
    const business = await getTrackedBusiness(
      svc,
      who.workspaceId,
      input.business_id,
    )
    if (!business)
      return {
        ok: false,
        code: 'NOT_FOUND',
        message: 'That business isn’t tracked here.',
      }
    target = {
      cid: business.cid,
      place_id: business.place_id,
      title: business.title,
    }
    latitude = isLatitude(input.latitude) ? input.latitude : business.latitude
    longitude = isLongitude(input.longitude)
      ? input.longitude
      : business.longitude
    language = business.language_code
    iso = marketOfLocation(business.location_code).iso
  } else if (isLatitude(input.latitude) && isLongitude(input.longitude)) {
    latitude = input.latitude
    longitude = input.longitude
    const market = countryMarket(input.country ?? 'us')
    language = market?.language_code ?? 'en'
  } else {
    placeText =
      typeof input.place === 'string'
        ? input.place.replace(/\s+/g, ' ').trim().slice(0, 120)
        : null
    if (!placeText)
      return {
        ok: false,
        code: 'INVALID',
        message:
          'Where should the map be searched: a tracked business, a coordinate, or a town?',
      }
    const market = countryMarket(input.country ?? 'us')
    if (!market)
      return {
        ok: false,
        code: 'INVALID',
        message:
          'That country isn’t covered. Give a two-letter country code, like “us”.',
      }
    language = market.language_code
    iso = market.iso
  }

  const point =
    latitude !== null && longitude !== null
      ? `${formatCoordinate(latitude)},${formatCoordinate(longitude)},${zoom}z`
      : null
  const request = {
    v: VERSION,
    keyword,
    at: point ?? `place:${iso}:${placeText?.toLowerCase()}`,
    device,
    depth,
    language_code: language,
  }
  const now = deps.now?.() ?? new Date()
  const finish = (
    body: StoredMap,
    meta: { lookup_id: string | null; fetched_at: string; from_cache: boolean },
  ): LocalMapResults => {
    // The stored rows were marked for the business they were read for; mark again for this one.
    const rows = body.rows.map((row) => ({
      ...row,
      is_target: target ? isTargetRow(row, target) : false,
    }))
    return {
      ...body,
      rows,
      target_position: rows.find((row) => row.is_target)?.position ?? null,
      ...meta,
    }
  }
  if (!input.refresh) {
    const hit = await readLookup<StoredMap>(
      svc,
      who.workspaceId,
      LOCAL_MAP_RESULTS_KIND,
      request,
      { maxAgeMs: MAP_RESULTS_MAX_AGE_MS, now },
    )
    if (hit && Array.isArray(hit.result?.rows))
      return {
        ok: true,
        result: finish(hit.result, {
          lookup_id: hit.id,
          fetched_at: hit.fetched_at,
          from_cache: true,
        }),
      }
  }
  const opened = await paidSeoClient(svc, who, deps)
  if (!opened.ok) return opened
  let placeName: string | null = null
  let placeLabel: string | null = null
  if (!point) {
    const [place] = await searchPlaces(iso, placeText ?? '', 1, deps)
    if (!place)
      return {
        ok: false,
        code: 'PLACE_NOT_FOUND',
        message: `No town called “${placeText}” was found. Try the town’s name alone.`,
      }
    placeName = place.location_name
    placeLabel = place.label
  }
  const items = await opened.client.serp.local({
    keyword,
    locationCoordinate: point ?? undefined,
    locationName: placeName ?? undefined,
    languageCode: language,
    searchType: 'maps',
    device,
    depth,
    searchPlaces: false,
  })
  const rows = mapResultRows(items, target)
  const body: StoredMap = {
    keyword,
    latitude,
    longitude,
    zoom: point ? zoom : null,
    place: placeLabel,
    device,
    rows,
    target_position: rows.find((row) => row.is_target)?.position ?? null,
  }
  const saved = await writeLookup(
    svc,
    { workspaceId: who.workspaceId, userId: who.userId },
    {
      kind: LOCAL_MAP_RESULTS_KIND,
      request,
      result: body,
      label: `${keyword} · ${placeLabel ?? point}`,
    },
    { now },
  )
  return {
    ok: true,
    result: finish(body, {
      lookup_id: saved?.id ?? null,
      fetched_at: saved?.fetched_at ?? now.toISOString(),
      from_cache: false,
    }),
  }
}
