/**
 * Rank grids: creating, changing and deleting the squares a tracked place is
 * scanned over. The one core behind the routes and the tools. Free: nothing
 * here buys anything (a scan does, ./scans.ts).
 *
 *   - A grid belongs to one tracked place, at most MAX_GRIDS_PER_BUSINESS
 *     each. Its centre defaults to the place's own coordinate.
 *   - Keywords are trimmed, lowercased and de-duplicated, at most
 *     MAX_KEYWORDS_PER_GRID; the geometry is checked (./geometry.ts).
 *   - A grid with a scan running is left alone: the scan reads it (changes
 *     and deletes wait for it to finish). A scan keeps the grid as it was
 *     searched, so changing a grid never rewrites an earlier scan.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import 'server-only'
import { gridProblem, isLatitude, isLongitude } from './geometry'
import {
  DEFAULT_GRID_SIZE,
  DEFAULT_LOCAL_DEVICE,
  DEFAULT_RADIUS_KM,
  LOCAL_DEVICES,
  MAX_GRIDS_PER_BUSINESS,
  MAX_KEYWORDS_PER_GRID,
  MAX_LOCAL_KEYWORD_LENGTH,
  type LocalDevice,
} from './limits'
import {
  estimateScan,
  getGrid,
  getLiveScan,
  getTrackedBusiness,
  GRID_FIELDS,
  gridView,
  latestScans,
  listGrids,
  type GridRow,
} from './queries'
import type {
  LocalRankGridDetail,
  LocalRankGridView,
  LocalScanEstimate,
} from './view'

export type GridFailure = {
  ok: false
  code: 'NOT_FOUND' | 'INVALID' | 'LIMIT_REACHED' | 'STILL_RUNNING'
  message: string
}

export interface GridInput {
  keywords?: unknown
  center_latitude?: unknown
  center_longitude?: unknown
  radius_km?: unknown
  size?: unknown
  device?: unknown
  language_code?: unknown
}

/** Keywords as a grid stores them, or why they can't be. */
export function normalizeGridKeywords(
  value: unknown,
): { ok: true; keywords: string[] } | { ok: false; message: string } {
  const list = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[\n,]/)
      : null
  if (!list)
    return {
      ok: false,
      message:
        'Give one to five keywords people search for, like “emergency plumber”.',
    }
  const keywords: string[] = []
  for (const entry of list) {
    if (typeof entry !== 'string') continue
    const keyword = entry.replace(/\s+/g, ' ').trim().toLowerCase()
    if (!keyword) continue
    if (keyword.length > MAX_LOCAL_KEYWORD_LENGTH)
      return {
        ok: false,
        message: `Keep each keyword under ${MAX_LOCAL_KEYWORD_LENGTH} characters.`,
      }
    if (!keywords.includes(keyword)) keywords.push(keyword)
  }
  if (keywords.length === 0)
    return { ok: false, message: 'Give at least one keyword.' }
  if (keywords.length > MAX_KEYWORDS_PER_GRID)
    return {
      ok: false,
      message: `A grid searches at most ${MAX_KEYWORDS_PER_GRID} keywords.`,
    }
  return { ok: true, keywords }
}

function isDevice(value: unknown): value is LocalDevice {
  return (
    typeof value === 'string' &&
    (LOCAL_DEVICES as readonly string[]).includes(value)
  )
}

function languageOf(value: unknown, fallback: string): string | null {
  if (value === undefined || value === null || value === '') return fallback
  return typeof value === 'string' &&
    /^[a-z]{2,3}(-[a-z0-9]{2,4})?$/i.test(value)
    ? value.toLowerCase()
    : null
}

interface ResolvedGrid {
  keywords: string[]
  center_latitude: number
  center_longitude: number
  radius_km: number
  size: number
  device: LocalDevice
  language_code: string
}

function resolveGrid(
  input: GridInput,
  base: ResolvedGrid,
): { ok: true; grid: ResolvedGrid } | GridFailure {
  let keywords = base.keywords
  if (input.keywords !== undefined) {
    const parsed = normalizeGridKeywords(input.keywords)
    if (!parsed.ok)
      return { ok: false, code: 'INVALID', message: parsed.message }
    keywords = parsed.keywords
  }
  const latitude = input.center_latitude ?? base.center_latitude
  const longitude = input.center_longitude ?? base.center_longitude
  if (!isLatitude(latitude) || !isLongitude(longitude))
    return {
      ok: false,
      code: 'INVALID',
      message: 'The grid’s centre isn’t a place on the map.',
    }
  const radius = input.radius_km ?? base.radius_km
  const size = input.size ?? base.size
  const device = input.device ?? base.device
  if (!isDevice(device))
    return {
      ok: false,
      code: 'INVALID',
      message: 'The device is mobile or desktop.',
    }
  const language = languageOf(input.language_code, base.language_code)
  if (!language)
    return {
      ok: false,
      code: 'INVALID',
      message: 'That isn’t a language code (like “en”).',
    }
  const problem = gridProblem({ latitude, longitude }, size, radius)
  if (problem) return { ok: false, code: 'INVALID', message: problem }
  return {
    ok: true,
    grid: {
      keywords,
      center_latitude: latitude,
      center_longitude: longitude,
      radius_km: Math.round((radius as number) * 1000) / 1000,
      size: size as number,
      device,
      language_code: language,
    },
  }
}

/** A new grid for a tracked place. */
export async function createLocalGrid(
  svc: SupabaseClient,
  who: { workspaceId: string; userId: string },
  businessId: string,
  input: GridInput,
): Promise<{ ok: true; grid: LocalRankGridView } | GridFailure> {
  const business = await getTrackedBusiness(svc, who.workspaceId, businessId)
  if (!business)
    return {
      ok: false,
      code: 'NOT_FOUND',
      message: 'That business isn’t tracked here.',
    }
  if (input.keywords === undefined)
    return { ok: false, code: 'INVALID', message: 'Give at least one keyword.' }
  const resolved = resolveGrid(input, {
    keywords: [],
    center_latitude: business.latitude,
    center_longitude: business.longitude,
    radius_km: DEFAULT_RADIUS_KM,
    size: DEFAULT_GRID_SIZE,
    device: DEFAULT_LOCAL_DEVICE,
    language_code: business.language_code,
  })
  if (!resolved.ok) return resolved

  const { count, error: countError } = await svc
    .from('seo_local_grid')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', who.workspaceId)
    .eq('business_id', businessId)
  if (countError)
    throw new Error(`seo local grid count failed: ${countError.message}`)
  if ((count ?? 0) >= MAX_GRIDS_PER_BUSINESS) {
    return {
      ok: false,
      code: 'LIMIT_REACHED',
      message: `A business has at most ${MAX_GRIDS_PER_BUSINESS} rank grids. Change or delete one instead.`,
    }
  }

  const { data, error } = await svc
    .from('seo_local_grid')
    .insert({
      workspace_id: who.workspaceId,
      business_id: businessId,
      created_by: who.userId,
      ...resolved.grid,
    })
    .select(GRID_FIELDS)
    .single()
  if (error || !data)
    throw new Error(`seo local grid insert failed: ${error?.message}`)
  return { ok: true, grid: gridView(data as GridRow) }
}

/** Change a grid's keywords, centre, radius, size, device or language. The next scan uses the new grid. */
export async function updateLocalGrid(
  svc: SupabaseClient,
  who: { workspaceId: string },
  gridId: string,
  input: GridInput,
): Promise<{ ok: true; grid: LocalRankGridView } | GridFailure> {
  const grid = await getGrid(svc, who.workspaceId, gridId)
  if (!grid)
    return {
      ok: false,
      code: 'NOT_FOUND',
      message: 'That rank grid doesn’t exist.',
    }
  if (await getLiveScan(svc, who.workspaceId, gridId)) {
    return {
      ok: false,
      code: 'STILL_RUNNING',
      message:
        'Wait for the grid’s scan to finish, or stop it, before changing the grid.',
    }
  }
  const resolved = resolveGrid(input, grid)
  if (!resolved.ok) return resolved
  const { data, error } = await svc
    .from('seo_local_grid')
    .update({ ...resolved.grid, updated_at: new Date().toISOString() })
    .eq('workspace_id', who.workspaceId)
    .eq('id', gridId)
    .select(GRID_FIELDS)
    .maybeSingle()
  if (error) throw new Error(`seo local grid update failed: ${error.message}`)
  if (!data)
    return {
      ok: false,
      code: 'NOT_FOUND',
      message: 'That rank grid doesn’t exist.',
    }
  return { ok: true, grid: gridView(data as GridRow) }
}

/** Delete a grid with its scans. Refused while a scan runs. */
export async function deleteLocalGrid(
  svc: SupabaseClient,
  who: { workspaceId: string },
  gridId: string,
): Promise<{ ok: true; grid: LocalRankGridView } | GridFailure> {
  const grid = await getGrid(svc, who.workspaceId, gridId)
  if (!grid)
    return {
      ok: false,
      code: 'NOT_FOUND',
      message: 'That rank grid doesn’t exist.',
    }
  if (await getLiveScan(svc, who.workspaceId, gridId)) {
    return {
      ok: false,
      code: 'STILL_RUNNING',
      message: 'Stop the grid’s scan before deleting the grid.',
    }
  }
  const { error } = await svc
    .from('seo_local_grid')
    .delete()
    .eq('workspace_id', who.workspaceId)
    .eq('id', gridId)
  if (error) throw new Error(`seo local grid delete failed: ${error.message}`)
  return { ok: true, grid }
}

/** The workspace's grids (of one place, or all) each with its newest scan. */
export async function listLocalGrids(
  svc: SupabaseClient,
  workspaceId: string,
  businessId?: string | null,
): Promise<LocalRankGridDetail[]> {
  const grids = await listGrids(svc, workspaceId, businessId)
  const latest = await latestScans(
    svc,
    workspaceId,
    grids.map((grid) => grid.id),
  )
  return grids.map((grid) => ({
    grid,
    latest_scan: latest.get(grid.id) ?? null,
  }))
}

export async function getLocalGridDetail(
  svc: SupabaseClient,
  workspaceId: string,
  gridId: string,
): Promise<LocalRankGridDetail | null> {
  const grid = await getGrid(svc, workspaceId, gridId)
  if (!grid) return null
  const latest = await latestScans(svc, workspaceId, [gridId])
  return { grid, latest_scan: latest.get(gridId) ?? null }
}

/**
 * The estimate of a scan, free: of a stored grid (`grid_id`), or of a grid
 * being drawn (keywords count, size, radius, centre). Never buys anything.
 */
export async function estimateLocalScan(
  svc: SupabaseClient,
  workspaceId: string,
  input: GridInput & {
    grid_id?: unknown
    keyword_count?: unknown
    business_id?: unknown
  },
): Promise<{ ok: true; estimate: LocalScanEstimate } | GridFailure> {
  if (typeof input.grid_id === 'string') {
    const grid = await getGrid(svc, workspaceId, input.grid_id)
    if (!grid)
      return {
        ok: false,
        code: 'NOT_FOUND',
        message: 'That rank grid doesn’t exist.',
      }
    return {
      ok: true,
      estimate: estimateScan({ ...grid, keywords: grid.keywords.length }),
    }
  }
  let center = {
    latitude: input.center_latitude,
    longitude: input.center_longitude,
  }
  if (
    (center.latitude === undefined || center.longitude === undefined) &&
    typeof input.business_id === 'string'
  ) {
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
    center = { latitude: business.latitude, longitude: business.longitude }
  }
  let keywordCount: number
  if (input.keywords !== undefined) {
    const parsed = normalizeGridKeywords(input.keywords)
    if (!parsed.ok)
      return { ok: false, code: 'INVALID', message: parsed.message }
    keywordCount = parsed.keywords.length
  } else if (
    typeof input.keyword_count === 'number' &&
    Number.isInteger(input.keyword_count) &&
    input.keyword_count >= 1 &&
    input.keyword_count <= MAX_KEYWORDS_PER_GRID
  ) {
    keywordCount = input.keyword_count
  } else {
    return {
      ok: false,
      code: 'INVALID',
      message: `Give the keywords, or how many (1 to ${MAX_KEYWORDS_PER_GRID}).`,
    }
  }
  const resolved = resolveGrid(
    {
      ...input,
      keywords: undefined,
      center_latitude: center.latitude,
      center_longitude: center.longitude,
    },
    {
      keywords: [],
      center_latitude: 0,
      center_longitude: 0,
      radius_km: DEFAULT_RADIUS_KM,
      size: DEFAULT_GRID_SIZE,
      device: DEFAULT_LOCAL_DEVICE,
      language_code: 'en',
    },
  )
  if (!resolved.ok) return resolved
  return {
    ok: true,
    estimate: estimateScan({ ...resolved.grid, keywords: keywordCount }),
  }
}
