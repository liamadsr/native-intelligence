/**
 * Google Ads fetchers.
 *
 * Adapted from OpenSEO (MIT, see ../THIRD_PARTY_NOTICES.md).
 */
import {
  fetchAdsKeywordIdeas,
  fetchAdsSearchVolume,
} from '@/lib/seo/dataforseo/google-ads'
import { afterEach, expect, it, vi } from 'vitest'
import { setupDataforseoTestEnv } from './test-support'

setupDataforseoTestEnv()

afterEach(() => vi.unstubAllGlobals())

function stubAdsFetch() {
  const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () =>
    Response.json({
      status_code: 20000,
      tasks: [
        {
          status_code: 20000,
          path: ['v3', 'keywords_data', 'google_ads', 'search_volume', 'live'],
          cost: 0,
          result: [],
        },
      ],
    }),
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function expectLanguageCode(
  fetchMock: ReturnType<typeof stubAdsFetch>,
  languageCode: string,
) {
  const body = fetchMock.mock.lastCall?.[1]?.body
  if (typeof body !== 'string') throw new Error('Expected JSON request body')
  expect(JSON.parse(body)).toEqual([
    expect.objectContaining({ language_code: languageCode }),
  ])
}

it('sends Norwegian Bokmål to Google Ads as no', async () => {
  const fetchMock = stubAdsFetch()

  await fetchAdsSearchVolume({
    keywords: ['hotell oslo'],
    locationCode: 2578,
    languageCode: 'nb',
    locationName: 'Oslo,Oslo,Norway',
  })
  expectLanguageCode(fetchMock, 'no')

  await fetchAdsKeywordIdeas({
    keyword: 'hotell oslo',
    locationCode: 2578,
    languageCode: 'nb',
    limit: 10,
  })
  expectLanguageCode(fetchMock, 'no')
})
