/**
 * A business's Google reviews, posts, and questions and answers: three paid
 * reads, each kept as a snapshot (../lookup-cache.ts) that answers the same
 * question for a day.
 *
 * Reviews and posts are queued at the provider: the read is bought when its
 * task is posted, and collecting the task is free. They run inside the
 * request, never longer than about a minute:
 *
 *   1. A stored read that is complete answers for free.
 *   2. Otherwise the task is posted (paid, once) and its id stored at once,
 *      as a snapshot that says "collecting".
 *   3. The request then collects the task, for up to TASK_WAIT_MS (40 s). The
 *      provider usually has reviews within about 20 s at the priority we
 *      post at.
 *   4. Still not back: the answer says so honestly ("still collecting, read
 *      again shortly"). Asking again finds the "collecting" snapshot and
 *      collects the same task for free: nothing is bought twice.
 *
 * A task the provider failed outright is forgotten (the snapshot deleted), so
 * the next ask can buy it again; a read that merely did not answer keeps it.
 * `refresh` buys afresh, except over a read of the same question bought in
 * the last few minutes that is still collecting (REFRESH_REUSES_COLLECTING_MS):
 * that one is collected, so repeating a refresh never pays twice.
 *
 * Questions and answers are a live read: bought and answered in one call.
 *
 * Adapted from OpenSEO (MIT, see ../THIRD_PARTY_NOTICES.md).
 */
import type { SeoDataRefusal } from '@/lib/seo/access'
import {
  fetchBusinessDataTaskResult,
  type BusinessTaskEndpoint,
  type BusinessTaskOutcome,
  type DataforseoClient,
} from '@/lib/seo/dataforseo'
import { isSeoError } from '@/lib/seo/errors'
import {
  deleteLookup,
  readLookup,
  updateLookupResult,
  writeLookup,
} from '@/lib/seo/lookup-cache'
import { paidSeoClient, type SeoWho } from '@/lib/seo/paid'
import type { SupabaseClient } from '@supabase/supabase-js'
import 'server-only'
import {
  refKeyword,
  refLabel,
  refLocation,
  updateTrackedFromRead,
  type BusinessRef,
  type LocalDeps,
} from './businesses'
import { businessDataCoordinate } from './geometry'
import {
  DEFAULT_QUESTIONS_DEPTH,
  DEFAULT_REVIEWS_DEPTH,
  DEFAULT_UPDATES_DEPTH,
  MAX_QUESTIONS_DEPTH,
  MAX_REVIEWS_DEPTH,
  MAX_UPDATES_DEPTH,
  MIN_REVIEWS_DEPTH,
  MIN_UPDATES_DEPTH,
  PROFILE_SEARCH_RADIUS_KM,
  QUESTIONS_MAX_AGE_MS,
  REFRESH_REUSES_COLLECTING_MS,
  REVIEWS_MAX_AGE_MS,
  TASK_POLL_MS,
  TASK_WAIT_MS,
  UPDATES_MAX_AGE_MS,
} from './limits'
import { postsFromResult, questionsFromRows, reviewsFromResult } from './shape'
import type {
  GoogleBusinessQuestionsResult,
  GoogleBusinessReviewsData,
  GoogleBusinessReviewsResult,
  GoogleBusinessUpdatesResult,
  QueuedReadStatus,
} from './view'

export const GBP_REVIEWS_KIND = 'gbp_reviews'
export const GBP_UPDATES_KIND = 'gbp_updates'
export const GBP_QUESTIONS_KIND = 'gbp_questions'
const VERSION = 1

export interface QueuedDeps extends LocalDeps {
  fetchTask?: (input: {
    endpoint: BusinessTaskEndpoint
    taskId: string
  }) => Promise<BusinessTaskOutcome>
  sleep?: (ms: number) => Promise<void>
  /** Overrides TASK_WAIT_MS (tests). */
  waitMs?: number
}

type StoredTask<T> =
  | { state: 'collecting'; endpoint: BusinessTaskEndpoint; task_id: string }
  | {
      state: 'completed'
      endpoint: BusinessTaskEndpoint
      task_id: string
      data: T
    }

const sleepMs = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms))

function clampDepth(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(Math.max(Math.round(value), min), max)
    : fallback
}

/** Collects a task until it is back or the wait is over. Throws what the read throws. */
async function waitForTask(
  input: { endpoint: BusinessTaskEndpoint; taskId: string },
  deps: QueuedDeps,
): Promise<BusinessTaskOutcome> {
  const fetchTask = deps.fetchTask ?? fetchBusinessDataTaskResult
  const sleep = deps.sleep ?? sleepMs
  const budget = deps.waitMs ?? TASK_WAIT_MS
  let waited = 0
  for (;;) {
    const outcome = await fetchTask(input)
    if (outcome.status === 'completed') return outcome
    if (waited + TASK_POLL_MS > budget) return outcome
    await sleep(TASK_POLL_MS)
    waited += TASK_POLL_MS
  }
}

interface QueuedRead<T> {
  kind: string
  request: Record<string, unknown>
  label: string
  maxAgeMs: number
  endpoint: BusinessTaskEndpoint
  post: (client: DataforseoClient) => Promise<string>
  shape: (result: Record<string, unknown> | null) => T
}

type QueuedAnswer<T> =
  | {
      ok: true
      status: QueuedReadStatus
      data: T | null
      lookup_id: string | null
      fetched_at: string
      from_cache: boolean
      /** The data came back during this call (not from a stored, already complete read). */
      collected_now: boolean
    }
  | SeoDataRefusal

async function readQueued<T>(
  svc: SupabaseClient,
  who: SeoWho,
  read: QueuedRead<T>,
  refresh: boolean,
  deps: QueuedDeps,
): Promise<QueuedAnswer<T>> {
  const now = deps.now?.() ?? new Date()
  const found = await readLookup<StoredTask<T>>(
    svc,
    who.workspaceId,
    read.kind,
    read.request,
    {
      maxAgeMs: refresh ? REFRESH_REUSES_COLLECTING_MS : read.maxAgeMs,
      now,
    },
  )
  // A refresh skips a complete stored read (that is what it is for), but
  // still collects a young one that is out and not back yet: a "collecting"
  // answer asked again, with refresh still set, never buys a second task.
  const stored =
    refresh && found?.result?.state !== 'collecting' ? null : found
  if (stored?.result?.state === 'completed') {
    return {
      ok: true,
      status: 'completed',
      data: stored.result.data,
      lookup_id: stored.id,
      fetched_at: stored.fetched_at,
      from_cache: true,
      collected_now: false,
    }
  }

  let taskId: string
  let lookupId: string | null
  let fetchedAt: string
  let fromCache: boolean
  if (stored?.result?.state === 'collecting' && stored.result.task_id) {
    // Bought already: collect the same task, free.
    taskId = stored.result.task_id
    lookupId = stored.id
    fetchedAt = stored.fetched_at
    fromCache = true
  } else {
    const opened = await paidSeoClient(svc, who, deps)
    if (!opened.ok) return opened
    taskId = await read.post(opened.client)
    // Stored before collecting, so a request that ends early never loses what was bought.
    const saved = await writeLookup(
      svc,
      { workspaceId: who.workspaceId, userId: who.userId },
      {
        kind: read.kind,
        request: read.request,
        result: {
          state: 'collecting',
          endpoint: read.endpoint,
          task_id: taskId,
        } satisfies StoredTask<T>,
        label: read.label,
      },
      { now },
    )
    lookupId = saved?.id ?? null
    fetchedAt = saved?.fetched_at ?? now.toISOString()
    fromCache = false
  }

  let outcome: BusinessTaskOutcome
  try {
    outcome = await waitForTask({ endpoint: read.endpoint, taskId }, deps)
  } catch (err) {
    if (isSeoError(err) && err.code === 'INTERNAL_ERROR') {
      // The provider failed the task itself: forget it, so the next ask can buy it again.
      if (lookupId) await deleteLookup(svc, who.workspaceId, lookupId)
      throw err
    }
    // The read failed, not the task: it stays stored and the next ask collects it free.
    console.warn('[seo-local] task collect failed', {
      kind: read.kind,
      error: err instanceof Error ? err.message : String(err),
    })
    return {
      ok: true,
      status: 'collecting',
      data: null,
      lookup_id: lookupId,
      fetched_at: fetchedAt,
      from_cache: fromCache,
      collected_now: false,
    }
  }
  if (outcome.status !== 'completed') {
    return {
      ok: true,
      status: 'collecting',
      data: null,
      lookup_id: lookupId,
      fetched_at: fetchedAt,
      from_cache: fromCache,
      collected_now: false,
    }
  }
  const data = read.shape(outcome.result)
  const completed: StoredTask<T> = {
    state: 'completed',
    endpoint: read.endpoint,
    task_id: taskId,
    data,
  }
  if (lookupId) {
    await updateLookupResult(svc, who.workspaceId, lookupId, completed)
  } else {
    const saved = await writeLookup(
      svc,
      { workspaceId: who.workspaceId, userId: who.userId },
      {
        kind: read.kind,
        request: read.request,
        result: completed,
        label: read.label,
      },
      { now },
    )
    lookupId = saved?.id ?? null
  }
  return {
    ok: true,
    status: 'completed',
    data,
    lookup_id: lookupId,
    fetched_at: fetchedAt,
    from_cache: fromCache,
    collected_now: true,
  }
}

export interface ReviewsInput {
  depth?: number | null
  /** Also the reviews Google shows from other sites (costs more per review). */
  other_sources?: boolean | null
  refresh?: boolean
}

/** A business's Google reviews, newest first, with the stars and the owner's replies counted. */
export async function readGoogleBusinessReviews(
  svc: SupabaseClient,
  who: SeoWho,
  ref: BusinessRef,
  input: ReviewsInput = {},
  deps: QueuedDeps = {},
): Promise<{ ok: true; result: GoogleBusinessReviewsResult } | SeoDataRefusal> {
  const depth = clampDepth(
    input.depth,
    MIN_REVIEWS_DEPTH,
    MAX_REVIEWS_DEPTH,
    DEFAULT_REVIEWS_DEPTH,
  )
  const otherSources = input.other_sources === true
  const location = refLocation(ref)
  const endpoint: BusinessTaskEndpoint = otherSources
    ? 'extended_reviews'
    : 'reviews'
  const answer = await readQueued<GoogleBusinessReviewsData>(
    svc,
    who,
    {
      kind: GBP_REVIEWS_KIND,
      request: {
        v: VERSION,
        keyword: refKeyword(ref),
        language_code: ref.languageCode,
        depth,
        other_sources: otherSources,
        ...location,
      },
      label: `${refLabel(ref)} · ${depth} reviews`,
      maxAgeMs: REVIEWS_MAX_AGE_MS,
      endpoint,
      post: (client) =>
        client.business.reviewsTaskPost({
          // The reviews endpoints take the id itself; the name only when there is no id.
          cid: ref.cid ?? undefined,
          placeId: ref.cid ? undefined : (ref.placeId ?? undefined),
          keyword:
            ref.cid || ref.placeId ? undefined : (ref.title ?? undefined),
          ...location,
          languageCode: ref.languageCode,
          depth,
          sortBy: 'newest',
          includeOtherSources: otherSources,
        }),
      shape: reviewsFromResult,
    },
    input.refresh === true,
    deps,
  )
  if (!answer.ok) return answer
  if (
    answer.status === 'completed' &&
    answer.collected_now &&
    ref.trackedId &&
    answer.data
  ) {
    await updateTrackedFromRead(
      svc,
      who.workspaceId,
      ref.trackedId,
      { rating: answer.data.rating, review_count: answer.data.total_reviews },
      null,
    )
  }
  return {
    ok: true,
    result: {
      status: answer.status,
      data: answer.data,
      lookup_id: answer.lookup_id,
      fetched_at: answer.fetched_at,
      from_cache: answer.from_cache,
    },
  }
}

/** A business's Google posts (updates, offers, events), newest first. */
export async function readGoogleBusinessUpdates(
  svc: SupabaseClient,
  who: SeoWho,
  ref: BusinessRef,
  input: { depth?: number | null; refresh?: boolean } = {},
  deps: QueuedDeps = {},
): Promise<{ ok: true; result: GoogleBusinessUpdatesResult } | SeoDataRefusal> {
  const depth = clampDepth(
    input.depth,
    MIN_UPDATES_DEPTH,
    MAX_UPDATES_DEPTH,
    DEFAULT_UPDATES_DEPTH,
  )
  const location = refLocation(ref)
  const answer = await readQueued(
    svc,
    who,
    {
      kind: GBP_UPDATES_KIND,
      request: {
        v: VERSION,
        keyword: refKeyword(ref),
        language_code: ref.languageCode,
        depth,
        ...location,
      },
      label: `${refLabel(ref)} · posts`,
      maxAgeMs: UPDATES_MAX_AGE_MS,
      endpoint: 'my_business_updates',
      post: (client) =>
        client.business.updatesTaskPost({
          keyword: refKeyword(ref),
          ...location,
          languageCode: ref.languageCode,
          depth,
        }),
      shape: postsFromResult,
    },
    input.refresh === true,
    deps,
  )
  if (!answer.ok) return answer
  return {
    ok: true,
    result: {
      status: answer.status,
      data: answer.data,
      lookup_id: answer.lookup_id,
      fetched_at: answer.fetched_at,
      from_cache: answer.from_cache,
    },
  }
}

type StoredQuestions = Pick<
  GoogleBusinessQuestionsResult,
  'questions' | 'unanswered'
>

/** The questions and answers on a business's profile, live. Needs the business's coordinate. */
export async function readGoogleBusinessQuestions(
  svc: SupabaseClient,
  who: SeoWho,
  ref: BusinessRef,
  input: { depth?: number | null; refresh?: boolean } = {},
  deps: LocalDeps = {},
): Promise<
  | { ok: true; result: GoogleBusinessQuestionsResult }
  | { ok: false; code: 'INVALID'; message: string }
  | SeoDataRefusal
> {
  if (ref.latitude === null || ref.longitude === null) {
    return {
      ok: false,
      code: 'INVALID',
      message:
        'Questions are read around the business’s coordinate: give it, or use a tracked business.',
    }
  }
  const depth = clampDepth(
    input.depth,
    1,
    MAX_QUESTIONS_DEPTH,
    DEFAULT_QUESTIONS_DEPTH,
  )
  const coordinate = businessDataCoordinate(
    { latitude: ref.latitude, longitude: ref.longitude },
    PROFILE_SEARCH_RADIUS_KM,
  )
  const request = {
    v: VERSION,
    keyword: refKeyword(ref),
    language_code: ref.languageCode,
    depth,
    coordinate,
  }
  const now = deps.now?.() ?? new Date()
  if (!input.refresh) {
    const hit = await readLookup<StoredQuestions>(
      svc,
      who.workspaceId,
      GBP_QUESTIONS_KIND,
      request,
      { maxAgeMs: QUESTIONS_MAX_AGE_MS, now },
    )
    if (hit && Array.isArray(hit.result?.questions))
      return {
        ok: true,
        result: {
          ...hit.result,
          lookup_id: hit.id,
          fetched_at: hit.fetched_at,
          from_cache: true,
        },
      }
  }
  const opened = await paidSeoClient(svc, who, deps)
  if (!opened.ok) return opened
  const rows = await opened.client.business.questionsAnswers({
    keyword: refKeyword(ref),
    locationCoordinate: coordinate,
    languageCode: ref.languageCode,
    depth,
  })
  const questions = questionsFromRows(rows)
  const body: StoredQuestions = {
    questions,
    unanswered: questions.filter((question) => question.answers.length === 0)
      .length,
  }
  const saved = await writeLookup(
    svc,
    { workspaceId: who.workspaceId, userId: who.userId },
    {
      kind: GBP_QUESTIONS_KIND,
      request,
      result: body,
      label: `${refLabel(ref)} · questions`,
    },
    { now },
  )
  return {
    ok: true,
    result: {
      ...body,
      lookup_id: saved?.id ?? null,
      fetched_at: saved?.fetched_at ?? now.toISOString(),
      from_cache: false,
    },
  }
}
