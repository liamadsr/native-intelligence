/**
 * Live SERP checks: the merge of three reads, and the service around it (the
 * receipt written before collecting, a bounded wait, "partial" and
 * "collecting" answers, a free top-up on a repeat, a fresh purchase after
 * every read failed, a search that found nothing kept for a few hours, and
 * `refresh` collecting a check still coming in instead of buying it again).
 *
 * Adapted from OpenSEO (MIT, see ../../THIRD_PARTY_NOTICES.md).
 */
import type { DataforseoClient } from '@/lib/seo/dataforseo'
import {
  createRecordingTestMeter,
  setupDataforseoTestEnv,
} from '@/lib/seo/dataforseo/__tests__/test-support'
import { createDataforseoClient } from '@/lib/seo/dataforseo/client'
import { describe, expect, it, vi } from 'vitest'
import {
  collectSerpLookup,
  estimateSerpUsd,
  getSerpResults,
  hasCollectingSerp,
  hasStoredSerp,
  resolveSerp,
  SERP_EMPTY_MAX_AGE_MS,
  SERP_REFRESH_COLLECTING_MS,
  type SerpDeps,
} from '../serp'
import { mergeSerpReads, serpItemsView, type SerpReadItem } from '../serp-merge'
import { allowAccess, testDb } from './support'

setupDataforseoTestEnv()

const WS = '11111111-1111-4111-8111-111111111111'
const who = { workspaceId: WS, userId: 'user-1' }

function organic(
  position: number,
  domain: string | null,
  title = 'Page',
): SerpReadItem {
  return {
    type: 'organic',
    rank_group: position,
    rank_absolute: position + 1,
    title,
    url: `https://${domain}/`,
    domain,
    description: 'desc',
  }
}

const view = (reads: SerpReadItem[][]) =>
  serpItemsView(mergeSerpReads(reads)).map(
    ({ rank, domain, best_position, seen_in }) => [
      rank,
      domain,
      best_position,
      seen_in,
    ],
  )

describe('merging reads', () => {
  it('puts the sites the reads agree on first, each at its best position', () => {
    expect(
      view([
        [organic(1, 'poisoned.example'), organic(4, 'agreed.example')],
        // A redirect row's breadcrumb host has no www, but it is the same site.
        [organic(2, 'www.agreed.example'), organic(3, 'second.example')],
        [organic(5, 'agreed.example'), organic(6, 'second.example')],
      ]),
    ).toEqual([
      [1, 'www.agreed.example', 2, 3],
      [2, 'second.example', 3, 2],
      [3, 'poisoned.example', 1, 1],
    ])
  })

  it('counts a site once per read and lists SERP features after the organic rows', () => {
    const feature: SerpReadItem = { type: 'people_also_ask', rank_absolute: 2 }
    const merged = serpItemsView(
      mergeSerpReads([
        [feature, organic(1, 'a.example'), organic(2, 'a.example')],
        [organic(1, 'a.example'), feature],
      ]),
    )
    expect(
      merged.map(({ type, rank, best_position, seen_in }) => [
        type,
        rank,
        best_position,
        seen_in,
      ]),
    ).toEqual([
      ['organic', 1, 1, 2],
      ['people_also_ask', null, null, 2],
    ])
  })
})

type Outcome = Awaited<ReturnType<NonNullable<SerpDeps['fetchTask']>>>
const completed = (...items: SerpReadItem[]): Outcome => ({
  status: 'completed',
  items: items.map((item) => ({ ...item, type: item.type })),
})

/** A fake client whose post answers with these task ids, a fake clock, and reads answered from `reads`. */
function harness(reads: Record<string, Outcome>, taskIds = Object.keys(reads)) {
  let now = 1_000_000
  const post = vi.fn(async (inputs: unknown[]) =>
    inputs.map(() => ({ status: 'fulfilled' as const, value: taskIds })),
  )
  const fetchTask = vi.fn(
    async (taskId: string) => reads[taskId] ?? { status: 'pending' as const },
  )
  const deps: SerpDeps = {
    client: {
      serp: { readsTaskPostBatch: post },
    } as unknown as DataforseoClient,
    checkAccess: allowAccess,
    fetchTask,
    clock: () => now,
    sleep: async (ms) => {
      now += ms
    },
    pollMs: 3000,
  }
  return { post, fetchTask, deps, reads }
}

describe('getSerpResults', () => {
  it('buys three reads, writes the receipt, collects them, and answers a repeat from storage without asking again', async () => {
    const { svc, tables } = testDb()
    const h = harness({
      t1: completed(organic(1, 'a.example')),
      t2: completed(organic(1, 'a.example'), organic(2, 'b.example')),
      t3: completed(organic(2, 'a.example')),
    })

    const out = await getSerpResults(
      svc,
      who,
      { keyword: 'Running Shoes' },
      h.deps,
    )
    if (!out.ok) throw new Error(out.message)
    expect(h.post).toHaveBeenCalledWith([
      {
        keyword: 'running shoes',
        locationCode: 2840,
        languageCode: 'en',
        depth: 10,
        device: 'desktop',
      },
    ])
    expect(out.result).toMatchObject({
      status: 'complete',
      reads_total: 3,
      reads_in: 3,
      keyword: 'running shoes',
      from_cache: false,
    })
    expect(
      out.result.items.map((item) => [
        item.domain,
        item.seen_in,
        item.best_position,
      ]),
    ).toEqual([
      ['a.example', 3, 1],
      ['b.example', 1, 2],
    ])
    expect(tables.seo_lookup?.[0]).toMatchObject({
      kind: 'serp_results',
      label: 'running shoes · United States',
    })

    const polls = h.fetchTask.mock.calls.length
    const repeat = await getSerpResults(
      svc,
      who,
      { keyword: 'running shoes' },
      h.deps,
    )
    expect(repeat.ok && repeat.result).toMatchObject({
      from_cache: true,
      status: 'complete',
      lookup_id: out.result.lookup_id,
    })
    expect(h.post).toHaveBeenCalledTimes(1)
    expect(h.fetchTask).toHaveBeenCalledTimes(polls)
  })

  it('answers what is back by the deadline as partial, and a repeat collects the late read for free with one check', async () => {
    const { svc } = testDb()
    const h = harness({
      t1: completed(organic(1, 'a.example')),
      t2: { status: 'pending' },
    })

    const first = await getSerpResults(
      svc,
      who,
      { keyword: 'trail shoes' },
      h.deps,
    )
    if (!first.ok) throw new Error(first.message)
    expect(first.result).toMatchObject({
      status: 'partial',
      reads_in: 1,
      reads_total: 2,
    })
    expect(first.result.items[0]).toMatchObject({ seen_in: 1 })
    // Polled in rounds 3 s apart until the 40 s deadline, never longer.
    const rounds = h.fetchTask.mock.calls.filter(([id]) => id === 't2').length
    expect(rounds).toBeGreaterThan(5)
    expect(rounds).toBeLessThanOrEqual(15)

    h.reads.t2 = completed(organic(1, 'a.example'))
    const before = h.fetchTask.mock.calls.length
    const repeat = await getSerpResults(
      svc,
      who,
      { keyword: 'trail shoes' },
      h.deps,
    )
    expect(repeat.ok && repeat.result).toMatchObject({
      status: 'complete',
      reads_in: 2,
      from_cache: true,
    })
    expect(repeat.ok && repeat.result.items[0]).toMatchObject({ seen_in: 2 })
    expect(h.fetchTask.mock.calls.length - before).toBe(1)
    expect(h.post).toHaveBeenCalledTimes(1)
  })

  it('says it is collecting when no read is back, and GET by id collects it later at no charge', async () => {
    const { svc } = testDb()
    const h = harness({ t1: { status: 'pending' } })
    const first = await getSerpResults(
      svc,
      who,
      { keyword: 'slow keyword' },
      h.deps,
    )
    if (!first.ok) throw new Error(first.message)
    expect(first.result).toMatchObject({
      status: 'collecting',
      items: [],
      reads_in: 0,
    })
    expect(first.result.lookup_id).toEqual(expect.any(String))

    h.reads.t1 = completed(organic(3, 'c.example'))
    const later = await collectSerpLookup(
      svc,
      WS,
      first.result.lookup_id as string,
      h.deps,
    )
    expect(later).toMatchObject({ status: 'complete', reads_in: 1 })
    expect(later?.items[0]).toMatchObject({
      domain: 'c.example',
      best_position: 3,
    })
    expect(
      await collectSerpLookup(
        svc,
        '22222222-2222-4222-8222-222222222222',
        first.result.lookup_id as string,
        h.deps,
      ),
    ).toBeNull()
    expect(h.post).toHaveBeenCalledTimes(1)
  })

  it('buys fresh reads after every read failed, nothing stored', async () => {
    const { svc, tables } = testDb()
    const h = harness({ t1: { status: 'failed', message: 'Internal Error.' } })
    await expect(
      getSerpResults(svc, who, { keyword: 'flaky' }, h.deps),
    ).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' })
    expect(tables.seo_lookup ?? []).toHaveLength(0)

    h.reads.t1 = completed(organic(1, 'a.example'))
    await getSerpResults(svc, who, { keyword: 'flaky' }, h.deps)
    expect(h.post).toHaveBeenCalledTimes(2)
  })

  it('keeps a search that found nothing for a few hours, then buys again; refresh buys at once', async () => {
    const { svc, tables } = testDb()
    let at = new Date('2026-11-12T08:00:00.000Z')
    const h = harness({ t1: completed(), t2: completed() })
    const deps = { ...h.deps, now: () => at }

    const empty = await getSerpResults(svc, who, { keyword: 'new brand' }, deps)
    expect(empty.ok && empty.result).toMatchObject({
      status: 'complete',
      items: [],
      lookup_id: expect.any(String),
      from_cache: false,
    })
    expect(tables.seo_lookup).toHaveLength(1)

    at = new Date(at.getTime() + SERP_EMPTY_MAX_AGE_MS - 60_000)
    expect(
      await hasStoredSerp(svc, WS, resolveSerp({ keyword: 'new brand' }), at),
    ).toBe(true)
    const again = await getSerpResults(svc, who, { keyword: 'new brand' }, deps)
    expect(again.ok && again.result).toMatchObject({
      status: 'complete',
      items: [],
      from_cache: true,
      lookup_id: empty.ok ? empty.result.lookup_id : null,
    })
    expect(h.post).toHaveBeenCalledTimes(1)

    await getSerpResults(
      svc,
      who,
      { keyword: 'new brand', refresh: true },
      deps,
    )
    expect(h.post).toHaveBeenCalledTimes(2)

    // Past the short window (counted from the newest check) it is bought again.
    at = new Date(at.getTime() + SERP_EMPTY_MAX_AGE_MS + 60_000)
    expect(
      await hasStoredSerp(svc, WS, resolveSerp({ keyword: 'new brand' }), at),
    ).toBe(false)
    await getSerpResults(svc, who, { keyword: 'new brand' }, deps)
    expect(h.post).toHaveBeenCalledTimes(3)
  })

  it('with refresh, collects a check still coming in instead of buying it again', async () => {
    const { svc } = testDb()
    let at = new Date('2026-11-12T08:00:00.000Z')
    const h = harness({ t1: { status: 'pending' } })
    const deps = { ...h.deps, now: () => at }

    const first = await getSerpResults(svc, who, { keyword: 'slow' }, deps)
    expect(first.ok && first.result.status).toBe('collecting')

    at = new Date(at.getTime() + 60_000)
    const r = resolveSerp({ keyword: 'slow' })
    expect(await hasCollectingSerp(svc, WS, r, at)).toBe(true)
    h.reads.t1 = completed(organic(1, 'a.example'))
    const before = h.fetchTask.mock.calls.length
    const repeat = await getSerpResults(
      svc,
      who,
      { keyword: 'slow', refresh: true },
      deps,
    )
    expect(repeat.ok && repeat.result).toMatchObject({
      status: 'complete',
      from_cache: true,
      lookup_id: first.ok ? first.result.lookup_id : null,
    })
    expect(h.fetchTask.mock.calls.length - before).toBe(1)
    expect(h.post).toHaveBeenCalledTimes(1)

    // Once it is in, refresh buys again, as the person asked.
    expect(await hasCollectingSerp(svc, WS, r, at)).toBe(false)
    await getSerpResults(svc, who, { keyword: 'slow', refresh: true }, deps)
    expect(h.post).toHaveBeenCalledTimes(2)
  })

  it('with refresh, buys again when the check still out is older than a few minutes', async () => {
    const { svc } = testDb()
    let at = new Date('2026-11-12T08:00:00.000Z')
    const h = harness({ t1: { status: 'pending' } })
    const deps = { ...h.deps, now: () => at }
    await getSerpResults(svc, who, { keyword: 'stuck' }, deps)

    at = new Date(at.getTime() + SERP_REFRESH_COLLECTING_MS + 60_000)
    expect(
      await hasCollectingSerp(svc, WS, resolveSerp({ keyword: 'stuck' }), at),
    ).toBe(false)
    await getSerpResults(svc, who, { keyword: 'stuck', refresh: true }, deps)
    expect(h.post).toHaveBeenCalledTimes(2)
  })

  it('keeps a mobile check apart from a desktop one, and a poll that throws leaves its read pending', async () => {
    const { svc } = testDb()
    const h = harness({ t1: completed(organic(1, 'a.example')) })
    await getSerpResults(svc, who, { keyword: 'shoes' }, h.deps)
    h.fetchTask.mockRejectedValueOnce(new Error('socket hang up'))
    const mobile = await getSerpResults(
      svc,
      who,
      { keyword: 'shoes', device: 'mobile' },
      h.deps,
    )
    expect(h.post).toHaveBeenCalledTimes(2)
    expect(h.post).toHaveBeenLastCalledWith([
      expect.objectContaining({ device: 'mobile' }),
    ])
    expect(mobile.ok && mobile.result).toMatchObject({
      status: 'complete',
      device: 'mobile',
    })
  })

  it('returns the refusal without buying when search data may not be bought', async () => {
    const { svc } = testDb()
    const h = harness({ t1: completed(organic(1, 'a.example')) })
    const out = await getSerpResults(
      svc,
      who,
      { keyword: 'shoes' },
      {
        ...h.deps,
        checkAccess: async () => ({
          ok: false,
          code: 'UNATTENDED',
          message: 'Only when the person asks.',
        }),
      },
    )
    expect(out).toEqual({
      ok: false,
      code: 'UNATTENDED',
      message: 'Only when the person asks.',
    })
    expect(h.post).not.toHaveBeenCalled()
  })

  it('validates depth and keyword before anything is bought', () => {
    expect(() => resolveSerp({ keyword: 'x', depth: 15 })).toThrow(
      /multiple of 10/,
    )
    expect(() => resolveSerp({ keyword: ' ' })).toThrow(/keyword/)
    expect(
      estimateSerpUsd(resolveSerp({ keyword: 'x', depth: 100 })),
    ).toBeGreaterThan(estimateSerpUsd(resolveSerp({ keyword: 'x' })))
  })

  it('meters the post as a serp spend through the real client', async () => {
    const { svc } = testDb()
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({
        status_code: 20000,
        tasks: [1, 2, 3].map((i) => ({
          id: `r${i}`,
          status_code: 20100,
          cost: 0.0012,
        })),
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const recording = createRecordingTestMeter()
    const h = harness({
      r1: completed(organic(1, 'a.example')),
      r2: completed(organic(1, 'a.example')),
      r3: completed(organic(1, 'a.example')),
    })
    const out = await getSerpResults(
      svc,
      who,
      { keyword: 'shoes' },
      { ...h.deps, client: createDataforseoClient(recording.meter) },
    )
    expect(out.ok && out.result.reads_in).toBe(3)
    expect(recording.spend).toEqual([
      expect.objectContaining({
        feature: 'serp',
        costUsd: expect.closeTo(0.0036, 6),
      }),
    ])
  })
})
