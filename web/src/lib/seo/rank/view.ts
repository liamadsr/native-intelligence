/**
 * What the rank tracking pages and the tools read: the shapes the API
 * returns, and the plain maths over them (a keyword's change since the
 * previous check, the tracker's summary and movers, the cost estimate).
 * Safe to import from client components (types and plain functions only,
 * nothing of the server's).
 */
import {
  devicesCount,
  estimateRankCheckUsd,
  isScheduledRankTrackingInterval,
  MAX_READS_PER_CHECK,
  MIN_READS_PER_CHECK,
  scheduledChecksPerMonth,
  type RankTrackingDevices,
  type RankTrackingScheduleInterval,
} from '@/lib/seo/shared/rank-tracking'

export type RankDevice = 'desktop' | 'mobile'
export type { RankTrackingDevices, RankTrackingScheduleInterval }
export type RankRunStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'canceled'
export type RankRunTrigger = 'manual' | 'scheduled'
export type RankSkipReason =
  | 'not_configured'
  | 'no_keywords'
  | 'creator_gone'
  | 'creator_not_member'
  | 'free_plan'

export interface RankScheduleView {
  interval: RankTrackingScheduleInterval
  /** 0 = Sunday; weekly schedules only. */
  weekday: number | null
  hour: number | null
  minute: number | null
  /** The zone the time was chosen in; null = UTC or a time picked for the person. */
  time_zone: string | null
}

export interface RankRunView {
  id: string
  tracker_id: string
  trigger: RankRunTrigger
  status: RankRunStatus
  keywords_total: number
  keywords_checked: number
  /** Keyword and device pairs the check reads. */
  checks_total: number
  /** Pairs that got a result. */
  checks_collected: number
  /** The most the check could cost, in USD. */
  estimate_usd: number
  /** What its searches cost so far, in USD. */
  cost_usd: number
  /** Why it failed, in words for the person; null unless status is failed. */
  error: string | null
  /** A completed check's note on the keywords that got no result; null when every one did. */
  note: string | null
  /** The person who asked; null for a scheduled check. */
  started_by: string | null
  scheduled_for: string | null
  created_at: string
  started_at: string | null
  completed_at: string | null
}

export interface RankTrackerView {
  id: string
  domain: string
  location_code: number
  language_code: string
  /** A city-level tracker's canonical Google location; null tracks the whole country. */
  location_name: string | null
  devices: RankTrackingDevices
  serp_depth: number
  schedule: RankScheduleView
  next_check_at: string | null
  last_checked_at: string | null
  paused: boolean
  /** Why the last scheduled check was skipped, as a code and in words; null when it ran. */
  skip_reason: RankSkipReason | null
  skip_message: string | null
  keyword_count: number
  created_by: string | null
  created_at: string
  /** The newest check, whatever its status; null before the first. */
  latest_run: RankRunView | null
}

/** Where a keyword stands on one device. */
export interface RankPositionView {
  device: RankDevice
  /**
   * ranked      found at `position` in the latest check;
   * not_found   checked, and the site was not in the results read;
   * not_checked no completed check has a result for it yet.
   */
  status: 'ranked' | 'not_found' | 'not_checked'
  position: number | null
  previous_position: number | null
  /** Places gained since the previous check (positive is up); null when either check has no position. */
  change: number | null
  movement: 'up' | 'down' | 'same' | 'new' | 'lost' | null
  ranking_url: string | null
  serp_features: string[]
  checked_at: string | null
}

export interface RankKeywordRow {
  id: string
  keyword: string
  pinned: boolean
  created_at: string
  /** Null when the tracker does not check that device. */
  desktop: RankPositionView | null
  mobile: RankPositionView | null
  /** Opens the same search on Google, in the tracker's market. */
  google_serp_url: string
}

export interface RankMover {
  keyword_id: string
  keyword: string
  position: number
  previous_position: number
  change: number
}

export interface RankTrackerSummary {
  device: RankDevice
  /** Keywords the tracker follows. */
  tracked: number
  /** Keywords a completed check has a result for on this device. */
  checked: number
  /** Of those, found in the results read. */
  ranking: number
  not_found: number
  top3: number
  top10: number
  top100: number
  /** Mean position of the keywords found, one decimal; null when none is. */
  average_position: number | null
  improved: number
  declined: number
  unchanged: number
  /** Found now, not found in the previous check. */
  new_rankings: number
  /** Found in the previous check, not now. */
  lost_rankings: number
  movers: { up: RankMover[]; down: RankMover[] }
}

export interface RankTrackerDetail {
  tracker: RankTrackerView
  /** One per device the tracker checks. */
  summaries: RankTrackerSummary[]
}

export interface RankHistoryPoint {
  run_id: string
  checked_at: string
  /** Null: checked, not found. A check with no result for the keyword has no point. */
  position: number | null
  ranking_url: string | null
}

export interface RankKeywordHistory {
  keyword_id: string
  keyword: string
  series: {
    desktop: RankHistoryPoint[] | null
    mobile: RankHistoryPoint[] | null
  }
}

export interface RankTrendPoint {
  run_id: string
  checked_at: string
  keywords_total: number
  checked: number
  found: number
  top3: number
  top10: number
  top100: number
  average_position: number | null
}

export interface RankTrackerTrend {
  device: RankDevice
  points: RankTrendPoint[]
}

export interface RankEstimateView {
  keyword_count: number
  devices: RankTrackingDevices
  serp_depth: number
  /** Keyword and device pairs one check reads. */
  searches_per_read: number
  /** Every pair is read at least `min` times, and up to `max` while the reads disagree. */
  reads_per_check: { min: number; max: number }
  /** The most one check costs, in USD (every pair read `max` times). */
  per_check_usd: number
  schedule: RankTrackingScheduleInterval
  /** A planning figure (30 daily, 4 weekly, 1 monthly), not a calendar count; 0 when the schedule is off. */
  checks_per_month: number
  /** per_check_usd times checks_per_month; 0 when the schedule is off. */
  monthly_usd: number
}

/** A page of a list: pass `next_offset` as `offset` for the next one; null after the last. */
export interface RankPaged<T> {
  rows: T[]
  next_offset: number | null
}

/** True while a check is still being worked on (poll it). */
export function isLiveRankRun(status: RankRunStatus): boolean {
  return status === 'queued' || status === 'running'
}

export function trackerDevices(devices: RankTrackingDevices): RankDevice[] {
  return devices === 'both' ? ['desktop', 'mobile'] : [devices]
}

const SKIP_MESSAGES: Record<RankSkipReason, string> = {
  not_configured:
    'Scheduled checks are off: search data isn’t set up on this server.',
  no_keywords: 'Scheduled checks are skipped: the tracker has no keywords yet.',
  creator_gone:
    'Scheduled checks are skipped: the person who set this tracker up no longer has an account.',
  creator_not_member:
    'Scheduled checks are skipped: the person who set this tracker up is no longer a member of this workspace.',
  free_plan:
    'Scheduled checks are skipped: the person who set this tracker up is on the free plan.',
}

export function skipReasonMessage(reason: string | null): string | null {
  return reason && reason in SKIP_MESSAGES
    ? SKIP_MESSAGES[reason as RankSkipReason]
    : null
}

export function isSkipReason(value: unknown): value is RankSkipReason {
  return typeof value === 'string' && value in SKIP_MESSAGES
}

/** A keyword's standing on one device, from its latest and previous results. */
export function positionView(input: {
  device: RankDevice
  has_current: boolean
  position: number | null
  has_previous: boolean
  previous_position: number | null
  url: string | null
  serp_features: unknown
  checked_at: string | null
}): RankPositionView {
  const position = input.has_current ? input.position : null
  const previous = input.has_previous ? input.previous_position : null
  let movement: RankPositionView['movement'] = null
  let change: number | null = null
  if (input.has_current && input.has_previous) {
    if (position !== null && previous !== null) {
      change = previous - position
      movement = change > 0 ? 'up' : change < 0 ? 'down' : 'same'
    } else if (position !== null) movement = 'new'
    else if (previous !== null) movement = 'lost'
  }
  return {
    device: input.device,
    status: !input.has_current
      ? 'not_checked'
      : position === null
        ? 'not_found'
        : 'ranked',
    position,
    previous_position: previous,
    change,
    movement,
    ranking_url: input.has_current ? input.url : null,
    serp_features: Array.isArray(input.serp_features)
      ? input.serp_features.filter((f): f is string => typeof f === 'string')
      : [],
    checked_at: input.has_current ? input.checked_at : null,
  }
}

/** How many movers each direction a summary names. */
export const MOVERS_SHOWN = 5

/**
 * The tracker's standing on one device from every keyword's latest and
 * previous result: counts in the top 3 / 10 / 100, the average position of
 * the keywords found, and the biggest moves since the previous check.
 */
export function summarizePositions(
  device: RankDevice,
  tracked: number,
  rows: Array<{ keyword_id: string; keyword: string; view: RankPositionView }>,
  moversShown = MOVERS_SHOWN,
): RankTrackerSummary {
  const summary: RankTrackerSummary = {
    device,
    tracked,
    checked: 0,
    ranking: 0,
    not_found: 0,
    top3: 0,
    top10: 0,
    top100: 0,
    average_position: null,
    improved: 0,
    declined: 0,
    unchanged: 0,
    new_rankings: 0,
    lost_rankings: 0,
    movers: { up: [], down: [] },
  }
  let positionSum = 0
  const moves: RankMover[] = []
  for (const { keyword_id, keyword, view } of rows) {
    if (view.device !== device || view.status === 'not_checked') continue
    summary.checked++
    if (view.position === null) summary.not_found++
    else {
      summary.ranking++
      positionSum += view.position
      if (view.position <= 3) summary.top3++
      if (view.position <= 10) summary.top10++
      if (view.position <= 100) summary.top100++
    }
    if (view.movement === 'up') summary.improved++
    if (view.movement === 'down') summary.declined++
    if (view.movement === 'same') summary.unchanged++
    if (view.movement === 'new') summary.new_rankings++
    if (view.movement === 'lost') summary.lost_rankings++
    if (
      view.change !== null &&
      view.change !== 0 &&
      view.position !== null &&
      view.previous_position !== null
    ) {
      moves.push({
        keyword_id,
        keyword,
        position: view.position,
        previous_position: view.previous_position,
        change: view.change,
      })
    }
  }
  if (summary.ranking > 0)
    summary.average_position =
      Math.round((positionSum / summary.ranking) * 10) / 10
  const byKeyword = (a: RankMover, b: RankMover) =>
    a.keyword.localeCompare(b.keyword)
  summary.movers.up = moves
    .filter((m) => m.change > 0)
    .sort((a, b) => b.change - a.change || byKeyword(a, b))
    .slice(0, moversShown)
  summary.movers.down = moves
    .filter((m) => m.change < 0)
    .sort((a, b) => a.change - b.change || byKeyword(a, b))
    .slice(0, moversShown)
  return summary
}

/**
 * What a check of these keywords costs at most, and per month on a schedule:
 * the free maths shown before anything is saved or started. Every keyword and
 * device is read MIN_READS_PER_CHECK to MAX_READS_PER_CHECK times, and the
 * estimate prices the maximum, so a real check costs this or less.
 */
export function estimateView(input: {
  keywords: readonly string[]
  devices: RankTrackingDevices
  serp_depth: number
  schedule: RankTrackingScheduleInterval
}): RankEstimateView {
  const { costUsd } = estimateRankCheckUsd(
    input.keywords,
    input.devices,
    input.serp_depth,
  )
  const perCheck = roundUsd(costUsd)
  const checksPerMonth = isScheduledRankTrackingInterval(input.schedule)
    ? scheduledChecksPerMonth(input.schedule)
    : 0
  return {
    keyword_count: input.keywords.length,
    devices: input.devices,
    serp_depth: input.serp_depth,
    searches_per_read: input.keywords.length * devicesCount(input.devices),
    reads_per_check: { min: MIN_READS_PER_CHECK, max: MAX_READS_PER_CHECK },
    per_check_usd: perCheck,
    schedule: input.schedule,
    checks_per_month: checksPerMonth,
    monthly_usd: roundUsd(costUsd * checksPerMonth),
  }
}

/** Dollars to the hundredth of a cent, up: an estimate never reads below the maths. */
export function roundUsd(usd: number): number {
  // `|| 0`: zero comes out of the ceiling as -0.
  return Math.ceil(usd * 10_000 - 1e-9) / 10_000 || 0
}

/**
 * Whether a change makes the tracker spend more on its own: a higher monthly
 * figure (more keywords, devices or depth on a schedule, a faster schedule,
 * a paused schedule resumed). A tracker with its schedule off spends only
 * when someone starts a check, which asks on its own.
 */
export function raisesCost(
  before: RankEstimateView,
  after: RankEstimateView,
): boolean {
  return after.monthly_usd > before.monthly_usd + 1e-9
}

/**
 * The answer of a change or a check that needs the person's yes first
 * (./trackers.ts, ./runs.ts): nothing was changed or started. A route answers
 * it 409 NEEDS_GO_AHEAD with `estimate` (and `previous_estimate`) in
 * `details`; a tool tells the agent to say the cost and ask. The caller shows
 * the cost and sends the same request again with `confirmed: true`.
 */
export type RankGoAheadRefusal = {
  ok: false
  code: 'NEEDS_GO_AHEAD'
  message: string
  /** What it costs with the change: per check, and per month on its schedule. */
  estimate: RankEstimateView
  /** A saved tracker's cost as it is now, before the change. */
  previous_estimate?: RankEstimateView
}

function usdText(n: number): string {
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`
}

/**
 * A go-ahead refusal in words for the person. `check`: a manual check above
 * the confirmation line. `schedule`: a change that starts or raises what the
 * tracker spends on its own.
 */
export function goAheadRefusal(
  kind: 'check' | 'schedule',
  estimate: RankEstimateView,
  previous?: RankEstimateView,
): RankGoAheadRefusal {
  const message =
    kind === 'check'
      ? `This check costs up to ${usdText(estimate.per_check_usd)}, from this workspace’s search data budget. Confirm to start it.`
      : `This makes the tracker spend on its own: each check costs up to ${usdText(estimate.per_check_usd)}, about ${estimate.checks_per_month} checks a month, so up to ${usdText(estimate.monthly_usd)} a month, from this workspace’s search data budget. Confirm to go ahead.`
  return {
    ok: false,
    code: 'NEEDS_GO_AHEAD',
    message,
    estimate,
    ...(previous ? { previous_estimate: previous } : {}),
  }
}
