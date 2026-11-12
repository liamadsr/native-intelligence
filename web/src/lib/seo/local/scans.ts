/**
 * Starting, stopping and reading local rank scans: the one core behind the
 * routes and the agent's tools, so both follow the same rules.
 *
 *   - A scan is a person's request. It goes through the SEO area's access
 *     check first (the server has search data, the person is not on the free
 *     plan, a person is actually there: ../access.ts); a turn nobody is in
 *     never starts one. Its searches are metered against the workspace's
 *     monthly ceiling in the person's name.
 *   - One live scan per grid: a second start while one is queued or running
 *     is refused with the live one (a unique index keyed on the grid holds
 *     it). A live scan far past any real scan's length is stuck: the next
 *     start fails it and goes ahead.
 *   - A scan estimated above CONFIRM_ABOVE_USD needs the person's yes, and
 *     the SERVER holds that line, not only the page or the agent: without
 *     `confirmed` it is refused (CONFIRMATION_REQUIRED, with the estimate,
 *     so the caller can show the cost and ask) and nothing is written.
 *   - A caller that showed the person an estimate can also pass it back as
 *     the most it agreed to: a grid that changed since and now costs more is
 *     refused instead of started. An extra guard; it never stands in for the
 *     confirmation.
 *   - Every refusal comes before anything is written: a stuck scan is only
 *     failed and replaced once the new one is confirmed and allowed.
 *   - The start only writes the scan row (the grid and the place as they are
 *     now) and sends the event. The scan runs in the background lane
 *     (src/lib/inngest/seo-local-functions.ts).
 *
 * Adapted from OpenSEO (MIT, see ../THIRD_PARTY_NOTICES.md).
 */
import {
  inngest,
  SEO_LOCAL_SCAN_CANCEL,
  SEO_LOCAL_SCAN_REQUESTED,
} from '@/lib/inngest/client'
import {
  checkSeoDataAccess,
  type SeoDataAccess,
  type SeoDataRefusal,
} from '@/lib/seo/access'
import type { SupabaseClient } from '@supabase/supabase-js'
import 'server-only'
import { gridSpacingKm, localGridZoom } from './geometry'
import {
  COMPETITORS_LISTED,
  CONFIRM_ABOVE_USD,
  STUCK_SCAN_AFTER_MS,
} from './limits'
import {
  estimateScan,
  getGrid,
  getLiveScan,
  getScan,
  getTrackedBusiness,
  listScanPoints,
  SCAN_FIELDS,
  scanView,
  type ScanRow,
} from './queries'
import { failScan, plannedPoints } from './scan-engine'
import { createLocalScanStore } from './scan-store'
import {
  buildGridRows,
  competitorsSeen,
  isLiveScan,
  summarizeCells,
  type LocalGridKeywordResult,
  type LocalScanEstimate,
  type LocalScanResult,
  type LocalScanView,
} from './view'

export type SendEvent = (event: {
  name: string
  data: Record<string, unknown>
}) => Promise<unknown>

export interface ScanDeps {
  send?: SendEvent
  /** The access check (tests stub it). */
  checkAccess?: (who: {
    userId: string | null
    workspaceId?: string | null
    unattended?: boolean
  }) => Promise<SeoDataAccess>
  now?: () => Date
}

const defaultSend: SendEvent = (event) => inngest.send(event)

export type StartScanResult =
  | { ok: true; scan: LocalScanView }
  | { ok: false; code: 'NOT_FOUND'; message: string }
  | {
      ok: false
      code: 'SCAN_ALREADY_RUNNING'
      message: string
      scan: LocalScanView
    }
  | {
      ok: false
      code: 'ESTIMATE_CHANGED'
      message: string
      estimate_usd: number
      estimate: LocalScanEstimate
    }
  | {
      ok: false
      code: 'CONFIRMATION_REQUIRED'
      message: string
      estimate_usd: number
      estimate: LocalScanEstimate
    }
  | { ok: false; code: 'START_FAILED'; message: string }
  | SeoDataRefusal

export interface StartScanOptions {
  /**
   * The person said yes to this scan's cost. Needed when the estimate is
   * above CONFIRM_ABOVE_USD (routes: `confirmed: true`; tools:
   * `confirmed_with_user: true`).
   */
  confirmed?: boolean
  /** The estimate the person was shown: a grid that now costs more is refused. */
  maxEstimateUsd?: number | null
}

/** "$0.29", or four places below a cent. */
function formatUsd(n: number): string {
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`
}

export async function startLocalScan(
  svc: SupabaseClient,
  who: { workspaceId: string; userId: string; unattended?: boolean },
  gridId: string,
  opts: StartScanOptions = {},
  deps: ScanDeps = {},
): Promise<StartScanResult> {
  const now = deps.now?.() ?? new Date()
  const grid = await getGrid(svc, who.workspaceId, gridId)
  if (!grid)
    return {
      ok: false,
      code: 'NOT_FOUND',
      message: 'That rank grid doesn’t exist.',
    }
  const business = await getTrackedBusiness(
    svc,
    who.workspaceId,
    grid.business_id,
  )
  if (!business)
    return {
      ok: false,
      code: 'NOT_FOUND',
      message: 'That rank grid’s business is no longer tracked.',
    }

  const live = await getLiveScan(svc, who.workspaceId, gridId)
  if (live) {
    const since = Date.parse(live.started_at ?? live.created_at)
    if (Number.isFinite(since) && now.getTime() - since < STUCK_SCAN_AFTER_MS) {
      return {
        ok: false,
        code: 'SCAN_ALREADY_RUNNING',
        message:
          'A scan of this grid is still running. It has to finish, or be stopped, before another starts.',
        scan: live,
      }
    }
  }

  // Who may spend comes first: a guest, a free-plan person or a turn nobody
  // is in is refused before any estimate is shown or any yes is asked.
  const access = await (deps.checkAccess ?? checkSeoDataAccess)({
    userId: who.userId,
    workspaceId: who.workspaceId,
    unattended: who.unattended,
  })
  if (!access.ok) return access

  // The grid as it is now, priced the same way the page and the agent price it.
  const detail = estimateScan({
    keywords: grid.keywords.length,
    size: grid.size,
    center_latitude: grid.center_latitude,
    center_longitude: grid.center_longitude,
    radius_km: grid.radius_km,
    device: grid.device,
    language_code: grid.language_code,
  })
  const estimate = detail.estimate_usd
  if (
    typeof opts.maxEstimateUsd === 'number' &&
    Number.isFinite(opts.maxEstimateUsd) &&
    estimate > opts.maxEstimateUsd + 1e-9
  ) {
    return {
      ok: false,
      code: 'ESTIMATE_CHANGED',
      message: `The grid changed since its estimate was shown: a scan is now ${detail.searches} searches and costs about ${formatUsd(estimate)}. Look at the new estimate before scanning.`,
      estimate_usd: estimate,
      estimate: detail,
    }
  }
  if (estimate > CONFIRM_ABOVE_USD && opts.confirmed !== true) {
    return {
      ok: false,
      code: 'CONFIRMATION_REQUIRED',
      message: `This scan is ${detail.searches} searches and costs about ${formatUsd(estimate)} from the workspace’s search data budget. Confirm to start it.`,
      estimate_usd: estimate,
      estimate: detail,
    }
  }

  // Allowed and confirmed: only now is a stuck scan ended to make way.
  if (live) {
    await failScan(
      createLocalScanStore(svc),
      live.id,
      'STUCK',
      'The scan stopped answering and was replaced by a new one.',
    )
  }

  const spacing = gridSpacingKm(grid.radius_km, grid.size)
  const { data, error } = await svc
    .from('seo_local_scan')
    .insert({
      workspace_id: who.workspaceId,
      grid_id: grid.id,
      business_id: business.id,
      started_by: who.userId,
      keywords: grid.keywords,
      size: grid.size,
      radius_km: grid.radius_km,
      spacing_km: spacing,
      center_latitude: grid.center_latitude,
      center_longitude: grid.center_longitude,
      zoom: localGridZoom(spacing, grid.center_latitude),
      device: grid.device,
      language_code: grid.language_code,
      target_title: business.title,
      target_cid: business.cid,
      target_place_id: business.place_id,
      points_total: grid.size * grid.size * grid.keywords.length,
      estimate_usd: estimate,
    })
    .select(SCAN_FIELDS)
    .single()
  if (error || !data) {
    // The one-live-scan index: another start won the race.
    if (error?.code === '23505') {
      const winner = await getLiveScan(svc, who.workspaceId, gridId)
      if (winner)
        return {
          ok: false,
          code: 'SCAN_ALREADY_RUNNING',
          message: 'A scan of this grid is already running.',
          scan: winner,
        }
    }
    console.error('[seo-local] start: insert failed', error?.message)
    return {
      ok: false,
      code: 'START_FAILED',
      message: 'Could not start the scan just now. Try again in a moment.',
    }
  }
  const scan = scanView(data as ScanRow)

  try {
    await (deps.send ?? defaultSend)({
      name: SEO_LOCAL_SCAN_REQUESTED,
      data: { scanId: scan.id, workspaceId: who.workspaceId },
    })
  } catch (err) {
    // The row exists but nothing will ever run it: say so on the row, so it never sits at "queued".
    console.error('[seo-local] start: event send failed', err)
    await svc
      .from('seo_local_scan')
      .update({
        status: 'failed',
        error_code: 'START_FAILED',
        error_detail:
          'The scan could not be started. Nothing was bought. Run it again.',
        completed_at: now.toISOString(),
      })
      .eq('id', scan.id)
      .eq('workspace_id', who.workspaceId)
    return {
      ok: false,
      code: 'START_FAILED',
      message: 'Could not start the scan just now. Try again in a moment.',
    }
  }
  return { ok: true, scan }
}

export type CancelScanResult =
  | { ok: true; scan: LocalScanView }
  | { ok: false; code: 'NOT_FOUND' | 'NOT_RUNNING'; message: string }

/** Stop a queued or running scan. Points it already read stay; searches already sent may still have been charged. */
export async function cancelLocalScan(
  svc: SupabaseClient,
  who: { workspaceId: string },
  scanId: string,
  deps: Pick<ScanDeps, 'send'> = {},
): Promise<CancelScanResult> {
  const scan = await getScan(svc, who.workspaceId, scanId)
  if (!scan)
    return { ok: false, code: 'NOT_FOUND', message: 'That scan doesn’t exist.' }
  if (!isLiveScan(scan.status))
    return {
      ok: false,
      code: 'NOT_RUNNING',
      message: 'That scan already ended.',
    }

  // The status first: it is what a step in flight reads, and what stops the next one.
  const now = new Date().toISOString()
  const { error } = await svc
    .from('seo_local_scan')
    .update({ status: 'canceled', completed_at: now, updated_at: now })
    .eq('id', scanId)
    .eq('workspace_id', who.workspaceId)
    .in('status', ['queued', 'running'])
  if (error) throw new Error(`seo local scan cancel failed: ${error.message}`)
  const { error: pointError } = await svc
    .from('seo_local_scan_point')
    .update({
      status: 'not_collected',
      error: 'The scan was stopped before this search was read.',
      collected_at: now,
    })
    .eq('workspace_id', who.workspaceId)
    .eq('scan_id', scanId)
    .eq('status', 'pending')
  // The points are only labels; the status above already stopped the scan.
  if (pointError)
    console.error(
      '[seo-local] cancel: points update failed',
      pointError.message,
    )

  try {
    await (deps.send ?? defaultSend)({
      name: SEO_LOCAL_SCAN_CANCEL,
      data: { scanId },
    })
  } catch (err) {
    // The status alone already stops the scan at its next step.
    console.error('[seo-local] cancel: event send failed', err)
  }
  const settled = await getScan(svc, who.workspaceId, scanId)
  return { ok: true, scan: settled ?? { ...scan, status: 'canceled' } }
}

/**
 * A scan's result: one square per keyword (every planned point gets a cell),
 * the summary numbers per keyword and over all of them, and the businesses
 * seen most. Free. Null when the scan is not this workspace's.
 */
export async function getLocalScanResult(
  svc: SupabaseClient,
  workspaceId: string,
  scanId: string,
): Promise<LocalScanResult | null> {
  const scan = await getScan(svc, workspaceId, scanId)
  if (!scan) return null
  return buildScanResult(scan, await listScanPoints(svc, workspaceId, scanId))
}

/** Shapes a scan and its stored points into the result (pure; exposed for tests). */
export function buildScanResult(
  scan: LocalScanView,
  points: Awaited<ReturnType<typeof listScanPoints>>,
): LocalScanResult {
  const planned = plannedPoints({
    centerLatitude: scan.center_latitude,
    centerLongitude: scan.center_longitude,
    size: scan.size,
    radiusKm: scan.radius_km,
  })
  const live = isLiveScan(scan.status)
  const keywords: LocalGridKeywordResult[] = scan.keywords.map(
    (keyword, index) => {
      const mine = points.filter((point) => point.keyword_index === index)
      const rows = buildGridRows(scan.size, planned, mine, live)
      return { keyword, rows, summary: summarizeCells(rows.flat()) }
    },
  )
  return {
    scan,
    size: scan.size,
    keywords,
    summary: summarizeCells(keywords.flatMap((entry) => entry.rows.flat())),
    competitors: competitorsSeen(points, COMPETITORS_LISTED),
  }
}

/** The estimate of a grid's next scan (free maths), with whether the agent must ask first. */
export { estimateScan }
