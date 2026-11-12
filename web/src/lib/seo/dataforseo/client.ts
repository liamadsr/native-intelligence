/**
 * The metered DataForSEO client: every paid endpoint, each wrapped so it runs
 * through the injected DataforseoMeter with its price estimate.
 *
 * Adapted from OpenSEO (MIT, see ../THIRD_PARTY_NOTICES.md).
 */
import 'server-only'

import {
  fetchLlmAggregatedMetrics,
  fetchLlmCrossAggregatedMetrics,
  fetchLlmMentionsSearch,
  fetchLlmResponse,
  fetchLlmTopPages,
} from '@/lib/seo/dataforseo/ai'
import {
  fetchAiTrackingLiveAnswer,
  postAiTrackingTasks,
} from '@/lib/seo/dataforseo/ai-tracking'
import {
  fetchBacklinksHistory,
  fetchBacklinksRows,
  fetchBacklinksSummary,
  fetchDomainPagesSummary,
  fetchReferringDomains,
} from '@/lib/seo/dataforseo/backlinks'
import {
  fetchBusinessListingsSearch,
  fetchMyBusinessInfo,
  fetchQuestionsAnswers,
  postGoogleReviewsTask,
  postMyBusinessUpdatesTask,
} from '@/lib/seo/dataforseo/business'
import { runCapturingCharges } from '@/lib/seo/dataforseo/charge-capture'
import {
  DataforseoChargedTaskError,
  invalidFieldName,
  type DataforseoApiResponse,
} from '@/lib/seo/dataforseo/envelope'
import {
  fetchAdsKeywordIdeas,
  fetchAdsSearchVolume,
} from '@/lib/seo/dataforseo/google-ads'
import {
  fetchDomainRankOverview,
  fetchKeywordIdeas,
  fetchKeywordOverview,
  fetchKeywordSuggestions,
  fetchRankedKeywords,
  fetchRelatedKeywords,
  fetchRelevantPages,
  fetchSerpCompetitors,
} from '@/lib/seo/dataforseo/labs'
import { fetchLighthouseResult } from '@/lib/seo/dataforseo/lighthouse'
import type {
  DataforseoMeter,
  SeoSpendFeature,
} from '@/lib/seo/dataforseo/meter'
import { dataforseoPricing } from '@/lib/seo/dataforseo/pricing'
import {
  fetchLocalSerp,
  postLocalSerpTasks,
  postRankCheckTasks,
  postSerpReadTasks,
  type SerpReadsQuery,
} from '@/lib/seo/dataforseo/serp'
import { SeoError } from '@/lib/seo/errors'

/** Every metered entry accepts this beside its own input (fetchers ignore it). */
export type MeteredCallOptions = {
  /** Attributes the spend to another part of the SEO area than the entry's default. */
  feature?: SeoSpendFeature
}

/**
 * The one choke point every metered call runs through.
 *
 * The charge is read off the provider's tasks as soon as a response is
 * parsed, before its result is (./charge-capture.ts). Any throw after the
 * provider accepted and charged the task (a result whose shape changed, a
 * classified task error, a fetcher's own check) leaves here as a
 * DataforseoChargedTaskError carrying that charge, so the meter writes the
 * ledger row and the month's ceiling keeps counting. A failure before
 * anything was charged leaves unchanged and records nothing.
 *
 * A DataForSEO rejection of a malformed request ("Invalid Field: ...") that
 * DataForSEO did not bill returned nothing of value and cost nothing, so it
 * reaches the meter as a plain VALIDATION_ERROR rather than a charged
 * failure. If DataForSEO still billed it (costUsd > 0), it stays a
 * DataforseoChargedTaskError so the meter records the spend instead of it
 * being silently eaten.
 */
async function execForMeter<T>(
  exec: () => Promise<DataforseoApiResponse<T>>,
): Promise<DataforseoApiResponse<T>> {
  try {
    return await runCapturingCharges(exec)
  } catch (error) {
    if (
      error instanceof DataforseoChargedTaskError &&
      error.isInvalidField &&
      error.billing.costUsd <= 0
    ) {
      // The field name, not the message, which quotes the value that was sent.
      console.warn('dataforseo.invalid-field', {
        event: 'dataforseo.invalid-field',
        path: `/${error.billing.path.join('/')}`,
        field: invalidFieldName(error.message),
      })
      throw new SeoError('VALIDATION_ERROR', error.message)
    }
    throw error
  }
}

/**
 * Wraps a section fetcher with the meter. Each entry on the client is
 * `metered(fetchX, dataforseoPricing.section.x, defaultFeature)`, which
 * returns a function with the fetcher's own input type (plus `feature`) and
 * resolves to its unwrapped `.data`.
 *
 * `estimateUsd` is required: it is the upper bound the meter checks before
 * the call, so an entry cannot be added without a price (see pricing.ts).
 */
function metered<I, T>(
  meter: DataforseoMeter,
  fetcher: (input: I) => Promise<DataforseoApiResponse<T>>,
  estimateUsd: (input: I) => number,
  defaultFeature: SeoSpendFeature,
): (input: I & MeteredCallOptions) => Promise<T> {
  return (input) =>
    meter.run({
      feature: input.feature ?? defaultFeature,
      estimateUsd: estimateUsd(input),
      exec: () => execForMeter(() => fetcher(input)),
    })
}

/**
 * Runs a batch of metered calls, each estimated, refused or recorded on its
 * own, and resolves per call, in input order. One refused or failed call does
 * not fail the others.
 */
function meteredBatch<I, T>(
  meter: DataforseoMeter,
  fetcher: (input: I) => Promise<DataforseoApiResponse<T>>,
  estimateUsd: (input: I) => number,
  defaultFeature: SeoSpendFeature,
): (
  inputs: I[],
  options?: MeteredCallOptions,
) => Promise<PromiseSettledResult<T>[]> {
  const one = metered(meter, fetcher, estimateUsd, defaultFeature)
  return (inputs, options = {}) =>
    Promise.allSettled(
      inputs.map((input) =>
        one({ ...input, feature: options.feature ?? defaultFeature }),
      ),
    )
}

export type DataforseoClient = ReturnType<typeof createDataforseoClient>

export function createDataforseoClient(meter: DataforseoMeter) {
  return {
    business: {
      businessListings: metered(
        meter,
        fetchBusinessListingsSearch,
        dataforseoPricing.business.businessListings,
        'local_seo',
      ),
      questionsAnswers: metered(
        meter,
        fetchQuestionsAnswers,
        dataforseoPricing.business.questionsAnswers,
        'local_seo',
      ),
      myBusinessInfo: metered(
        meter,
        fetchMyBusinessInfo,
        dataforseoPricing.business.myBusinessInfo,
        'local_seo',
      ),
      // task_post is where DataForSEO charges; collection runs unmetered
      // through fetchBusinessDataTaskResult (see index.ts).
      reviewsTaskPost: metered(
        meter,
        postGoogleReviewsTask,
        dataforseoPricing.business.reviewsTaskPost,
        'local_seo',
      ),
      updatesTaskPost: metered(
        meter,
        postMyBusinessUpdatesTask,
        dataforseoPricing.business.updatesTaskPost,
        'local_seo',
      ),
    },
    backlinks: {
      summary: metered(
        meter,
        fetchBacklinksSummary,
        dataforseoPricing.backlinks.summary,
        'backlinks',
      ),
      rows: metered(
        meter,
        fetchBacklinksRows,
        dataforseoPricing.backlinks.rows,
        'backlinks',
      ),
      referringDomains: metered(
        meter,
        fetchReferringDomains,
        dataforseoPricing.backlinks.referringDomains,
        'backlinks',
      ),
      domainPages: metered(
        meter,
        fetchDomainPagesSummary,
        dataforseoPricing.backlinks.domainPages,
        'backlinks',
      ),
      history: metered(
        meter,
        fetchBacklinksHistory,
        dataforseoPricing.backlinks.history,
        'backlinks',
      ),
    },
    keywords: {
      related: metered(
        meter,
        fetchRelatedKeywords,
        dataforseoPricing.keywords.related,
        'keywords',
      ),
      suggestions: metered(
        meter,
        fetchKeywordSuggestions,
        dataforseoPricing.keywords.suggestions,
        'keywords',
      ),
      ideas: metered(
        meter,
        fetchKeywordIdeas,
        dataforseoPricing.keywords.ideas,
        'keywords',
      ),
      // Google Ads endpoints for countries Labs doesn't support.
      adsIdeas: metered(
        meter,
        fetchAdsKeywordIdeas,
        dataforseoPricing.keywords.adsIdeas,
        'keywords',
      ),
      adsSearchVolume: metered(
        meter,
        fetchAdsSearchVolume,
        dataforseoPricing.keywords.adsSearchVolume,
        'keywords',
      ),
    },
    domain: {
      rankOverview: metered(
        meter,
        fetchDomainRankOverview,
        dataforseoPricing.domain.rankOverview,
        'domain',
      ),
      rankedKeywords: metered(
        meter,
        fetchRankedKeywords,
        dataforseoPricing.domain.rankedKeywords,
        'domain',
      ),
      relevantPages: metered(
        meter,
        fetchRelevantPages,
        dataforseoPricing.domain.relevantPages,
        'domain',
      ),
    },
    serp: {
      // Posts each query's merged reads (one task_post per query); every
      // query is estimated, refused and recorded on its own. DataForSEO bills
      // task_post, collection (fetchSerpTaskResult) is free. Resolves per
      // query, in order.
      readsTaskPostBatch: meteredBatch<SerpReadsQuery, string[]>(
        meter,
        postSerpReadTasks,
        dataforseoPricing.serp.readsTaskPost,
        'serp',
      ),
      // Posts up to 100 queued rank check tasks as one metered call
      // (DataForSEO bills task_post at post time, collection is free).
      rankCheckTaskPost: metered(
        meter,
        postRankCheckTasks,
        dataforseoPricing.serp.rankCheckTaskPost,
        'rank_tracking',
      ),
      local: metered(
        meter,
        fetchLocalSerp,
        dataforseoPricing.serp.local,
        'local_seo',
      ),
      // Live Maps searches for a Local SEO check, one per grid point, each
      // metered on its own. Resolves per call, in order.
      localBatch: meteredBatch(
        meter,
        fetchLocalSerp,
        dataforseoPricing.serp.local,
        'local_seo',
      ),
      // One queued Maps task per rank grid point, as one metered call
      // (DataForSEO bills task_post, collection is free).
      localTaskPost: metered(
        meter,
        postLocalSerpTasks,
        dataforseoPricing.serp.localTaskPost,
        'local_seo',
      ),
    },
    labs: {
      // Callers (e.g. keyword metrics for a saved list) can attribute the
      // spend to their own feature by passing `feature` in the input;
      // defaults to rank_tracking when omitted.
      keywordOverview: metered(
        meter,
        fetchKeywordOverview,
        dataforseoPricing.labs.keywordOverview,
        'rank_tracking',
      ),
      serpCompetitors: metered(
        meter,
        fetchSerpCompetitors,
        dataforseoPricing.labs.serpCompetitors,
        'keywords',
      ),
    },
    lighthouse: {
      live: metered(
        meter,
        fetchLighthouseResult,
        dataforseoPricing.lighthouse.live,
        'lighthouse',
      ),
    },
    aiSearch: {
      mentionsSearch: metered(
        meter,
        fetchLlmMentionsSearch,
        dataforseoPricing.aiSearch.mentionsSearch,
        'ai_visibility',
      ),
      aggregatedMetrics: metered(
        meter,
        fetchLlmAggregatedMetrics,
        dataforseoPricing.aiSearch.aggregatedMetrics,
        'ai_visibility',
      ),
      topPages: metered(
        meter,
        fetchLlmTopPages,
        dataforseoPricing.aiSearch.topPages,
        'ai_visibility',
      ),
      crossAggregatedMetrics: metered(
        meter,
        fetchLlmCrossAggregatedMetrics,
        dataforseoPricing.aiSearch.crossAggregatedMetrics,
        'ai_visibility',
      ),
      llmResponse: metered(
        meter,
        fetchLlmResponse,
        dataforseoPricing.aiSearch.llmResponse,
        'ai_visibility',
      ),
      // Posts up to 100 tracked prompts for one engine as one metered call.
      // DataForSEO bills at task_post, so that is the cost the meter records;
      // answers are collected for free with fetchAiTrackingTaskResult.
      trackingTaskPost: metered(
        meter,
        postAiTrackingTasks,
        dataforseoPricing.aiSearch.trackingTaskPost,
        'ai_visibility',
      ),
      // A manual run's live answers, each metered on its own. Resolves per
      // call, in order.
      trackingLiveBatch: meteredBatch(
        meter,
        fetchAiTrackingLiveAnswer,
        dataforseoPricing.aiSearch.trackingLive,
        'ai_visibility',
      ),
    },
  } as const
}
