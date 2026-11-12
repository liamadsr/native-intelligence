/**
 * Keyword metrics for a typed list, against a stubbed provider through the
 * real metered client: routing by country, the missing list, the stored
 * result (in any order of the same keywords), and saved keywords refreshed.
 */
import {
  createRecordingTestMeter,
  setupDataforseoTestEnv,
} from '@/lib/seo/dataforseo/__tests__/test-support'
import { createDataforseoClient } from '@/lib/seo/dataforseo/client'
import { describe, expect, it } from 'vitest'
import {
  estimateMetricsUsd,
  getKeywordMetrics,
  resolveMetrics,
} from '../metrics'
import {
  ADS,
  adsTask,
  allowAccess,
  kw,
  LABS,
  okTask,
  posted,
  stubProvider,
  testDb,
} from './support'

setupDataforseoTestEnv()

const WS = '11111111-1111-4111-8111-111111111111'
const who = { workspaceId: WS, userId: 'user-1' }

function deps() {
  const recording = createRecordingTestMeter()
  return {
    recording,
    deps: {
      client: createDataforseoClient(recording.meter),
      checkAccess: allowAccess,
    },
  }
}

describe('getKeywordMetrics', () => {
  it('reads a Labs country’s metrics in one call, lists what had no data, and answers the same list (any order) from storage', async () => {
    const { svc, tables } = testDb()
    const fetchMock = stubProvider({
      [LABS.overview]: () =>
        okTask(LABS.overview, {
          items: [
            kw('trail running shoes', 12100, { kd: 44 }),
            kw('waterproof trail shoes', 2900),
          ],
        }),
    })
    const { recording, deps: d } = deps()

    const out = await getKeywordMetrics(
      svc,
      who,
      {
        keywords: [
          'Trail Running Shoes',
          'waterproof trail shoes',
          'zzqx trail',
          'trail running shoes',
        ],
      },
      d,
    )
    if (!out.ok) throw new Error(out.message)
    expect(posted(fetchMock, LABS.overview)).toEqual([
      [
        expect.objectContaining({
          keywords: [
            'trail running shoes',
            'waterproof trail shoes',
            'zzqx trail',
          ],
          location_code: 2840,
          include_clickstream_data: false,
        }),
      ],
    ])
    expect(
      out.result.rows.map((row) => [
        row.keyword,
        row.search_volume,
        row.keyword_difficulty,
      ]),
    ).toEqual([
      ['trail running shoes', 12100, 44],
      ['waterproof trail shoes', 2900, 30],
    ])
    expect(out.result.missing).toEqual(['zzqx trail'])
    expect(recording.spend.map((entry) => entry.feature)).toEqual(['keywords'])
    expect(tables.seo_lookup?.[0]).toMatchObject({
      kind: 'keyword_metrics',
      label: 'trail running shoes and 2 more · United States',
    })

    const again = await getKeywordMetrics(
      svc,
      who,
      {
        keywords: [
          'zzqx trail',
          'waterproof trail shoes',
          'trail running shoes',
        ],
      },
      d,
    )
    expect(again.ok && again.result.from_cache).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('routes a Google-Ads-only country to search volume, without difficulty or intent', async () => {
    const { svc } = testDb()
    const fetchMock = stubProvider({
      [ADS.volume]: () =>
        adsTask(ADS.volume, [
          {
            keyword: 'hotel reykjavik',
            search_volume: 1900,
            cpc: 0.8,
            competition_index: 70,
          },
        ]),
    })
    const out = await getKeywordMetrics(
      svc,
      who,
      { keywords: ['hotel reykjavik'], location_code: 2352, clickstream: true },
      deps().deps,
    )
    if (!out.ok) throw new Error(out.message)
    expect(out.result).toMatchObject({
      data_provider: 'google_ads',
      language_code: 'is',
    })
    expect(out.result.rows).toEqual([
      {
        keyword: 'hotel reykjavik',
        search_volume: 1900,
        cpc: 0.8,
        competition: 0.7,
        keyword_difficulty: null,
        intent: 'unknown',
        trend: [],
      },
    ])
    expect(posted(fetchMock, ADS.volume)).toHaveLength(1)
  })

  it('refreshes saved keywords it covers, clearing numbers a lookup found none for', async () => {
    const saved = (keyword: string, id: string) => ({
      id,
      workspace_id: WS,
      keyword,
      location_code: 2840,
      language_code: 'en',
      search_volume: 99,
      cpc: 9,
      competition: 0.9,
      keyword_difficulty: 9,
      intent: 'navigational',
      monthly_searches: [],
      metrics_fetched_at: '2026-01-01T00:00:00Z',
      tags: [],
      note: null,
      created_by: null,
      created_at: '2026-01-01T00:00:00Z',
    })
    const { svc, tables } = testDb({
      seo_saved_keyword: [
        saved('trail running shoes', 's-1'),
        saved('zzqx trail', 's-2'),
      ],
    })
    stubProvider({
      [LABS.overview]: () =>
        okTask(LABS.overview, { items: [kw('trail running shoes', 12100)] }),
    })
    await getKeywordMetrics(
      svc,
      who,
      { keywords: ['trail running shoes', 'zzqx trail'] },
      deps().deps,
    )
    expect(tables.seo_saved_keyword?.[0]).toMatchObject({
      search_volume: 12100,
      intent: 'commercial',
    })
    expect(tables.seo_saved_keyword?.[1]).toMatchObject({
      search_volume: null,
      keyword_difficulty: null,
      intent: 'unknown',
    })
  })

  it('refuses an empty or oversized list before anything is bought', () => {
    expect(() => resolveMetrics({ keywords: ['  '] })).toThrow(/at least one/)
    expect(() =>
      resolveMetrics({
        keywords: Array.from({ length: 701 }, (_, i) => `k${i}`),
      }),
    ).toThrow(/at most 700/)
    expect(
      estimateMetricsUsd(
        resolveMetrics({
          keywords: Array.from({ length: 700 }, (_, i) => `k${i}`),
        }),
      ),
    ).toBeLessThan(0.25)
  })
})
