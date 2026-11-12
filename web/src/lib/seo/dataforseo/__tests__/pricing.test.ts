/**
 * Price estimators hold at least what DataForSEO bills.
 *
 * Adapted from OpenSEO (MIT, see ../THIRD_PARTY_NOTICES.md).
 */
import { dataforseoPricing } from '@/lib/seo/dataforseo/pricing'
import { estimateRankCheckUsd } from '@/lib/seo/shared/rank-tracking'
import { describe, expect, it } from 'vitest'

const location = { locationCode: 2840, languageCode: 'en' }

describe('dataforseoPricing', () => {
  it.each([
    {
      name: 'Labs research, 500 rows with clickstream (incident shape)',
      estimateUsd: dataforseoPricing.keywords.related({
        keyword: 'seo',
        ...location,
        limit: 500,
        includeClickstreamData: true,
      }),
      rawUsd: 0.144,
    },
    {
      name: 'Labs research, default 150 rows',
      estimateUsd: dataforseoPricing.keywords.suggestions({
        keyword: 'seo',
        ...location,
        limit: 150,
      }),
      rawUsd: 0.03,
    },
    {
      name: 'merged SERP reads at the default depth (page 1)',
      estimateUsd: dataforseoPricing.serp.readsTaskPost({
        keyword: 'seo',
        ...location,
      }),
      rawUsd: 0.0036,
    },
    {
      name: 'merged SERP reads with final URLs (standard queue, half the rate)',
      estimateUsd: dataforseoPricing.serp.readsTaskPost({
        keyword: 'seo',
        ...location,
        finalUrls: true,
      }),
      rawUsd: 0.0018,
    },
    {
      name: 'merged SERP reads at depth 20',
      estimateUsd: dataforseoPricing.serp.readsTaskPost({
        keyword: 'seo',
        ...location,
        depth: 20,
      }),
      rawUsd: 0.0063,
    },
    {
      name: 'merged SERP reads at depth 100',
      estimateUsd: dataforseoPricing.serp.readsTaskPost({
        keyword: 'seo',
        ...location,
        depth: 100,
      }),
      rawUsd: 0.0279,
    },
    {
      name: 'merged SERP reads for a keyword with a search operator (billed 5x)',
      estimateUsd: dataforseoPricing.serp.readsTaskPost({
        keyword: 'site:example.com seo',
        ...location,
      }),
      rawUsd: 0.018,
    },
    {
      name: 'Lighthouse run',
      estimateUsd: dataforseoPricing.lighthouse.live({
        url: 'https://example.com',
        strategy: 'mobile',
      }),
      rawUsd: 0.005,
    },
    {
      name: 'backlinks history over one year',
      estimateUsd: dataforseoPricing.backlinks.history({
        target: 'example.com',
        dateFrom: '2025-09-09',
        dateTo: '2026-09-08',
      }),
      rawUsd: 0.024 + 365 * 0.000036,
    },
  ])('$name', ({ estimateUsd, rawUsd }) => {
    expect(estimateUsd).toBeCloseTo(rawUsd, 10)
  })

  it.each([
    { includeOtherSources: false, billedUsd: 0.00375 },
    { includeOtherSources: true, billedUsd: 0.01 },
  ])(
    'holds at least the billed cost of a depth-20 reviews post (other sources: $includeOtherSources)',
    ({ includeOtherSources, billedUsd }) => {
      const estimateUsd = dataforseoPricing.business.reviewsTaskPost({
        cid: '123',
        ...location,
        depth: 20,
        sortBy: 'newest',
        includeOtherSources,
      })
      expect(estimateUsd).toBeGreaterThanOrEqual(billedUsd)
    },
  )

  // Real bills read from DataForSEO's id_list, each above the earlier estimate.
  const near = { locationCoordinate: '40.74,-73.98', languageCode: 'en' }
  it.each([
    {
      name: 'Q&A at depth 10',
      estimateUsd: dataforseoPricing.business.questionsAnswers({
        keyword: 'x',
        ...near,
        depth: 10,
      }),
      billedUsd: 0.0054,
    },
    {
      name: 'Q&A at depth 30',
      estimateUsd: dataforseoPricing.business.questionsAnswers({
        keyword: 'x',
        ...near,
        depth: 30,
      }),
      billedUsd: 0.0108,
    },
    {
      name: 'Local Finder at depth 100',
      estimateUsd: dataforseoPricing.serp.local({
        keyword: 'x',
        ...near,
        searchType: 'local_finder',
        device: 'mobile',
        depth: 100,
      }),
      billedUsd: 0.02,
    },
    {
      name: 'Maps tasks queued at high priority',
      estimateUsd: dataforseoPricing.serp.localTaskPost({
        keyword: 'x',
        locationCoordinates: ['1,1,13z', '2,2,13z'],
        languageCode: 'en',
        device: 'mobile',
        depth: 20,
      }),
      billedUsd: 0.0024,
    },
    {
      name: 'Claude response with web search',
      estimateUsd: dataforseoPricing.aiSearch.llmResponse({
        userPrompt: 'x',
        modelSlug: 'claude',
        modelName: 'claude-sonnet-4-5',
        webSearch: true,
      }),
      billedUsd: 0.142357,
    },
  ])(
    'holds at least the measured bill: $name',
    ({ estimateUsd, billedUsd }) => {
      expect(estimateUsd).toBeGreaterThanOrEqual(billedUsd)
    },
  )

  it('prices a queued task_post batch the way the rank check estimate does', () => {
    // Operator keywords bill 5x, so approvals must see the same mix.
    const keywords = Array.from({ length: 100 }, (_, i) =>
      i % 10 === 0 ? `site:example.com kw ${i}` : `kw ${i}`,
    )
    const estimateUsd = dataforseoPricing.serp.rankCheckTaskPost({
      tasks: keywords.map((keyword, i) => ({
        keyword,
        keywordId: `id-${i}`,
        device: 'desktop' as const,
      })),
      ...location,
      depth: 20,
    })
    // The estimate is the worst case: six reads.
    expect(6 * estimateUsd).toBeCloseTo(
      estimateRankCheckUsd(keywords, 'desktop', 20).costUsd,
      10,
    )
  })
})
