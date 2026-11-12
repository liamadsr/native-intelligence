/**
 * What the product reads about local SEO (the SEO page and the tools):
 * tracked places, rank grids, scans and a scan's points. Every read is
 * scoped by workspace_id in the query: the caller's client is the service
 * role's, so the filter is the fence. Free: nothing here buys anything.
 */
import { dataforseoPricing } from '@/lib/seo/dataforseo'
import type { SupabaseClient } from '@supabase/supabase-js'
import 'server-only'
import {
  buildLocalGrid,
  gridSpacingKm,
  localGridZoom,
  mapsCoordinate,
} from './geometry'
import { CONFIRM_ABOVE_USD, LOCAL_RANK_DEPTH, type LocalDevice } from './limits'
import {
  roundUsd,
  type LocalPointCompetitor,
  type LocalPointStatus,
  type LocalRankGridView,
  type LocalScanEstimate,
  type LocalScanPointRow,
  type LocalScanStatus,
  type LocalScanView,
  type TrackedBusinessView,
} from './view'

// ---------------------------------------------------------------------------
// Businesses
// ---------------------------------------------------------------------------

export const BUSINESS_FIELDS =
  'id, title, cid, place_id, address, latitude, longitude, category, additional_categories, phone, website, domain, rating, review_count, is_claimed, location_code, language_code, profile_fetched_at, added_by, created_at'

export interface BusinessRow {
  id: string
  title: string
  cid: string | null
  place_id: string | null
  address: string | null
  latitude: number
  longitude: number
  category: string | null
  additional_categories: unknown
  phone: string | null
  website: string | null
  domain: string | null
  rating: number | string | null
  review_count: number | null
  is_claimed: boolean | null
  location_code: number
  language_code: string
  profile_fetched_at: string | null
  added_by: string | null
  created_at: string
}

function numberOrNull(
  value: number | string | null | undefined,
): number | null {
  if (value === null || value === undefined) return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

export function businessView(row: BusinessRow): TrackedBusinessView {
  return {
    id: row.id,
    title: row.title,
    cid: row.cid,
    place_id: row.place_id,
    address: row.address,
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    category: row.category,
    additional_categories: Array.isArray(row.additional_categories)
      ? row.additional_categories.filter(
          (entry): entry is string => typeof entry === 'string',
        )
      : [],
    phone: row.phone,
    website: row.website,
    domain: row.domain,
    rating: numberOrNull(row.rating),
    review_count: row.review_count,
    is_claimed: row.is_claimed,
    location_code: row.location_code,
    language_code: row.language_code,
    profile_fetched_at: row.profile_fetched_at,
    added_by: row.added_by,
    created_at: row.created_at,
  }
}

/** The workspace's tracked places, oldest first (the order they were added). At most the cap, so one page. */
export async function listTrackedBusinesses(
  svc: SupabaseClient,
  workspaceId: string,
): Promise<TrackedBusinessView[]> {
  const { data, error } = await svc
    .from('seo_local_business')
    .select(BUSINESS_FIELDS)
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: true })
    .limit(200)
  if (error) throw new Error(`seo local business list failed: ${error.message}`)
  return ((data ?? []) as BusinessRow[]).map(businessView)
}

export async function getTrackedBusiness(
  svc: SupabaseClient,
  workspaceId: string,
  id: string,
): Promise<TrackedBusinessView | null> {
  const { data, error } = await svc
    .from('seo_local_business')
    .select(BUSINESS_FIELDS)
    .eq('workspace_id', workspaceId)
    .eq('id', id)
    .maybeSingle()
  if (error) throw new Error(`seo local business read failed: ${error.message}`)
  return data ? businessView(data as BusinessRow) : null
}

// ---------------------------------------------------------------------------
// Grids
// ---------------------------------------------------------------------------

export const GRID_FIELDS =
  'id, business_id, keywords, center_latitude, center_longitude, radius_km, size, device, language_code, created_by, created_at, updated_at'

export interface GridRow {
  id: string
  business_id: string
  keywords: string[] | null
  center_latitude: number
  center_longitude: number
  radius_km: number | string
  size: number
  device: LocalDevice
  language_code: string
  created_by: string | null
  created_at: string
  updated_at: string
}

/** What one scan of a grid costs by the price list: one queued Maps search per point per keyword. Free maths. */
export function estimateScan(grid: {
  keywords: number
  size: number
  center_latitude: number
  center_longitude: number
  radius_km: number
  device?: LocalDevice
  language_code?: string
}): LocalScanEstimate {
  const points = grid.size * grid.size
  const spacing = gridSpacingKm(grid.radius_km, grid.size)
  const zoom = localGridZoom(spacing, grid.center_latitude)
  const coordinates = buildLocalGrid(
    { latitude: grid.center_latitude, longitude: grid.center_longitude },
    grid.size,
    grid.radius_km,
  ).map((point) => mapsCoordinate(point, zoom))
  const perKeyword = dataforseoPricing.serp.localTaskPost({
    keyword: '',
    locationCoordinates: coordinates,
    languageCode: grid.language_code ?? 'en',
    device: grid.device ?? 'mobile',
    depth: LOCAL_RANK_DEPTH,
  })
  const estimate = roundUsd(perKeyword * Math.max(grid.keywords, 0))
  return {
    keywords: grid.keywords,
    points,
    searches: points * grid.keywords,
    estimate_usd: estimate,
    needs_confirmation: estimate > CONFIRM_ABOVE_USD,
  }
}

export function gridView(row: GridRow): LocalRankGridView {
  const radius = Number(row.radius_km)
  const keywords = row.keywords ?? []
  return {
    id: row.id,
    business_id: row.business_id,
    keywords,
    center_latitude: Number(row.center_latitude),
    center_longitude: Number(row.center_longitude),
    radius_km: radius,
    size: row.size,
    spacing_km: gridSpacingKm(radius, row.size),
    device: row.device,
    language_code: row.language_code,
    estimate_usd: estimateScan({
      keywords: keywords.length,
      size: row.size,
      center_latitude: Number(row.center_latitude),
      center_longitude: Number(row.center_longitude),
      radius_km: radius,
      device: row.device,
      language_code: row.language_code,
    }).estimate_usd,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

/** The workspace's grids, of one business or of all, oldest first. */
export async function listGrids(
  svc: SupabaseClient,
  workspaceId: string,
  businessId?: string | null,
): Promise<LocalRankGridView[]> {
  let query = svc
    .from('seo_local_grid')
    .select(GRID_FIELDS)
    .eq('workspace_id', workspaceId)
  if (businessId) query = query.eq('business_id', businessId)
  const { data, error } = await query
    .order('created_at', { ascending: true })
    .limit(500)
  if (error) throw new Error(`seo local grid list failed: ${error.message}`)
  return ((data ?? []) as GridRow[]).map(gridView)
}

export async function getGrid(
  svc: SupabaseClient,
  workspaceId: string,
  id: string,
): Promise<LocalRankGridView | null> {
  const { data, error } = await svc
    .from('seo_local_grid')
    .select(GRID_FIELDS)
    .eq('workspace_id', workspaceId)
    .eq('id', id)
    .maybeSingle()
  if (error) throw new Error(`seo local grid read failed: ${error.message}`)
  return data ? gridView(data as GridRow) : null
}

// ---------------------------------------------------------------------------
// Scans
// ---------------------------------------------------------------------------

export const SCAN_FIELDS =
  'id, grid_id, business_id, status, keywords, size, radius_km, spacing_km, center_latitude, center_longitude, zoom, device, points_total, points_collected, points_found, top3, top10, average_position, estimate_usd, cost_usd, error_code, error_detail, started_by, created_at, started_at, completed_at'

export interface ScanRow {
  id: string
  grid_id: string
  business_id: string
  status: LocalScanStatus
  keywords: string[] | null
  size: number
  radius_km: number | string
  spacing_km: number | string
  center_latitude: number
  center_longitude: number
  zoom: number
  device: LocalDevice
  points_total: number
  points_collected: number
  points_found: number
  top3: number | null
  top10: number | null
  average_position: number | string | null
  estimate_usd: number | string
  cost_usd: number | string
  error_code: string | null
  error_detail: string | null
  started_by: string | null
  created_at: string
  started_at: string | null
  completed_at: string | null
}

export function scanView(row: ScanRow): LocalScanView {
  const done = row.status === 'completed' && row.top3 !== null
  return {
    id: row.id,
    grid_id: row.grid_id,
    business_id: row.business_id,
    status: row.status,
    keywords: row.keywords ?? [],
    size: row.size,
    radius_km: Number(row.radius_km),
    spacing_km: Number(row.spacing_km),
    center_latitude: Number(row.center_latitude),
    center_longitude: Number(row.center_longitude),
    zoom: row.zoom,
    device: row.device,
    points_total: row.points_total,
    points_collected: row.points_collected,
    points_found: row.points_found,
    estimate_usd: numberOrNull(row.estimate_usd) ?? 0,
    cost_usd: numberOrNull(row.cost_usd) ?? 0,
    error:
      row.status === 'failed'
        ? (row.error_detail ?? 'The scan stopped unexpectedly. Run it again.')
        : null,
    summary: done
      ? {
          points_total: row.points_total,
          points_collected: row.points_collected,
          points_found: row.points_found,
          top3: row.top3 ?? 0,
          top10: row.top10 ?? 0,
          top3_percent:
            row.points_collected > 0
              ? Math.round(((row.top3 ?? 0) / row.points_collected) * 100)
              : null,
          average_position: numberOrNull(row.average_position),
        }
      : null,
    started_by: row.started_by,
    created_at: row.created_at,
    started_at: row.started_at,
    completed_at: row.completed_at,
  }
}

export const SCAN_LIST_LIMIT = 50

/** A grid's scans, newest first. */
export async function listScans(
  svc: SupabaseClient,
  workspaceId: string,
  gridId: string,
  limit = 20,
): Promise<LocalScanView[]> {
  const { data, error } = await svc
    .from('seo_local_scan')
    .select(SCAN_FIELDS)
    .eq('workspace_id', workspaceId)
    .eq('grid_id', gridId)
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(limit, 1), SCAN_LIST_LIMIT))
  if (error) throw new Error(`seo local scan list failed: ${error.message}`)
  return ((data ?? []) as ScanRow[]).map(scanView)
}

export async function getScan(
  svc: SupabaseClient,
  workspaceId: string,
  id: string,
): Promise<LocalScanView | null> {
  const { data, error } = await svc
    .from('seo_local_scan')
    .select(SCAN_FIELDS)
    .eq('workspace_id', workspaceId)
    .eq('id', id)
    .maybeSingle()
  if (error) throw new Error(`seo local scan read failed: ${error.message}`)
  return data ? scanView(data as ScanRow) : null
}

/** The grid's queued or running scan, if any. */
export async function getLiveScan(
  svc: SupabaseClient,
  workspaceId: string,
  gridId: string,
): Promise<LocalScanView | null> {
  const { data, error } = await svc
    .from('seo_local_scan')
    .select(SCAN_FIELDS)
    .eq('workspace_id', workspaceId)
    .eq('grid_id', gridId)
    .in('status', ['queued', 'running'])
    .order('created_at', { ascending: false })
    .limit(1)
  if (error) throw new Error(`seo local scan read failed: ${error.message}`)
  const row = ((data ?? []) as ScanRow[])[0]
  return row ? scanView(row) : null
}

/** Whether any grid of a business has a queued or running scan. */
export async function businessHasLiveScan(
  svc: SupabaseClient,
  workspaceId: string,
  businessId: string,
): Promise<boolean> {
  const { data, error } = await svc
    .from('seo_local_scan')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('business_id', businessId)
    .in('status', ['queued', 'running'])
    .limit(1)
  if (error) throw new Error(`seo local scan read failed: ${error.message}`)
  return (data ?? []).length > 0
}

/** The newest scan of each of these grids (completed or not), by grid id. */
export async function latestScans(
  svc: SupabaseClient,
  workspaceId: string,
  gridIds: string[],
): Promise<Map<string, LocalScanView>> {
  const out = new Map<string, LocalScanView>()
  if (gridIds.length === 0) return out
  // One read: a few recent scans per grid at most, newest first.
  const { data, error } = await svc
    .from('seo_local_scan')
    .select(SCAN_FIELDS)
    .eq('workspace_id', workspaceId)
    .in('grid_id', gridIds)
    .order('created_at', { ascending: false })
    .limit(Math.min(gridIds.length * 10, 1000))
  if (error) throw new Error(`seo local scan read failed: ${error.message}`)
  for (const row of (data ?? []) as ScanRow[])
    if (!out.has(row.grid_id)) out.set(row.grid_id, scanView(row))
  return out
}

interface PointDbRow {
  keyword: string
  keyword_index: number
  grid_row: number
  grid_col: number
  latitude: number
  longitude: number
  status: LocalPointStatus
  position: number | null
  results_count: number | null
  competitors: unknown
}

const READ_PAGE = 1000

function competitorsOf(value: unknown): LocalPointCompetitor[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const e = entry as Record<string, unknown>
    if (typeof e.title !== 'string' || typeof e.position !== 'number') return []
    return [
      {
        position: e.position,
        title: e.title,
        cid: typeof e.cid === 'string' ? e.cid : null,
        place_id: typeof e.place_id === 'string' ? e.place_id : null,
        rating: typeof e.rating === 'number' ? e.rating : null,
        review_count:
          typeof e.review_count === 'number' ? e.review_count : null,
        is_target: e.is_target === true,
      },
    ]
  })
}

/** Every point of a scan (at most 7x7 times the keyword cap), paged past PostgREST's 1000-row answer. */
export async function listScanPoints(
  svc: SupabaseClient,
  workspaceId: string,
  scanId: string,
): Promise<Array<LocalScanPointRow & { keyword_index: number }>> {
  const out: Array<LocalScanPointRow & { keyword_index: number }> = []
  for (let from = 0; ; from += READ_PAGE) {
    const { data, error } = await svc
      .from('seo_local_scan_point')
      .select(
        'keyword, keyword_index, grid_row, grid_col, latitude, longitude, status, position, results_count, competitors',
      )
      .eq('workspace_id', workspaceId)
      .eq('scan_id', scanId)
      .order('keyword_index')
      .order('grid_row')
      .order('grid_col')
      .range(from, from + READ_PAGE - 1)
    if (error) throw new Error(`seo local scan points failed: ${error.message}`)
    const rows = (data ?? []) as PointDbRow[]
    for (const row of rows) {
      out.push({
        keyword: row.keyword,
        keyword_index: row.keyword_index,
        row: row.grid_row,
        col: row.grid_col,
        latitude: Number(row.latitude),
        longitude: Number(row.longitude),
        status: row.status,
        position: row.position,
        results_count: row.results_count,
        competitors: competitorsOf(row.competitors),
      })
    }
    if (rows.length < READ_PAGE) break
  }
  return out
}
