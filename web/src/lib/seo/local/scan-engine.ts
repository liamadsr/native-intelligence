/**
 * The local rank scan engine: what each step of the background lane
 * (src/lib/inngest/seo-local-functions.ts) does. It talks to the database
 * only through a LocalScanStore (./scan-store.ts in production, an in-memory
 * one in tests) and to the provider only through the deps it is handed, so
 * every step can be run against stubs.
 *
 *   claimScan     queued -> running (a compare-and-set; a redelivered
 *                 attempt finds its own row running and carries on).
 *   postKeyword   ONE paid post per keyword: one queued Maps search per grid
 *                 point, recorded with what the provider charged for it (the
 *                 metered client's billing, ./scan-client.ts), so the scan's
 *                 cost_usd is the real charge, not the price list's estimate.
 *                 A marker is written before the provider is called,
 *                 so a retried step never posts again: it reads back the
 *                 task ids the first attempt recorded, or, when that attempt
 *                 died between paying and recording, writes the keyword's
 *                 points as not collected instead of buying them twice. Each
 *                 point is written pending with its task id (ids derived from
 *                 scan + keyword + point, so a retry rewrites the same rows).
 *   collectRound  one free read of every point still pending. A point that
 *                 came back is written with the business's position, how
 *                 many businesses were listed and the first few; a search
 *                 the provider failed is written not collected; one still
 *                 running stays pending for the next round. Only pending
 *                 points change, so a retried round writes nothing twice.
 *   finalizeScan  whatever is still pending is written not collected, and
 *                 the summary numbers go on the scan row. Nothing spins: the
 *                 lane's rounds are a fixed list of waits.
 *   failScan      the scan ends failed with words for the person.
 *
 * A provider refusal that no retry fixes (the monthly spend limit, a missing
 * or refused key, an empty provider balance) comes back as a ScanFailure, not
 * a throw, so the lane writes it once instead of retrying it.
 *
 * Adapted from OpenSEO (MIT, see ../THIRD_PARTY_NOTICES.md).
 */
import {
  dataforseoPricing,
  type DataforseoClient,
  type LocalSerpTaskOutcome,
} from '@/lib/seo/dataforseo'
import { isSeoError } from '@/lib/seo/errors'
import { seoErrorMessage } from '@/lib/seo/http'
import { buildLocalGrid, mapsCoordinate } from './geometry'
import { scanPointId, scanPostKey } from './ids'
import { LOCAL_RANK_DEPTH, type LocalDevice } from './limits'
import { pointOutcome, type TargetBusiness } from './shape'
import {
  cellStatus,
  summarizeCells,
  type LocalPointCompetitor,
  type LocalScanStatus,
} from './view'

/** The scan as the engine reads it: the grid and the place as they were when it started. */
export interface LocalScanRecord {
  id: string
  workspaceId: string
  status: LocalScanStatus
  keywords: string[]
  size: number
  radiusKm: number
  centerLatitude: number
  centerLongitude: number
  zoom: number
  device: LocalDevice
  languageCode: string
  target: TargetBusiness
  startedBy: string | null
}

export type PostBegin =
  | { state: 'go' }
  | { state: 'posted'; tasks: Array<string | null> }
  | { state: 'unknown' }
  | { state: 'inactive' }

/** A point written when its keyword is posted. */
export interface PointSeed {
  id: string
  scanId: string
  workspaceId: string
  keyword: string
  keywordIndex: number
  row: number
  col: number
  latitude: number
  longitude: number
  taskId: string | null
  /** pending (its search is out) or not_collected (refused, or its post's receipt was lost). */
  status: 'pending' | 'not_collected'
  error: string | null
}

export interface PendingPoint {
  id: string
  taskId: string | null
}

export interface PointSettlement {
  id: string
  status: 'collected' | 'not_collected'
  position: number | null
  results_count: number | null
  competitors: LocalPointCompetitor[]
  error: string | null
}

export interface StoredPointState {
  keywordIndex: number
  status: 'pending' | 'collected' | 'not_collected'
  position: number | null
}

export interface ScanFinish {
  status: 'completed' | 'failed'
  pointsTotal: number
  pointsCollected: number
  pointsFound: number
  top3: number | null
  top10: number | null
  averagePosition: number | null
  errorCode: string | null
  errorDetail: string | null
}

export interface LocalScanStore {
  getScan(scanId: string): Promise<LocalScanRecord | null>
  /** queued|running -> running; true when this attempt owns the scan. */
  claimScan(scanId: string): Promise<boolean>
  beginPost(scanId: string, key: string): Promise<PostBegin>
  recordPost(
    scanId: string,
    key: string,
    tasks: Array<string | null>,
    costUsd: number,
  ): Promise<void>
  /** Insert points that do not exist yet; existing rows are left as they are. */
  seedPoints(rows: PointSeed[]): Promise<void>
  listPendingPoints(scanId: string): Promise<PendingPoint[]>
  /** Write read points, pending ones only. Returns how many changed. */
  settlePoints(scanId: string, rows: PointSettlement[]): Promise<number>
  /** Every still-pending point -> not_collected. Returns how many. */
  markUncollected(scanId: string, error: string): Promise<number>
  listPointStates(scanId: string): Promise<StoredPointState[]>
  /** Write the scan's end, only while it is queued or running. True when written. */
  finishScan(scanId: string, finish: ScanFinish): Promise<boolean>
}

export interface ScanFailure {
  failure: { code: string; message: string }
}

export function isScanFailure(value: unknown): value is ScanFailure {
  return !!value && typeof value === 'object' && 'failure' in value
}

export type PostOutcome =
  | { skipped: 'inactive' }
  | { posted: number; refused: number; reused: boolean }
  | { lost: number }
  | { notSent: number; reason: string }
  | ScanFailure

const NOT_ACCEPTED = 'The search provider did not accept this search.'
const RECEIPT_LOST =
  'This search may have been sent, but its receipt was lost, so it was not sent again.'
const SEARCH_FAILED = 'The search provider could not complete this search.'
const NEVER_CAME_BACK = 'This search did not come back in time.'
const SCAN_STOPPED = 'The scan stopped before this search was read.'

/** Provider refusals no retry fixes: the scan ends with the provider's own words for the person. */
const STOPPING_CODES = new Set([
  'SPEND_LIMIT_REACHED',
  'SEO_NOT_CONFIGURED',
  'PROVIDER_AUTH_FAILED',
  'INSUFFICIENT_PROVIDER_BALANCE',
])

export function plannedPoints(
  scan: Pick<
    LocalScanRecord,
    'centerLatitude' | 'centerLongitude' | 'size' | 'radiusKm'
  >,
) {
  return buildLocalGrid(
    { latitude: scan.centerLatitude, longitude: scan.centerLongitude },
    scan.size,
    scan.radiusKm,
  )
}

function seeds(
  scan: LocalScanRecord,
  keywordIndex: number,
  tasks: Array<string | null> | null,
  missing: string,
): PointSeed[] {
  const keyword = scan.keywords[keywordIndex]
  return plannedPoints(scan).map((point, index) => {
    const taskId = tasks?.[index] ?? null
    return {
      id: scanPointId(scan.id, keyword, point.row, point.col),
      scanId: scan.id,
      workspaceId: scan.workspaceId,
      keyword,
      keywordIndex,
      row: point.row,
      col: point.col,
      latitude: point.latitude,
      longitude: point.longitude,
      taskId,
      status: taskId ? 'pending' : 'not_collected',
      error: taskId ? null : missing,
    }
  })
}

export async function claimScan(
  store: LocalScanStore,
  scanId: string,
): Promise<LocalScanRecord | null> {
  if (!(await store.claimScan(scanId))) return null
  return store.getScan(scanId)
}

/**
 * The client a scan posts through: the workspace's metered client, and
 * `billedUsd`, the running total of what the provider charged for the calls
 * made through it (./scan-client.ts). Without `billedUsd` (a stub) the post
 * is recorded at the price list's estimate.
 */
export type ScanPostClient = Pick<DataforseoClient, 'serp'> & {
  billedUsd?: () => number
}

/**
 * Post one keyword's searches, once. `client` is the workspace's metered
 * client (the meter checks the monthly ceiling and writes the ledger).
 */
export async function postKeyword(
  store: LocalScanStore,
  scanId: string,
  keywordIndex: number,
  client: ScanPostClient,
): Promise<PostOutcome> {
  const scan = await store.getScan(scanId)
  if (
    !scan ||
    scan.status !== 'running' ||
    keywordIndex >= scan.keywords.length
  )
    return { skipped: 'inactive' }
  const key = scanPostKey(keywordIndex)
  const begin = await store.beginPost(scanId, key)
  if (begin.state === 'inactive') return { skipped: 'inactive' }
  if (begin.state === 'posted') {
    // A retry after the post was recorded: write the points again (a no-op where they exist).
    const rows = seeds(scan, keywordIndex, begin.tasks, NOT_ACCEPTED)
    await store.seedPoints(rows)
    return {
      posted: rows.filter((row) => row.taskId).length,
      refused: rows.filter((row) => !row.taskId).length,
      reused: true,
    }
  }
  if (begin.state === 'unknown') {
    // An attempt posted and died before recording: never buy the same searches twice.
    const rows = seeds(scan, keywordIndex, null, RECEIPT_LOST)
    await store.seedPoints(rows)
    return { lost: rows.length }
  }

  const coordinates = plannedPoints(scan).map((point) =>
    mapsCoordinate(point, scan.zoom),
  )
  const input = {
    keyword: scan.keywords[keywordIndex],
    locationCoordinates: coordinates,
    languageCode: scan.languageCode,
    device: scan.device,
    depth: LOCAL_RANK_DEPTH,
  }
  const billedBefore = client.billedUsd?.() ?? 0
  const charged = () =>
    client.billedUsd ? Math.max(0, client.billedUsd() - billedBefore) : null
  let tasks: Array<string | null>
  try {
    tasks = await client.serp.localTaskPost(input)
  } catch (err) {
    // Nothing usable came back. Whatever the provider charged, the meter has
    // written to the ledger, and the scan records the same charge (0 when it
    // could not be read) with the post as empty, and moves on.
    await store.recordPost(scanId, key, [], charged() ?? 0)
    const { code, message } = seoErrorMessage(err)
    if (
      !isSeoError(err) ||
      (code !== 'SPEND_LIMIT_REACHED' && code !== 'VALIDATION_ERROR')
    ) {
      console.error('[seo-local] post failed', {
        scanId,
        keywordIndex,
        code,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    const rows = seeds(scan, keywordIndex, null, NOT_ACCEPTED)
    await store.seedPoints(rows)
    if (STOPPING_CODES.has(code)) return { failure: { code, message } }
    return { notSent: rows.length, reason: message }
  }
  const accepted = tasks.filter(
    (task): task is string => typeof task === 'string' && task.length > 0,
  )
  // What the provider charged; the price list only when that can't be read.
  const cost =
    charged() ??
    (accepted.length > 0
      ? dataforseoPricing.serp.localTaskPost({
          ...input,
          locationCoordinates: accepted,
        })
      : 0)
  await store.recordPost(scanId, key, tasks, cost)
  const rows = seeds(scan, keywordIndex, tasks, NOT_ACCEPTED)
  await store.seedPoints(rows)
  return {
    posted: accepted.length,
    refused: rows.length - accepted.length,
    reused: false,
  }
}

export type CollectOutcome =
  | { inactive: true }
  | { pending: number; settled: number }

export interface CollectDeps {
  /** The free read of one queued Maps search. */
  fetchResult: (taskId: string) => Promise<LocalSerpTaskOutcome>
  /** Reads at once (default 8). */
  parallel?: number
}

async function inBatches<T, R>(
  items: readonly T[],
  size: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = []
  for (let i = 0; i < items.length; i += size)
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))))
  return out
}

/** One free read of every point still pending. */
export async function collectRound(
  store: LocalScanStore,
  scanId: string,
  deps: CollectDeps,
): Promise<CollectOutcome> {
  const scan = await store.getScan(scanId)
  if (!scan || scan.status !== 'running') return { inactive: true }
  const pending = await store.listPendingPoints(scanId)
  const outcomes = await inBatches(
    pending,
    Math.max(1, deps.parallel ?? 8),
    async (point): Promise<PointSettlement | null> => {
      if (!point.taskId)
        return {
          id: point.id,
          status: 'not_collected',
          position: null,
          results_count: null,
          competitors: [],
          error: NOT_ACCEPTED,
        }
      let outcome: LocalSerpTaskOutcome
      try {
        outcome = await deps.fetchResult(point.taskId)
      } catch (err) {
        // The read failed, not the search: the point stays pending for the next round.
        console.warn('[seo-local] collect read failed', {
          scanId,
          error: err instanceof Error ? err.message : String(err),
        })
        return null
      }
      if (outcome.status === 'pending') return null
      if (outcome.status === 'failed') {
        console.warn('[seo-local] search failed', {
          scanId,
          message: outcome.message,
        })
        return {
          id: point.id,
          status: 'not_collected',
          position: null,
          results_count: null,
          competitors: [],
          error: SEARCH_FAILED,
        }
      }
      const read = pointOutcome(outcome.items, scan.target)
      return {
        id: point.id,
        status: 'collected',
        position: read.position,
        results_count: read.results_count,
        competitors: read.competitors,
        error: null,
      }
    },
  )
  const settled = outcomes.filter((row): row is PointSettlement => row !== null)
  if (settled.length > 0) await store.settlePoints(scanId, settled)
  return { pending: pending.length - settled.length, settled: settled.length }
}

/** Ends the scan: what never came back is not collected, the summary numbers go on the row. */
export async function finalizeScan(
  store: LocalScanStore,
  scanId: string,
): Promise<{
  status: 'completed' | 'failed' | 'inactive'
  summary?: ReturnType<typeof summarizeCells>
}> {
  const scan = await store.getScan(scanId)
  if (!scan || scan.status !== 'running') return { status: 'inactive' }
  await store.markUncollected(scanId, NEVER_CAME_BACK)
  const points = await store.listPointStates(scanId)
  const planned = scan.size * scan.size * scan.keywords.length
  const cells = points.map((point) => ({
    status: cellStatus(point),
    position: point.position,
  }))
  // A keyword whose post never ran has no rows: its points count as not collected.
  for (let missing = points.length; missing < planned; missing++)
    cells.push({ status: 'not_collected', position: null })
  const summary = summarizeCells(cells)
  const nothing = summary.points_collected === 0
  await store.finishScan(scanId, {
    status: nothing ? 'failed' : 'completed',
    pointsTotal: planned,
    pointsCollected: summary.points_collected,
    pointsFound: summary.points_found,
    top3: nothing ? null : summary.top3,
    top10: nothing ? null : summary.top10,
    averagePosition: nothing ? null : summary.average_position,
    errorCode: nothing ? 'NOTHING_COLLECTED' : null,
    errorDetail: nothing
      ? 'None of the scan’s searches came back. Run it again in a while.'
      : null,
  })
  return { status: nothing ? 'failed' : 'completed', summary }
}

/** Ends a queued or running scan as failed, with words for the person. */
export async function failScan(
  store: LocalScanStore,
  scanId: string,
  code: string,
  message: string,
): Promise<void> {
  await store.markUncollected(scanId, SCAN_STOPPED)
  const scan = await store.getScan(scanId)
  const points = await store.listPointStates(scanId)
  const collected = points.filter((point) => point.status === 'collected')
  await store.finishScan(scanId, {
    status: 'failed',
    pointsTotal: scan
      ? Math.max(points.length, scan.size * scan.size * scan.keywords.length)
      : points.length,
    pointsCollected: collected.length,
    pointsFound: collected.filter((point) => point.position != null).length,
    top3: null,
    top10: null,
    averagePosition: null,
    errorCode: code.slice(0, 60),
    errorDetail: message.slice(0, 2000),
  })
}
