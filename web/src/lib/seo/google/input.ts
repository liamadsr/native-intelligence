/**
 * The request bodies the Google routes take, checked with zod at the door.
 * The library checks the rules that need more than a shape (date order, a
 * breakdown the report takes); these only keep the shapes and sizes honest.
 */
import { z } from 'zod'
import {
  ANALYTICS_CHANNELS,
  ANALYTICS_MAX_LIMIT,
  ANALYTICS_REPORTS,
  GSC_DATA_STATES,
  GSC_DATE_RANGES,
  GSC_DIMENSIONS,
  GSC_FILTER_OPERATORS,
  GSC_MAX_FILTERS,
  GSC_MAX_ROW_LIMIT,
  GSC_SEARCH_TYPES,
  URL_INSPECTION_MAX,
} from './view'

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

export const performanceInput = z.object({
  dimensions: z.array(z.enum(GSC_DIMENSIONS)).min(1).max(4).optional(),
  date_range: z.enum(GSC_DATE_RANGES).optional(),
  start_date: date.optional(),
  end_date: date.optional(),
  filters: z
    .array(
      z.object({
        dimension: z.enum(GSC_DIMENSIONS),
        operator: z.enum(GSC_FILTER_OPERATORS).optional(),
        expression: z.string().min(1).max(1000),
      }),
    )
    .max(GSC_MAX_FILTERS)
    .optional(),
  row_limit: z.number().int().min(1).max(GSC_MAX_ROW_LIMIT).optional(),
  start_row: z.number().int().min(0).max(10_000_000).optional(),
  min_position: z.number().min(1).max(1000).optional(),
  max_position: z.number().min(1).max(1000).optional(),
  min_impressions: z.number().int().min(0).optional(),
  type: z.enum(GSC_SEARCH_TYPES).optional(),
  data_state: z.enum(GSC_DATA_STATES).optional(),
  compare: z.boolean().optional(),
})

export const opportunitiesInput = z.object({
  start_date: date.optional(),
  end_date: date.optional(),
  limit: z.number().int().min(1).max(100).optional(),
})

export const inspectInput = z.object({
  urls: z.array(z.string().min(1).max(2048)).min(1).max(URL_INSPECTION_MAX),
  language_code: z.string().max(20).optional(),
})

export const analyticsReportInput = z.object({
  report: z.enum(ANALYTICS_REPORTS),
  start_date: date.optional(),
  end_date: date.optional(),
  limit: z.number().int().min(1).max(ANALYTICS_MAX_LIMIT).optional(),
  offset: z.number().int().min(0).max(10_000_000).optional(),
  channel: z.enum(ANALYTICS_CHANNELS).optional(),
  include_date: z.boolean().optional(),
  breakdown: z.string().max(40).optional(),
  compare_previous_period: z.boolean().optional(),
  only_with_transactions: z.boolean().optional(),
  trend: z.enum(['daily', 'weekly']).optional(),
})
