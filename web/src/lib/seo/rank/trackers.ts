/**
 * Creating, changing and deleting rank trackers and their keywords, and the
 * free cost maths: the one core behind the rank tracking routes and the
 * agent's tools, so both follow the same rules.
 *
 *   - Any member of the workspace may set up a tracker. Setting one up costs
 *     nothing; checks do (./runs.ts for a manual one, the schedule for the
 *     rest). Whoever sets it up with a schedule, or later turns one on, is
 *     the person whose plan the schedule rides on (./gate.ts, created_by).
 *   - Anything that turns on or raises what a tracker spends on its own (a
 *     schedule with keywords at create, a schedule turned on, resumed or made
 *     more frequent, more devices or depth, keywords added to a scheduled
 *     tracker) runs the access check (../access.ts) and needs `confirmed`:
 *     the person saw the new monthly cost and said yes. However small: no
 *     floor, so a rise can't be split into steps nobody is asked about.
 *     Without it the answer is NEEDS_GO_AHEAD carrying the estimate
 *     (./view.ts goAheadRefusal), and nothing is written. The routes and the
 *     tools share this one rule.
 *   - A schedule runs on the standing of the person who turned it on or last
 *     set its interval (created_by, after their access check passed), not on
 *     whoever first set the tracker up: a guest's tracker scheduled by a
 *     paying member runs; a schedule turned on by someone who later loses
 *     standing stops. Changes that cost nothing more leave it alone.
 *   - Pausing a tracker, or turning its schedule off, stops its scheduled
 *     check if one is running. Moving only the schedule's time never adds a
 *     check: the new due time is never earlier than the one it replaces.
 *   - No site named means the workspace's own (../site.ts).
 *   - One tracker per site and market (country or city, and language) per
 *     workspace, held here rather than by a unique index (a workspace merge
 *     must never meet one), and at most MAX_TRACKERS_PER_WORKSPACE.
 *   - Keywords are lowercased in the tracker's language and deduplicated;
 *     the per-tracker cap is held under a lock by seo_rank_add_keywords.
 *   - The schedule (off, daily, weekly, monthly, at an optional time in the
 *     person's time zone) anchors next_check_at in UTC; it only moves when
 *     the schedule itself changes, so editing the devices doesn't reshuffle
 *     the time. Port of the source's config schedule rules.
 *
 * Adapted from OpenSEO (MIT, see ../THIRD_PARTY_NOTICES.md).
 */
import { checkSeoDataAccess } from '@/lib/seo/access'
import { assertSerpLocationNameAccepted } from '@/lib/seo/dataforseo'
import { isSeoError } from '@/lib/seo/errors'
import { domainField } from '@/lib/seo/shared/domain'
import {
  getIsoCountryCode,
  getLanguageCode,
  isSupportedLanguageCode,
  isSupportedLocationCode,
} from '@/lib/seo/shared/keyword-locations'
import {
  computeNextCheckAt,
  isScheduledRankTrackingInterval,
  type RankCheckScheduleTime,
} from '@/lib/seo/shared/rank-tracking'
import { scheduleTimeSchema } from '@/lib/seo/shared/schedule-time'
import { workspaceSiteUrl } from '@/lib/seo/site'
import type { SupabaseClient } from '@supabase/supabase-js'
import 'server-only'
import {
  DEFAULT_DEVICES,
  DEFAULT_SCHEDULE_INTERVAL,
  DEFAULT_SERP_DEPTH,
  MAX_KEYWORD_LENGTH,
  MAX_KEYWORDS_PER_ADD,
  MAX_KEYWORDS_PER_TRACKER,
  MAX_SERP_DEPTH,
  MAX_TRACKERS_PER_WORKSPACE,
  MIN_SERP_DEPTH,
} from './limits'
import {
  countRankTrackers,
  getRankTracker,
  getTrackerRow,
  readTrackerKeywords,
  TRACKER_FIELDS,
  type TrackerRow,
} from './queries'
import { cancelLiveRunsForTracker, type SendEvent } from './runs'
import {
  estimateView,
  goAheadRefusal,
  raisesCost,
  type RankEstimateView,
  type RankGoAheadRefusal,
  type RankTrackerView,
  type RankTrackingDevices,
  type RankTrackingScheduleInterval,
} from './view'

export type RankFailure = { ok: false; code: string; message: string }

const DEVICES: readonly RankTrackingDevices[] = ['desktop', 'mobile', 'both']
const INTERVALS: readonly RankTrackingScheduleInterval[] = [
  'manual',
  'daily',
  'weekly',
  'monthly',
]

/** A schedule time as the API and the tools take it (snake case, the zone optional). */
export interface ScheduleTimeInput {
  weekday?: number | null
  hour: number
  minute: number
  time_zone?: string | null
}

export interface TrackerSettingsInput {
  devices?: unknown
  serp_depth?: unknown
  schedule_interval?: unknown
  /** null clears a chosen time (the schedule then picks a quiet hour). */
  schedule_time?: unknown
}

export interface CreateTrackerInput extends TrackerSettingsInput {
  domain?: unknown
  location_code?: unknown
  language_code?: unknown
  location_name?: unknown
  keywords?: unknown
  /** The person saw what the schedule costs and said yes (only `true` counts). */
  confirmed?: unknown
}

export interface UpdateTrackerInput extends TrackerSettingsInput {
  paused?: unknown
  /** The person saw what the change costs and said yes (only `true` counts). */
  confirmed?: unknown
}

export interface TrackerDeps {
  /** Checks a city name against the provider's free sandbox (tests stub it). */
  probeLocation?: typeof assertSerpLocationNameAccepted
  /** The access check (tests stub it). */
  access?: typeof checkSeoDataAccess
  /** The lane's event sender, for stopping a check (tests stub it). */
  send?: SendEvent
  now?: () => Date
}

/** Who is changing a tracker: the person, and whether anyone is actually there (a loop isn't). */
export interface TrackerActor {
  workspaceId: string
  userId: string
  unattended?: boolean
}

export type RankRefusal = RankFailure & { refusal: true }

/**
 * Turning a schedule on, or raising what it spends, sets up spending that
 * runs by itself, so it asks what a person's paid lookup asks (../access.ts):
 * the server has search data, the person is a full member and not on the
 * free plan, and a person is there.
 */
async function scheduleAccess(
  who: TrackerActor,
  deps: TrackerDeps,
): Promise<RankRefusal | null> {
  const access = await (deps.access ?? checkSeoDataAccess)({
    userId: who.userId,
    workspaceId: who.workspaceId,
    unattended: who.unattended,
  })
  return access.ok
    ? null
    : { ok: false, code: access.code, message: access.message, refusal: true }
}

function invalid(message: string): RankFailure {
  return { ok: false, code: 'INVALID_INPUT', message }
}

function parseDevices(value: unknown, fallback: RankTrackingDevices) {
  if (value === undefined || value === null) return fallback
  return DEVICES.includes(value as RankTrackingDevices)
    ? (value as RankTrackingDevices)
    : null
}

function parseDepth(value: unknown, fallback: number) {
  if (value === undefined || value === null) return fallback
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_SERP_DEPTH &&
    value <= MAX_SERP_DEPTH &&
    value % 10 === 0
    ? value
    : null
}

function parseInterval(value: unknown, fallback: RankTrackingScheduleInterval) {
  if (value === undefined || value === null) return fallback
  return INTERVALS.includes(value as RankTrackingScheduleInterval)
    ? (value as RankTrackingScheduleInterval)
    : null
}

/** A schedule time, checked. undefined = not given; null = cleared. */
function parseScheduleTime(
  value: unknown,
): { ok: true; time: RankCheckScheduleTime | null | undefined } | RankFailure {
  if (value === undefined) return { ok: true, time: undefined }
  if (value === null) return { ok: true, time: null }
  if (typeof value !== 'object')
    return invalid('The schedule time needs an hour and a minute.')
  const raw = value as Record<string, unknown>
  const parsed = scheduleTimeSchema.safeParse({
    weekday: raw.weekday ?? undefined,
    hour: raw.hour,
    minute: raw.minute,
    timeZone: raw.time_zone ?? raw.timeZone ?? undefined,
  })
  if (!parsed.success)
    return invalid(
      'That schedule time isn’t valid: an hour 0-23, a minute 0-59, a weekday 0-6 (0 is Sunday) for a weekly schedule, and a real time zone such as "America/New_York".',
    )
  return { ok: true, time: parsed.data }
}

/**
 * When the first scheduled check is due for this schedule, or null when it
 * is off. Port of the source's resolveNextCheckAt: a weekly time needs its
 * weekday, and a time needs a schedule.
 */
export function resolveNextCheckAt(
  interval: RankTrackingScheduleInterval,
  time: RankCheckScheduleTime | null | undefined,
): { ok: true; next: string | null } | RankFailure {
  if (isScheduledRankTrackingInterval(interval)) {
    if (interval === 'weekly' && time && time.weekday === undefined)
      return invalid('A weekly schedule time needs a weekday (0 is Sunday).')
    return {
      ok: true,
      next: computeNextCheckAt(interval, null, time ?? undefined),
    }
  }
  if (time)
    return invalid('A schedule time needs a daily, weekly or monthly schedule.')
  return { ok: true, next: null }
}

function scheduleColumns(time: RankCheckScheduleTime | null | undefined) {
  return {
    schedule_weekday: time?.weekday ?? null,
    schedule_hour: time?.hour ?? null,
    schedule_minute: time?.minute ?? null,
    schedule_time_zone: time?.timeZone ?? null,
  }
}

/**
 * Keywords as a tracker stores them: trimmed, inner spaces collapsed,
 * lowercased in the tracker's language (Turkish "İstanbul" becomes
 * "istanbul"), deduplicated in the order given. Empty and over-long ones are
 * counted out.
 */
export function normalizeKeywords(
  raw: readonly unknown[],
  languageCode: string,
): { keywords: string[]; rejected: number } {
  const seen = new Set<string>()
  const keywords: string[] = []
  let rejected = 0
  for (const item of raw) {
    if (typeof item !== 'string') {
      rejected++
      continue
    }
    const trimmed = item.trim().replace(/\s+/g, ' ')
    let lowered: string
    try {
      lowered = trimmed.toLocaleLowerCase(languageCode)
    } catch {
      lowered = trimmed.toLowerCase()
    }
    if (!lowered || lowered.length > MAX_KEYWORD_LENGTH) {
      rejected++
      continue
    }
    if (seen.has(lowered)) continue
    seen.add(lowered)
    keywords.push(lowered)
  }
  return { keywords, rejected }
}

function keywordList(value: unknown): unknown[] | RankFailure {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) return invalid('Keywords come as a list.')
  if (value.length > MAX_KEYWORDS_PER_ADD)
    return invalid(`Add at most ${MAX_KEYWORDS_PER_ADD} keywords at a time.`)
  return value
}

export type CreateTrackerResult =
  | {
      ok: true
      tracker: RankTrackerView
      keywords: AddKeywordsOutcome
    }
  | (RankFailure & { tracker_id?: string })
  | RankGoAheadRefusal

/** Set up a tracker. Starts no check; a schedule with keywords needs `confirmed` (see the header). */
export async function createRankTracker(
  svc: SupabaseClient,
  who: TrackerActor,
  input: CreateTrackerInput,
  deps: TrackerDeps = {},
): Promise<CreateTrackerResult> {
  const typed =
    typeof input.domain === 'string' && input.domain.trim()
      ? input.domain.trim()
      : null
  const address = typed ?? (await workspaceSiteUrl(svc, who.workspaceId))
  if (!address)
    return {
      ok: false,
      code: 'NO_SITE',
      message: 'Which website? Give its domain (for example example.com).',
    }
  const domain = domainField.safeParse(address.slice(0, 2000))
  if (!domain.success) return invalid('Enter a valid domain like example.com.')

  const locationCode =
    input.location_code === undefined || input.location_code === null
      ? 2840
      : input.location_code
  if (
    typeof locationCode !== 'number' ||
    !Number.isInteger(locationCode) ||
    !isSupportedLocationCode(locationCode)
  )
    return invalid('That country isn’t one search data covers.')
  const languageCode =
    typeof input.language_code === 'string' && input.language_code.trim()
      ? input.language_code.trim()
      : getLanguageCode(locationCode)
  if (!isSupportedLanguageCode(languageCode))
    return invalid('That language isn’t one search data covers.')
  let locationName: string | null = null
  if (input.location_name !== undefined && input.location_name !== null) {
    if (typeof input.location_name !== 'string' || !input.location_name.trim())
      return invalid('The city must be a Google location name.')
    locationName = input.location_name.trim()
    if (locationName.length > 200)
      return invalid('That location name is too long.')
  }

  const devices = parseDevices(input.devices, DEFAULT_DEVICES)
  if (!devices) return invalid('Devices are desktop, mobile or both.')
  const depth = parseDepth(input.serp_depth, DEFAULT_SERP_DEPTH)
  if (depth === null)
    return invalid(
      `The depth is how many results to read: ${MIN_SERP_DEPTH} to ${MAX_SERP_DEPTH}, in tens.`,
    )
  const interval = parseInterval(
    input.schedule_interval,
    DEFAULT_SCHEDULE_INTERVAL,
  )
  if (!interval)
    return invalid('The schedule is manual (off), daily, weekly or monthly.')
  const time = parseScheduleTime(input.schedule_time)
  if (!time.ok) return time
  const next = resolveNextCheckAt(interval, time.time)
  if (!next.ok) return next
  const list = keywordList(input.keywords)
  if (!Array.isArray(list)) return list
  if (isScheduledRankTrackingInterval(interval)) {
    const refused = await scheduleAccess(who, deps)
    if (refused) return refused
  }

  if (
    (await countRankTrackers(svc, who.workspaceId)) >=
    MAX_TRACKERS_PER_WORKSPACE
  ) {
    return {
      ok: false,
      code: 'TOO_MANY_TRACKERS',
      message: `A workspace can have ${MAX_TRACKERS_PER_WORKSPACE} rank trackers. Delete one first.`,
    }
  }
  let dupe = svc
    .from('seo_rank_tracker')
    .select('id')
    .eq('workspace_id', who.workspaceId)
    .eq('domain', domain.data)
    .eq('location_code', locationCode)
    .eq('language_code', languageCode)
  dupe = locationName
    ? dupe.eq('location_name', locationName)
    : dupe.is('location_name', null)
  const { data: existing, error: dupeError } = await dupe.limit(1)
  if (dupeError)
    throw new Error(`seo rank tracker read failed: ${dupeError.message}`)
  const existingId = (existing as Array<{ id: string }> | null)?.[0]?.id
  if (existingId) {
    return {
      ok: false,
      code: 'DUPLICATE_TRACKER',
      message: `${domain.data} is already tracked in that market. Add keywords to that tracker instead.`,
      tracker_id: existingId,
    }
  }
  // A schedule with keywords spends from its first due time on: the person's
  // yes first. One with none spends nothing yet; adding keywords asks then.
  if (isScheduledRankTrackingInterval(interval) && input.confirmed !== true) {
    const estimate = estimateView({
      keywords: normalizeKeywords(list, languageCode).keywords,
      devices,
      serp_depth: depth,
      schedule: interval,
    })
    if (estimate.monthly_usd > 0) return goAheadRefusal('schedule', estimate)
  }

  if (locationName) {
    try {
      await (deps.probeLocation ?? assertSerpLocationNameAccepted)({
        locationName,
        languageCode,
        countryCode: getIsoCountryCode(locationCode),
      })
    } catch (err) {
      // Our own words: the probe's can name the provider and quote its reply.
      if (isSeoError(err) && err.code === 'VALIDATION_ERROR')
        return invalid(
          `"${locationName}" isn’t a location name Google accepts. Use the exact name from the location search, for example "Austin,Texas,United States".`,
        )
      throw err
    }
  }

  const { data, error } = await svc
    .from('seo_rank_tracker')
    .insert({
      workspace_id: who.workspaceId,
      created_by: who.userId,
      domain: domain.data,
      location_code: locationCode,
      language_code: languageCode,
      location_name: locationName,
      devices,
      serp_depth: depth,
      schedule_interval: interval,
      ...scheduleColumns(time.time),
      next_check_at: next.next,
    })
    .select(TRACKER_FIELDS)
    .single()
  if (error || !data) {
    console.error('[seo-rank] create: insert failed', error?.message)
    return {
      ok: false,
      code: 'CREATE_FAILED',
      message: 'Could not set up the tracker just now. Try again in a moment.',
    }
  }
  const row = data as TrackerRow
  const added = list.length
    ? await insertKeywords(svc, row, list)
    : { added: [], already_tracked: 0, over_cap: 0, rejected: 0 }
  const tracker = await getRankTracker(svc, who.workspaceId, row.id)
  if (!tracker) throw new Error('seo rank tracker vanished after create')
  return { ok: true, tracker, keywords: added }
}

export interface AddKeywordsOutcome {
  added: Array<{ id: string; keyword: string }>
  /** Already on the tracker (or repeated in the request). */
  already_tracked: number
  /** Left out because the tracker reached MAX_KEYWORDS_PER_TRACKER. */
  over_cap: number
  /** Empty or longer than MAX_KEYWORD_LENGTH. */
  rejected: number
}

async function insertKeywords(
  svc: SupabaseClient,
  tracker: Pick<TrackerRow, 'id' | 'workspace_id' | 'language_code'>,
  raw: readonly unknown[],
): Promise<AddKeywordsOutcome> {
  const { keywords, rejected } = normalizeKeywords(raw, tracker.language_code)
  if (keywords.length === 0)
    return { added: [], already_tracked: 0, over_cap: 0, rejected }
  const existing = new Set(
    (await readTrackerKeywords(svc, tracker.workspace_id, tracker.id)).map(
      (k) => k.keyword,
    ),
  )
  const fresh = keywords.filter((k) => !existing.has(k))
  // The cap is held in the database, under a lock on the tracker.
  const { data, error } = fresh.length
    ? await svc.rpc('seo_rank_add_keywords', {
        p_tracker: tracker.id,
        p_keywords: fresh,
        p_cap: MAX_KEYWORDS_PER_TRACKER,
      })
    : { data: [], error: null }
  if (error) throw new Error(`seo rank keyword add failed: ${error.message}`)
  const added = (data ?? []) as Array<{ id: string; keyword: string }>
  return {
    added,
    already_tracked: keywords.length - fresh.length,
    over_cap: Math.max(fresh.length - added.length, 0),
    rejected,
  }
}

/**
 * Add keywords to a tracker. Starts no check; a scheduled tracker checks them
 * from its next run on, so on one that is scheduled (and not paused) the add
 * raises what it spends: the access check, and `confirmed`.
 */
export async function addRankKeywords(
  svc: SupabaseClient,
  who: TrackerActor,
  trackerId: string,
  keywords: unknown,
  opts: { confirmed?: boolean } = {},
  deps: TrackerDeps = {},
): Promise<
  | ({ ok: true; tracker_id: string } & AddKeywordsOutcome)
  | RankFailure
  | RankRefusal
  | RankGoAheadRefusal
> {
  const list = keywordList(keywords)
  if (!Array.isArray(list)) return list
  if (list.length === 0) return invalid('Which keywords?')
  const row = await getTrackerRow(svc, who.workspaceId, trackerId)
  if (!row) return notFound()
  const planned = planUpdate(row, {}, deps.now?.() ?? new Date())
  if (!planned.ok) return planned
  const preview = await costPreview(
    svc,
    who.workspaceId,
    row,
    planned.plan,
    list,
  )
  if (preview.raises_cost) {
    const refused = await scheduleAccess(who, deps)
    if (refused) return refused
    if (opts.confirmed !== true)
      return goAheadRefusal('schedule', preview.after, preview.before)
  }
  return {
    ok: true,
    tracker_id: trackerId,
    ...(await insertKeywords(svc, row, list)),
  }
}

function idList(value: unknown): string[] | RankFailure {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (!Array.isArray(value) || value.length === 0)
    return invalid('Which keywords? Pass their ids.')
  if (value.length > MAX_KEYWORDS_PER_TRACKER)
    return invalid(`At most ${MAX_KEYWORDS_PER_TRACKER} ids at a time.`)
  const ids = [
    ...new Set(
      value.filter((v): v is string => typeof v === 'string' && UUID.test(v)),
    ),
  ]
  if (ids.length === 0) return invalid('Those aren’t keyword ids.')
  return ids
}

/** Stop following keywords. Their history stays. Unknown or foreign ids are ignored. */
export async function removeRankKeywords(
  svc: SupabaseClient,
  who: { workspaceId: string },
  trackerId: string,
  keywordIds: unknown,
): Promise<{ ok: true; removed: number } | RankFailure> {
  const ids = idList(keywordIds)
  if (!Array.isArray(ids)) return ids
  if (!(await getTrackerRow(svc, who.workspaceId, trackerId))) return notFound()
  const { data, error } = await svc
    .from('seo_rank_keyword')
    .delete()
    .eq('workspace_id', who.workspaceId)
    .eq('tracker_id', trackerId)
    .in('id', ids)
    .select('id')
  if (error) throw new Error(`seo rank keyword remove failed: ${error.message}`)
  return { ok: true, removed: (data ?? []).length }
}

/** Pin keywords to the top of the tracker's list, or unpin them. Pins are shared by the workspace. */
export async function pinRankKeywords(
  svc: SupabaseClient,
  who: { workspaceId: string },
  trackerId: string,
  keywordIds: unknown,
  pinned: boolean,
  deps: TrackerDeps = {},
): Promise<{ ok: true; updated: number } | RankFailure> {
  const ids = idList(keywordIds)
  if (!Array.isArray(ids)) return ids
  if (!(await getTrackerRow(svc, who.workspaceId, trackerId))) return notFound()
  const { data, error } = await svc
    .from('seo_rank_keyword')
    .update({
      pinned_at: pinned ? (deps.now?.() ?? new Date()).toISOString() : null,
    })
    .eq('workspace_id', who.workspaceId)
    .eq('tracker_id', trackerId)
    .in('id', ids)
    .select('id')
  if (error) throw new Error(`seo rank keyword pin failed: ${error.message}`)
  return { ok: true, updated: (data ?? []).length }
}

function notFound(): RankFailure {
  return {
    ok: false,
    code: 'NOT_FOUND',
    message: 'That rank tracker doesn’t exist.',
  }
}

interface PlannedUpdate {
  row: TrackerRow
  patch: Record<string, unknown>
  /** The tracker as it would be after the change. */
  after: Pick<
    TrackerRow,
    'devices' | 'serp_depth' | 'schedule_interval' | 'paused'
  >
}

/** Work out a settings change without writing it. */
function planUpdate(
  row: TrackerRow,
  input: UpdateTrackerInput,
  now: Date,
): { ok: true; plan: PlannedUpdate } | RankFailure {
  const devices = parseDevices(input.devices, row.devices)
  if (!devices) return invalid('Devices are desktop, mobile or both.')
  const depth = parseDepth(input.serp_depth, row.serp_depth)
  if (depth === null)
    return invalid(
      `The depth is how many results to read: ${MIN_SERP_DEPTH} to ${MAX_SERP_DEPTH}, in tens.`,
    )
  const interval = parseInterval(input.schedule_interval, row.schedule_interval)
  if (!interval)
    return invalid('The schedule is manual (off), daily, weekly or monthly.')
  if (input.paused !== undefined && typeof input.paused !== 'boolean')
    return invalid('paused is true or false.')
  const paused = (input.paused as boolean | undefined) ?? row.paused
  const time = parseScheduleTime(input.schedule_time)
  if (!time.ok) return time

  const patch: Record<string, unknown> = {}
  if (devices !== row.devices) patch.devices = devices
  if (depth !== row.serp_depth) patch.serp_depth = depth
  if (paused !== row.paused) patch.paused = paused

  // Move the anchor only when the schedule itself changed, so an edit of the
  // devices doesn't reshuffle the time (the source's rule).
  const scheduleChanged =
    time.time !== undefined ||
    interval !== row.schedule_interval ||
    (interval !== 'manual' && !row.next_check_at)
  if (scheduleChanged) {
    const chosen =
      time.time === undefined
        ? interval === row.schedule_interval
          ? storedTime(row)
          : undefined
        : time.time
    const next = resolveNextCheckAt(interval, chosen)
    if (!next.ok) return next
    patch.schedule_interval = interval
    patch.next_check_at =
      // Only the time moved: never earlier than the due time it replaces, so
      // a daily check done at 9:00 moved to 17:00 runs tomorrow at 17:00, not
      // a second time today.
      next.next &&
      interval === row.schedule_interval &&
      isScheduledRankTrackingInterval(interval) &&
      row.next_check_at
        ? notBefore(interval, next.next, row.next_check_at)
        : next.next
    Object.assign(patch, scheduleColumns(chosen))
  } else if (
    row.paused &&
    !paused &&
    isScheduledRankTrackingInterval(interval) &&
    row.next_check_at &&
    new Date(row.next_check_at).getTime() <= now.getTime()
  ) {
    // Resumed after its due time passed: the next slot on the same anchor,
    // not a check the moment it resumes.
    patch.next_check_at = computeNextCheckAt(interval, row.next_check_at)
  }
  return {
    ok: true,
    plan: {
      row,
      patch,
      after: {
        devices,
        serp_depth: depth,
        schedule_interval: interval,
        paused,
      },
    },
  }
}

/** The first due time of the schedule, from `next` on, that is not earlier than `floor`. */
function notBefore(
  interval: Parameters<typeof computeNextCheckAt>[0],
  next: string,
  floor: string,
): string {
  const until = new Date(floor).getTime()
  let at = next
  // A step is a day at least, and the floor is at most one period away (two
  // for a month's end): a few rounds. The bound only guards a bad row.
  for (let i = 0; i < 400 && new Date(at).getTime() < until; i++)
    at = computeNextCheckAt(interval, at)
  return at
}

function storedTime(row: TrackerRow): RankCheckScheduleTime | undefined {
  if (row.schedule_hour === null || row.schedule_minute === null)
    return undefined
  return {
    hour: row.schedule_hour,
    minute: row.schedule_minute,
    ...(row.schedule_weekday === null ? {} : { weekday: row.schedule_weekday }),
    ...(row.schedule_time_zone ? { timeZone: row.schedule_time_zone } : {}),
  }
}

function effectiveSchedule(
  t: Pick<TrackerRow, 'schedule_interval' | 'paused'>,
): RankTrackingScheduleInterval {
  return t.paused ? 'manual' : t.schedule_interval
}

export interface TrackerChangePreview {
  before: RankEstimateView
  after: RankEstimateView
  /** The change makes the tracker spend more on its own (see raisesCost). */
  raises_cost: boolean
}

/**
 * What a change would do to the tracker's cost, without writing it: settings
 * (`input`) and keywords to add (`addKeywords`). Free maths.
 */
export async function previewTrackerChange(
  svc: SupabaseClient,
  who: { workspaceId: string },
  trackerId: string,
  change: { input?: UpdateTrackerInput; addKeywords?: unknown[] },
  deps: TrackerDeps = {},
): Promise<({ ok: true } & TrackerChangePreview) | RankFailure> {
  const row = await getTrackerRow(svc, who.workspaceId, trackerId)
  if (!row) return notFound()
  const planned = planUpdate(
    row,
    change.input ?? {},
    deps.now?.() ?? new Date(),
  )
  if (!planned.ok) return planned
  return {
    ok: true,
    ...(await costPreview(
      svc,
      who.workspaceId,
      row,
      planned.plan,
      change.addKeywords ?? [],
    )),
  }
}

/** The cost before and after a planned change: the one maths behind the preview and the go-ahead rule. */
async function costPreview(
  svc: SupabaseClient,
  workspaceId: string,
  row: TrackerRow,
  plan: PlannedUpdate,
  addKeywords: readonly unknown[],
): Promise<TrackerChangePreview> {
  const keywords = (await readTrackerKeywords(svc, workspaceId, row.id)).map(
    (k) => k.keyword,
  )
  const extra = normalizeKeywords(addKeywords, row.language_code).keywords
  const existing = new Set(keywords)
  const proposed = [
    ...keywords,
    ...extra.filter((k) => !existing.has(k)),
  ].slice(0, Math.max(keywords.length, MAX_KEYWORDS_PER_TRACKER))
  const before = estimateView({
    keywords,
    devices: row.devices,
    serp_depth: row.serp_depth,
    schedule: effectiveSchedule(row),
  })
  const after = estimateView({
    keywords: proposed,
    devices: plan.after.devices,
    serp_depth: plan.after.serp_depth,
    schedule: effectiveSchedule(plan.after),
  })
  return { before, after, raises_cost: raisesCost(before, after) }
}

/**
 * Change a tracker's devices, depth, schedule or pause. Its site and market
 * stay (a new market is a new tracker). A change that turns on or raises what
 * it spends on its own needs the access check and `confirmed` (see the
 * header); pausing it, or turning its schedule off, stops its scheduled check
 * if one is running.
 */
export async function updateRankTracker(
  svc: SupabaseClient,
  who: TrackerActor,
  trackerId: string,
  input: UpdateTrackerInput,
  deps: TrackerDeps = {},
): Promise<
  | { ok: true; tracker: RankTrackerView }
  | RankFailure
  | RankRefusal
  | RankGoAheadRefusal
> {
  const row = await getTrackerRow(svc, who.workspaceId, trackerId)
  if (!row) return notFound()
  const planned = planUpdate(row, input, deps.now?.() ?? new Date())
  if (!planned.ok) return planned
  const scheduledBefore = effectiveSchedule(row) !== 'manual'
  const scheduledAfter = effectiveSchedule(planned.plan.after) !== 'manual'
  const preview = await costPreview(
    svc,
    who.workspaceId,
    row,
    planned.plan,
    [],
  )
  // Whoever turns the schedule on (a resume included), or sets its interval,
  // owns it from now on: the schedule's gate (./gate.ts) runs on that
  // person's standing, so it is theirs, not the creator's.
  const takesOwnership =
    (scheduledAfter && !scheduledBefore) ||
    (scheduledAfter &&
      planned.plan.after.schedule_interval !== row.schedule_interval)
  if (preview.raises_cost || takesOwnership) {
    const refused = await scheduleAccess(who, deps)
    if (refused) return refused
  }
  if (preview.raises_cost && input.confirmed !== true)
    return goAheadRefusal('schedule', preview.after, preview.before)
  // Only a person who just passed the access check above becomes the owner.
  const patch: Record<string, unknown> = takesOwnership
    ? { ...planned.plan.patch, created_by: who.userId, last_skip_reason: null }
    : planned.plan.patch
  if (Object.keys(patch).length > 0) {
    const { error } = await svc
      .from('seo_rank_tracker')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('workspace_id', who.workspaceId)
      .eq('id', trackerId)
    if (error)
      throw new Error(`seo rank tracker update failed: ${error.message}`)
  }
  // Its schedule stopped: a scheduled check still buying stops with it (the
  // cancel path, so its paid searches already posted stay paid, nothing more).
  if (scheduledBefore && !scheduledAfter)
    await cancelLiveRunsForTracker(
      svc,
      who.workspaceId,
      trackerId,
      { send: deps.send },
      { trigger: 'scheduled' },
    )
  const tracker = await getRankTracker(svc, who.workspaceId, trackerId)
  if (!tracker) return notFound()
  return { ok: true, tracker }
}

/** Delete a tracker with its keywords, checks and history. A check still running is stopped first. */
export async function deleteRankTracker(
  svc: SupabaseClient,
  who: { workspaceId: string },
  trackerId: string,
  deps: {
    send?: (event: {
      name: string
      data: Record<string, unknown>
    }) => Promise<unknown>
  } = {},
): Promise<{ ok: true; tracker: RankTrackerView } | RankFailure> {
  const tracker = await getRankTracker(svc, who.workspaceId, trackerId)
  if (!tracker) return notFound()
  await cancelLiveRunsForTracker(svc, who.workspaceId, trackerId, deps)
  const { error } = await svc
    .from('seo_rank_tracker')
    .delete()
    .eq('workspace_id', who.workspaceId)
    .eq('id', trackerId)
  if (error) throw new Error(`seo rank tracker delete failed: ${error.message}`)
  return { ok: true, tracker }
}

/**
 * The free maths for a tracker that isn't saved yet: what a check of these
 * keywords costs at most, and per month on the schedule. Nothing is read.
 */
export function estimateDraft(input: {
  keywords?: unknown
  language_code?: unknown
  devices?: unknown
  serp_depth?: unknown
  schedule_interval?: unknown
}): { ok: true; estimate: RankEstimateView } | RankFailure {
  const list = Array.isArray(input.keywords) ? input.keywords : []
  if (list.length > MAX_KEYWORDS_PER_TRACKER)
    return invalid(
      `A tracker follows at most ${MAX_KEYWORDS_PER_TRACKER} keywords.`,
    )
  const language =
    typeof input.language_code === 'string' && input.language_code
      ? input.language_code
      : 'en'
  const devices = parseDevices(input.devices, DEFAULT_DEVICES)
  if (!devices) return invalid('Devices are desktop, mobile or both.')
  const depth = parseDepth(input.serp_depth, DEFAULT_SERP_DEPTH)
  if (depth === null)
    return invalid(
      `The depth is how many results to read: ${MIN_SERP_DEPTH} to ${MAX_SERP_DEPTH}, in tens.`,
    )
  const interval = parseInterval(
    input.schedule_interval,
    DEFAULT_SCHEDULE_INTERVAL,
  )
  if (!interval)
    return invalid('The schedule is manual (off), daily, weekly or monthly.')
  return {
    ok: true,
    estimate: estimateView({
      keywords: normalizeKeywords(list, language).keywords,
      devices,
      serp_depth: depth,
      schedule: interval,
    }),
  }
}
