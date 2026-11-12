/**
 * One rank check, step by step: what the background lane
 * (src/lib/inngest/seo-rank-functions.ts) runs. Written against two small
 * ports, a store (./store.ts over migration 594) and the data provider
 * (./data-port.ts), so the tests run it whole against an in-memory store and
 * a stubbed provider.
 *
 *   claim      queued -> running, a compare-and-set (a redelivered attempt
 *              finds its own row running and carries on).
 *   prepare    the tracker and its keywords; a scheduled check asks the
 *              schedule's gate again (./gate.ts); a manual check buys at
 *              most what its start estimated (the figure the person saw and
 *              said yes to): a tracker that grew since (more keywords,
 *              devices or depth) fails it before anything is bought
 *              (ESTIMATE_CHANGED); the most the check can cost is held
 *              against what the workspace has left this month.
 *   reads      Google serves scrapers pages that leave real results out or
 *              reshuffle them, so one read can't be trusted. Every keyword
 *              and device is read MIN_READS_PER_CHECK times, and up to
 *              MAX_READS_PER_CHECK while a read missed the site or the
 *              positions disagree by more than two places; the best position
 *              wins. No new read starts an hour after the check began.
 *     post-R-B  one paid batch of up to 100 searches to the provider's
 *               standard queue. PAID, SO RUN ONCE: the step never throws
 *               past its marker (a thrown step is retried by the lane, and a
 *               retry pays again), and a marker row written before the call
 *               (seo_rank_post_begin) stops a re-run after a crash from
 *               posting a second time. A refusal of the monthly ceiling stops
 *               every later post. A scheduled check asks the schedule's gate
 *               again before each marker (the tracker paused, its person gone
 *               or on the free plan since the check began): a refusal stops
 *               every later post and ends the check in the gate's words,
 *               keeping what was already read; an answer that can't be read
 *               throws before the marker, so the lane retries the step and
 *               nothing is bought blind.
 *     wait-R-N  a sleep in the lane (no request held open): 4, 2, 2, 2, 2,
 *               3, 5, 5, 5, 15, 15 minutes, the source's cadence. Queued
 *               searches usually finish in about five minutes; collecting a
 *               slow one is free, posting it again is not.
 *     collect-R-N  FREE AND REPEATABLE: one free task_get per waiting search
 *               (at most 500 per step, 25 at a time), and the results
 *               written as they come (seo_rank_write_snapshots keeps a pair's
 *               first answer and then only a better position, so a re-run
 *               writes nothing new). A search still unfinished after the last
 *               wait is given up: its pair is "not checked", never waited on
 *               forever.
 *   drop-unconfirmed-misses  a pair every read missed that the previous
 *              check found reads as not checked, keeping its old position.
 *   resolve-goto-urls  Google's google.com/goto links become the real pages
 *              (a free call; best effort).
 *   finalize   completed (naming any keyword that got no result) or failed
 *              (nothing collected: the reason in words), the tracker's
 *              last_checked_at on a completed check.
 *
 * Adapted from OpenSEO (MIT, see ../THIRD_PARTY_NOTICES.md).
 */
import {
  DataforseoChargedTaskError,
  type PostedRankCheckTask,
  type RankCheckResult,
  type RankCheckTasksPostInput,
} from '@/lib/seo/dataforseo'
import { isSeoError } from '@/lib/seo/errors'
import { isGoogleRedirect } from '@/lib/seo/shared/google-serp-url'
import {
  estimateRankCheckUsd,
  MAX_READS_PER_CHECK,
  MAX_TASKS_PER_POST,
  MIN_READS_PER_CHECK,
} from '@/lib/seo/shared/rank-tracking'
import 'server-only'
import { scheduledCheckGate, type GateDeps } from './gate'
import { postKey, snapshotRowId } from './ids'
import {
  roundUsd,
  trackerDevices,
  type RankDevice,
  type RankTrackingDevices,
} from './view'

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

export interface RunRecord {
  id: string
  tracker_id: string
  workspace_id: string
  trigger: 'manual' | 'scheduled'
  status: 'queued' | 'running' | 'completed' | 'failed' | 'canceled'
  started_by: string | null
  /** The most the check may cost, as estimated (and confirmed) at its start. Numeric: may come back as a string. */
  estimate_usd: number | string
}

export interface TrackerRecord {
  id: string
  workspace_id: string
  created_by: string | null
  domain: string
  location_code: number
  language_code: string
  location_name: string | null
  devices: RankTrackingDevices
  serp_depth: number
  paused: boolean
}

/** A posted search, as a step carries it. */
export interface PostedTask {
  taskId: string
  keywordId: string
  device: RankDevice
}

export interface SnapshotWrite {
  id: string
  keyword_id: string
  keyword: string
  device: RankDevice
  position: number | null
  url: string | null
  serp_features: string[]
}

export interface StoredSnapshot {
  id: string
  keyword_id: string
  device: RankDevice
  position: number | null
  url: string | null
}

export interface RankRunStore {
  /** queued -> running (started_at set), or true when already running. */
  claimRun(runId: string, workspaceId: string): Promise<boolean>
  getRun(runId: string): Promise<RunRecord | null>
  getTracker(trackerId: string): Promise<TrackerRecord | null>
  listKeywords(
    trackerId: string,
  ): Promise<Array<{ id: string; keyword: string }>>
  /** Counts and the estimate, written only while the run is running. */
  updateRun(
    runId: string,
    patch: Partial<{
      keywords_total: number
      checks_total: number
      estimate_usd: number
      keywords_checked: number
      checks_collected: number
    }>,
  ): Promise<void>
  /** running -> completed | failed. False when the run was no longer running. */
  finishRun(
    runId: string,
    patch: {
      status: 'completed' | 'failed'
      keywords_checked: number
      checks_collected: number
      error_code: string | null
      error_detail: string | null
    },
  ): Promise<boolean>
  /** queued | running -> failed. False when it had already ended. */
  failRun(runId: string, code: string, message: string): Promise<boolean>
  beginPost(
    runId: string,
    key: string,
  ): Promise<{
    state: 'go' | 'posted' | 'unknown' | 'inactive'
    tasks: PostedTask[] | null
  }>
  recordPost(
    runId: string,
    key: string,
    tasks: PostedTask[],
    costUsd: number,
  ): Promise<void>
  writeSnapshots(runId: string, rows: SnapshotWrite[]): Promise<void>
  runSnapshots(runId: string): Promise<StoredSnapshot[]>
  dropUnconfirmedMisses(runId: string): Promise<number>
  setSnapshotUrls(rows: Array<{ id: string; url: string }>): Promise<void>
  markTrackerChecked(trackerId: string, at: string): Promise<void>
  monthlySpend(workspaceId: string): Promise<number>
}

export type CollectOutcome =
  | { status: 'pending' }
  | { status: 'failed'; message: string }
  | { status: 'completed'; result: RankCheckResult }

export interface RankDataPort {
  /** One metered task_post. Resolves to the accepted searches and what the provider charged. */
  post(
    input: RankCheckTasksPostInput,
  ): Promise<{ posted: PostedRankCheckTask[]; costUsd: number }>
  /** One free task_get. */
  collect(input: {
    taskId: string
    keywordId: string
    keyword: string
    targetDomain: string
  }): Promise<CollectOutcome>
  /** The free goto converter. */
  resolveGoto(urls: string[]): Promise<Map<string, string>>
}

export interface RankEngineDeps {
  store: RankRunStore
  /** The provider for this check, metered for this workspace (userId null: a scheduled check). */
  data: (who: { workspaceId: string; userId: string | null }) => RankDataPort
  gate: GateDeps
  now: () => number
  /** The workspace's monthly search data ceiling, in dollars. */
  capDollars: number
  /** When the ceiling starts over (for the refusal's words). */
  resetsOn: (now: number) => string
}

export type RankStep = {
  run: <T>(id: string, fn: () => Promise<T>) => Promise<T>
  sleep: (id: string, duration: string) => Promise<void>
}

// ---------------------------------------------------------------------------
// Constants (the source's)
// ---------------------------------------------------------------------------

/** Waits between reads of the queue: cumulative 4 / 6 / 8 / 10 / 12 / 15 / 20 / 25 / 30 / 45 / 60 minutes. */
export const QUEUED_POLL_INTERVALS = [
  '4m',
  '2m',
  '2m',
  '2m',
  '2m',
  '3m',
  '5m',
  '5m',
  '5m',
  '15m',
  '15m',
] as const
/** Concurrent task_get requests in a collect step. */
export const TASK_GET_CONCURRENCY = 25
/** task_get calls in one collect step at most. */
export const TASK_GETS_PER_COLLECT = 500
/** No new read starts this long after the check began, so a check ends in about two hours. */
export const READ_WINDOW_MS = 60 * 60_000
/** Positions this close together count as the reads agreeing. */
const READS_AGREE_WITHIN_POSITIONS = 2
/** Keywords a partial check's note names. */
const UNCHECKED_KEYWORDS_SHOWN = 10

// ---------------------------------------------------------------------------
// Reads: the pure part
// ---------------------------------------------------------------------------

export interface ReadPair {
  keywordId: string
  keyword: string
  device: RankDevice
  /** One entry per read: the position, or null (no page came back, or the site wasn't on it). */
  reads: Array<number | null>
  /** Whether any read got a page back. */
  answered: boolean
}

export function pairKey(keywordId: string, device: string): string {
  return `${keywordId}:${device}`
}

export function expandPairs(
  keywords: ReadonlyArray<{ id: string; keyword: string }>,
  devices: readonly RankDevice[],
): ReadPair[] {
  return keywords.flatMap((kw) =>
    devices.map((device) => ({
      keywordId: kw.id,
      keyword: kw.keyword,
      device,
      reads: [],
      answered: false,
    })),
  )
}

function found(pair: ReadPair): number[] {
  return pair.reads.filter((p): p is number => p !== null)
}

export function bestPosition(pair: ReadPair): number | null {
  const f = found(pair)
  return f.length > 0 ? Math.min(...f) : null
}

/** Fewer than the minimum reads, a read that missed, or reads more than two places apart. */
export function needsAnotherRead(pair: ReadPair): boolean {
  if (pair.reads.length < MIN_READS_PER_CHECK) return true
  const f = found(pair)
  if (f.length < pair.reads.length) return true
  return Math.max(...f) - Math.min(...f) > READS_AGREE_WITHIN_POSITIONS
}

/** Add one read's results to the pairs that were read in it. A pair with no result this read counts a miss. */
export function mergeRead(
  pairs: ReadPair[],
  read: readonly ReadPair[],
  results: ReadonlyArray<[string, string, number | null]>,
): void {
  const got = new Map(
    results.map(([keywordId, device, position]) => [
      pairKey(keywordId, device),
      position,
    ]),
  )
  const wasRead = new Set(read.map((p) => pairKey(p.keywordId, p.device)))
  for (const pair of pairs) {
    const key = pairKey(pair.keywordId, pair.device)
    if (!wasRead.has(key)) continue
    const has = got.has(key)
    pair.reads.push(has ? (got.get(key) ?? null) : null)
    pair.answered = pair.answered || has
  }
}

/** Names a partial check's keywords that got no result, so people see which. */
export function describeUnchecked(
  keywords: ReadonlyArray<{ id: string; keyword: string }>,
  devices: readonly RankDevice[],
  snapshots: ReadonlyArray<{ keyword_id: string; device: string }>,
): string {
  const checked = new Set(snapshots.map((s) => pairKey(s.keyword_id, s.device)))
  const unchecked = keywords.flatMap((kw) => {
    const missing = devices.filter((d) => !checked.has(pairKey(kw.id, d)))
    if (missing.length === 0) return []
    // The device only when the other one got a result.
    return missing.length < devices.length
      ? [`"${kw.keyword}" (${missing[0]})`]
      : [`"${kw.keyword}"`]
  })
  if (unchecked.length === 0) return ''
  const shown = unchecked.slice(0, UNCHECKED_KEYWORDS_SHOWN).join(', ')
  const more = unchecked.length - UNCHECKED_KEYWORDS_SHOWN
  return `Not checked: ${shown}${more > 0 ? ` and ${more} more` : ''}.`
}

/** Google adds srsltid to many result links; it isn't part of the page. */
export function withoutGoogleTracking(url: string): string {
  try {
    const parsed = new URL(url)
    if (!parsed.searchParams.has('srsltid')) return url
    parsed.searchParams.delete('srsltid')
    return parsed.toString()
  } catch {
    return url
  }
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/** A failure the check names: final, written to the run in words, never retried. */
export class RankCheckFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'RankCheckFailure'
  }
}

type Named = { failure: { code: string; message: string } }

async function named<T>(fn: () => Promise<T>): Promise<T | Named> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof RankCheckFailure)
      return { failure: { code: err.code, message: err.message } }
    throw err
  }
}

function isNamed(value: unknown): value is Named {
  return !!value && typeof value === 'object' && 'failure' in value
}

export interface PreparedCheck {
  runId: string
  workspaceId: string
  trackerId: string
  /** Whose request the searches are metered under; null for a scheduled check. */
  payer: string | null
  /** A scheduled check: every paid batch asks the schedule's gate first. */
  scheduled: boolean
  domain: string
  locationCode: number
  languageCode: string
  locationName: string | null
  depth: number
  devices: RankDevice[]
  keywords: Array<{ id: string; keyword: string }>
  readsEndAt: number
}

async function prepareCheck(
  deps: RankEngineDeps,
  runId: string,
): Promise<PreparedCheck | { inactive: true }> {
  const run = await deps.store.getRun(runId)
  if (!run || run.status !== 'running') return { inactive: true }
  const tracker = await deps.store.getTracker(run.tracker_id)
  if (!tracker) return { inactive: true }
  const keywords = await deps.store.listKeywords(tracker.id)
  if (keywords.length === 0)
    throw new RankCheckFailure(
      'NO_KEYWORDS',
      'The tracker has no keywords to check.',
    )

  if (run.trigger === 'scheduled') {
    const gate = await scheduledCheckGate(tracker, keywords.length, deps.gate)
    // Couldn't tell: a thrown error, so the lane retries this free step.
    if (!gate.ok && gate.retry) throw new Error(gate.message)
    if (!gate.ok) throw new RankCheckFailure('SKIPPED', gate.message)
  }

  const devices = trackerDevices(tracker.devices)
  const { costUsd } = estimateRankCheckUsd(
    keywords.map((k) => k.keyword),
    tracker.devices,
    tracker.serp_depth,
  )
  // A manual check buys what its start priced, never more: the tracker can
  // grow between the start and this step (a change to a tracker checked by
  // hand costs nothing on its own, so it asks nobody). A scheduled check
  // isn't held to it: every rise of a schedule's cost was confirmed when it
  // was made.
  if (
    run.trigger === 'manual' &&
    roundUsd(costUsd) > roundUsd(Number(run.estimate_usd) || 0) + 1e-6
  )
    throw new RankCheckFailure(
      'ESTIMATE_CHANGED',
      'The tracker changed after this check was started, so it was not run. Nothing was bought. Start it again.',
    )
  // The most this check can cost, against what is left this month: a check
  // that can't finish inside the ceiling isn't started (the source's rule).
  // A ledger that can't be read throws: the step retries, it never spends blind.
  const spent = await deps.store.monthlySpend(tracker.workspace_id)
  if (spent + costUsd > deps.capDollars) {
    const left = Math.max(deps.capDollars - spent, 0)
    throw new RankCheckFailure(
      'SPEND_LIMIT_REACHED',
      `This check could cost up to $${roundUsd(costUsd).toFixed(2)}, more than this workspace has left of its search data limit this month ($${left.toFixed(2)} of $${deps.capDollars}). It starts over on ${deps.resetsOn(deps.now())}.`,
    )
  }
  await deps.store.updateRun(runId, {
    keywords_total: keywords.length,
    checks_total: keywords.length * devices.length,
    estimate_usd: roundUsd(costUsd),
  })
  return {
    runId,
    workspaceId: tracker.workspace_id,
    trackerId: tracker.id,
    payer: run.trigger === 'manual' ? run.started_by : null,
    scheduled: run.trigger === 'scheduled',
    domain: tracker.domain,
    locationCode: tracker.location_code,
    languageCode: tracker.language_code,
    locationName: tracker.location_name,
    depth: tracker.serp_depth,
    devices,
    keywords,
    readsEndAt: deps.now() + READ_WINDOW_MS,
  }
}

type PostOutcome =
  | { outcome: 'posted' | 'recovered' | 'lost'; tasks: PostedTask[] }
  | {
      outcome: 'failed' | 'spend_limit' | 'inactive' | 'refused'
      tasks: PostedTask[]
      message: string
    }

/** One paid batch. Never throws past the marker: see the file header. */
async function postBatch(
  deps: RankEngineDeps,
  port: RankDataPort,
  ctx: PreparedCheck,
  key: string,
  chunk: readonly ReadPair[],
): Promise<PostOutcome> {
  if (ctx.scheduled) {
    // The person's standing can change while a check runs (about an hour):
    // nothing is bought on a schedule that may no longer spend.
    const tracker = await deps.store.getTracker(ctx.trackerId)
    if (!tracker)
      return {
        outcome: 'inactive',
        tasks: [],
        message: 'The check was stopped.',
      }
    const gate = await scheduledCheckGate(
      tracker,
      ctx.keywords.length,
      deps.gate,
    )
    // Couldn't tell: a throw BEFORE the marker, so the lane's retry of this
    // step can still post once, and nothing was bought.
    if (!gate.ok && gate.retry) throw new Error(gate.message)
    if (!gate.ok) return { outcome: 'refused', tasks: [], message: gate.message }
  }
  const begun = await deps.store.beginPost(ctx.runId, key)
  if (begun.state === 'inactive')
    return { outcome: 'inactive', tasks: [], message: 'The check was stopped.' }
  // A re-run of this step: the attempt before it already posted (or may
  // have). Take back what it wrote; never post again.
  if (begun.state === 'posted')
    return { outcome: 'recovered', tasks: begun.tasks ?? [] }
  if (begun.state === 'unknown') {
    console.warn(
      '[seo-rank] a paid batch was claimed by an attempt that never recorded it; not posting again',
      { runId: ctx.runId, key },
    )
    return { outcome: 'lost', tasks: [] }
  }
  try {
    const { posted, costUsd } = await port.post({
      tasks: chunk.map((p) => ({
        keyword: p.keyword,
        keywordId: p.keywordId,
        device: p.device,
      })),
      locationCode: ctx.locationCode,
      languageCode: ctx.languageCode,
      locationName: ctx.locationName ?? undefined,
      depth: ctx.depth,
    })
    const tasks = posted.map((t) => ({
      taskId: t.taskId,
      keywordId: t.keywordId,
      device: t.device,
    }))
    await deps.store
      .recordPost(ctx.runId, key, tasks, costUsd)
      .catch((err) =>
        console.error('[seo-rank] posted batch not recorded', {
          runId: ctx.runId,
          key,
          err,
        }),
      )
    return { outcome: 'posted', tasks }
  } catch (err) {
    const charged =
      err instanceof DataforseoChargedTaskError ? err.billing.costUsd : 0
    await deps.store.recordPost(ctx.runId, key, [], charged).catch(() => {})
    if (isSeoError(err) && err.code === 'SPEND_LIMIT_REACHED')
      return { outcome: 'spend_limit', tasks: [], message: err.message }
    console.error('[seo-rank] batch post failed', {
      runId: ctx.runId,
      key,
      err,
    })
    return {
      outcome: 'failed',
      tasks: [],
      message:
        isSeoError(err) && err.code === 'UPSTREAM_UNAVAILABLE'
          ? 'The search data provider didn’t answer. Try again in a moment.'
          : 'Some searches could not be sent to the search data provider.',
    }
  }
}

type CollectStepOutput = {
  completed: Array<[string, RankDevice, number | null]>
  stillPending: PostedTask[]
}

/** Free and repeatable: read the waiting searches and write what came back. */
async function collectBatch(
  deps: RankEngineDeps,
  port: RankDataPort,
  ctx: PreparedCheck,
  batch: readonly PostedTask[],
): Promise<CollectStepOutput> {
  const text = new Map(ctx.keywords.map((k) => [k.id, k.keyword]))
  const rows: SnapshotWrite[] = []
  const stillPending: PostedTask[] = []
  for (let i = 0; i < batch.length; i += TASK_GET_CONCURRENCY) {
    const chunk = batch.slice(i, i + TASK_GET_CONCURRENCY)
    const settled = await Promise.allSettled(
      chunk.map((task) =>
        port.collect({
          taskId: task.taskId,
          keywordId: task.keywordId,
          keyword: text.get(task.keywordId) ?? '',
          targetDomain: ctx.domain,
        }),
      ),
    )
    settled.forEach((result, index) => {
      const task = chunk[index]
      // A failed read of the queue: ask again next round (free).
      if (result.status === 'rejected' || result.value.status === 'pending') {
        stillPending.push(task)
        return
      }
      if (result.value.status === 'failed') {
        console.warn('[seo-rank] search failed at the provider', {
          runId: ctx.runId,
          message: result.value.message,
        })
        return
      }
      const r = result.value.result
      rows.push({
        id: snapshotRowId(ctx.runId, task.keywordId, task.device),
        keyword_id: task.keywordId,
        keyword: text.get(task.keywordId) ?? r.keyword,
        device: task.device,
        position: r.position,
        url: r.url,
        serp_features: r.serpFeatures,
      })
    })
  }
  if (rows.length > 0) {
    try {
      await deps.store.writeSnapshots(ctx.runId, rows)
      const snaps = await deps.store.runSnapshots(ctx.runId)
      await deps.store.updateRun(ctx.runId, {
        keywords_checked: new Set(snaps.map((s) => s.keyword_id)).size,
        checks_collected: snaps.length,
      })
    } catch (err) {
      // Collection is free: hand the whole batch to the next round rather than fail the check.
      console.error(
        '[seo-rank] writing results failed; collecting again next round',
        { runId: ctx.runId, err },
      )
      return { completed: [], stillPending: [...batch] }
    }
  }
  return {
    completed: rows.map((r) => [r.keyword_id, r.device, r.position]),
    stillPending,
  }
}

interface ReadRoundOutcome {
  results: Array<[string, string, number | null]>
  /** The first failure a batch reported, in words. */
  error: string | null
  /** Posting stopped for the rest of the check (the ceiling or the schedule's gate refused, or the check was stopped). */
  stop: 'spend_limit' | 'refused' | 'inactive' | null
}

async function readRound(
  step: RankStep,
  deps: RankEngineDeps,
  port: RankDataPort,
  ctx: PreparedCheck,
  read: number,
  toRead: readonly ReadPair[],
): Promise<ReadRoundOutcome> {
  let pending: PostedTask[] = []
  let error: string | null = null
  let stop: ReadRoundOutcome['stop'] = null
  // A failed batch doesn't stop the others: searches already posted are paid for and must be collected.
  for (
    let i = 0, batch = 0;
    i < toRead.length;
    i += MAX_TASKS_PER_POST, batch++
  ) {
    const chunk = toRead.slice(i, i + MAX_TASKS_PER_POST)
    const out = await step.run(`post-${read}-${batch}`, () =>
      postBatch(deps, port, ctx, postKey(read, batch), chunk),
    )
    pending.push(...out.tasks)
    if ('message' in out) {
      error = error ?? out.message
      if (
        out.outcome === 'spend_limit' ||
        out.outcome === 'refused' ||
        out.outcome === 'inactive'
      ) {
        error = out.message
        stop = out.outcome
        break
      }
    }
  }
  // Stopped: its results would not count, so there is nothing to wait for.
  if (stop === 'inactive') return { results: [], error, stop }

  const results: Array<[string, string, number | null]> = []
  for (
    let round = 0;
    round < QUEUED_POLL_INTERVALS.length && pending.length > 0;
    round++
  ) {
    await step.sleep(`wait-${read}-${round}`, QUEUED_POLL_INTERVALS[round])
    const batch = pending.slice(0, TASK_GETS_PER_COLLECT)
    const overflow = pending.slice(TASK_GETS_PER_COLLECT)
    const out = await step.run(`collect-${read}-${round}`, () =>
      collectBatch(deps, port, ctx, batch),
    )
    results.push(...out.completed)
    pending = [...out.stillPending, ...overflow]
  }
  if (pending.length > 0)
    console.warn(
      '[seo-rank] searches never came back; their pairs read as not checked',
      { runId: ctx.runId, read, count: pending.length },
    )
  return { results, error, stop }
}

async function resolveRunGotoUrls(
  deps: RankEngineDeps,
  port: RankDataPort,
  runId: string,
): Promise<number> {
  const snaps = await deps.store.runSnapshots(runId)
  const wrapped = snaps.flatMap(({ id, url }) =>
    url && isGoogleRedirect(url) ? [{ id, url }] : [],
  )
  let resolved = 0
  for (let i = 0; i < wrapped.length; i += 100) {
    const chunk = wrapped.slice(i, i + 100)
    const pages = await port.resolveGoto(chunk.map(({ url }) => url))
    const rows = chunk.flatMap(({ id, url }) => {
      const page = pages.get(url)
      return page
        ? [{ id, url: withoutGoogleTracking(page).slice(0, 2048) }]
        : []
    })
    await deps.store.setSnapshotUrls(rows)
    resolved += rows.length
  }
  return resolved
}

async function finalizeCheck(
  deps: RankEngineDeps,
  ctx: PreparedCheck,
  outcome: {
    error: string | null
    stoppedBySpend: boolean
    /** The schedule's gate refused a later batch: its words. */
    stoppedByGate?: boolean
  },
): Promise<{ status: string; runId: string }> {
  const run = await deps.store.getRun(ctx.runId)
  const nowIso = new Date(deps.now()).toISOString()
  if (!run) return { status: 'gone', runId: ctx.runId }
  // An earlier attempt of this step got as far as completing: finish its tracker write.
  if (run.status === 'completed') {
    await deps.store.markTrackerChecked(ctx.trackerId, nowIso)
    return { status: 'completed', runId: ctx.runId }
  }
  // Canceled, or failed by someone else: their decision stands.
  if (run.status !== 'running') return { status: run.status, runId: ctx.runId }

  const snaps = await deps.store.runSnapshots(ctx.runId)
  const keywordsChecked = new Set(snaps.map((s) => s.keyword_id)).size
  const pairsTotal = ctx.keywords.length * ctx.devices.length
  let status: 'completed' | 'failed' = 'completed'
  let code: string | null = null
  let detail: string | null = null
  const stopped = outcome.stoppedBySpend || outcome.stoppedByGate === true
  const stopCode = outcome.stoppedByGate ? 'SKIPPED' : 'SPEND_LIMIT_REACHED'
  if (keywordsChecked === 0) {
    status = 'failed'
    code = stopped ? stopCode : 'NOTHING_COLLECTED'
    detail =
      outcome.error ??
      'No keyword could be checked: Google’s results didn’t come back in time. Run the check again later.'
  } else if (snaps.length < pairsTotal) {
    code = stopped ? stopCode : 'PARTIAL'
    const checkedSummary =
      ctx.devices.length > 1
        ? ctx.devices
            .map(
              (device) =>
                `${new Set(snaps.filter((s) => s.device === device).map((s) => s.keyword_id)).size} of ${ctx.keywords.length} ${device}`,
            )
            .join(' and ')
        : `${keywordsChecked} of ${ctx.keywords.length}`
    detail = [
      `Checked ${checkedSummary} keyword(s).`,
      describeUnchecked(ctx.keywords, ctx.devices, snaps),
      stopped ? outcome.error : null,
    ]
      .filter(Boolean)
      .join(' ')
      .slice(0, 2000)
  } else if (outcome.stoppedByGate) {
    // Every pair has a result, but its later reads were stopped: say why.
    code = stopCode
    detail = outcome.error
  }
  const finished = await deps.store.finishRun(ctx.runId, {
    status,
    keywords_checked: keywordsChecked,
    checks_collected: snaps.length,
    error_code: code,
    error_detail: detail,
  })
  // A failed check must not move last_checked_at: nothing was checked.
  if (finished && status === 'completed')
    await deps.store.markTrackerChecked(ctx.trackerId, nowIso)
  console.log('[seo-rank] check ended', {
    runId: ctx.runId,
    status,
    keywordsChecked,
    keywordsTotal: ctx.keywords.length,
    code,
  })
  return { status: finished ? status : 'superseded', runId: ctx.runId }
}

// ---------------------------------------------------------------------------
// The whole check
// ---------------------------------------------------------------------------

export async function runRankCheck(
  step: RankStep,
  deps: RankEngineDeps,
  data: { runId: string; workspaceId: string },
): Promise<Record<string, unknown>> {
  const { runId, workspaceId } = data
  const claimed = await step.run('claim', () =>
    deps.store.claimRun(runId, workspaceId),
  )
  if (!claimed) return { skipped: 'not_claimable', runId }

  const prepared = await step.run('prepare', () =>
    named(() => prepareCheck(deps, runId)),
  )
  if (isNamed(prepared)) {
    return step.run('record-failure', async () => {
      await deps.store.failRun(
        runId,
        prepared.failure.code,
        prepared.failure.message,
      )
      return { status: 'failed', code: prepared.failure.code, runId }
    })
  }
  if ('inactive' in prepared) return { skipped: 'inactive', runId }
  const ctx = prepared
  const port = deps.data({ workspaceId: ctx.workspaceId, userId: ctx.payer })

  const pairs = expandPairs(ctx.keywords, ctx.devices)
  let error: string | null = null
  let stoppedBySpend = false
  let stoppedByGate = false
  for (let read = 1; read <= MAX_READS_PER_CHECK; read++) {
    if (read > 1) {
      // The clock is read inside a step, so a replay makes the same decision.
      const window = await step.run(`window-${read}`, async () => ({
        open: deps.now() < ctx.readsEndAt,
      }))
      if (!window.open) break
    }
    const toRead = read === 1 ? pairs : pairs.filter(needsAnotherRead)
    if (toRead.length === 0) break
    const round = await readRound(step, deps, port, ctx, read, toRead)
    mergeRead(pairs, toRead, round.results)
    if (round.stop === 'spend_limit' || round.stop === 'refused') {
      if (round.stop === 'spend_limit') stoppedBySpend = true
      else stoppedByGate = true
      error = round.error
    } else error = error ?? round.error
    if (round.stop) break
  }

  await step.run('drop-unconfirmed-misses', () =>
    deps.store.dropUnconfirmedMisses(runId),
  )
  await step.run('resolve-goto-urls', async () => {
    try {
      return { resolved: await resolveRunGotoUrls(deps, port, runId) }
    } catch (err) {
      // The positions are saved, and a goto link still leads to the page.
      console.warn('[seo-rank] goto links not resolved', { runId, err })
      return { resolved: 0 }
    }
  })
  return step.run('finalize', () =>
    finalizeCheck(deps, ctx, { error, stoppedBySpend, stoppedByGate }),
  )
}
