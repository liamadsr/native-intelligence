/**
 * Free maths and free lists: a scan's estimate from the provider's price list
 * (one queued Maps search per point per keyword), whether the agent must ask
 * first, the place picker's ranking, and the category list's process cache.
 */
import { dataforseoPricing } from '@/lib/seo/dataforseo'
import { describe, expect, it, vi } from 'vitest'
import {
  CONFIRM_ABOVE_USD,
  MAX_MAP_RESULTS_DEPTH,
  MAX_QUESTIONS_DEPTH,
  MAX_REVIEWS_DEPTH,
  MAX_SEARCH_LIMIT,
  MAX_UPDATES_DEPTH,
} from '../limits'
import { rankPlaces } from '../place-search'
import { estimateScan } from '../queries'
import {
  countryMarket,
  listBusinessCategories,
  resetCategoriesCache,
  searchPlaces,
} from '../reference'

const grid = { center_latitude: 45.52, center_longitude: -122.68, radius_km: 3 }

describe('estimateScan', () => {
  it('is one search per point per keyword at the queued Maps price', () => {
    const perSearch = dataforseoPricing.serp.localTaskPost({
      keyword: '',
      locationCoordinates: ['1,2,13z'],
      languageCode: 'en',
      device: 'mobile',
      depth: 20,
    })
    const e = estimateScan({ ...grid, size: 3, keywords: 1 })
    expect(e).toEqual({
      keywords: 1,
      points: 9,
      searches: 9,
      estimate_usd: Number((9 * perSearch).toFixed(6)),
      needs_confirmation: false,
    })
  })

  it('asks the person first above the threshold: a 7x7 with five keywords is 245 searches', () => {
    const e = estimateScan({ ...grid, size: 7, keywords: 5 })
    expect(e.searches).toBe(245)
    expect(e.estimate_usd).toBeGreaterThan(CONFIRM_ABOVE_USD)
    expect(e.needs_confirmation).toBe(true)
    expect(
      estimateScan({ ...grid, size: 7, keywords: 1 }).needs_confirmation,
    ).toBe(false)
  })
})

describe('the one-call reads stay under the confirmation line', () => {
  // A scan is the only local purchase that can pass CONFIRM_ABOVE_USD in one
  // request; every other read is one call, priced here at the most its own
  // caps allow. A price change that lifts one over the line fails here, and
  // that read then needs the same confirmation as a scan.
  it('prices each read at its caps below CONFIRM_ABOVE_USD', () => {
    const p = dataforseoPricing
    const most = {
      business_listings: p.business.businessListings({
        limit: MAX_SEARCH_LIMIT,
      } as never),
      maps_search: p.serp.local({
        searchType: 'maps',
        depth: MAX_MAP_RESULTS_DEPTH,
      } as never),
      profile: p.business.myBusinessInfo({} as never),
      reviews: p.business.reviewsTaskPost({
        depth: MAX_REVIEWS_DEPTH,
        includeOtherSources: false,
      } as never),
      reviews_other_sources: p.business.reviewsTaskPost({
        depth: MAX_REVIEWS_DEPTH,
        includeOtherSources: true,
      } as never),
      posts: p.business.updatesTaskPost({
        depth: MAX_UPDATES_DEPTH,
      } as never),
      questions: p.business.questionsAnswers({
        depth: MAX_QUESTIONS_DEPTH,
      } as never),
    }
    for (const [read, usd] of Object.entries(most)) {
      expect({ read, under: usd > 0 && usd <= CONFIRM_ABOVE_USD }).toEqual({
        read,
        under: true,
      })
    }
  })
})

describe('rankPlaces', () => {
  const places = [
    { locationName: 'Portland,Maine,United States', locationType: 'City' },
    { locationName: 'Portland,Oregon,United States', locationType: 'City' },
    {
      locationName: 'Portland-Auburn, ME,United States',
      locationType: 'DMA Region',
    },
    {
      locationName: 'South Portland,Maine,United States',
      locationType: 'City',
    },
    {
      locationName: 'Multnomah County,Oregon,United States',
      locationType: 'County',
    },
  ]

  it('reads a state abbreviation after the town and puts the exact town first', () => {
    expect(
      rankPlaces('Portland OR', places, 'us').map((p) => p.locationName),
    ).toEqual(['Portland,Oregon,United States'])
    expect(
      rankPlaces('portland', places, 'us').map((p) => p.locationName),
    ).toEqual([
      'Portland,Maine,United States',
      'Portland,Oregon,United States',
      'Portland-Auburn, ME,United States',
      'South Portland,Maine,United States',
    ])
  })

  it('matches without accents and answers nothing for an empty query', () => {
    expect(
      rankPlaces(
        'montreal',
        [{ locationName: 'Montréal,Quebec,Canada', locationType: 'City' }],
        'ca',
      ),
    ).toHaveLength(1)
    expect(rankPlaces('  ', places, 'us')).toEqual([])
  })
})

describe('searchPlaces and countryMarket', () => {
  it('turns a country code into its market and searches its free list', async () => {
    expect(countryMarket('US')).toMatchObject({
      iso: 'us',
      location_code: 2840,
      language_code: 'en',
    })
    expect(countryMarket('zz')).toBeNull()
    const fetchLocations = vi.fn(async () => [
      {
        locationCode: 1,
        locationName: 'Portland,Oregon,United States',
        locationType: 'City',
        displayLabel: 'Portland, Oregon, United States',
      },
    ])
    expect(
      await searchPlaces('us', 'portland or', 10, { fetchLocations }),
    ).toEqual([
      {
        location_name: 'Portland,Oregon,United States',
        location_code: 1,
        location_type: 'City',
        label: 'Portland, Oregon, United States',
      },
    ])
    expect(fetchLocations).toHaveBeenCalledWith('us')
  })
})

describe('listBusinessCategories', () => {
  it('fetches the free list once and filters it in memory', async () => {
    resetCategoriesCache()
    const fetchCategories = vi.fn(async () => ({
      data: [
        { category: 'pizza_restaurant', businessCount: 120 },
        { category: 'plumber', businessCount: 90 },
      ],
      billing: { path: [], costUsd: 0 },
    }))
    expect(
      await listBusinessCategories('PIZZA', 50, { fetchCategories }),
    ).toEqual({
      categories: [{ category: 'pizza_restaurant', business_count: 120 }],
      matched: 1,
    })
    expect(
      (await listBusinessCategories(null, 1, { fetchCategories })).categories,
    ).toHaveLength(1)
    expect(fetchCategories).toHaveBeenCalledTimes(1)
  })
})
