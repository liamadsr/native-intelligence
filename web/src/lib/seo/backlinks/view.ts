/**
 * What the backlinks pages and tools read: an overview of a domain's or a
 * page's backlinks (totals, new and lost, the history series), and one page
 * of its profile (the backlinks themselves, the referring domains, or the
 * pages that collect the most links), with the filters and sorts each takes.
 * Client safe: types, the request schemas and their defaults only.
 *
 * Adapted from OpenSEO (MIT, see ../THIRD_PARTY_NOTICES.md).
 */
import {
  backlinksRowsModeSchema,
  backlinksScopeParamSchema,
} from '@/lib/seo/shared/backlinks'
import type { ResearchScope } from '@/lib/seo/shared/researchScope'
import { z } from 'zod'

/** The three lists of a backlinks profile. */
export const BACKLINKS_TABS = ['backlinks', 'domains', 'pages'] as const
export type BacklinksTab = (typeof BACKLINKS_TABS)[number]

export const BACKLINKS_PAGE_SIZES = [25, 50, 100] as const
export const DEFAULT_BACKLINKS_PAGE_SIZE = 50
/** The deepest page a profile may ask for (the provider pages by offset). */
export const MAX_BACKLINKS_PAGE = 100

const optionalNumber = z
  .union([
    z.number(),
    z.string().transform((value, ctx) => {
      const trimmed = value.trim()
      if (trimmed === '') return undefined
      const parsed = Number(trimmed)
      if (!Number.isFinite(parsed)) {
        ctx.addIssue({ code: 'custom', message: 'Invalid number' })
        return z.NEVER
      }
      return parsed
    }),
  ])
  .optional()

const filterTerms = z.string().max(500).optional()

export const backlinksRowsFiltersSchema = z.object({
  include: filterTerms,
  exclude: filterTerms,
  minDomainRank: optionalNumber,
  maxDomainRank: optionalNumber,
  minLinkAuthority: optionalNumber,
  maxLinkAuthority: optionalNumber,
  minSpamScore: optionalNumber,
  maxSpamScore: optionalNumber,
  linkType: z.enum(['dofollow', 'nofollow']).optional(),
  hideLost: z.boolean().optional(),
  hideBroken: z.boolean().optional(),
  /** Exact-match on the linking domain; used to expand one domain's links. */
  domainFrom: z.string().max(255).optional(),
})

export const referringDomainsFiltersSchema = z.object({
  include: filterTerms,
  exclude: filterTerms,
  minBacklinks: optionalNumber,
  maxBacklinks: optionalNumber,
  minRank: optionalNumber,
  maxRank: optionalNumber,
  minSpamScore: optionalNumber,
  maxSpamScore: optionalNumber,
})

export const topPagesFiltersSchema = z.object({
  include: filterTerms,
  exclude: filterTerms,
  minBacklinks: optionalNumber,
  maxBacklinks: optionalNumber,
  minReferringDomains: optionalNumber,
  maxReferringDomains: optionalNumber,
  minRank: optionalNumber,
  maxRank: optionalNumber,
})

export const backlinksSortOrderSchema = z.enum(['asc', 'desc'])
export const backlinksRowsSortFieldSchema = z.enum([
  'rank',
  'domainRank',
  'spamScore',
  'firstSeen',
])
export const referringDomainsSortFieldSchema = z.enum([
  'domain',
  'backlinks',
  'referringPages',
  'rank',
  'spamScore',
  'firstSeen',
  'brokenBacklinks',
])
export const topPagesSortFieldSchema = z.enum([
  'backlinks',
  'referringDomains',
  'rank',
  'brokenBacklinks',
])

export type BacklinksSortOrder = z.infer<typeof backlinksSortOrderSchema>
export type BacklinksRowsSortField = z.infer<
  typeof backlinksRowsSortFieldSchema
>
export type ReferringDomainsSortField = z.infer<
  typeof referringDomainsSortFieldSchema
>
export type TopPagesSortField = z.infer<typeof topPagesSortFieldSchema>
export type BacklinksRowsFilters = z.infer<typeof backlinksRowsFiltersSchema>
export type ReferringDomainsFilters = z.infer<
  typeof referringDomainsFiltersSchema
>
export type TopPagesFilters = z.infer<typeof topPagesFiltersSchema>
export type BacklinksRowsMode = z.infer<typeof backlinksRowsModeSchema>

/** Each tab's default sort. */
export const BACKLINKS_DEFAULT_SORT = {
  backlinks: { field: 'firstSeen', order: 'desc' },
  domains: { field: 'backlinks', order: 'desc' },
  pages: { field: 'backlinks', order: 'desc' },
} as const satisfies Record<
  BacklinksTab,
  { field: string; order: BacklinksSortOrder }
>

const targetField = z.string().trim().max(2048).optional()

/** POST /api/account/seo/backlinks/overview. No target: the workspace's own site. */
export const backlinksOverviewRequestSchema = z.object({
  target: targetField,
  scope: backlinksScopeParamSchema.optional(),
  /** Buy again even when a stored overview is fresh. */
  refresh: z.boolean().optional(),
})
export type BacklinksOverviewRequest = z.infer<
  typeof backlinksOverviewRequestSchema
>

const pageBase = {
  target: targetField,
  scope: backlinksScopeParamSchema.optional(),
  page: z.number().int().min(1).max(MAX_BACKLINKS_PAGE).default(1),
  page_size: z
    .number()
    .int()
    .refine((value) =>
      (BACKLINKS_PAGE_SIZES as readonly number[]).includes(value),
    )
    .default(DEFAULT_BACKLINKS_PAGE_SIZE),
  sort_order: backlinksSortOrderSchema.default('desc'),
  refresh: z.boolean().optional(),
}

/** POST /api/account/seo/backlinks/profile: one page of one tab. */
export const backlinksProfileRequestSchema = z.discriminatedUnion('tab', [
  z.object({
    tab: z.literal('backlinks'),
    ...pageBase,
    sort_field: backlinksRowsSortFieldSchema.default(
      BACKLINKS_DEFAULT_SORT.backlinks.field,
    ),
    filters: backlinksRowsFiltersSchema.default({}),
    mode: backlinksRowsModeSchema.default('one_per_domain'),
    hide_spam: z.boolean().default(true),
  }),
  z.object({
    tab: z.literal('domains'),
    ...pageBase,
    sort_field: referringDomainsSortFieldSchema.default(
      BACKLINKS_DEFAULT_SORT.domains.field,
    ),
    filters: referringDomainsFiltersSchema.default({}),
    hide_spam: z.boolean().default(true),
  }),
  z.object({
    tab: z.literal('pages'),
    ...pageBase,
    sort_field: topPagesSortFieldSchema.default(
      BACKLINKS_DEFAULT_SORT.pages.field,
    ),
    filters: topPagesFiltersSchema.default({}),
  }),
])
export type BacklinksProfileRequest = z.infer<
  typeof backlinksProfileRequestSchema
>

export interface BacklinksSummary {
  rank: number | null
  backlinks: number | null
  referring_pages: number | null
  referring_domains: number | null
  broken_backlinks: number | null
  broken_pages: number | null
  /** Share of backlinks that are dofollow, 0 to 1. Null when the provider did not say. */
  dofollow_share: number | null
  backlinks_spam_score: number | null
  target_spam_score: number | null
  new_backlinks: number | null
  lost_backlinks: number | null
  new_referring_domains: number | null
  lost_referring_domains: number | null
}

export interface BacklinksTrendPoint {
  date: string
  backlinks: number | null
  referring_domains: number | null
  rank: number | null
  new_backlinks: number | null
  lost_backlinks: number | null
  new_referring_domains: number | null
  lost_referring_domains: number | null
}

/** What a stored or fresh lookup carries beside its data. */
export interface StoredLookupMeta {
  lookup_id: string | null
  fetched_at: string
  from_cache: boolean
}

export interface BacklinksOverview extends StoredLookupMeta {
  target: string
  display_target: string
  scope: ResearchScope
  summary: BacklinksSummary
  /** A year of daily totals and new/lost counts, oldest first. Empty for a page or a subfolder. */
  history: BacklinksTrendPoint[]
  /** What the numbers do not cover, in words (a provider limit), or null. */
  scope_note: string | null
}

export interface BacklinkRow {
  domain_from: string | null
  url_from: string | null
  url_to: string | null
  /** The link text, as the linking page wrote it: outside text. */
  anchor: string | null
  item_type: string | null
  dofollow: boolean | null
  rel_attributes: string[]
  rank: number | null
  domain_from_rank: number | null
  page_from_rank: number | null
  spam_score: number | null
  first_seen: string | null
  last_seen: string | null
  is_lost: boolean
  is_broken: boolean
  links_count: number | null
}

export interface ReferringDomainRow {
  domain: string | null
  backlinks: number | null
  referring_pages: number | null
  rank: number | null
  spam_score: number | null
  first_seen: string | null
  broken_backlinks: number | null
  broken_pages: number | null
}

export interface TopPageRow {
  page: string | null
  backlinks: number | null
  referring_domains: number | null
  rank: number | null
  broken_backlinks: number | null
}

interface ProfilePageBase extends StoredLookupMeta {
  target: string
  display_target: string
  scope: ResearchScope
  page: number
  page_size: number
  total_count: number | null
  has_more: boolean
}

export type BacklinksProfilePage =
  | (ProfilePageBase & { tab: 'backlinks'; rows: BacklinkRow[] })
  | (ProfilePageBase & { tab: 'domains'; rows: ReferringDomainRow[] })
  | (ProfilePageBase & { tab: 'pages'; rows: TopPageRow[] })

/** Provider timestamps look like "2019-03-05 07:34:01 +00:00": the day is enough. */
export function dayOf(value: string | null | undefined): string | null {
  return value ? value.slice(0, 10) : null
}
