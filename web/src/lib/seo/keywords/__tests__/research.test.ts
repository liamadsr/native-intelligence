/**
 * Keyword research against a stubbed provider through the real metered
 * client (a recording meter in place of the workspace's): the auto blend and
 * its fallback, Google-Ads-only routing, wildcard seeds, the stored-result
 * cache, the access refusal, and saved keywords picking up fresh metrics.
 *
 * Adapted from OpenSEO (MIT, see ../../THIRD_PARTY_NOTICES.md).
 */
import {
  createRecordingTestMeter,
  setupDataforseoTestEnv,
} from '@/lib/seo/dataforseo/__tests__/test-support'
import { createDataforseoClient } from '@/lib/seo/dataforseo/client'
import { describe, expect, it, vi } from 'vitest'
import {
  estimateResearchUsd,
  researchKeywords,
  resolveResearch,
} from '../research'
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

const caregivingSuggestions = [
  kw('caregiving', 110000, { kd: 60, intent: 'informational' }),
  ...[
    'caregiving jobs',
    'caregiving tips',
    'caregiving app',
    'caregiving course',
    'caregiving burnout',
  ].map((k) => kw(k, 900)),
]
const caregivingIdeas = [
  'respite care',
  'elder care',
  'adult day care',
  'care home',
].map((k) => kw(k, 500))

describe('auto mode', () => {
  it('blends suggestions and ideas at half the limit each, stores the result, and answers a repeat from it', async () => {
    const { svc, tables } = testDb()
    const fetchMock = stubProvider({
      [LABS.suggestions]: () =>
        okTask(LABS.suggestions, { items: caregivingSuggestions }, 0.021),
      [LABS.ideas]: () => okTask(LABS.ideas, { items: caregivingIdeas }, 0.021),
    })
    const { recording, deps: d } = deps()

    const out = await researchKeywords(svc, who, { seed: '  Caregiving ' }, d)
    if (!out.ok) throw new Error(out.message)

    expect(posted(fetchMock, LABS.suggestions)).toEqual([
      [
        expect.objectContaining({
          keyword: 'caregiving',
          limit: 75,
          location_code: 2840,
          language_code: 'en',
          ignore_synonyms: true,
          include_clickstream_data: false,
        }),
      ],
    ])
    expect(posted(fetchMock, LABS.ideas)).toEqual([
      [expect.objectContaining({ keywords: ['caregiving'], limit: 75 })],
    ])
    expect(posted(fetchMock, LABS.related)).toEqual([])
    expect(out.result).toMatchObject({
      seed: 'caregiving',
      source: 'blended',
      used_fallback: false,
      data_provider: 'labs',
      from_cache: false,
    })
    expect(out.result.rows.map((row) => row.keyword).slice(0, 4)).toEqual([
      'caregiving',
      'respite care',
      'caregiving jobs',
      'elder care',
    ])
    expect(out.result.rows[0]).toMatchObject({
      search_volume: 110000,
      keyword_difficulty: 60,
      intent: 'informational',
      cpc: 1.25,
    })
    expect(recording.spend.map((entry) => entry.feature)).toEqual([
      'keywords',
      'keywords',
    ])
    expect(tables.seo_lookup).toHaveLength(1)
    expect(tables.seo_lookup?.[0]).toMatchObject({
      kind: 'keyword_research',
      label: 'caregiving · United States',
      fetched_by: 'user-1',
    })

    const again = await researchKeywords(svc, who, { seed: 'caregiving' }, d)
    if (!again.ok) throw new Error(again.message)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(again.result).toMatchObject({
      from_cache: true,
      lookup_id: out.result.lookup_id,
    })
    expect(again.result.rows).toEqual(out.result.rows)

    await researchKeywords(svc, who, { seed: 'caregiving', refresh: true }, d)
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('keeps the leg that was bought when the other fails: stored, marked partial, nothing more bought', async () => {
    const { svc, tables } = testDb()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetchMock = stubProvider({
      [LABS.suggestions]: () =>
        okTask(LABS.suggestions, { items: caregivingSuggestions.slice(0, 2) }),
      [LABS.ideas]: () => ({ status_code: 50000, status_message: 'Internal Error.' }),
      [LABS.related]: () => okTask(LABS.related, { items: [] }),
    })
    const { recording, deps: d } = deps()

    const out = await researchKeywords(svc, who, { seed: 'caregiving' }, d)
    if (!out.ok) throw new Error(out.message)
    expect(out.result.rows.map((row) => row.keyword)).toEqual([
      'caregiving',
      'caregiving jobs',
    ])
    expect(out.result.partial).toEqual({
      missing: ['ideas'],
      note: expect.stringMatching(/^Keywords from the same topic could not be read just now\./),
    })
    // A thin blend would normally add related searches: not after a failure.
    expect(posted(fetchMock, LABS.related)).toEqual([])
    expect(recording.spend).toHaveLength(1)
    expect(tables.seo_lookup).toHaveLength(1)

    const again = await researchKeywords(svc, who, { seed: 'caregiving' }, d)
    expect(again.ok && again.result).toMatchObject({
      from_cache: true,
      partial: { missing: ['ideas'] },
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })

  it('keeps the paid blend when the related-searches top-up fails', async () => {
    const { svc, tables } = testDb()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    stubProvider({
      [LABS.suggestions]: () =>
        okTask(LABS.suggestions, { items: [kw('zither', 100)] }),
      [LABS.ideas]: () => okTask(LABS.ideas, { items: [] }),
      [LABS.related]: () => ({ status_code: 50000, status_message: 'Internal Error.' }),
    })
    const { deps: d } = deps()

    const out = await researchKeywords(svc, who, { seed: 'zither' }, d)
    if (!out.ok) throw new Error(out.message)
    expect(out.result).toMatchObject({
      used_fallback: false,
      partial: { missing: ['related'] },
    })
    expect(out.result.rows.map((row) => row.keyword)).toEqual(['zither'])
    expect(tables.seo_lookup).toHaveLength(1)
  })

  it('fails, storing nothing, only when neither source came back', async () => {
    const { svc, tables } = testDb()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const down = () => ({ status_code: 50000, status_message: 'Internal Error.' })
    stubProvider({ [LABS.suggestions]: down, [LABS.ideas]: down })
    const { deps: d } = deps()

    await expect(
      researchKeywords(svc, who, { seed: 'caregiving' }, d),
    ).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' })
    expect(tables.seo_lookup ?? []).toHaveLength(0)
  })

  it('adds related searches when the blend is thin, and keeps close variants when asked', async () => {
    const { svc } = testDb()
    const fetchMock = stubProvider({
      [LABS.suggestions]: () =>
        okTask(LABS.suggestions, { items: [kw('obscure widget', 10)] }),
      [LABS.ideas]: () =>
        okTask(LABS.ideas, { items: [kw('widget repair', 20)] }),
      [LABS.related]: () =>
        okTask(LABS.related, {
          items: ['widget parts', 'widget kit', 'widget store'].map((k) => ({
            keyword_data: kw(k, 30),
          })),
        }),
    })
    const out = await researchKeywords(
      svc,
      who,
      { seed: 'obscure widget', group_keywords: true },
      deps().deps,
    )
    if (!out.ok) throw new Error(out.message)
    expect(out.result).toMatchObject({ source: 'blended', used_fallback: true })
    expect(out.result.rows.map((row) => row.keyword)).toEqual([
      'obscure widget',
      'widget parts',
      'widget repair',
      'widget kit',
      'widget store',
    ])
    expect(posted(fetchMock, LABS.related)).toEqual([
      [
        expect.objectContaining({
          limit: 150,
          depth: 3,
          ignore_synonyms: false,
        }),
      ],
    ])
  })

  it('a leg the provider refused as invalid leaves the other, paid leg stored and marked partial', async () => {
    const { svc, tables } = testDb()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    stubProvider({
      [LABS.suggestions]: () =>
        okTask(LABS.suggestions, { items: caregivingSuggestions }),
      [LABS.ideas]: () => ({
        status_code: 20000,
        tasks: [
          {
            status_code: 40501,
            status_message: "Invalid Field: 'limit'.",
            path: ['v3'],
            cost: 0,
          },
        ],
      }),
    })
    const out = await researchKeywords(
      svc,
      who,
      { seed: 'caregiving' },
      deps().deps,
    )
    expect(out.ok && out.result.partial).toMatchObject({ missing: ['ideas'] })
    expect(out.ok && out.result.rows).toHaveLength(caregivingSuggestions.length)
    expect(tables.seo_lookup).toHaveLength(1)
  })
})

describe('routing', () => {
  it('serves a Google-Ads-only country from keyword ideas, with no difficulty or intent, whatever was asked', async () => {
    const { svc } = testDb()
    const fetchMock = stubProvider({
      [ADS.ideas]: () =>
        adsTask(ADS.ideas, [
          {
            keyword: 'northern lights tour',
            search_volume: 320,
            cpc: 1.1,
            competition_index: 50,
          },
          { keyword: 'Northern Lights Tour', search_volume: 320 },
        ]),
    })
    const d = deps().deps
    const out = await researchKeywords(
      svc,
      who,
      {
        seed: 'northern lights tour',
        location_code: 2352,
        mode: 'related',
        clickstream: true,
        group_keywords: true,
      },
      d,
    )
    if (!out.ok) throw new Error(out.message)
    expect(out.result).toMatchObject({
      source: 'google_ads',
      mode: 'auto',
      data_provider: 'google_ads',
      language_code: 'is',
    })
    expect(out.result.rows).toEqual([
      {
        keyword: 'northern lights tour',
        search_volume: 320,
        cpc: 1.1,
        competition: 0.5,
        keyword_difficulty: null,
        intent: 'unknown',
        trend: [],
      },
    ])
    expect(posted(fetchMock, ADS.ideas)).toEqual([
      [
        expect.objectContaining({
          keywords: ['northern lights tour'],
          location_code: 2352,
          language_code: 'is',
        }),
      ],
    ])

    // Clickstream and grouping don't apply there, so this is the same question.
    const same = await researchKeywords(
      svc,
      who,
      { seed: 'northern lights tour', location_code: 2352 },
      d,
    )
    expect(same.ok && same.result.from_cache).toBe(true)
  })

  it('researches a wildcard seed as one suggestions call for its anchor, filtered to the pattern', async () => {
    const { svc } = testDb()
    const fetchMock = stubProvider({
      [LABS.suggestions]: () =>
        okTask(LABS.suggestions, {
          items: [kw('best flea treatment for dogs', 4400)],
        }),
    })
    const out = await researchKeywords(
      svc,
      who,
      { seed: 'Best * for dogs', mode: 'ideas' },
      deps().deps,
    )
    if (!out.ok) throw new Error(out.message)
    expect(out.result.source).toBe('suggestions')
    expect(posted(fetchMock, LABS.suggestions)).toEqual([
      [
        expect.objectContaining({
          keyword: 'for dogs',
          include_seed_keyword: false,
          filters: [
            ['keyword', 'like', 'best % for dogs'],
            'or',
            ['keyword', 'like', 'best % for dogs %'],
            'or',
            ['keyword', 'like', '% best % for dogs'],
            'or',
            ['keyword', 'like', '% best % for dogs %'],
          ],
        }),
      ],
    ])
  })

  it('rejects before any call: a wildcard in a Google Ads country, an unknown country, a language the country is not served in', async () => {
    const { svc } = testDb()
    const fetchMock = stubProvider({})
    const d = deps().deps
    await expect(
      researchKeywords(
        svc,
        who,
        { seed: 'best * for dogs', location_code: 2352 },
        d,
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'Wildcard search isn’t available for this country.',
    })
    await expect(
      researchKeywords(svc, who, { seed: 'shoes', location_code: 9999 }, d),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    await expect(
      researchKeywords(
        svc,
        who,
        { seed: 'shoes', location_code: 2840, language_code: 'ru' },
        d,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    await expect(
      researchKeywords(svc, who, { seed: '   ' }, d),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('access and saved keywords', () => {
  it('returns the refusal and buys nothing when search data may not be bought, but still serves a stored result', async () => {
    const { svc } = testDb()
    const fetchMock = stubProvider({
      [LABS.suggestions]: () =>
        okTask(LABS.suggestions, { items: caregivingSuggestions }),
      [LABS.ideas]: () => okTask(LABS.ideas, { items: caregivingIdeas }),
    })
    const refuse = async () => ({
      ok: false as const,
      code: 'FREE_PLAN' as const,
      message: 'Keyword data is part of the paid plan.',
    })
    const recording = createRecordingTestMeter()
    const client = createDataforseoClient(recording.meter)

    expect(
      await researchKeywords(
        svc,
        who,
        { seed: 'caregiving' },
        { client, checkAccess: refuse },
      ),
    ).toEqual({
      ok: false,
      code: 'FREE_PLAN',
      message: 'Keyword data is part of the paid plan.',
    })
    expect(fetchMock).not.toHaveBeenCalled()

    await researchKeywords(
      svc,
      who,
      { seed: 'caregiving' },
      { client, checkAccess: allowAccess },
    )
    const stored = await researchKeywords(
      svc,
      who,
      { seed: 'caregiving' },
      { client, checkAccess: refuse },
    )
    expect(stored.ok && stored.result.from_cache).toBe(true)
  })

  it('writes the fresh metrics onto saved keywords in the same market only', async () => {
    const { svc, tables } = testDb({
      seo_saved_keyword: [
        {
          id: 's-1',
          workspace_id: WS,
          keyword: 'elder care',
          location_code: 2840,
          language_code: 'en',
          search_volume: 1,
          cpc: null,
          competition: null,
          keyword_difficulty: null,
          intent: null,
          monthly_searches: [],
          metrics_fetched_at: null,
          tags: ['care'],
          note: null,
          created_by: null,
          created_at: '2026-10-01T00:00:00Z',
        },
        {
          id: 's-2',
          workspace_id: WS,
          keyword: 'elder care',
          location_code: 2826,
          language_code: 'en',
          search_volume: 1,
          cpc: null,
          competition: null,
          keyword_difficulty: null,
          intent: null,
          monthly_searches: [],
          metrics_fetched_at: null,
          tags: [],
          note: null,
          created_by: null,
          created_at: '2026-10-01T00:00:00Z',
        },
      ],
    })
    stubProvider({
      [LABS.suggestions]: () =>
        okTask(LABS.suggestions, { items: caregivingSuggestions }),
      [LABS.ideas]: () => okTask(LABS.ideas, { items: caregivingIdeas }),
    })
    await researchKeywords(svc, who, { seed: 'caregiving' }, deps().deps)
    const [us, uk] = tables.seo_saved_keyword ?? []
    expect(us).toMatchObject({
      search_volume: 500,
      keyword_difficulty: 30,
      intent: 'commercial',
      tags: ['care'],
    })
    expect(us?.metrics_fetched_at).toEqual(expect.any(String))
    expect(uk).toMatchObject({ search_volume: 1, metrics_fetched_at: null })
  })
})

describe('the estimate', () => {
  it('bounds what a research can cost: the auto blend with its fallback, one Google Ads call', () => {
    const auto150 = estimateResearchUsd(resolveResearch({ seed: 'shoes' }))
    const auto500 = estimateResearchUsd(
      resolveResearch({ seed: 'shoes', result_limit: 500 }),
    )
    const clickstream = estimateResearchUsd(
      resolveResearch({ seed: 'shoes', result_limit: 500, clickstream: true }),
    )
    expect(auto150).toBeGreaterThan(0.05)
    expect(auto500).toBeGreaterThan(auto150)
    expect(clickstream).toBeCloseTo(auto500 * 2)
    expect(
      estimateResearchUsd(
        resolveResearch({ seed: 'shoes', location_code: 2352 }),
      ),
    ).toBeCloseTo(0.09)
  })
})
