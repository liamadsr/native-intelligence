/**
 * The local rank scan engine against a stubbed data client and an in-memory
 * store: the paid post happens once (a retried step never buys again), the
 * free reads settle points as they come back and leave the rest pending, a
 * retried read writes nothing twice, what never comes back ends not
 * collected, and a stopped scan does nothing more.
 */
import { SeoError } from '@/lib/seo/errors'
import { describe, expect, it, vi } from 'vitest'
import { mapsCoordinate } from '../geometry'
import { scanPointId } from '../ids'
import {
  claimScan,
  collectRound,
  failScan,
  finalizeScan,
  postKeyword,
  type LocalScanRecord,
} from '../scan-engine'
import { createMemoryScanStore } from './memory-store'

const SCAN: LocalScanRecord = {
  id: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-0000000000aa',
  status: 'queued',
  keywords: ['dentist', 'emergency dentist'],
  size: 3,
  radiusKm: 2,
  centerLatitude: 40,
  centerLongitude: -74,
  zoom: 13,
  device: 'mobile',
  languageCode: 'en',
  target: { title: 'Fernhill Dental', cid: '123', place_id: 'place-fernhill' },
  startedBy: 'user-1',
}

function client(
  post: (input: {
    keyword: string
    locationCoordinates: string[]
  }) => Promise<Array<string | null>>,
) {
  const localTaskPost = vi.fn(post)
  return {
    localTaskPost,
    client: { serp: { localTaskPost } } as unknown as Parameters<
      typeof postKeyword
    >[3],
  }
}

const everyTask = async ({
  keyword,
  locationCoordinates,
}: {
  keyword: string
  locationCoordinates: string[]
}) => locationCoordinates.map((_, index) => `${keyword}-${index}`)

async function claimed() {
  const memory = createMemoryScanStore(SCAN)
  await claimScan(memory.store, SCAN.id)
  return memory
}

describe('claimScan', () => {
  it('claims a queued scan once it is running, and not a canceled one', async () => {
    const memory = createMemoryScanStore(SCAN)
    expect((await claimScan(memory.store, SCAN.id))?.status).toBe('running')
    // A redelivered attempt carries on with its own row.
    expect(await claimScan(memory.store, SCAN.id)).not.toBeNull()
    memory.state.scan.status = 'canceled'
    expect(await claimScan(memory.store, SCAN.id)).toBeNull()
  })
})

describe('postKeyword', () => {
  it('posts one queued search per grid point, north row first, at the scan’s zoom', async () => {
    const memory = await claimed()
    const { localTaskPost, client: c } = client(everyTask)
    const out = await postKeyword(memory.store, SCAN.id, 0, c)

    expect(out).toEqual({ posted: 9, refused: 0, reused: false })
    expect(localTaskPost).toHaveBeenCalledTimes(1)
    expect(localTaskPost).toHaveBeenCalledWith({
      keyword: 'dentist',
      // 2 km spacing at latitude 40: 0.0180874° of latitude, 0.0234532° of longitude.
      locationCoordinates: [
        '40.0180874,-74.0234532,13z',
        '40.0180874,-74,13z',
        '40.0180874,-73.9765468,13z',
        '40,-74.0234532,13z',
        '40,-74,13z',
        '40,-73.9765468,13z',
        '39.9819126,-74.0234532,13z',
        '39.9819126,-74,13z',
        '39.9819126,-73.9765468,13z',
      ],
      languageCode: 'en',
      device: 'mobile',
      depth: 20,
    })
    expect(memory.state.points.size).toBe(9)
    const first = memory.state.points.get(scanPointId(SCAN.id, 'dentist', 0, 0))
    expect(first).toMatchObject({
      status: 'pending',
      taskId: 'dentist-0',
      row: 0,
      col: 0,
    })
    // The cost of the searches accepted, by the price list ($0.0012 each).
    expect(memory.state.posts.get('keyword-0')?.cost).toBeCloseTo(9 * 0.0012, 6)
  })

  it('never posts again when the step is retried after the post was recorded', async () => {
    const memory = await claimed()
    const { localTaskPost, client: c } = client(everyTask)
    await postKeyword(memory.store, SCAN.id, 0, c)
    const again = await postKeyword(memory.store, SCAN.id, 0, c)

    expect(localTaskPost).toHaveBeenCalledTimes(1)
    expect(again).toEqual({ posted: 9, refused: 0, reused: true })
    expect(memory.state.points.size).toBe(9)
  })

  it('writes the points not collected, without posting, when an attempt paid but never recorded', async () => {
    const memory = await claimed()
    // The marker exists with no task ids: an attempt died between paying and recording.
    await memory.store.beginPost(SCAN.id, 'keyword-1')
    const { localTaskPost, client: c } = client(everyTask)
    const out = await postKeyword(memory.store, SCAN.id, 1, c)

    expect(localTaskPost).not.toHaveBeenCalled()
    expect(out).toEqual({ lost: 9 })
    const points = [...memory.state.points.values()]
    expect(
      points.every(
        (p) =>
          p.status === 'not_collected' && p.keyword === 'emergency dentist',
      ),
    ).toBe(true)
  })

  it('keeps the grid when the provider refuses one point', async () => {
    const memory = await claimed()
    const { client: c } = client(async ({ locationCoordinates }) =>
      locationCoordinates.map((_, i) => (i === 4 ? null : `t-${i}`)),
    )
    const out = await postKeyword(memory.store, SCAN.id, 0, c)
    expect(out).toEqual({ posted: 8, refused: 1, reused: false })
    expect(
      memory.state.points.get(scanPointId(SCAN.id, 'dentist', 1, 1))?.status,
    ).toBe('not_collected')
  })

  it('answers a spend-limit refusal as a scan failure, never a throw', async () => {
    const memory = await claimed()
    const { client: c } = client(async () => {
      throw new SeoError(
        'SPEND_LIMIT_REACHED',
        'This workspace has used its search data budget for November.',
      )
    })
    const out = await postKeyword(memory.store, SCAN.id, 0, c)
    expect(out).toEqual({
      failure: {
        code: 'SPEND_LIMIT_REACHED',
        message: 'This workspace has used its search data budget for November.',
      },
    })
    expect(
      [...memory.state.points.values()].every(
        (p) => p.status === 'not_collected',
      ),
    ).toBe(true)
  })

  it('moves on from a provider outage on one keyword', async () => {
    const memory = await claimed()
    const { client: c } = client(async () => {
      throw new SeoError(
        'UPSTREAM_UNAVAILABLE',
        'HTTP 502 from /v3/serp/google/maps/task_post',
      )
    })
    const out = await postKeyword(memory.store, SCAN.id, 0, c)
    expect(out).toMatchObject({ notSent: 9 })
  })

  it('records what the provider charged for the post, not the price list', async () => {
    const memory = await claimed()
    let billed = 0.5 // calls made through the same client before this post
    const localTaskPost = vi.fn(async (input: { keyword: string; locationCoordinates: string[] }) => {
      billed += 0.0093 // the provider's own bill for these nine searches
      return everyTask(input)
    })
    const c = {
      serp: { localTaskPost },
      billedUsd: () => billed,
    } as unknown as Parameters<typeof postKeyword>[3]
    await postKeyword(memory.store, SCAN.id, 0, c)
    expect(memory.state.posts.get('keyword-0')?.cost).toBeCloseTo(0.0093, 6)
  })

  it('records a charge the provider made on a failed post', async () => {
    const memory = await claimed()
    let billed = 0
    const c = {
      serp: {
        localTaskPost: async () => {
          billed += 0.004
          throw new SeoError('INTERNAL_ERROR', 'Task failed after billing')
        },
      },
      billedUsd: () => billed,
    } as unknown as Parameters<typeof postKeyword>[3]
    const out = await postKeyword(memory.store, SCAN.id, 0, c)
    expect(out).toMatchObject({ notSent: 9 })
    expect(memory.state.posts.get('keyword-0')).toMatchObject({ tasks: [] })
    expect(memory.state.posts.get('keyword-0')?.cost).toBeCloseTo(0.004, 6)
  })

  it('posts nothing for a scan that was stopped', async () => {
    const memory = await claimed()
    memory.state.scan.status = 'canceled'
    const { localTaskPost, client: c } = client(everyTask)
    expect(await postKeyword(memory.store, SCAN.id, 0, c)).toEqual({
      skipped: 'inactive',
    })
    expect(localTaskPost).not.toHaveBeenCalled()
  })
})

describe('collectRound and finalizeScan', () => {
  const items = (position: number) => [
    {
      type: 'maps_search',
      rank_absolute: 1,
      title: 'Northside Dental',
      cid: '999',
      rating: { value: 4.8, votes_count: 310 },
    },
    {
      type: 'maps_search',
      rank_absolute: position,
      title: 'Fernhill Dental',
      cid: '123',
    },
  ]

  async function posted() {
    const memory = await claimed()
    const { client: c } = client(everyTask)
    await postKeyword(memory.store, SCAN.id, 0, c)
    await postKeyword(memory.store, SCAN.id, 1, c)
    return memory
  }

  it('collects what came back, leaves the rest pending, and writes nothing twice on a retry', async () => {
    const memory = await posted()
    // Keyword one is back everywhere (position 2); keyword two is still running.
    const fetchResult = vi.fn(async (taskId: string) =>
      taskId.startsWith('dentist-')
        ? { status: 'completed' as const, items: items(2) }
        : { status: 'pending' as const },
    )
    const first = await collectRound(memory.store, SCAN.id, { fetchResult })
    expect(first).toEqual({ pending: 9, settled: 9 })
    const center = memory.state.points.get(
      scanPointId(SCAN.id, 'dentist', 1, 1),
    )
    expect(center).toMatchObject({
      status: 'collected',
      position: 2,
      results_count: 2,
    })
    expect(center?.competitors[0]).toMatchObject({
      title: 'Northside Dental',
      position: 1,
      is_target: false,
    })

    // A retried round reads again but changes no collected point.
    fetchResult.mockImplementation(async () => ({
      status: 'completed' as const,
      items: items(7),
    }))
    const retried = await collectRound(memory.store, SCAN.id, { fetchResult })
    expect(retried).toEqual({ pending: 0, settled: 9 })
    expect(
      memory.state.points.get(scanPointId(SCAN.id, 'dentist', 1, 1))?.position,
    ).toBe(2)
    expect(
      memory.state.points.get(scanPointId(SCAN.id, 'emergency dentist', 1, 1))
        ?.position,
    ).toBe(7)
  })

  it('keeps a point pending when the read itself fails, and writes a failed search not collected', async () => {
    const memory = await posted()
    const fetchResult = vi.fn(async (taskId: string) => {
      if (taskId === 'dentist-0')
        throw new SeoError('UPSTREAM_UNAVAILABLE', 'HTTP 503')
      if (taskId === 'dentist-1')
        return { status: 'failed' as const, message: 'Internal Error.' }
      return { status: 'completed' as const, items: items(1) }
    })
    const out = await collectRound(memory.store, SCAN.id, { fetchResult })
    expect(out).toEqual({ pending: 1, settled: 17 })
    expect(
      memory.state.points.get(scanPointId(SCAN.id, 'dentist', 0, 0))?.status,
    ).toBe('pending')
    expect(
      memory.state.points.get(scanPointId(SCAN.id, 'dentist', 0, 1))?.status,
    ).toBe('not_collected')
  })

  it('finalizes: what never came back is not collected, and the summary numbers are written', async () => {
    const memory = await posted()
    const fetchResult = async (taskId: string) => {
      if (taskId.startsWith('emergency')) return { status: 'pending' as const }
      const index = Number(taskId.split('-').pop())
      // Found at positions 1..3 on the top row, not found below.
      return {
        status: 'completed' as const,
        items: index < 3 ? items(index + 1) : items(30).slice(0, 1),
      }
    }
    await collectRound(memory.store, SCAN.id, { fetchResult })
    const done = await finalizeScan(memory.store, SCAN.id)

    expect(done.status).toBe('completed')
    expect(memory.state.finish).toMatchObject({
      status: 'completed',
      pointsTotal: 18,
      pointsCollected: 9,
      pointsFound: 3,
      top3: 3,
      top10: 3,
      averagePosition: 2,
    })
    expect(
      [...memory.state.points.values()].filter((p) => p.status === 'pending'),
    ).toHaveLength(0)
    expect(
      memory.state.points.get(scanPointId(SCAN.id, 'emergency dentist', 2, 2)),
    ).toMatchObject({
      status: 'not_collected',
      error: 'This search did not come back in time.',
    })
  })

  it('fails a scan none of whose searches came back', async () => {
    const memory = await posted()
    const done = await finalizeScan(memory.store, SCAN.id)
    expect(done.status).toBe('failed')
    expect(memory.state.finish).toMatchObject({
      status: 'failed',
      errorCode: 'NOTHING_COLLECTED',
      pointsCollected: 0,
    })
  })

  it('stops reading a canceled scan and never finishes it over the cancel', async () => {
    const memory = await posted()
    memory.state.scan.status = 'canceled'
    const fetchResult = vi.fn()
    expect(await collectRound(memory.store, SCAN.id, { fetchResult })).toEqual({
      inactive: true,
    })
    expect(fetchResult).not.toHaveBeenCalled()
    expect((await finalizeScan(memory.store, SCAN.id)).status).toBe('inactive')
    expect(memory.state.finish).toBeNull()
  })

  it('failScan writes the scan failed with the words given and ends pending points', async () => {
    const memory = await posted()
    await failScan(
      memory.store,
      SCAN.id,
      'SPEND_LIMIT_REACHED',
      'The monthly limit is reached.',
    )
    expect(memory.state.finish).toMatchObject({
      status: 'failed',
      errorCode: 'SPEND_LIMIT_REACHED',
      errorDetail: 'The monthly limit is reached.',
      pointsTotal: 18,
    })
    expect(
      [...memory.state.points.values()].every(
        (p) => p.status === 'not_collected',
      ),
    ).toBe(true)
  })
})

describe('the coordinate string', () => {
  it('drops trailing zeros and carries the zoom', () => {
    expect(mapsCoordinate({ latitude: 40.5, longitude: -74 }, 12)).toBe(
      '40.5,-74,12z',
    )
  })
})
