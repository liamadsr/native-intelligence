/**
 * Google Analytics 4, read only, for one access token: the Admin API for the
 * properties the account can see and how a property is set up (data streams,
 * enhanced measurement, key events, custom definitions), and the Data API's
 * runReport. Free: nothing here is metered.
 *
 * Adapted from OpenSEO (MIT, see ../THIRD_PARTY_NOTICES.md).
 */
import 'server-only'
import { z } from 'zod'
import { GoogleSeoError } from './errors'
import { googleJson } from './fetch'
import type { GoogleClientOptions } from './search-console-client'

const ADMIN_API = 'https://analyticsadmin.googleapis.com/v1beta'
const ADMIN_ALPHA_API = 'https://analyticsadmin.googleapis.com/v1alpha'
const DATA_API = 'https://analyticsdata.googleapis.com/v1beta'
const MAX_ACCOUNT_SUMMARY_PAGES = 100

export const PROPERTY_ID = /^properties\/\d{1,20}$/
const STREAM_NAME = /^properties\/\d{1,20}\/dataStreams\/\d{1,20}$/

const propertyIdSchema = z.string().regex(PROPERTY_ID)

const accountSummariesSchema = z.object({
  accountSummaries: z
    .array(
      z.object({
        account: z.string(),
        displayName: z.string().default(''),
        propertySummaries: z
          .array(
            z.object({
              property: propertyIdSchema,
              displayName: z.string().default(''),
            }),
          )
          .optional(),
      }),
    )
    .optional(),
  nextPageToken: z.string().optional(),
})

const propertySchema = z.object({
  name: propertyIdSchema,
  displayName: z.string().default(''),
  timeZone: z.string().min(1),
  currencyCode: z.string().default(''),
})

const dataStreamsSchema = z.object({
  dataStreams: z
    .array(
      z.object({
        name: z.string().regex(STREAM_NAME),
        type: z.string(),
        displayName: z.string().default(''),
        webStreamData: z
          .object({
            measurementId: z.string().optional(),
            defaultUri: z.string().optional(),
          })
          .optional(),
      }),
    )
    .optional(),
})

// ProtoJSON leaves out a field at its default value, so every one defaults.
const enhancedMeasurementSchema = z.object({
  streamEnabled: z.boolean().default(false),
  scrollsEnabled: z.boolean().default(false),
  outboundClicksEnabled: z.boolean().default(false),
  siteSearchEnabled: z.boolean().default(false),
  videoEngagementEnabled: z.boolean().default(false),
  fileDownloadsEnabled: z.boolean().default(false),
  pageChangesEnabled: z.boolean().default(false),
  formInteractionsEnabled: z.boolean().default(false),
  searchQueryParameter: z.string().default(''),
})

const keyEventsSchema = z.object({
  keyEvents: z
    .array(
      z.object({
        eventName: z.string(),
        countingMethod: z.string().default(''),
        custom: z.boolean().optional(),
      }),
    )
    .optional(),
})
const customDimensionsSchema = z.object({
  customDimensions: z
    .array(
      z.object({
        parameterName: z.string(),
        displayName: z.string().default(''),
        scope: z.string().default(''),
      }),
    )
    .optional(),
})
const customMetricsSchema = z.object({
  customMetrics: z
    .array(
      z.object({
        parameterName: z.string(),
        displayName: z.string().default(''),
        scope: z.string().default(''),
        measurementUnit: z.string().default(''),
      }),
    )
    .optional(),
})

const quotaStatusSchema = z.object({
  consumed: z.number().int(),
  remaining: z.number().int(),
})

const runReportSchema = z.object({
  dimensionHeaders: z.array(z.object({ name: z.string() })).optional(),
  metricHeaders: z
    .array(z.object({ name: z.string(), type: z.string().optional() }))
    .optional(),
  rows: z
    .array(
      z.object({
        dimensionValues: z
          .array(z.object({ value: z.string().default('') }))
          .optional(),
        metricValues: z
          .array(z.object({ value: z.string().default('') }))
          .optional(),
      }),
    )
    .optional(),
  rowCount: z.number().int().nonnegative().optional(),
  metadata: z
    .object({
      dataLossFromOtherRow: z.boolean().optional(),
      samplingMetadatas: z
        .array(
          z.object({
            samplesReadCount: z.string(),
            samplingSpaceSize: z.string(),
          }),
        )
        .optional(),
      schemaRestrictionResponse: z
        .object({
          activeMetricRestrictions: z
            .array(
              z.object({
                metricName: z.string(),
                restrictedMetricTypes: z.array(z.string()).optional(),
              }),
            )
            .optional(),
        })
        .optional(),
      currencyCode: z.string().optional(),
      timeZone: z.string().optional(),
      emptyReason: z.string().optional(),
      subjectToThresholding: z.boolean().optional(),
    })
    .optional(),
  propertyQuota: z.record(z.string(), quotaStatusSchema).optional(),
})

export type Ga4RunReportResponse = z.infer<typeof runReportSchema>

export interface Ga4RunReportRequest {
  dateRanges: Array<{ startDate: string; endDate: string }>
  dimensions: Array<{ name: string }>
  metrics: Array<{ name: string }>
  dimensionFilter?: unknown
  metricFilter?: unknown
  offset: string
  limit: string
  orderBys: Array<{
    metric?: { metricName: string }
    dimension?: { dimensionName: string }
    desc?: boolean
  }>
  keepEmptyRows: false
  returnPropertyQuota: true
}

export interface Ga4PropertySummary {
  propertyId: string
  displayName: string
  accountDisplayName: string
}

/** 'properties/123', or a bare '123', as Google's resource name; null for anything else. */
export function canonicalPropertyId(value: string): string | null {
  const trimmed = value.trim()
  if (PROPERTY_ID.test(trimmed)) return trimmed
  return /^\d{1,20}$/.test(trimmed) ? `properties/${trimmed}` : null
}

function checkedProperty(propertyId: string): string {
  const id = canonicalPropertyId(propertyId)
  if (!id)
    throw new GoogleSeoError(
      'INVALID_REQUEST',
      'analytics',
      'A Google Analytics property looks like properties/123456.',
    )
  return id
}

export function createAnalyticsClient(
  token: string,
  opts: GoogleClientOptions = {},
) {
  const base = {
    product: 'analytics' as const,
    token,
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs,
  }
  const admin = { ...base, what: 'this property' }
  return {
    /** accountSummaries.list, every page: each property the account can see, with its account's name. */
    async listProperties(): Promise<Ga4PropertySummary[]> {
      const properties: Ga4PropertySummary[] = []
      let pageToken: string | undefined
      for (let page = 0; page < MAX_ACCOUNT_SUMMARY_PAGES; page += 1) {
        const url = new URL(`${ADMIN_API}/accountSummaries`)
        url.searchParams.set('pageSize', '200')
        if (pageToken) url.searchParams.set('pageToken', pageToken)
        const data = await googleJson(
          url.toString(),
          accountSummariesSchema,
          base,
        )
        for (const account of data.accountSummaries ?? []) {
          for (const property of account.propertySummaries ?? []) {
            properties.push({
              propertyId: property.property,
              displayName: property.displayName,
              accountDisplayName: account.displayName,
            })
          }
        }
        pageToken = data.nextPageToken || undefined
        if (!pageToken) return properties
      }
      throw new GoogleSeoError(
        'UPSTREAM',
        'analytics',
        'Google Analytics listed more properties than we can read. Try again later.',
        { detail: 'accountSummaries > 100 pages' },
      )
    },

    /** properties.get: its name, time zone and currency. */
    async getProperty(propertyId: string) {
      return googleJson(
        `${ADMIN_API}/${checkedProperty(propertyId)}`,
        propertySchema,
        admin,
      )
    },

    async listDataStreams(propertyId: string) {
      const url = new URL(
        `${ADMIN_ALPHA_API}/${checkedProperty(propertyId)}/dataStreams`,
      )
      url.searchParams.set('pageSize', '200')
      return (
        (await googleJson(url.toString(), dataStreamsSchema, admin))
          .dataStreams ?? []
      )
    },

    async getEnhancedMeasurementSettings(streamName: string) {
      if (!STREAM_NAME.test(streamName))
        throw new GoogleSeoError(
          'UPSTREAM',
          'analytics',
          'Google Analytics named a data stream we couldn’t read.',
          { detail: 'stream name' },
        )
      return googleJson(
        `${ADMIN_ALPHA_API}/${streamName}/enhancedMeasurementSettings`,
        enhancedMeasurementSchema,
        admin,
      )
    },

    async listKeyEvents(propertyId: string) {
      const url = new URL(
        `${ADMIN_API}/${checkedProperty(propertyId)}/keyEvents`,
      )
      url.searchParams.set('pageSize', '200')
      return (
        (await googleJson(url.toString(), keyEventsSchema, admin)).keyEvents ??
        []
      )
    },

    async listCustomDimensions(propertyId: string) {
      const url = new URL(
        `${ADMIN_API}/${checkedProperty(propertyId)}/customDimensions`,
      )
      url.searchParams.set('pageSize', '200')
      return (
        (await googleJson(url.toString(), customDimensionsSchema, admin))
          .customDimensions ?? []
      )
    },

    async listCustomMetrics(propertyId: string) {
      const url = new URL(
        `${ADMIN_API}/${checkedProperty(propertyId)}/customMetrics`,
      )
      url.searchParams.set('pageSize', '200')
      return (
        (await googleJson(url.toString(), customMetricsSchema, admin))
          .customMetrics ?? []
      )
    },

    /** The Data API's runReport for one property. */
    async runReport(
      propertyId: string,
      request: Ga4RunReportRequest,
    ): Promise<Ga4RunReportResponse> {
      return googleJson(
        `${DATA_API}/${checkedProperty(propertyId)}:runReport`,
        runReportSchema,
        {
          ...base,
          method: 'POST',
          body: request,
          what: 'this property',
        },
      )
    },
  }
}

export type AnalyticsClient = ReturnType<typeof createAnalyticsClient>
