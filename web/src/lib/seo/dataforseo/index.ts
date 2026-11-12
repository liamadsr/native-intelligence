/**
 * Public surface of the DataForSEO integration. Internals live in the
 * per-section files (labs / serp / business / backlinks / ai / lighthouse);
 * everything funnels through envelope.ts (status + billing) and core.ts
 * (transport), and every paid call is metered in client.ts.
 *
 * Adapted from OpenSEO (MIT, see ../THIRD_PARTY_NOTICES.md).
 */
import 'server-only'

export {
  createDataforseoClient,
  type DataforseoClient,
  type MeteredCallOptions,
} from '@/lib/seo/dataforseo/client'
export {
  DATAFORSEO_API_KEY_SETTING,
  isDataforseoConfigured,
} from '@/lib/seo/dataforseo/core'
export {
  DataforseoChargedTaskError,
  type DataforseoApiCallCost,
  type DataforseoApiResponse,
} from '@/lib/seo/dataforseo/envelope'
export type {
  DataforseoMeter,
  SeoSpendFeature,
} from '@/lib/seo/dataforseo/meter'
export { dataforseoPricing, llmResponseUsd } from '@/lib/seo/dataforseo/pricing'

export {
  fetchKeywordMetricsForList,
  type KeywordMetricRow,
} from '@/lib/seo/dataforseo/keyword-metrics'

export {
  CHATGPT_LANGUAGE_CODE,
  CHATGPT_LOCATION_CODE,
  MAX_TASKS_PER_POST,
  buildLlmTarget,
  type LlmPlatform,
  type LlmTarget,
} from '@/lib/seo/dataforseo/shared'

export { SERP_ANALYSIS_DEPTH } from '@/lib/seo/dataforseo/serp'

export { normalizeBacklinksTarget } from '@/lib/seo/dataforseo/backlinks-target'

// Calls made outside the metered client. Task collection is free at
// DataForSEO (the task was charged at task_post), so routing these through
// the meter would count the spend twice; the rest are free endpoints ($0):
// business categories, the goto URL converter, account data, the LLM model
// catalog, SERP locations and the sandbox location check.
export {
  fetchAiTrackingTaskResult,
  type AiTrackingAnswer,
  type PostedAiTrackingTask,
} from '@/lib/seo/dataforseo/ai-tracking'
export {
  MAX_GOTO_URLS_PER_REQUEST,
  fetchUserData,
  resolveGotoUrls,
} from '@/lib/seo/dataforseo/appendix'
export {
  fetchBusinessDataTaskResult,
  fetchBusinessListingsCategories,
  type BusinessTaskEndpoint,
  type BusinessTaskOutcome,
} from '@/lib/seo/dataforseo/business'
export {
  isKnownLlmModelName,
  resolveLatestLlmModelName,
  type LlmResponseModelSlug,
} from '@/lib/seo/dataforseo/llm-models'
export {
  fetchLocalSerpTaskResult,
  fetchRankCheckTaskResult,
  fetchSerpTaskResult,
} from '@/lib/seo/dataforseo/serp'
export {
  assertSerpLocationNameAccepted,
  probeSerpLocation,
} from '@/lib/seo/dataforseo/serp-location-validate'
export {
  fetchSerpLocationsForCountry,
  type SerpLocationResult,
} from '@/lib/seo/dataforseo/serp-locations'

export type {
  DomainRankedKeywordItem,
  KeywordOverviewItem,
  LabsKeywordDataItem,
  RelevantPagesItem,
} from '@/lib/seo/dataforseo/labs'

export type {
  AdsKeywordIdeaItem,
  AdsKeywordItem,
} from '@/lib/seo/dataforseo/google-ads'

export type {
  LocalSerpTaskOutcome,
  PostedRankCheckTask,
  RankCheckResult,
  RankCheckTaskInput,
  SerpLiveItem,
  SerpReadsQuery,
} from '@/lib/seo/dataforseo/serp'

export type {
  BacklinksHistoryItem,
  BacklinksItem,
  BacklinksSummaryItem,
  DomainPageSummaryItem,
  ReferringDomainItem,
} from '@/lib/seo/dataforseo/backlinks'

export type { StoredLighthousePayload } from '@/lib/seo/dataforseo/lighthouse-stored-payload'

// Input types of the metered client's entries (each entry also takes
// MeteredCallOptions).
export type {
  LlmAggregatedMetricsInput,
  LlmCrossAggregatedMetricsInput,
  LlmMentionsSearchInput,
  LlmResponsesInput,
  LlmTopPagesInput,
} from '@/lib/seo/dataforseo/ai'
export type {
  AiTrackingLiveInput,
  AiTrackingTasksPostInput,
} from '@/lib/seo/dataforseo/ai-tracking'
export type {
  BacklinksListRequest,
  BacklinksRequest,
  BacklinksTimeseriesRequest,
} from '@/lib/seo/dataforseo/backlinks'
export type {
  BusinessListingsSearchInput,
  GoogleReviewsTaskInput,
  MyBusinessInfoInput,
  MyBusinessUpdatesTaskInput,
  QuestionsAnswersInput,
} from '@/lib/seo/dataforseo/business'
export type {
  AdsKeywordIdeasInput,
  AdsSearchVolumeInput,
} from '@/lib/seo/dataforseo/google-ads'
export type {
  DomainRankOverviewInput,
  KeywordIdeasInput,
  KeywordOverviewInput,
  KeywordSuggestionsInput,
  RankedKeywordsInput,
  RelatedKeywordsInput,
  RelevantPagesInput,
  SerpCompetitorsInput,
} from '@/lib/seo/dataforseo/labs'
export type { LighthouseInput } from '@/lib/seo/dataforseo/lighthouse'
export type {
  LocalSerpInput,
  LocalSerpTasksPostInput,
  RankCheckTasksPostInput,
} from '@/lib/seo/dataforseo/serp'
