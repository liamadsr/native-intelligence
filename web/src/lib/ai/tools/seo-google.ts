import { runAnalyticsReport } from '@/lib/seo/google/analytics'
import { notConnected } from '@/lib/seo/google/errors'
import {
  getSearchOpportunities,
  OPPORTUNITY_MAX_LIMIT,
} from '@/lib/seo/google/opportunities'
import { googleToolError, googleToolRefusal } from '@/lib/seo/google/respond'
import {
  getSearchConsolePerformance,
  inspectUrls,
  type GoogleSeoDeps,
} from '@/lib/seo/google/search-console'
import {
  listAnalyticsProperties,
  listSearchConsoleSites,
  readGoogleSources,
  setAnalyticsProperty,
  setSearchConsoleSite,
  suggestSite,
} from '@/lib/seo/google/source'
import {
  ANALYTICS_CHANNELS,
  GSC_DATE_RANGES,
  GSC_DIMENSIONS,
  GSC_FILTER_OPERATORS,
  GSC_MAX_FILTERS,
  GSC_MAX_ROW_LIMIT,
  GSC_SEARCH_TYPES,
  URL_INSPECTION_MAX,
  type AnalyticsComparison,
  type AnalyticsReport,
  type AnalyticsReportInput,
  type AnalyticsRow,
  type SearchConsoleRow,
} from '@/lib/seo/google/view'
import { workspaceSiteUrl } from '@/lib/seo/site'
import type { SupabaseClient } from '@supabase/supabase-js'
import { tool } from 'ai'
import { z } from 'zod'
import { webText } from './web-derived'

/**
 * SEO: the workspace's own Google data (src/lib/seo/google), read only and
 * free (Google charges nothing, so reads are allowed in an unattended turn,
 * a weekly report included).
 *
 *   list_search_console_sites            the sites the person's own Search
 *                                        Console connection can see, and the
 *                                        one the workspace reads.
 *   set_search_console_site              choose the workspace's site.
 *   get_search_console_performance       clicks, impressions, CTR, position by
 *                                        query, page, country, device, date.
 *   get_search_opportunities             striking-distance and low-CTR
 *                                        queries; pages scored with Analytics.
 *   get_url_inspection                   is a page indexed, and why not.
 *   list_google_analytics_properties     the person's GA4 properties.
 *   set_google_analytics_property        choose the workspace's property.
 *   get_google_analytics_<report>        the nine fixed GA4 reports.
 *
 * Every read goes through the connection of the member who chose the site
 * or property, so every member sees the same data. Choosing needs the
 * person's own connection, and only on their own turn.
 *
 * Search queries are searchers' own words, and event names, campaign and
 * source names, site-search terms and product names are whatever the site or
 * its visitors sent: they reach the model inside the WEB fence
 * (web-derived.ts). URLs, page paths, numbers and ids stay plain.
 */

/** GA4 dimensions whose values are the site's or its visitors' own text. */
const ANALYTICS_TEXT_FIELDS = [
  'eventName',
  'searchTerm',
  'itemName',
  'sessionCampaignName',
  'sessionSourceMedium',
] as const

function fenceAnalyticsRow(row: AnalyticsRow): AnalyticsRow {
  const out: AnalyticsRow = { ...row }
  for (const field of ANALYTICS_TEXT_FIELDS)
    if (typeof out[field] === 'string')
      out[field] = webText(out[field] as string) as string
  return out
}

function fenceComparison(c: AnalyticsComparison | null) {
  if (!c) return null
  return {
    previous_date_range: c.previous_date_range,
    complete: c.complete,
    limited_data: c.has_limited_data,
    rows: c.rows.map((r) => ({
      ...fenceAnalyticsRow(r.dimensions),
      ...r.metrics,
    })),
  }
}

/** A Search Console row as the model reads it: each key named by its dimension, a query fenced. */
function gscRowForModel(row: SearchConsoleRow, dimensions: readonly string[]) {
  const out: Record<string, unknown> = {}
  dimensions.forEach((d, i) => {
    const value = row.keys[i] ?? null
    out[d] = d === 'query' ? webText(value) : value
  })
  return {
    ...out,
    clicks: row.clicks,
    impressions: row.impressions,
    ctr: row.ctr,
    position: row.position,
  }
}

const LIMITED_NOTE =
  'Google marked this report as limited (thresholding, sampling, an "(other)" row or a restricted metric): a missing row is unknown, never zero.'

type ToolFailure = ReturnType<typeof googleToolError>

/** A report as the model reads it (the site's and its visitors' own words fenced); a failure passes through. */
function analyticsForModel(report: AnalyticsReport | ToolFailure) {
  if (!('kind' in report)) return report
  const property = {
    property_id: report.source.property_id,
    property_name: webText(report.source.property_name),
    time_zone: report.source.time_zone,
    currency: report.source.currency_code,
  }
  if (report.kind === 'measurement_health') {
    return {
      success: true,
      property,
      summary: report.summary,
      issues: report.issues,
      web_streams: report.web_streams.map((s) => ({
        ...s,
        display_name: webText(s.display_name),
      })),
      other_streams: report.other_streams.map((s) => ({
        ...s,
        display_name: webText(s.display_name),
      })),
      key_events: report.key_events.map((k) => ({
        ...k,
        event_name: webText(k.event_name),
      })),
      custom_dimensions: report.custom_dimensions.map((d) => ({
        ...d,
        display_name: webText(d.display_name),
      })),
      custom_metrics: report.custom_metrics.map((m) => ({
        ...m,
        display_name: webText(m.display_name),
      })),
    }
  }
  if (report.kind === 'overview') {
    return {
      success: true,
      property,
      date_range: report.request.date_range,
      previous_date_range: report.request.previous_date_range,
      channel: 'organic_search',
      current: report.current,
      previous: report.previous,
      change: report.comparison,
      trend: report.trend,
      diagnostics: report.diagnostics,
      warnings: report.warnings,
      ...(report.has_limited_data ? { note: LIMITED_NOTE } : {}),
    }
  }
  return {
    success: true,
    property,
    date_range: report.request.date_range,
    channel: report.request.channel,
    breakdown: report.request.breakdown,
    rows: report.rows.map(fenceAnalyticsRow),
    row_count: report.row_count,
    total_rows: report.total_row_count,
    next_offset: report.page.next_offset,
    comparison: fenceComparison(report.comparison),
    activity: report.activity,
    diagnostics: report.diagnostics,
    warnings: report.warnings,
    ...(report.metadata.has_limited_data
      ? { note: LIMITED_NOTE, limits: report.metadata }
      : {}),
    ...(report.total_row_count === 0 &&
    report.request.channel === 'organic_search'
      ? {
          empty_hint:
            'This report is filtered to organic search; channel all (where offered) includes every channel.',
        }
      : {}),
  }
}

const dateField = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const commonAnalyticsInput = {
  start_date: dateField
    .optional()
    .describe(
      'YYYY-MM-DD in the property’s time zone, with end_date. Default: the last 28 complete days',
    ),
  end_date: dateField.optional().describe('YYYY-MM-DD, with start_date'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe('Rows (default 100)'),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('next_offset from the previous call'),
}
const channelField = z
  .enum(ANALYTICS_CHANNELS)
  .optional()
  .describe('organic_search (default) or all')
const NOT_PROPERTY =
  ' Reads only the workspace’s chosen Google Analytics property; costs nothing.'

export function createSeoGoogleTools(
  userId: string,
  supabase: SupabaseClient,
  workspaceId: string,
  opts: { unattended?: boolean; deps?: GoogleSeoDeps } = {},
) {
  const who = { workspaceId, userId }
  const deps = opts.deps ?? {}
  const chooseRefusal = {
    success: false as const,
    code: 'NEEDS_PERSON',
    error:
      'Only the person chooses which site or property the workspace reads, on their own turn. Tell them what you would choose and let them ask.',
  }

  /** One fixed report for the workspace's chosen property, or the failure as the agent reads it. */
  const readReport = async (
    input: AnalyticsReportInput,
  ): Promise<AnalyticsReport | ToolFailure> => {
    try {
      return await runAnalyticsReport(supabase, who, input, deps)
    } catch (err) {
      return googleToolError(err, `analytics ${input.report}`)
    }
  }

  return {
    list_search_console_sites: tool({
      description:
        'List the Google Search Console sites the person’s own Search Console connection can see (a domain property like sc-domain:example.com, or a URL prefix), which one the workspace reads now and who chose it, and the one matching the workspace’s website when exactly one does. ' +
        'Use it before set_search_console_site. If Search Console isn’t connected it says how to connect it.',
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const [listed, sources, website] = await Promise.all([
            listSearchConsoleSites(supabase, { userId }, deps),
            readGoogleSources(supabase, workspaceId),
            workspaceSiteUrl(supabase, workspaceId).catch(() => null),
          ])
          if (!listed.accounts.length && !sources.search_console)
            return googleToolError(notConnected('search_console'), 'list sites')
          return {
            success: true,
            accounts: listed.accounts,
            sites: listed.options.map((s) => ({
              site_url: s.site_url,
              verified: s.verified,
              permission: s.permission_level,
              account_id: s.account_id,
            })),
            current: sources.search_console
              ? {
                  site_url: sources.search_console.site_url,
                  chosen_by: sources.search_console.chosen_by_name,
                  connection: sources.search_console.health,
                }
              : null,
            suggested: suggestSite(website, listed.options),
            ...(listed.accounts.length
              ? {}
              : {
                  note: 'The person has no Search Console connection of their own, so they can’t choose another site.',
                }),
          }
        } catch (err) {
          return googleToolError(err, 'list sites')
        }
      },
    }),

    set_search_console_site: tool({
      description:
        'Choose which Search Console site the workspace’s SEO reads, through the person’s own Search Console connection (it must list the site as verified). Every member then reads it through that connection. ' +
        'Pass the site_url exactly as list_search_console_sites shows it (a bare domain works when only one site covers it). Confirm the site with the person first. Replaces the previous choice.',
      inputSchema: z.object({
        site_url: z
          .string()
          .trim()
          .min(1)
          .max(2048)
          .describe(
            'e.g. "sc-domain:example.com" or "https://www.example.com/"',
          ),
        account_id: z
          .string()
          .uuid()
          .optional()
          .describe(
            'Which of their connections, when they have several (from list_search_console_sites)',
          ),
      }),
      execute: async ({ site_url, account_id }) => {
        if (opts.unattended) return chooseRefusal
        try {
          const out = await setSearchConsoleSite(
            supabase,
            { workspaceId, userId },
            { site_url, ...(account_id ? { account_id } : {}) },
            deps,
          )
          if (!out.ok) return googleToolRefusal(out, 'search_console')
          return {
            success: true,
            site_url: out.source?.site_url ?? site_url,
            message: `The workspace now reads ${out.source?.site_url ?? site_url} in Search Console.`,
          }
        } catch (err) {
          return googleToolError(err, 'set site')
        }
      },
    }),

    get_search_console_performance: tool({
      description:
        'The workspace’s own Google Search Console data for its chosen site: clicks, impressions, CTR (0–1) and average position by query, page, country, device or date, plus the window’s totals (and, with compare, the change from the period before). ' +
        'First-party data: use it for what already ranks and what nearly does. Use min_position / max_position / min_impressions rather than reading everything (applied over the top 1000 rows by clicks). ' +
        'Dates are Pacific Time and the last ~3 days may be incomplete. For a page’s index status use get_url_inspection; for ready-made opportunities use get_search_opportunities. Costs nothing.',
      inputSchema: z.object({
        dimensions: z
          .array(z.enum(GSC_DIMENSIONS))
          .min(1)
          .max(4)
          .optional()
          .describe(
            "Group by these (default ['query']). ['page'] for top pages, ['query','page'] to map queries to pages, ['date'] for a series",
          ),
        date_range: z
          .enum(GSC_DATE_RANGES)
          .optional()
          .describe(
            'Preset window (default last_28_days), ending ~3 days ago. Ignored when both dates are given',
          ),
        start_date: dateField
          .optional()
          .describe('YYYY-MM-DD (Pacific Time), with end_date'),
        end_date: dateField.optional().describe('YYYY-MM-DD, with start_date'),
        filters: z
          .array(
            z.object({
              dimension: z.enum(GSC_DIMENSIONS),
              operator: z.enum(GSC_FILTER_OPERATORS).optional(),
              expression: z.string().min(1).max(1000),
            }),
          )
          .max(GSC_MAX_FILTERS)
          .optional()
          .describe(
            "AND-combined. One page's queries: [{dimension:'page', operator:'equals', expression:'https://example.com/post'}] with dimensions ['query']",
          ),
        row_limit: z
          .number()
          .int()
          .min(1)
          .max(GSC_MAX_ROW_LIMIT)
          .optional()
          .describe('Rows (default 100 here); page with start_row'),
        start_row: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('next_start_row from the previous call'),
        min_position: z
          .number()
          .min(1)
          .optional()
          .describe(
            'Striking distance: min_position 5, max_position 20, min_impressions 50',
          ),
        max_position: z.number().min(1).optional(),
        min_impressions: z.number().int().min(0).optional(),
        type: z
          .enum(GSC_SEARCH_TYPES)
          .optional()
          .describe('Search type (default web)'),
        compare: z
          .boolean()
          .optional()
          .describe(
            'Also read the same-length period before, for the totals’ change',
          ),
      }),
      execute: async (input) => {
        try {
          const out = await getSearchConsolePerformance(
            supabase,
            who,
            { ...input, row_limit: input.row_limit ?? 100 },
            deps,
          )
          return {
            success: true,
            site_url: out.site_url,
            start_date: out.start_date,
            end_date: out.end_date,
            dimensions: out.dimensions,
            rows: out.rows.map((r) => gscRowForModel(r, out.dimensions)),
            row_count: out.row_count,
            next_start_row: out.next_start_row,
            ...(out.filtered ? { filtered: out.filtered } : {}),
            totals: out.totals,
            ...(out.previous
              ? { previous: out.previous, change: out.change }
              : {}),
          }
        } catch (err) {
          return googleToolError(err, 'search console performance')
        }
      },
    }),

    get_search_opportunities: tool({
      description:
        'Find what is most worth improving, from the workspace’s own Search Console data: striking-distance queries (the site’s best page ranks 5–20), low-CTR queries (ranking 1–10 with real demand but well under the site’s own click-through at that position: a title or snippet to rewrite), ' +
        'and, when a Google Analytics property is chosen too, pages ranking 4–20 scored by demand, what their search visitors do, and how close they are to the top (a page with no Analytics row is listed unscored: unknown, not zero). ' +
        'Default window: the 28 days ending 3 days ago. Report the few that matter in plain words. Costs nothing.',
      inputSchema: z.object({
        start_date: dateField.optional().describe('YYYY-MM-DD, with end_date'),
        end_date: dateField.optional(),
        limit: z
          .number()
          .int()
          .min(1)
          .max(OPPORTUNITY_MAX_LIMIT)
          .optional()
          .describe('Rows per list (default 20 here)'),
      }),
      execute: async ({ start_date, end_date, limit }) => {
        try {
          const out = await getSearchOpportunities(
            supabase,
            who,
            { start_date, end_date, limit: limit ?? 20 },
            deps,
          )
          return {
            success: true,
            site_url: out.site_url,
            start_date: out.start_date,
            end_date: out.end_date,
            striking_distance: out.striking_distance.map((r) => ({
              ...r,
              query: webText(r.query),
            })),
            low_ctr: out.low_ctr.map((r) => ({
              ...r,
              query: webText(r.query),
            })),
            query_rows_considered: out.query_rows_considered,
            ...(out.query_rows_truncated
              ? {
                  note: 'Only the top 1000 query-and-page rows were read: this is not every query the site ranks for.',
                }
              : {}),
            pages: out.pages
              ? {
                  property: webText(out.pages.property_name),
                  rows: out.pages.rows,
                  total_candidates: out.pages.total_candidates,
                  scoring: out.pages.scoring,
                  coverage: out.pages.coverage,
                  warnings: out.pages.warnings,
                }
              : null,
            ...(out.pages_unavailable
              ? { pages_unavailable: out.pages_unavailable }
              : {}),
          }
        } catch (err) {
          return googleToolError(err, 'search opportunities')
        }
      },
    }),

    get_url_inspection: tool({
      description:
        `Check whether Google has indexed up to ${URL_INSPECTION_MAX} pages of the workspace’s chosen Search Console site, and why not: verdict and coverage state, robots.txt and fetch state, last crawl, the canonical Google chose against the one the page declares (a mismatch is the usual answer), mobile and rich-result verdicts. ` +
        'It reads what Search Console already knows; it is not a live test. Each URL must belong to the chosen site. Costs nothing.',
      inputSchema: z.object({
        urls: z
          .array(z.string().url().max(2048))
          .min(1)
          .max(URL_INSPECTION_MAX)
          .describe('Full page addresses'),
        language_code: z.string().max(20).optional().describe('e.g. "en-US"'),
      }),
      execute: async ({ urls, language_code }) => {
        try {
          const out = await inspectUrls(
            supabase,
            who,
            { urls, language_code },
            deps,
          )
          return { success: true, site_url: out.site_url, results: out.results }
        } catch (err) {
          return googleToolError(err, 'url inspection')
        }
      },
    }),

    list_google_analytics_properties: tool({
      description:
        'List the Google Analytics 4 properties the person’s own Google Analytics connection can see, and which one the workspace reads now and who chose it. Use it before set_google_analytics_property. If Google Analytics isn’t connected it says how to connect it.',
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const [listed, sources] = await Promise.all([
            listAnalyticsProperties(supabase, { userId }, deps),
            readGoogleSources(supabase, workspaceId),
          ])
          if (!listed.accounts.length && !sources.analytics)
            return googleToolError(notConnected('analytics'), 'list properties')
          return {
            success: true,
            accounts: listed.accounts,
            properties: listed.options.map((p) => ({
              property_id: p.property_id,
              name: webText(p.display_name),
              account_name: webText(p.account_display_name),
              account_id: p.account_id,
            })),
            current: sources.analytics
              ? {
                  property_id: sources.analytics.property_id,
                  name: webText(sources.analytics.property_name),
                  chosen_by: sources.analytics.chosen_by_name,
                  connection: sources.analytics.health,
                }
              : null,
            suggested:
              listed.options.length === 1
                ? listed.options[0].property_id
                : null,
          }
        } catch (err) {
          return googleToolError(err, 'list properties')
        }
      },
    }),

    set_google_analytics_property: tool({
      description:
        'Choose which Google Analytics 4 property the workspace’s SEO reads, through the person’s own Google Analytics connection (it must list the property). Every member then reads it through that connection. ' +
        'Pass property_id from list_google_analytics_properties. Confirm it with the person first. Replaces the previous choice.',
      inputSchema: z.object({
        property_id: z
          .string()
          .trim()
          .min(1)
          .max(40)
          .describe('e.g. "properties/123456"'),
        account_id: z
          .string()
          .uuid()
          .optional()
          .describe('Which of their connections, when they have several'),
      }),
      execute: async ({ property_id, account_id }) => {
        if (opts.unattended) return chooseRefusal
        try {
          const out = await setAnalyticsProperty(
            supabase,
            { workspaceId, userId },
            { property_id, ...(account_id ? { account_id } : {}) },
            deps,
          )
          if (!out.ok) return googleToolRefusal(out, 'analytics')
          return {
            success: true,
            property_id: out.source?.property_id ?? property_id,
            name: webText(out.source?.property_name ?? null),
            message: 'The workspace now reads this Google Analytics property.',
          }
        } catch (err) {
          return googleToolError(err, 'set property')
        }
      },
    }),

    get_google_analytics_organic_overview: tool({
      description:
        'Is organic search traffic improving? Top-line organic sessions, users, engagement, key events, transactions and revenue against the same-length period before, with a daily or weekly trend. ' +
        'For the pages behind the totals use get_google_analytics_organic_landing_pages; for other channels get_google_analytics_traffic_acquisition.' +
        NOT_PROPERTY,
      inputSchema: z.object({
        start_date: commonAnalyticsInput.start_date,
        end_date: commonAnalyticsInput.end_date,
        trend: z
          .enum(['daily', 'weekly'])
          .optional()
          .describe('daily (default) or weekly'),
      }),
      execute: async ({ start_date, end_date, trend }) =>
        analyticsForModel(
          await readReport({
            report: 'organic_overview',
            start_date,
            end_date,
            trend,
          }),
        ),
    }),

    get_google_analytics_organic_landing_pages: tool({
      description:
        'The landing pages organic search visitors arrive on, each with sessions, engagement, key events, transactions and revenue. ' +
        'For page views on any channel use get_google_analytics_page_performance; for these pages joined with Search Console rankings use get_search_opportunities.' +
        NOT_PROPERTY,
      inputSchema: z.object(commonAnalyticsInput),
      execute: async (a) =>
        analyticsForModel(
          await readReport({ report: 'organic_landing_pages', ...a }),
        ),
    }),

    get_google_analytics_page_performance: tool({
      description:
        'Page views, users, engagement time and key events for each page (organic search by default; channel all for every channel; include_date for one row per page per day).' +
        NOT_PROPERTY,
      inputSchema: z.object({
        ...commonAnalyticsInput,
        channel: channelField,
        include_date: z
          .boolean()
          .optional()
          .describe('One row per page per day'),
      }),
      execute: async (a) =>
        analyticsForModel(
          await readReport({ report: 'page_performance', ...a }),
        ),
    }),

    get_google_analytics_key_events: tool({
      description:
        'The property’s key events (conversions) with counts and users, by event or by event and landing page; organic search by default. compare_previous_period works for the event breakdown. ' +
        'To check how key events are set up use get_google_analytics_measurement_health.' +
        NOT_PROPERTY,
      inputSchema: z.object({
        ...commonAnalyticsInput,
        channel: channelField,
        breakdown: z
          .enum(['event', 'event_and_landing_page'])
          .optional()
          .describe('event (default) or event_and_landing_page'),
        compare_previous_period: z.boolean().optional(),
      }),
      execute: async (a) =>
        analyticsForModel(await readReport({ report: 'key_events', ...a })),
    }),

    get_google_analytics_traffic_acquisition: tool({
      description:
        'Where the site’s traffic comes from, every channel: by channel group, source / medium or campaign, with sessions, users, engagement, key events, transactions and revenue. ' +
        'compare_previous_period works for channel_group; source_medium also checks attribution quality.' +
        NOT_PROPERTY,
      inputSchema: z.object({
        ...commonAnalyticsInput,
        breakdown: z
          .enum(['channel_group', 'source_medium', 'campaign'])
          .optional()
          .describe('channel_group (default), source_medium or campaign'),
        compare_previous_period: z.boolean().optional(),
      }),
      execute: async (a) =>
        analyticsForModel(
          await readReport({ report: 'traffic_acquisition', ...a }),
        ),
    }),

    get_google_analytics_ecommerce_performance: tool({
      description:
        'Ecommerce results: item views, add-to-carts, purchases and item revenue by item, or transactions and purchase revenue by landing page (only_with_transactions keeps pages that sold). ' +
        'Says whether there was any ecommerce at all (detected, none or unknown). Organic search by default.' +
        NOT_PROPERTY,
      inputSchema: z.object({
        ...commonAnalyticsInput,
        channel: channelField,
        breakdown: z
          .enum(['item', 'landing_page'])
          .optional()
          .describe('item (default) or landing_page'),
        only_with_transactions: z.boolean().optional(),
      }),
      execute: async (a) =>
        analyticsForModel(
          await readReport({ report: 'ecommerce_performance', ...a }),
        ),
    }),

    get_google_analytics_site_search: tool({
      description:
        'What visitors search for on the site itself, with search events, users, sessions and engagement (needs site-search measurement on). For the Google searches that bring visitors, use get_search_console_performance.' +
        NOT_PROPERTY,
      inputSchema: z.object(commonAnalyticsInput),
      execute: async (a) =>
        analyticsForModel(await readReport({ report: 'site_search', ...a })),
    }),

    get_google_analytics_audience_breakdown: tool({
      description:
        'Visitors by device, country, or new versus returning, with users, sessions, engagement and key events; organic search by default. compare_previous_period works for device and new_vs_returning. No demographic or per-person data.' +
        NOT_PROPERTY,
      inputSchema: z.object({
        ...commonAnalyticsInput,
        channel: channelField,
        breakdown: z
          .enum(['device', 'country', 'new_vs_returning'])
          .optional()
          .describe('device (default), country or new_vs_returning'),
        compare_previous_period: z.boolean().optional(),
      }),
      execute: async (a) =>
        analyticsForModel(
          await readReport({ report: 'audience_breakdown', ...a }),
        ),
    }),

    get_google_analytics_measurement_health: tool({
      description:
        'How Google Analytics is set up on the chosen property: data streams, measurement ids, enhanced-measurement settings, key events and custom definitions, with the problems found. Use it when numbers look missing or wrong.' +
        NOT_PROPERTY,
      inputSchema: z.object({}),
      execute: async () =>
        analyticsForModel(await readReport({ report: 'measurement_health' })),
    }),
  }
}
