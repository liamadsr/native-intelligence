/**
 * What the product reads about rank tracking (the SEO pages and the tools):
 * the trackers, one tracker with its summary, its keywords with their latest
 * positions, its checks, a keyword's history and the tracker's trend. Every
 * read is scoped by workspace_id in the query: the caller's client is the
 * service role's, so the filter is the fence. Reads of stored results are
 * free; nothing here calls the data provider.
 */
import { googleSerpUrl } from '@/lib/seo/shared/google-serp-url'
import type { SupabaseClient } from '@supabase/supabase-js'
import 'server-only'
import { RANK_PAGE_SIZE } from './limits'
import {
  positionView,
  skipReasonMessage,
  summarizePositions,
  trackerDevices,
  type RankDevice,
  type RankHistoryPoint,
  type RankKeywordHistory,
  type RankKeywordRow,
  type RankPaged,
  type RankPositionView,
  type RankRunStatus,
  type RankRunTrigger,
  type RankRunView,
  type RankSkipReason,
  type RankTrackerDetail,
  type RankTrackerSummary,
  type RankTrackerTrend,
  type RankTrackerView,
  type RankTrackingDevices,
  type RankTrackingScheduleInterval,
} from './view'

export const TRACKER_FIELDS =
  'id, workspace_id, created_by, domain, location_code, language_code, location_name, devices, serp_depth, schedule_interval, schedule_weekday, schedule_hour, schedule_minute, schedule_time_zone, next_check_at, last_checked_at, last_skip_reason, paused, created_at'

export const RUN_FIELDS =
  'id, tracker_id, workspace_id, trigger, status, scheduled_for, keywords_total, keywords_checked, checks_total, checks_collected, estimate_usd, cost_usd, error_code, error_detail, started_by, created_at, started_at, completed_at'

export interface TrackerRow {
  id: string
  workspace_id: string
  created_by: string | null
  domain: string
  location_code: number
  language_code: string
  location_name: string | null
  devices: RankTrackingDevices
  serp_depth: number
  schedule_interval: RankTrackingScheduleInterval
  schedule_weekday: number | null
  schedule_hour: number | null
  schedule_minute: number | null
  schedule_time_zone: string | null
  next_check_at: string | null
  last_checked_at: string | null
  last_skip_reason: string | null
  paused: boolean
  created_at: string
}

export interface RunRow {
  id: string
  tracker_id: string
  workspace_id: string
  trigger: RankRunTrigger
  status: RankRunStatus
  scheduled_for: string | null
  keywords_total: number
  keywords_checked: number
  checks_total: number
  checks_collected: number
  estimate_usd: number | string
  cost_usd: number | string
  error_code: string | null
  error_detail: string | null
  started_by: string | null
  created_at: string
  started_at: string | null
  completed_at: string | null
}

export function runView(row: RunRow): RankRunView {
  return {
    id: row.id,
    tracker_id: row.tracker_id,
    trigger: row.trigger,
    status: row.status,
    keywords_total: row.keywords_total,
    keywords_checked: row.keywords_checked,
    checks_total: row.checks_total,
    checks_collected: row.checks_collected,
    estimate_usd: Number(row.estimate_usd) || 0,
    cost_usd: Number(row.cost_usd) || 0,
    error:
      row.status === 'failed'
        ? (row.error_detail ?? 'The check stopped unexpectedly. Run it again.')
        : null,
    note: row.status === 'completed' ? row.error_detail : null,
    started_by: row.started_by,
    scheduled_for: row.scheduled_for,
    created_at: row.created_at,
    started_at: row.started_at,
    completed_at: row.completed_at,
  }
}

export function trackerView(
  row: TrackerRow,
  extra: { keywordCount: number; latestRun: RunRow | null },
): RankTrackerView {
  const reason = skipReasonMessage(row.last_skip_reason)
    ? (row.last_skip_reason as RankSkipReason)
    : null
  return {
    id: row.id,
    domain: row.domain,
    location_code: row.location_code,
    language_code: row.language_code,
    location_name: row.location_name,
    devices: row.devices,
    serp_depth: row.serp_depth,
    schedule: {
      interval: row.schedule_interval,
      weekday: row.schedule_weekday,
      hour: row.schedule_hour,
      minute: row.schedule_minute,
      time_zone: row.schedule_time_zone,
    },
    next_check_at: row.paused ? null : row.next_check_at,
    last_checked_at: row.last_checked_at,
    paused: row.paused,
    skip_reason: reason,
    skip_message: skipReasonMessage(reason),
    keyword_count: extra.keywordCount,
    created_by: row.created_by,
    created_at: row.created_at,
    latest_run: extra.latestRun ? runView(extra.latestRun) : null,
  }
}

type TrackerWithEmbeds = TrackerRow & {
  keyword_count?: Array<{ count: number }> | null
  runs?: RunRow[] | null
}

const TRACKER_SELECT = `${TRACKER_FIELDS}, keyword_count:seo_rank_keyword(count), runs:seo_rank_run(${RUN_FIELDS})`

function embeddedView(row: TrackerWithEmbeds): RankTrackerView {
  return trackerView(row, {
    keywordCount: Number(row.keyword_count?.[0]?.count ?? 0),
    latestRun: row.runs?.[0] ?? null,
  })
}

/** Offset and size of a page, from whatever the caller passed. */
export function pageBounds(
  offset: unknown,
  limit: unknown,
  max = RANK_PAGE_SIZE,
): { from: number; size: number } {
  const from =
    typeof offset === 'number' && Number.isFinite(offset) && offset > 0
      ? Math.floor(offset)
      : 0
  const size =
    typeof limit === 'number' && Number.isFinite(limit)
      ? Math.min(Math.max(Math.floor(limit), 1), max)
      : max
  return { from, size }
}

/** The workspace's trackers, newest first, a page at a time, each with its keyword count and newest check. */
export async function listRankTrackers(
  svc: SupabaseClient,
  workspaceId: string,
  page: { offset?: number; limit?: number } = {},
): Promise<RankPaged<RankTrackerView>> {
  const { from, size } = pageBounds(page.offset, page.limit)
  // One more than asked: its presence says there is a next page.
  const { data, error } = await svc
    .from('seo_rank_tracker')
    .select(TRACKER_SELECT)
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false })
    .order('id')
    .order('created_at', { referencedTable: 'seo_rank_run', ascending: false })
    .limit(1, { referencedTable: 'seo_rank_run' })
    .range(from, from + size)
  if (error) throw new Error(`seo rank tracker list failed: ${error.message}`)
  const all = (data ?? []) as unknown as TrackerWithEmbeds[]
  return {
    rows: all.slice(0, size).map(embeddedView),
    next_offset: all.length > size ? from + size : null,
  }
}

/** How many trackers the workspace has (the cap's count). */
export async function countRankTrackers(
  svc: SupabaseClient,
  workspaceId: string,
): Promise<number> {
  const { count, error } = await svc
    .from('seo_rank_tracker')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId)
  if (error) throw new Error(`seo rank tracker count failed: ${error.message}`)
  return count ?? 0
}

/** The tracker's own row, or null. */
export async function getTrackerRow(
  svc: SupabaseClient,
  workspaceId: string,
  trackerId: string,
): Promise<TrackerRow | null> {
  const { data, error } = await svc
    .from('seo_rank_tracker')
    .select(TRACKER_FIELDS)
    .eq('workspace_id', workspaceId)
    .eq('id', trackerId)
    .maybeSingle()
  if (error) throw new Error(`seo rank tracker read failed: ${error.message}`)
  return (data as TrackerRow | null) ?? null
}

/** One tracker of this workspace with its keyword count and newest check, or null. */
export async function getRankTracker(
  svc: SupabaseClient,
  workspaceId: string,
  trackerId: string,
): Promise<RankTrackerView | null> {
  const { data, error } = await svc
    .from('seo_rank_tracker')
    .select(TRACKER_SELECT)
    .eq('workspace_id', workspaceId)
    .eq('id', trackerId)
    .order('created_at', { referencedTable: 'seo_rank_run', ascending: false })
    .limit(1, { referencedTable: 'seo_rank_run' })
    .maybeSingle()
  if (error) throw new Error(`seo rank tracker read failed: ${error.message}`)
  return data ? embeddedView(data as unknown as TrackerWithEmbeds) : null
}

/** Every keyword of a tracker (id and text), oldest first. At most the per-tracker cap, read a page at a time. */
export async function readTrackerKeywords(
  svc: SupabaseClient,
  workspaceId: string,
  trackerId: string,
): Promise<Array<{ id: string; keyword: string }>> {
  const out: Array<{ id: string; keyword: string }> = []
  const pageSize = 1000
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await svc
      .from('seo_rank_keyword')
      .select('id, keyword')
      .eq('workspace_id', workspaceId)
      .eq('tracker_id', trackerId)
      .order('created_at')
      .order('id')
      .range(from, from + pageSize - 1)
    if (error)
      throw new Error(`seo rank keywords read failed: ${error.message}`)
    const rows = (data ?? []) as Array<{ id: string; keyword: string }>
    out.push(...rows)
    if (rows.length < pageSize) return out
  }
}

interface PositionRow {
  keyword_id: string
  device: RankDevice
  position: number | null
  url: string | null
  serp_features: unknown
  checked_at: string | null
  previous_position: number | null
  previous_checked_at: string | null
  has_current: boolean
  has_previous: boolean
}

/** seo_rank_positions, a page of 1000 rows at a time (PostgREST's ceiling). */
async function readPositions(
  svc: SupabaseClient,
  trackerId: string,
  device: RankDevice | null,
  keywordIds: string[] | null,
): Promise<PositionRow[]> {
  const out: PositionRow[] = []
  const pageSize = 1000
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await svc
      .rpc('seo_rank_positions', {
        p_tracker: trackerId,
        p_device: device,
        p_keyword_ids: keywordIds,
      })
      .range(from, from + pageSize - 1)
    if (error) throw new Error(`seo rank positions failed: ${error.message}`)
    const rows = (data ?? []) as PositionRow[]
    out.push(...rows)
    if (rows.length < pageSize) return out
  }
}

function toPositionView(row: PositionRow): RankPositionView {
  return positionView({
    device: row.device,
    has_current: row.has_current,
    position: row.position,
    has_previous: row.has_previous,
    previous_position: row.previous_position,
    url: row.url,
    serp_features: row.serp_features,
    checked_at: row.checked_at,
  })
}

/** One tracker with a summary per device: counts in the top 3 / 10 / 100, the average position, the movers since the previous check. */
export async function getRankTrackerDetail(
  svc: SupabaseClient,
  workspaceId: string,
  trackerId: string,
): Promise<RankTrackerDetail | null> {
  const tracker = await getRankTracker(svc, workspaceId, trackerId)
  if (!tracker) return null
  const [keywords, positions] = await Promise.all([
    readTrackerKeywords(svc, workspaceId, trackerId),
    readPositions(svc, trackerId, null, null),
  ])
  const text = new Map(keywords.map((k) => [k.id, k.keyword]))
  const summaries: RankTrackerSummary[] = trackerDevices(tracker.devices).map(
    (device) =>
      summarizePositions(
        device,
        keywords.length,
        positions
          .filter((row) => row.device === device && text.has(row.keyword_id))
          .map((row) => ({
            keyword_id: row.keyword_id,
            keyword: text.get(row.keyword_id) ?? '',
            view: toPositionView(row),
          })),
      ),
  )
  return { tracker, summaries }
}

/**
 * A tracker's keywords with their latest positions, pinned first, then
 * alphabetical, a page at a time. The tracker must be this workspace's.
 */
export async function listRankKeywordRows(
  svc: SupabaseClient,
  tracker: Pick<
    RankTrackerView,
    'id' | 'devices' | 'location_code' | 'language_code' | 'location_name'
  >,
  workspaceId: string,
  page: { offset?: number; limit?: number } = {},
): Promise<RankPaged<RankKeywordRow>> {
  const { from, size } = pageBounds(page.offset, page.limit)
  const { data, error } = await svc
    .from('seo_rank_keyword')
    .select('id, keyword, pinned_at, created_at')
    .eq('workspace_id', workspaceId)
    .eq('tracker_id', tracker.id)
    .order('pinned_at', { ascending: false, nullsFirst: false })
    .order('keyword')
    .order('id')
    .range(from, from + size)
  if (error) throw new Error(`seo rank keyword list failed: ${error.message}`)
  const all = (data ?? []) as Array<{
    id: string
    keyword: string
    pinned_at: string | null
    created_at: string
  }>
  const page_ = all.slice(0, size)
  const positions = page_.length
    ? await readPositions(
        svc,
        tracker.id,
        null,
        page_.map((k) => k.id),
      )
    : []
  const byKey = new Map(
    positions.map((row) => [`${row.keyword_id}:${row.device}`, row]),
  )
  const devices = trackerDevices(tracker.devices)
  const market = {
    locationCode: tracker.location_code,
    languageCode: tracker.language_code,
    locationName: tracker.location_name,
  }
  const cell = (keywordId: string, device: RankDevice) => {
    if (!devices.includes(device)) return null
    const row = byKey.get(`${keywordId}:${device}`)
    return row
      ? toPositionView(row)
      : positionView({
          device,
          has_current: false,
          position: null,
          has_previous: false,
          previous_position: null,
          url: null,
          serp_features: [],
          checked_at: null,
        })
  }
  return {
    rows: page_.map((k) => ({
      id: k.id,
      keyword: k.keyword,
      pinned: k.pinned_at !== null,
      created_at: k.created_at,
      desktop: cell(k.id, 'desktop'),
      mobile: cell(k.id, 'mobile'),
      google_serp_url: googleSerpUrl(k.keyword, market),
    })),
    next_offset: all.length > size ? from + size : null,
  }
}

/** A tracker's checks, newest first, a page at a time. */
export async function listRankRuns(
  svc: SupabaseClient,
  workspaceId: string,
  trackerId: string,
  page: { offset?: number; limit?: number } = {},
): Promise<RankPaged<RankRunView>> {
  const { from, size } = pageBounds(page.offset, page.limit)
  const { data, error } = await svc
    .from('seo_rank_run')
    .select(RUN_FIELDS)
    .eq('workspace_id', workspaceId)
    .eq('tracker_id', trackerId)
    .order('created_at', { ascending: false })
    .order('id')
    .range(from, from + size)
  if (error) throw new Error(`seo rank run list failed: ${error.message}`)
  const all = (data ?? []) as RunRow[]
  return {
    rows: all.slice(0, size).map(runView),
    next_offset: all.length > size ? from + size : null,
  }
}

/** One check of this workspace, or null. */
export async function getRankRun(
  svc: SupabaseClient,
  workspaceId: string,
  runId: string,
): Promise<RankRunView | null> {
  const { data, error } = await svc
    .from('seo_rank_run')
    .select(RUN_FIELDS)
    .eq('workspace_id', workspaceId)
    .eq('id', runId)
    .maybeSingle()
  if (error) throw new Error(`seo rank run read failed: ${error.message}`)
  return data ? runView(data as RunRow) : null
}

/** The tracker's queued or running check, if any. */
export async function getLiveRankRun(
  svc: SupabaseClient,
  workspaceId: string,
  trackerId: string,
): Promise<RunRow | null> {
  const { data, error } = await svc
    .from('seo_rank_run')
    .select(RUN_FIELDS)
    .eq('workspace_id', workspaceId)
    .eq('tracker_id', trackerId)
    .in('status', ['queued', 'running'])
    .order('created_at', { ascending: false })
    .limit(1)
  if (error) throw new Error(`seo rank run read failed: ${error.message}`)
  return ((data ?? []) as RunRow[])[0] ?? null
}

/** How far back a history reads, at most. */
export const MAX_HISTORY_DAYS = 400
export const DEFAULT_HISTORY_DAYS = 90

function sinceIso(days: unknown, now: Date): string {
  const d =
    typeof days === 'number' && Number.isFinite(days)
      ? Math.min(Math.max(Math.floor(days), 1), MAX_HISTORY_DAYS)
      : DEFAULT_HISTORY_DAYS
  return new Date(now.getTime() - d * 86_400_000).toISOString()
}

/**
 * One keyword's results over the tracker's completed checks, oldest first,
 * per device the tracker checks. The tracker must be this workspace's; null
 * when the keyword isn't one of its (removed keywords keep their history but
 * are no longer listed).
 */
export async function getRankKeywordHistory(
  svc: SupabaseClient,
  workspaceId: string,
  tracker: Pick<RankTrackerView, 'id' | 'devices'>,
  keywordId: string,
  opts: { days?: number; now?: Date } = {},
): Promise<RankKeywordHistory | null> {
  const { data: kw, error: kwError } = await svc
    .from('seo_rank_keyword')
    .select('id, keyword')
    .eq('workspace_id', workspaceId)
    .eq('tracker_id', tracker.id)
    .eq('id', keywordId)
    .maybeSingle()
  if (kwError)
    throw new Error(`seo rank keyword read failed: ${kwError.message}`)
  if (!kw) return null
  const since = sinceIso(opts.days, opts.now ?? new Date())
  const rows: Array<{
    run_id: string
    checked_at: string
    device: RankDevice
    position: number | null
    url: string | null
  }> = []
  const pageSize = 1000
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await svc
      .rpc('seo_rank_keyword_history', {
        p_tracker: tracker.id,
        p_keyword: keywordId,
        p_since: since,
      })
      .range(from, from + pageSize - 1)
    if (error) throw new Error(`seo rank history failed: ${error.message}`)
    const got = (data ?? []) as typeof rows
    rows.push(...got)
    if (got.length < pageSize) break
  }
  const devices = trackerDevices(tracker.devices)
  const series = (device: RankDevice): RankHistoryPoint[] | null =>
    devices.includes(device)
      ? rows
          .filter((row) => row.device === device)
          .map((row) => ({
            run_id: row.run_id,
            checked_at: row.checked_at,
            position: row.position,
            ranking_url: row.url,
          }))
      : null
  const k = kw as { id: string; keyword: string }
  return {
    keyword_id: k.id,
    keyword: k.keyword,
    series: { desktop: series('desktop'), mobile: series('mobile') },
  }
}

/** The tracker's totals per completed check on each device it checks, oldest first. */
export async function getRankTrackerTrend(
  svc: SupabaseClient,
  tracker: Pick<RankTrackerView, 'id' | 'devices'>,
  opts: { days?: number; now?: Date } = {},
): Promise<RankTrackerTrend[]> {
  const since = sinceIso(opts.days, opts.now ?? new Date())
  const out: RankTrackerTrend[] = []
  for (const device of trackerDevices(tracker.devices)) {
    const { data, error } = await svc
      .rpc('seo_rank_trend', {
        p_tracker: tracker.id,
        p_device: device,
        p_since: since,
      })
      .range(0, 999)
    if (error) throw new Error(`seo rank trend failed: ${error.message}`)
    const rows = (data ?? []) as Array<{
      run_id: string
      checked_at: string
      keywords_total: number
      checked: number | string
      found: number | string
      top3: number | string
      top10: number | string
      top100: number | string
      average_position: number | string | null
    }>
    out.push({
      device,
      points: rows.map((row) => ({
        run_id: row.run_id,
        checked_at: row.checked_at,
        keywords_total: row.keywords_total,
        checked: Number(row.checked),
        found: Number(row.found),
        top3: Number(row.top3),
        top10: Number(row.top10),
        top100: Number(row.top100),
        average_position:
          row.average_position === null ? null : Number(row.average_position),
      })),
    })
  }
  return out
}
