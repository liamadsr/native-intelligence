/**
 * The paid profile, reviews, posts and questions reads: a stored snapshot
 * answers for free, the access check runs before anything is bought, a
 * queued reviews task is posted ONCE and its id stored before collecting, a
 * slow task answers "collecting" honestly and the next ask collects the same
 * task for free, and a task the provider failed is forgotten so it can be
 * bought again.
 *
 * The snapshot store (../../lookup-cache.ts) is replaced by an in-memory map;
 * the data client is a stub.
 */
import { SeoError } from '@/lib/seo/errors'
import type { SupabaseClient } from '@supabase/supabase-js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BusinessRef } from '../businesses'
import { REFRESH_REUSES_COLLECTING_MS } from '../limits'

const lookups = vi.hoisted(() => {
  const rows = new Map<
    string,
    {
      id: string
      kind: string
      key: string
      result: unknown
      fetched_at: string
    }
  >()
  let next = 0
  const keyOf = (kind: string, request: unknown) =>
    `${kind}:${JSON.stringify(request)}`
  return {
    rows,
    reset: () => {
      rows.clear()
      next = 0
    },
    readLookup: vi.fn(
      async (
        _svc: unknown,
        _ws: string,
        kind: string,
        request: unknown,
        opts?: { maxAgeMs: number; now?: Date },
      ) => {
        // The newest row for the question, no older than maxAgeMs (as the real one).
        const since =
          (opts?.now ?? new Date()).getTime() - Math.max(0, opts?.maxAgeMs ?? 0)
        const row = [...rows.values()]
          .filter(
            (r) =>
              r.key === keyOf(kind, request) &&
              Date.parse(r.fetched_at) >= since,
          )
          .pop()
        return row
          ? {
              id: row.id,
              kind,
              label: null,
              request,
              result: row.result,
              fetched_at: row.fetched_at,
              fetched_by: null,
            }
          : null
      },
    ),
    writeLookup: vi.fn(
      async (
        _svc: unknown,
        _who: unknown,
        entry: { kind: string; request: unknown; result: unknown },
        opts?: { now?: Date },
      ) => {
        const id = `lookup-${++next}`
        const fetchedAt = (opts?.now ?? new Date()).toISOString()
        rows.set(id, {
          id,
          kind: entry.kind,
          key: keyOf(entry.kind, entry.request),
          result: entry.result,
          fetched_at: fetchedAt,
        })
        return {
          id,
          kind: entry.kind,
          label: null,
          request: entry.request,
          result: entry.result,
          fetched_at: fetchedAt,
          fetched_by: null,
        }
      },
    ),
    updateLookupResult: vi.fn(
      async (_svc: unknown, _ws: string, id: string, result: unknown) => {
        const row = rows.get(id)
        if (row) row.result = result
        return !!row
      },
    ),
    deleteLookup: vi.fn(async (_svc: unknown, _ws: string, id: string) => {
      rows.delete(id)
    }),
  }
})

vi.mock('@/lib/seo/lookup-cache', () => ({
  readLookup: lookups.readLookup,
  writeLookup: lookups.writeLookup,
  updateLookupResult: lookups.updateLookupResult,
  deleteLookup: lookups.deleteLookup,
}))

const {
  readGoogleBusinessQuestions,
  readGoogleBusinessReviews,
  readGoogleBusinessUpdates,
} = await import('../business-data')
const { readGoogleBusinessProfile } = await import('../businesses')

const WHO = { workspaceId: 'ws-1', userId: 'user-1' }
const REF: BusinessRef = {
  trackedId: 'biz-1',
  title: 'Fernhill Studio',
  cid: '123',
  placeId: 'ChIJfernhill',
  latitude: 45.52,
  longitude: -122.68,
  locationCode: 2840,
  languageCode: 'en',
}

/** A service client whose only write here is the tracked business's update. */
function fakeSvc() {
  const updates: Array<Record<string, unknown>> = []
  const chain = {
    update: (patch: Record<string, unknown>) => {
      updates.push(patch)
      return chain
    },
    eq: () => chain,
    then: (resolve: (value: { error: null }) => unknown) =>
      resolve({ error: null }),
  }
  return { svc: { from: () => chain } as unknown as SupabaseClient, updates }
}

const allowed = async () => ({ ok: true as const })
const refused = async () => ({
  ok: false as const,
  code: 'FREE_PLAN' as const,
  message: 'Keyword, ranking and backlink data is part of the paid plan.',
})

beforeEach(() => {
  lookups.reset()
  vi.clearAllMocks()
})

describe('readGoogleBusinessReviews', () => {
  const completed = {
    status: 'completed' as const,
    result: {
      reviews_count: 132,
      rating: { value: 4.7 },
      items: [
        {
          review_id: 'r1',
          rating: { value: 5 },
          review_text: 'Lovely.',
          owner_answer: 'Thanks!',
        },
      ],
    },
  }

  it('posts once by cid, stores the task before collecting, and answers the reviews', async () => {
    const reviewsTaskPost = vi.fn(async () => 'task-1')
    const fetchTask = vi.fn(async () => completed)
    const { svc, updates } = fakeSvc()
    const out = await readGoogleBusinessReviews(
      svc,
      WHO,
      REF,
      {},
      {
        client: { business: { reviewsTaskPost } } as never,
        checkAccess: allowed,
        fetchTask,
      },
    )

    expect(reviewsTaskPost).toHaveBeenCalledTimes(1)
    expect(reviewsTaskPost).toHaveBeenCalledWith(
      expect.objectContaining({
        cid: '123',
        placeId: undefined,
        keyword: undefined,
        locationCoordinate: '45.52,-122.68,10000',
        depth: 20,
        sortBy: 'newest',
        includeOtherSources: false,
      }),
    )
    expect(fetchTask).toHaveBeenCalledWith({
      endpoint: 'reviews',
      taskId: 'task-1',
    })
    expect(out).toMatchObject({
      ok: true,
      result: {
        status: 'completed',
        from_cache: false,
        data: { total_reviews: 132, replied: 1 },
      },
    })
    // The tracked place's rating and review count follow the read.
    expect(updates[0]).toMatchObject({ rating: 4.7, review_count: 132 })
    // The stored snapshot is now complete: asking again is free.
    const again = await readGoogleBusinessReviews(
      svc,
      WHO,
      REF,
      {},
      {
        client: { business: { reviewsTaskPost } } as never,
        checkAccess: refused,
        fetchTask,
      },
    )
    expect(again).toMatchObject({
      ok: true,
      result: { status: 'completed', from_cache: true },
    })
    expect(reviewsTaskPost).toHaveBeenCalledTimes(1)
  })

  it('answers "collecting" when the task is slow, and collects the same task free on the next ask', async () => {
    const reviewsTaskPost = vi.fn(async () => 'task-2')
    const fetchTask = vi.fn(async () => ({
      status: 'pending' as const,
      result: null,
    }))
    const sleep = vi.fn(async () => {})
    const { svc } = fakeSvc()
    const deps = {
      client: { business: { reviewsTaskPost } } as never,
      checkAccess: allowed,
      fetchTask,
      sleep,
    }
    const first = await readGoogleBusinessReviews(svc, WHO, REF, {}, deps)

    expect(first).toMatchObject({
      ok: true,
      result: { status: 'collecting', data: null },
    })
    // About 40 seconds of reads, four seconds apart, never longer.
    expect(fetchTask.mock.calls.length).toBe(11)
    expect(sleep).toHaveBeenCalledTimes(10)

    fetchTask.mockResolvedValue(completed as never)
    const second = await readGoogleBusinessReviews(
      svc,
      WHO,
      REF,
      {},
      { ...deps, checkAccess: refused },
    )
    expect(second).toMatchObject({
      ok: true,
      result: {
        status: 'completed',
        from_cache: true,
        data: { total_reviews: 132 },
      },
    })
    expect(reviewsTaskPost).toHaveBeenCalledTimes(1)
    expect(fetchTask).toHaveBeenLastCalledWith({
      endpoint: 'reviews',
      taskId: 'task-2',
    })
  })

  it('forgets a task the provider failed, so the next ask buys it again', async () => {
    const reviewsTaskPost = vi.fn(async () => 'task-3')
    const fetchTask = vi.fn(async () => {
      throw new SeoError('INTERNAL_ERROR', 'Task failed (40102)')
    })
    const { svc } = fakeSvc()
    await expect(
      readGoogleBusinessReviews(
        svc,
        WHO,
        REF,
        {},
        {
          client: { business: { reviewsTaskPost } } as never,
          checkAccess: allowed,
          fetchTask,
        },
      ),
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
    expect(lookups.rows.size).toBe(0)
  })

  it('keeps the task when only the read failed', async () => {
    const reviewsTaskPost = vi.fn(async () => 'task-4')
    const fetchTask = vi.fn(async () => {
      throw new SeoError('UPSTREAM_UNAVAILABLE', 'HTTP 502')
    })
    const { svc } = fakeSvc()
    const out = await readGoogleBusinessReviews(
      svc,
      WHO,
      REF,
      {},
      {
        client: { business: { reviewsTaskPost } } as never,
        checkAccess: allowed,
        fetchTask,
      },
    )
    expect(out).toMatchObject({ ok: true, result: { status: 'collecting' } })
    expect(lookups.rows.size).toBe(1)
  })

  it('a refresh repeated while its read is still collecting collects the same task, never buying a second', async () => {
    let posted = 0
    const reviewsTaskPost = vi.fn(async () => `task-r${++posted}`)
    const fetchTask = vi.fn(async () => ({
      status: 'pending' as const,
      result: null,
    }))
    let clock = new Date('2026-11-12T10:00:00.000Z')
    const { svc } = fakeSvc()
    const deps = {
      client: { business: { reviewsTaskPost } } as never,
      checkAccess: allowed,
      fetchTask,
      sleep: async () => {},
      // LocalDeps joins two `now`s (a Date here, a number for the place lists): cast.
      now: (() => clock) as never,
    }
    const first = await readGoogleBusinessReviews(
      svc,
      WHO,
      REF,
      { refresh: true },
      deps,
    )
    expect(first).toMatchObject({ ok: true, result: { status: 'collecting' } })
    expect(reviewsTaskPost).toHaveBeenCalledTimes(1)

    // The agent repeats the same call, refresh and all, a minute later.
    clock = new Date('2026-11-12T10:01:00.000Z')
    fetchTask.mockResolvedValue(completed as never)
    const second = await readGoogleBusinessReviews(
      svc,
      WHO,
      REF,
      { refresh: true },
      { ...deps, checkAccess: refused },
    )
    expect(second).toMatchObject({
      ok: true,
      result: { status: 'completed', data: { total_reviews: 132 } },
    })
    expect(reviewsTaskPost).toHaveBeenCalledTimes(1)
    expect(fetchTask).toHaveBeenLastCalledWith({
      endpoint: 'reviews',
      taskId: 'task-r1',
    })

    // Now complete: a refresh is a fresh purchase again.
    clock = new Date('2026-11-12T10:02:00.000Z')
    await readGoogleBusinessReviews(svc, WHO, REF, { refresh: true }, deps)
    expect(reviewsTaskPost).toHaveBeenCalledTimes(2)
  })

  it('a refresh buys afresh over a collecting read older than the reuse window', async () => {
    let posted = 0
    const updatesTaskPost = vi.fn(async () => `task-u${++posted}`)
    const fetchTask = vi.fn(async () => ({
      status: 'pending' as const,
      result: null,
    }))
    let clock = new Date('2026-11-12T10:00:00.000Z')
    const { svc } = fakeSvc()
    const deps = {
      client: { business: { updatesTaskPost } } as never,
      checkAccess: allowed,
      fetchTask,
      sleep: async () => {},
      // LocalDeps joins two `now`s (a Date here, a number for the place lists): cast.
      now: (() => clock) as never,
    }
    await readGoogleBusinessUpdates(svc, WHO, REF, { refresh: true }, deps)
    clock = new Date(
      clock.getTime() + REFRESH_REUSES_COLLECTING_MS + 60_000,
    )
    await readGoogleBusinessUpdates(svc, WHO, REF, { refresh: true }, deps)
    expect(updatesTaskPost).toHaveBeenCalledTimes(2)
    // Without refresh, the stored read (any age within the day) is collected, free.
    await readGoogleBusinessUpdates(svc, WHO, REF, {}, deps)
    expect(updatesTaskPost).toHaveBeenCalledTimes(2)
  })

  it('buys nothing when search data may not be used, and takes the extended endpoint for other sources', async () => {
    const reviewsTaskPost = vi.fn(async () => 'task-5')
    const { svc } = fakeSvc()
    const out = await readGoogleBusinessReviews(
      svc,
      WHO,
      REF,
      {},
      {
        client: { business: { reviewsTaskPost } } as never,
        checkAccess: refused,
      },
    )
    expect(out).toMatchObject({ ok: false, code: 'FREE_PLAN' })
    expect(reviewsTaskPost).not.toHaveBeenCalled()

    const fetchTask = vi.fn(async () => completed)
    await readGoogleBusinessReviews(
      svc,
      WHO,
      REF,
      { other_sources: true, depth: 40 },
      {
        client: { business: { reviewsTaskPost } } as never,
        checkAccess: allowed,
        fetchTask,
      },
    )
    expect(reviewsTaskPost).toHaveBeenCalledWith(
      expect.objectContaining({ includeOtherSources: true, depth: 40 }),
    )
    expect(fetchTask).toHaveBeenCalledWith({
      endpoint: 'extended_reviews',
      taskId: 'task-5',
    })
  })
})

describe('readGoogleBusinessUpdates', () => {
  it('posts with the cid: keyword and shapes the posts', async () => {
    const updatesTaskPost = vi.fn(async () => 'u-1')
    const fetchTask = vi.fn(async () => ({
      status: 'completed' as const,
      result: {
        items: [
          { post_text: 'Open studio night.', post_date: '04/02/2026 00:00:00' },
        ],
      },
    }))
    const { svc } = fakeSvc()
    const out = await readGoogleBusinessUpdates(
      svc,
      WHO,
      REF,
      {},
      {
        client: { business: { updatesTaskPost } } as never,
        checkAccess: allowed,
        fetchTask,
      },
    )
    expect(updatesTaskPost).toHaveBeenCalledWith(
      expect.objectContaining({ keyword: 'cid:123', depth: 10 }),
    )
    expect(fetchTask).toHaveBeenCalledWith({
      endpoint: 'my_business_updates',
      taskId: 'u-1',
    })
    expect(out).toMatchObject({
      ok: true,
      result: {
        status: 'completed',
        data: { posts: [{ text: 'Open studio night.' }] },
      },
    })
  })
})

describe('readGoogleBusinessQuestions', () => {
  it('reads live around the business and counts the unanswered', async () => {
    const questionsAnswers = vi.fn(async () => [
      { question_text: 'Parking?', items: [] },
      { question_text: 'Kids?', items: [{ answer_text: 'From 8.' }] },
    ])
    const { svc } = fakeSvc()
    const out = await readGoogleBusinessQuestions(
      svc,
      WHO,
      REF,
      {},
      {
        client: { business: { questionsAnswers } } as never,
        checkAccess: allowed,
      },
    )
    expect(questionsAnswers).toHaveBeenCalledWith({
      keyword: 'cid:123',
      locationCoordinate: '45.52,-122.68,10000',
      languageCode: 'en',
      depth: 20,
    })
    expect(out).toMatchObject({
      ok: true,
      result: { unanswered: 1, from_cache: false },
    })
  })

  it('needs a coordinate', async () => {
    const { svc } = fakeSvc()
    const out = await readGoogleBusinessQuestions(
      svc,
      WHO,
      { ...REF, trackedId: null, latitude: null, longitude: null },
      {},
      { checkAccess: allowed },
    )
    expect(out).toMatchObject({ ok: false, code: 'INVALID' })
  })
})

describe('readGoogleBusinessProfile', () => {
  const record = {
    title: 'Fernhill Studio',
    category: 'Pottery classes',
    rating: { value: 4.7, votes_count: 132 },
    is_claimed: true,
    url: 'https://fernhillstudio.example/',
  }

  it('buys, stores and updates the tracked place; then answers from storage', async () => {
    const myBusinessInfo = vi.fn(async () => record)
    const { svc, updates } = fakeSvc()
    const out = await readGoogleBusinessProfile(
      svc,
      WHO,
      REF,
      {},
      {
        client: { business: { myBusinessInfo } } as never,
        checkAccess: allowed,
      },
    )
    expect(myBusinessInfo).toHaveBeenCalledWith({
      keyword: 'cid:123',
      locationCoordinate: '45.52,-122.68,10000',
      languageCode: 'en',
    })
    expect(out).toMatchObject({
      ok: true,
      result: {
        from_cache: false,
        profile: { title: 'Fernhill Studio', rating: 4.7 },
      },
    })
    expect(updates[0]).toMatchObject({
      rating: 4.7,
      review_count: 132,
      category: 'Pottery classes',
      is_claimed: true,
    })
    expect(updates[0].profile_fetched_at).toBeTruthy()

    const cached = await readGoogleBusinessProfile(
      svc,
      WHO,
      REF,
      {},
      {
        client: { business: { myBusinessInfo } } as never,
        checkAccess: refused,
      },
    )
    expect(cached).toMatchObject({ ok: true, result: { from_cache: true } })
    expect(myBusinessInfo).toHaveBeenCalledTimes(1)
  })

  it('a stored-only read never buys', async () => {
    const myBusinessInfo = vi.fn()
    const { svc } = fakeSvc()
    const out = await readGoogleBusinessProfile(
      svc,
      WHO,
      REF,
      { storedOnly: true },
      {
        client: { business: { myBusinessInfo } } as never,
        checkAccess: allowed,
      },
    )
    expect(out).toEqual({ ok: true, result: null })
    expect(myBusinessInfo).not.toHaveBeenCalled()
  })
})
