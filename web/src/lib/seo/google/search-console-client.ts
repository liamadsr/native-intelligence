/**
 * Google Search Console, read only, for one access token: the sites the
 * account can see, Search Analytics (clicks, impressions, CTR, position) and
 * URL Inspection. Free: Google charges nothing for these, so nothing here is
 * metered.
 *
 * Adapted from OpenSEO (MIT, see ../THIRD_PARTY_NOTICES.md).
 */
import 'server-only'
import { z } from 'zod'
import { googleJson } from './fetch'

const GSC_API_BASE = 'https://www.googleapis.com/webmasters/v3'
const URL_INSPECTION_URL =
  'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect'
/** Google takes a few seconds per inspection. */
const INSPECTION_TIMEOUT_MS = 45_000

const siteSchema = z.object({
  siteUrl: z.string().min(1),
  permissionLevel: z.string().default(''),
})
const sitesSchema = z.object({ siteEntry: z.array(siteSchema).optional() })

const rowSchema = z.object({
  keys: z.array(z.string()).optional(),
  clicks: z.number(),
  impressions: z.number(),
  ctr: z.number(),
  // Discover and Google News report no position.
  position: z.number().optional(),
})
const searchAnalyticsSchema = z.object({ rows: z.array(rowSchema).optional() })

const inspectionSchema = z.object({
  inspectionResult: z
    .object({
      indexStatusResult: z
        .object({
          verdict: z.string().optional(),
          coverageState: z.string().optional(),
          robotsTxtState: z.string().optional(),
          indexingState: z.string().optional(),
          lastCrawlTime: z.string().optional(),
          pageFetchState: z.string().optional(),
          googleCanonical: z.string().optional(),
          userCanonical: z.string().optional(),
          crawledAs: z.string().optional(),
          sitemap: z.array(z.string()).optional(),
          referringUrls: z.array(z.string()).optional(),
        })
        .optional(),
      mobileUsabilityResult: z
        .object({ verdict: z.string().optional() })
        .optional(),
      richResultsResult: z
        .object({ verdict: z.string().optional() })
        .optional(),
      inspectionResultLink: z.string().optional(),
    })
    .optional(),
})

export type GscSite = z.infer<typeof siteSchema>
export type GscSearchAnalyticsRow = z.infer<typeof rowSchema>
export type GscInspection = NonNullable<
  z.infer<typeof inspectionSchema>['inspectionResult']
>

export interface GscSearchAnalyticsRequest {
  startDate: string
  endDate: string
  dimensions?: string[]
  dimensionFilterGroups?: Array<{
    groupType: 'and' | 'or'
    filters: Array<{ dimension: string; operator: string; expression: string }>
  }>
  rowLimit?: number
  startRow?: number
  type?: string
  dataState?: string
}

export interface GoogleClientOptions {
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export function createSearchConsoleClient(
  token: string,
  opts: GoogleClientOptions = {},
) {
  const base = {
    product: 'search_console' as const,
    token,
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs,
  }
  return {
    /** sites.list: every property the account can see, verified or not. */
    async listSites(): Promise<GscSite[]> {
      const data = await googleJson(`${GSC_API_BASE}/sites`, sitesSchema, base)
      return data.siteEntry ?? []
    },

    /** searchAnalytics.query for one property; its name is used verbatim. */
    async querySearchAnalytics(
      siteUrl: string,
      body: GscSearchAnalyticsRequest,
    ): Promise<GscSearchAnalyticsRow[]> {
      const data = await googleJson(
        `${GSC_API_BASE}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
        searchAnalyticsSchema,
        {
          ...base,
          method: 'POST',
          body,
          what: 'this site',
        },
      )
      return data.rows ?? []
    },

    /** urlInspection.index.inspect: what Google already knows about one page (not a live test). */
    async inspectUrl(
      siteUrl: string,
      inspectionUrl: string,
      languageCode?: string,
    ): Promise<GscInspection | null> {
      const data = await googleJson(URL_INSPECTION_URL, inspectionSchema, {
        ...base,
        method: 'POST',
        body: {
          siteUrl,
          inspectionUrl,
          ...(languageCode ? { languageCode } : {}),
        },
        timeoutMs: opts.timeoutMs ?? INSPECTION_TIMEOUT_MS,
        what: 'that page',
      })
      return data.inspectionResult ?? null
    },
  }
}

export type SearchConsoleClient = ReturnType<typeof createSearchConsoleClient>
