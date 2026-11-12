/**
 * Domain data against a stubbed provider through the real metered client: the
 * overview (and its default, the workspace's own site), ranked keywords with
 * scope filters and paging, SERP competitors sorted and filtered from storage.
 *
 * Adapted from OpenSEO (MIT, see ../../THIRD_PARTY_NOTICES.md).
 */
import {
  createRecordingTestMeter,
  setupDataforseoTestEnv,
} from '@/lib/seo/dataforseo/__tests__/test-support'
import { createDataforseoClient } from '@/lib/seo/dataforseo/client'
import {
  allowAccess,
  LABS,
  okTask,
  posted,
  stubProvider,
  testDb,
} from '@/lib/seo/keywords/__tests__/support'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const site = vi.hoisted(() => ({ url: null as string | null }))
vi.mock('@/lib/seo/site', () => ({
  workspaceSiteUrl: vi.fn(async () => site.url),
}))

import { findSerpCompetitors, sortCompetitors } from '../competitors'
import {
  DOMAIN_OVERVIEW_EMPTY_MAX_AGE_MS,
  getDomainOverview,
} from '../overview'
import {
  getRankedKeywords,
  mapRankedKeywordItem,
  rankedFilters,
} from '../ranked-keywords'

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

function ranked(
  keyword: string,
  position: number,
  etv: number,
  url = 'https://www.example.com/pricing',
) {
  return {
    keyword_data: {
      keyword,
      keyword_info: { search_volume: 1000, cpc: 2.5 },
      keyword_properties: { keyword_difficulty: 33.4 },
    },
    ranked_serp_element: { serp_item: { url, rank_absolute: position, etv } },
  }
}

beforeEach(() => {
  site.url = 'https://www.example.com'
})

describe('getDomainOverview', () => {
  it('defaults to the workspace’s own site, buys the overview, then its top keywords and pages, and stores it', async () => {
    const { svc, tables } = testDb()
    const fetchMock = stubProvider({
      [LABS.rankOverview]: () =>
        okTask(LABS.rankOverview, {
          items: [{ metrics: { organic: { etv: 1234.6, count: 87 } } }],
        }),
      [LABS.rankedKeywords]: () =>
        okTask(LABS.rankedKeywords, {
          total_count: 87,
          items: [
            ranked('studio photography', 3, 120.25),
            ranked('portrait studio', 7, 40),
          ],
        }),
      [LABS.relevantPages]: () =>
        okTask(LABS.relevantPages, {
          items: [
            {
              page_address: 'https://www.example.com/pricing?x=1',
              metrics: { organic: { etv: 300.4, count: 12 } },
            },
          ],
        }),
    })
    const { recording, deps: d } = deps()
    const out = await getDomainOverview(svc, who, {}, d)
    if (!out.ok) throw new Error(out.message)
    expect(out.result).toMatchObject({
      domain: 'example.com',
      is_own_site: true,
      organic_traffic: 1235,
      organic_keywords: 87,
      has_data: true,
      from_cache: false,
    })
    expect(out.result.top_keywords[0]).toEqual({
      keyword: 'studio photography',
      position: 3,
      search_volume: 1000,
      traffic: 120.25,
      cpc: 2.5,
      keyword_difficulty: 33,
      url: 'https://www.example.com/pricing',
      relative_url: '/pricing',
    })
    expect(out.result.top_pages).toEqual([
      {
        url: 'https://www.example.com/pricing?x=1',
        relative_path: '/pricing?x=1',
        organic_traffic: 300,
        keywords: 12,
      },
    ])
    expect(out.result.caveats.join(' ')).toMatch(/estimate/)
    expect(posted(fetchMock, LABS.rankedKeywords)).toEqual([
      [
        expect.objectContaining({
          target: 'example.com',
          limit: 100,
          order_by: ['ranked_serp_element.serp_item.etv,desc'],
        }),
      ],
    ])
    expect(recording.spend.map((entry) => entry.feature)).toEqual([
      'domain',
      'domain',
      'domain',
    ])
    expect(tables.seo_lookup?.[0]).toMatchObject({
      kind: 'domain_overview',
      label: 'example.com · United States',
    })

    const again = await getDomainOverview(
      svc,
      who,
      { domain: 'https://example.com/about' },
      d,
    )
    expect(again.ok && again.result).toMatchObject({
      from_cache: true,
      is_own_site: false,
    })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('buys only the overview for a domain without rankings, keeps it for a few hours, then looks again', async () => {
    const { svc, tables } = testDb()
    const fetchMock = stubProvider({
      [LABS.rankOverview]: () => okTask(LABS.rankOverview, { items: [] }),
    })
    let at = new Date('2026-11-12T08:00:00.000Z')
    const d = { ...deps().deps, now: () => at }
    const input = { domain: 'brand-new.example.com' }
    const out = await getDomainOverview(svc, who, input, d)
    expect(out.ok && out.result).toMatchObject({
      has_data: false,
      organic_keywords: null,
      top_keywords: [],
      lookup_id: expect.any(String),
      from_cache: false,
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(tables.seo_lookup).toHaveLength(1)

    // Asked again within the window: answered from storage, nothing bought.
    at = new Date(at.getTime() + DOMAIN_OVERVIEW_EMPTY_MAX_AGE_MS - 60_000)
    const again = await getDomainOverview(svc, who, input, d)
    expect(again.ok && again.result).toMatchObject({
      has_data: false,
      from_cache: true,
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // A refresh buys again on the person's ask.
    await getDomainOverview(svc, who, { ...input, refresh: true }, d)
    expect(fetchMock).toHaveBeenCalledTimes(2)

    // Past the short window (from the newest one), it is looked at again.
    at = new Date(at.getTime() + DOMAIN_OVERVIEW_EMPTY_MAX_AGE_MS + 60_000)
    const later = await getDomainOverview(svc, who, input, d)
    expect(later.ok && later.result.from_cache).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('stores an overview whose top keywords failed, marked partial, and answers a repeat from it', async () => {
    const { svc, tables } = testDb()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetchMock = stubProvider({
      [LABS.rankOverview]: () =>
        okTask(LABS.rankOverview, {
          items: [{ metrics: { organic: { etv: 50, count: 9 } } }],
        }),
      [LABS.rankedKeywords]: () => ({
        status_code: 50000,
        status_message: 'Internal Error.',
      }),
      [LABS.relevantPages]: () => okTask(LABS.relevantPages, { items: [] }),
    })
    const { recording, deps: d } = deps()
    const out = await getDomainOverview(svc, who, { domain: 'shop.example.com' }, d)
    expect(out.ok && out.result).toMatchObject({
      has_data: true,
      partial: {
        missing: ['top_keywords'],
        note: expect.stringMatching(/top keywords couldn’t be read/),
      },
      from_cache: false,
    })
    expect(recording.spend).toHaveLength(2)
    expect(tables.seo_lookup).toHaveLength(1)

    const again = await getDomainOverview(
      svc,
      who,
      { domain: 'shop.example.com' },
      d,
    )
    expect(again.ok && again.result).toMatchObject({
      from_cache: true,
      partial: { missing: ['top_keywords'] },
    })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('refuses before buying: no site on file, a country without domain data, no access', async () => {
    const { svc } = testDb()
    const fetchMock = stubProvider({})
    site.url = null
    await expect(
      getDomainOverview(svc, who, {}, deps().deps),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      message: expect.stringMatching(/no website on file/),
    })
    await expect(
      getDomainOverview(
        svc,
        who,
        { domain: 'example.com', location_code: 2352 },
        deps().deps,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    await expect(
      getDomainOverview(svc, who, { domain: 'not a domain' }, deps().deps),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    const refused = await getDomainOverview(
      svc,
      who,
      { domain: 'example.com' },
      {
        ...deps().deps,
        checkAccess: async () => ({
          ok: false,
          code: 'SEO_NOT_CONFIGURED',
          message: 'Not set up.',
        }),
      },
    )
    expect(refused).toEqual({
      ok: false,
      code: 'SEO_NOT_CONFIGURED',
      message: 'Not set up.',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('getRankedKeywords', () => {
  it('narrows an exact page with scope filters, pages with next_offset, and stores each page', async () => {
    const { svc } = testDb()
    const fetchMock = stubProvider({
      [LABS.rankedKeywords]: () =>
        okTask(LABS.rankedKeywords, {
          total_count: 3,
          items: [ranked('a', 1, 10), ranked('b', 2, 5)],
        }),
    })
    const d = deps().deps
    const out = await getRankedKeywords(
      svc,
      who,
      {
        target: 'https://example.com/pricing',
        scope: 'exact_url',
        limit: 2,
        max_rank: 10,
        exclude_terms: ['Fernhill'],
      },
      d,
    )
    if (!out.ok) throw new Error(out.message)
    expect(out.result).toMatchObject({
      target: 'example.com/pricing',
      scope: 'exact_url',
      total_count: 3,
      next_offset: 2,
      is_own_site: false,
    })
    const [body] = posted(fetchMock, LABS.rankedKeywords) as Array<
      Array<{ filters: unknown[]; limit: number }>
    >
    expect(body?.[0]?.limit).toBe(2)
    expect(JSON.stringify(body?.[0]?.filters)).toContain(
      '"ranked_serp_element.serp_item.domain","in",["example.com","www.example.com"]',
    )
    expect(JSON.stringify(body?.[0]?.filters)).toContain(
      '"keyword_data.keyword","not_ilike","%fernhill%"',
    )
    const again = await getRankedKeywords(
      svc,
      who,
      {
        target: 'https://example.com/pricing',
        scope: 'exact_url',
        limit: 2,
        max_rank: 10,
        exclude_terms: ['fernhill'],
      },
      d,
    )
    expect(again.ok && again.result.from_cache).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('refuses more filter conditions than the provider takes, before buying', () => {
    expect(() =>
      rankedFilters({
        excludeTerms: Array.from({ length: 9 }, (_, i) => `t${i}`),
      }),
    ).toThrow(/Too many filters at once/)
  })

  it('maps a provider row, falling back to the element’s own fields', () => {
    expect(
      mapRankedKeywordItem({
        keyword: 'x',
        ranked_serp_element: {
          url: 'https://example.com/a?b=1',
          rank_absolute: 4.4,
          etv: 1.234,
        },
      }),
    ).toMatchObject({
      keyword: 'x',
      position: 4,
      traffic: 1.23,
      relative_url: '/a?b=1',
    })
    expect(mapRankedKeywordItem({})).toBeNull()
  })
})

describe('findSerpCompetitors', () => {
  it('marks the workspace’s own site, and re-sorts or excludes from the stored result for free', async () => {
    const { svc } = testDb()
    const fetchMock = stubProvider({
      [LABS.serpCompetitors]: () =>
        okTask(LABS.serpCompetitors, {
          items: [
            {
              domain: 'example.org',
              keywords_count: 9,
              avg_position: 6.5,
              visibility: 0.4,
              etv: 900,
            },
            {
              domain: 'www.example.com',
              keywords_count: 5,
              avg_position: 2.1,
              visibility: 0.2,
              etv: 300,
            },
            {
              domain: 'example.net',
              keywords_count: 7,
              avg_position: 4,
              visibility: 0.3,
              etv: null,
            },
          ],
        }),
    })
    const d = deps().deps
    const out = await findSerpCompetitors(
      svc,
      who,
      { keywords: ['Portrait Studio', 'headshots'] },
      d,
    )
    if (!out.ok) throw new Error(out.message)
    expect(out.result.own_domain).toBe('example.com')
    expect(out.result.rows.map((row) => [row.domain, row.own_site])).toEqual([
      ['example.org', false],
      ['example.net', false],
      ['www.example.com', true],
    ])
    expect(posted(fetchMock, LABS.serpCompetitors)).toEqual([
      [
        expect.objectContaining({
          keywords: ['portrait studio', 'headshots'],
          item_types: ['local_pack', 'organic'],
          include_subdomains: true,
        }),
      ],
    ])

    const resorted = await findSerpCompetitors(
      svc,
      who,
      {
        keywords: ['headshots', 'portrait studio'],
        sort_by: 'avg_position',
        exclude_domains: ['example.org'],
      },
      d,
    )
    expect(
      resorted.ok && resorted.result.rows.map((row) => row.domain),
    ).toEqual(['www.example.com', 'example.net'])
    expect(resorted.ok && resorted.result.from_cache).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('sorts missing numbers last', () => {
    const rows = [
      {
        domain: 'a',
        keywords_count: 1,
        avg_position: null,
        median_position: null,
        visibility: null,
        etv: 5,
        own_site: false,
      },
      {
        domain: 'b',
        keywords_count: 2,
        avg_position: 3,
        median_position: null,
        visibility: 0.1,
        etv: null,
        own_site: false,
      },
    ]
    expect(sortCompetitors(rows, 'traffic').map((row) => row.domain)).toEqual([
      'a',
      'b',
    ])
    expect(
      sortCompetitors(rows, 'avg_position').map((row) => row.domain),
    ).toEqual(['b', 'a'])
  })
})
