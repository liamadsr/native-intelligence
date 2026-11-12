/**
 * Which market (country and language) a keyword, SERP or domain lookup is
 * for, checked before anything is bought: a pair the provider does not serve
 * is otherwise rejected as an opaque, sometimes charged, failure. With no
 * country named the market is the United States in English, the provider's
 * largest; with only a country, that country's main language.
 *
 * Adapted from OpenSEO (MIT, see ../THIRD_PARTY_NOTICES.md).
 */
import { SeoInputError } from '@/lib/seo/input-error'
import {
  DEFAULT_LOCATION_CODE,
  getKeywordDataProvider,
  getLanguageCode,
  getLanguageOptions,
  isLanguageServedForLocation,
  isSupportedLanguageCode,
  isSupportedLocationCode,
} from '@/lib/seo/shared/keyword-locations'

export interface Market {
  locationCode: number
  languageCode: string
}

function resolveLocation(locationCode: number | null | undefined): number {
  const code = locationCode ?? DEFAULT_LOCATION_CODE
  if (!Number.isInteger(code) || !isSupportedLocationCode(code)) {
    throw new SeoInputError(
      'That country isn’t one we have search data for. Pick one from the list.',
    )
  }
  return code
}

/** The market for keyword research and keyword metrics: the language must be one keyword data serves in that country. */
export function resolveKeywordMarket(input: {
  location_code?: number | null
  language_code?: string | null
}): Market {
  const locationCode = resolveLocation(input.location_code)
  const languageCode =
    input.language_code?.trim() || getLanguageCode(locationCode)
  if (
    !isSupportedLanguageCode(languageCode) ||
    !isLanguageServedForLocation(locationCode, languageCode)
  ) {
    const offered = getLanguageOptions(locationCode)
      .map((option) => option.code)
      .join(', ')
    throw new SeoInputError(
      `That language isn’t available for this country. Available: ${offered}.`,
    )
  }
  return { locationCode, languageCode }
}

/** The market for a live SERP check: any country we list, any language search accepts. */
export function resolveSerpMarket(input: {
  location_code?: number | null
  language_code?: string | null
}): Market {
  const locationCode = resolveLocation(input.location_code)
  const languageCode =
    input.language_code?.trim() || getLanguageCode(locationCode)
  if (!isSupportedLanguageCode(languageCode)) {
    throw new SeoInputError(
      'That language isn’t one search results are available in.',
    )
  }
  return { locationCode, languageCode }
}

/** The market for domain data (overview, ranked keywords, SERP competitors): only countries the main keyword source covers. */
export function resolveDomainMarket(input: {
  location_code?: number | null
  language_code?: string | null
}): Market {
  const market = resolveKeywordMarket(input)
  if (getKeywordDataProvider(market.locationCode) !== 'labs') {
    throw new SeoInputError(
      'Domain data isn’t available for this country. Keyword research and live search results work there; domain overviews, ranked keywords and competitors don’t.',
    )
  }
  return market
}
