/**
 * Live Google results for one keyword (a SERP check): who ranks, in which
 * order, with which SERP features.
 *
 * Each check reads the page three times (./serp-merge.ts says why) in one
 * high-priority post to the provider; the reads usually come back within
 * about 20 seconds. The flow:
 *
 *   1. A stored check for the same keyword, market, device and depth (kind
 *      serp_results, 12 hours; one that found nothing, SERP_EMPTY_MAX_AGE_MS)
 *      answers instead of buying again. If some of its reads were still out,
 *      each is checked once more (free: the provider bills the post, not the
 *      collection). With `refresh`, a check still collecting and younger than
 *      SERP_REFRESH_COLLECTING_MS is collected the same way instead of bought
 *      again: "call again" while the first reads are out never buys twice.
 *   2. Otherwise, after the access check, the reads are bought and the
 *      lookup row is written AT ONCE with their task ids (the receipt), so a
 *      caller that lost the answer, or got "still collecting", collects the
 *      same reads by asking again instead of buying them twice.
 *   3. The reads are collected until they are all in or the deadline passes
 *      (40 seconds after the call started, so a route or tool call answers
 *      within about a minute even when the post itself was slow). What is in
 *      by then is merged and returned: `partial` with the rest still coming,
 *      or `collecting` when none is back. Asking again (the same request, or
 *      GET /api/account/seo/serp/[lookup_id]) collects the rest for free.
 *   4. When every read is in and nothing was found, the check is kept, but
 *      answers only for SERP_EMPTY_MAX_AGE_MS ("nothing found yet"): the
 *      provider also reports "no results" transiently, and a page found
 *      later must not wait 12 hours. `refresh` buys again on the person's
 *      ask. When every read failed, nothing came back: the row is deleted and
 *      the call fails, so the next ask buys fresh reads.
 *
 * Adapted from OpenSEO (MIT, see ../THIRD_PARTY_NOTICES.md).
 */
import type { SeoDataRefusal } from '@/lib/seo/access'
import { dataforseoPricing, fetchSerpTaskResult } from '@/lib/seo/dataforseo'
import { SeoError } from '@/lib/seo/errors'
import { SeoInputError } from '@/lib/seo/input-error'
import {
  deleteLookup,
  getLookup,
  HOUR_MS,
  readLookup,
  updateLookupResult,
  writeLookup,
} from '@/lib/seo/lookup-cache'
import { paidSeoClient, type SeoPaidDeps, type SeoWho } from '@/lib/seo/paid'
import type { SupabaseClient } from '@supabase/supabase-js'
import 'server-only'
import { resolveSerpMarket } from './market'
import {
  mergeSerpReads,
  serpItemsView,
  trimSerpItem,
  type SerpReadItem,
} from './serp-merge'
import {
  DEFAULT_SERP_DEPTH,
  describeMarket,
  normalizeKeyword,
  SERP_DEPTHS,
  type SerpDevice,
  type SerpResult,
} from './view'

export const SERP_RESULTS_KIND = 'serp_results'
export const SERP_MAX_AGE_MS = 12 * HOUR_MS
/** How long a check that found nothing answers the same question. */
export const SERP_EMPTY_MAX_AGE_MS = 3 * HOUR_MS
/**
 * With `refresh`, a stored check younger than this whose reads are still out
 * is collected instead of bought again (the reads usually land within a
 * minute; a minute-old "refresh" is the same question asked again).
 */
export const SERP_REFRESH_COLLECTING_MS = 5 * 60 * 1000
/** How long one call collects reads, counted from when it started. */
export const SERP_COLLECT_MS = 40_000
const SERP_POLL_MS = 3_000
/** The least time one poll gets, even past the deadline. */
const SERP_POLL_MIN_MS = 1_000
const SERP_VERSION = 1
const KEYWORD_MAX_LENGTH = 120

type TaskOutcome =
  | { status: 'pending' }
  | { status: 'failed'; message: string }
  | { status: 'completed'; items: Parameters<typeof trimSerpItem>[0][] }

export interface StoredSerpRead {
  task_id: string
  state: 'pending' | 'done' | 'failed'
  items?: SerpReadItem[]
  message?: string
}

export interface StoredSerp {
  v: number
  keyword: string
  location_code: number
  language_code: string
  device: SerpDevice
  depth: number
  reads: StoredSerpRead[]
}

export interface SerpInput {
  keyword: string
  location_code?: number | null
  language_code?: string | null
  device?: SerpDevice
  /** Results to read, a multiple of 10 up to 100 (default 10: page one). A deeper read costs more. */
  depth?: number
  refresh?: boolean
}

export interface ResolvedSerp {
  keyword: string
  locationCode: number
  languageCode: string
  device: SerpDevice
  depth: number
}

export interface SerpDeps extends SeoPaidDeps {
  /** Collects one read (default: the provider's free task collection). */
  fetchTask?: (taskId: string, signal?: AbortSignal) => Promise<TaskOutcome>
  /** Epoch ms at which collection stops (default: SERP_COLLECT_MS from now). Share one across a batch. */
  deadline?: number
  clock?: () => number
  sleep?: (ms: number) => Promise<void>
  pollMs?: number
}

export function resolveSerp(input: SerpInput): ResolvedSerp {
  const keyword = normalizeKeyword(input.keyword ?? '')
  if (!keyword) throw new SeoInputError('Give a keyword to look up.')
  if (keyword.length > KEYWORD_MAX_LENGTH)
    throw new SeoInputError(
      `Keep the keyword under ${KEYWORD_MAX_LENGTH} characters.`,
    )
  const depth = input.depth ?? DEFAULT_SERP_DEPTH
  if (!(SERP_DEPTHS as readonly number[]).includes(depth))
    throw new SeoInputError('Depth is a multiple of 10, from 10 to 100.')
  const market = resolveSerpMarket(input)
  return {
    keyword,
    ...market,
    device: input.device === 'mobile' ? 'mobile' : 'desktop',
    depth,
  }
}

export function serpRequestKey(r: ResolvedSerp) {
  return {
    v: SERP_VERSION,
    keyword: r.keyword,
    location_code: r.locationCode,
    language_code: r.languageCode,
    device: r.device,
    depth: r.depth,
  }
}

export function estimateSerpUsd(r: ResolvedSerp): number {
  return dataforseoPricing.serp.readsTaskPost({
    keyword: r.keyword,
    locationCode: r.locationCode,
    languageCode: r.languageCode,
    depth: r.depth,
    device: r.device,
  })
}

function isStoredSerp(value: unknown): value is StoredSerp {
  return (
    !!value &&
    typeof value === 'object' &&
    Array.isArray((value as StoredSerp).reads) &&
    typeof (value as StoredSerp).keyword === 'string'
  )
}

function hasPendingReads(stored: StoredSerp): boolean {
  return stored.reads.some((read) => read.state === 'pending')
}

/** Every read in, at least one answered, and nothing found. */
function foundNothing(stored: StoredSerp): boolean {
  return (
    !hasPendingReads(stored) &&
    stored.reads.some((read) => read.state === 'done') &&
    stored.reads.every((read) => !read.items?.length)
  )
}

/** Whether a stored check still answers the same question at `now`. */
function stillAnswers(
  hit: { result: unknown; fetched_at: string },
  now: Date,
): hit is { result: StoredSerp; fetched_at: string } {
  if (!isStoredSerp(hit.result)) return false
  if (!foundNothing(hit.result)) return true
  return now.getTime() - Date.parse(hit.fetched_at) <= SERP_EMPTY_MAX_AGE_MS
}

const realSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Checks the reads still out: once each (`once`), or round after round until
 * all are in or the deadline passes. A poll that fails says nothing about the
 * read (it is already paid for): it stays pending.
 */
export async function collectReads(
  reads: readonly StoredSerpRead[],
  opts: {
    once: boolean
    deadline: number
    fetchTask: NonNullable<SerpDeps['fetchTask']>
    clock: () => number
    sleep: (ms: number) => Promise<void>
    pollMs: number
  },
): Promise<StoredSerpRead[]> {
  const out = reads.map((read) => ({ ...read }))
  for (;;) {
    const pending = out.filter((read) => read.state === 'pending')
    if (pending.length === 0) return out
    await Promise.all(
      pending.map(async (read) => {
        const signal = AbortSignal.timeout(
          Math.max(opts.deadline - opts.clock(), SERP_POLL_MIN_MS),
        )
        const outcome = await opts
          .fetchTask(read.task_id, signal)
          .catch((err: unknown): TaskOutcome => {
            console.warn('[seo-serp] read poll failed', {
              taskId: read.task_id,
              err: err instanceof Error ? err.message : String(err),
            })
            return { status: 'pending' }
          })
        if (outcome.status === 'completed') {
          read.state = 'done'
          read.items = outcome.items.map(trimSerpItem)
        } else if (outcome.status === 'failed') {
          read.state = 'failed'
          read.message = outcome.message.slice(0, 300)
        }
      }),
    )
    if (
      opts.once ||
      !out.some((read) => read.state === 'pending') ||
      opts.clock() + opts.pollMs > opts.deadline
    )
      return out
    await opts.sleep(opts.pollMs)
  }
}

/** What the stored reads say right now, as the API returns it. */
export function serpResultFrom(
  stored: StoredSerp,
  meta: { lookup_id: string | null; fetched_at: string; from_cache: boolean },
): SerpResult {
  const done = stored.reads.filter((read) => read.state === 'done')
  const pending = stored.reads.some((read) => read.state === 'pending')
  const items = serpItemsView(
    mergeSerpReads(done.map((read) => read.items ?? [])),
  )
  return {
    ...meta,
    keyword: stored.keyword,
    location_code: stored.location_code,
    language_code: stored.language_code,
    device: stored.device,
    depth: stored.depth,
    status: !pending ? 'complete' : items.length > 0 ? 'partial' : 'collecting',
    reads_total: stored.reads.length,
    reads_in: done.length,
    items,
    fetched_at: meta.fetched_at,
  }
}

/**
 * Writes what collection found and answers it. Every read failed: the row is
 * deleted (a retry buys fresh reads) and that is an error. Every read in and
 * nothing found: the row is kept, and answers for SERP_EMPTY_MAX_AGE_MS.
 */
async function settle(
  svc: SupabaseClient,
  workspaceId: string,
  row: { id: string | null; fetched_at: string; from_cache: boolean },
  stored: StoredSerp,
): Promise<SerpResult> {
  const result = serpResultFrom(stored, {
    lookup_id: row.id,
    fetched_at: row.fetched_at,
    from_cache: row.from_cache,
  })
  if (
    result.status === 'complete' &&
    result.items.length === 0 &&
    !stored.reads.some((read) => read.state === 'done')
  ) {
    if (row.id) await deleteLookup(svc, workspaceId, row.id)
    throw new SeoError(
      'UPSTREAM_UNAVAILABLE',
      'Every read of this search failed at the search data provider. Try again in a moment.',
    )
  }
  if (row.id) await updateLookupResult(svc, workspaceId, row.id, stored)
  return result
}

function collectOptions(deps: SerpDeps, once: boolean) {
  const clock = deps.clock ?? Date.now
  return {
    once,
    deadline: deps.deadline ?? clock() + SERP_COLLECT_MS,
    fetchTask:
      deps.fetchTask ??
      (fetchSerpTaskResult as NonNullable<SerpDeps['fetchTask']>),
    clock,
    sleep: deps.sleep ?? realSleep,
    pollMs: deps.pollMs ?? SERP_POLL_MS,
  }
}

/** Whether a check for this request is stored (complete, or still collecting): asking for it again costs nothing. */
export async function hasStoredSerp(
  svc: SupabaseClient,
  workspaceId: string,
  r: ResolvedSerp,
  now: Date = new Date(),
): Promise<boolean> {
  const hit = await readLookup<StoredSerp>(
    svc,
    workspaceId,
    SERP_RESULTS_KIND,
    serpRequestKey(r),
    { maxAgeMs: SERP_MAX_AGE_MS, now },
  )
  return !!hit && stillAnswers(hit, now)
}

/** The stored check `refresh` collects instead of buying: young, with reads still out. Null when there is none. */
async function readCollectingSerp(
  svc: SupabaseClient,
  workspaceId: string,
  r: ResolvedSerp,
  now: Date,
) {
  const hit = await readLookup<StoredSerp>(
    svc,
    workspaceId,
    SERP_RESULTS_KIND,
    serpRequestKey(r),
    { maxAgeMs: SERP_REFRESH_COLLECTING_MS, now },
  )
  return hit && isStoredSerp(hit.result) && hasPendingReads(hit.result)
    ? { ...hit, result: hit.result }
    : null
}

/** Whether `refresh` for this request would collect a check still coming in rather than buy one (free). */
export async function hasCollectingSerp(
  svc: SupabaseClient,
  workspaceId: string,
  r: ResolvedSerp,
  now: Date = new Date(),
): Promise<boolean> {
  return (await readCollectingSerp(svc, workspaceId, r, now)) !== null
}

/** Answers from a stored check, checking each read still out once (free). */
async function answerStored(
  svc: SupabaseClient,
  workspaceId: string,
  hit: { id: string; fetched_at: string; result: StoredSerp },
  deps: SerpDeps,
): Promise<SerpResult> {
  const meta = { id: hit.id, fetched_at: hit.fetched_at, from_cache: true }
  if (!hasPendingReads(hit.result))
    return serpResultFrom(hit.result, {
      lookup_id: hit.id,
      fetched_at: hit.fetched_at,
      from_cache: true,
    })
  // A repeat checks each read once: repeats are free, and must not turn into
  // a run of polls against the provider.
  const reads = await collectReads(hit.result.reads, collectOptions(deps, true))
  return settle(svc, workspaceId, meta, { ...hit.result, reads })
}

/** Live results for one keyword: stored (and topped up for free) or bought. */
export async function getSerpResults(
  svc: SupabaseClient,
  who: SeoWho,
  input: SerpInput,
  deps: SerpDeps = {},
): Promise<{ ok: true; result: SerpResult } | SeoDataRefusal> {
  const r = resolveSerp(input)
  const key = serpRequestKey(r)
  const now = deps.now?.() ?? new Date()
  if (!input.refresh) {
    const hit = await readLookup<StoredSerp>(
      svc,
      who.workspaceId,
      SERP_RESULTS_KIND,
      key,
      { maxAgeMs: SERP_MAX_AGE_MS, now },
    )
    if (hit && stillAnswers(hit, now))
      return {
        ok: true,
        result: await answerStored(
          svc,
          who.workspaceId,
          { ...hit, result: hit.result },
          deps,
        ),
      }
  } else {
    // "Fresh" while the first reads are still out is the same question asked
    // again: collect those, never buy a second set.
    const collecting = await readCollectingSerp(svc, who.workspaceId, r, now)
    if (collecting)
      return {
        ok: true,
        result: await answerStored(svc, who.workspaceId, collecting, deps),
      }
  }

  const opened = await paidSeoClient(svc, who, deps)
  if (!opened.ok) return opened
  const options = collectOptions(deps, false)
  const [posted] = await opened.client.serp.readsTaskPostBatch([
    {
      keyword: r.keyword,
      locationCode: r.locationCode,
      languageCode: r.languageCode,
      depth: r.depth,
      device: r.device,
    },
  ])
  if (!posted || posted.status === 'rejected')
    throw (
      posted?.reason ??
      new SeoError('INTERNAL_ERROR', 'The search could not be started.')
    )
  const stored: StoredSerp = {
    v: SERP_VERSION,
    keyword: r.keyword,
    location_code: r.locationCode,
    language_code: r.languageCode,
    device: r.device,
    depth: r.depth,
    reads: posted.value.map((taskId) => ({
      task_id: taskId,
      state: 'pending' as const,
    })),
  }
  // The receipt goes in first: the reads are paid for, and a repeat must
  // collect them rather than buy them again.
  const label = `${r.keyword} · ${describeMarket(r.locationCode, r.languageCode)}${r.device === 'mobile' ? ' · mobile' : ''}`
  const row = await writeLookup(
    svc,
    { workspaceId: who.workspaceId, userId: who.userId },
    { kind: SERP_RESULTS_KIND, request: key, result: stored, label },
    { now },
  )
  const reads = await collectReads(stored.reads, options)
  return {
    ok: true,
    result: await settle(
      svc,
      who.workspaceId,
      {
        id: row?.id ?? null,
        fetched_at: row?.fetched_at ?? now.toISOString(),
        from_cache: false,
      },
      { ...stored, reads },
    ),
  }
}

/**
 * A stored SERP check by id, with each read still out checked once (free).
 * Null when it is not this workspace's or not a SERP check.
 */
export async function collectSerpLookup(
  svc: SupabaseClient,
  workspaceId: string,
  id: string,
  deps: SerpDeps = {},
): Promise<SerpResult | null> {
  const row = await getLookup<StoredSerp>(svc, workspaceId, id)
  if (!row || row.kind !== SERP_RESULTS_KIND || !isStoredSerp(row.result))
    return null
  return answerStored(svc, workspaceId, { ...row, result: row.result }, deps)
}
