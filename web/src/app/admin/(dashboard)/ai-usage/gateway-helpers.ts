/**
 * Pure helpers for the Gateway-backed AI-usage dashboard view
 * (Phase B — docs/plans/gateway-usage-tracking.md).
 *
 * Everything here is a plain, side-effect-free function so it can be unit
 * tested without the RSC page. The page composes these over the rows returned
 * by getGatewayUsageReport().
 */

import type { GatewayReportRow } from '@/lib/ai/gateway-report'

/**
 * Converts the page's resolved [from, to) exclusive datetimes into the INCLUSIVE
 * YYYY-MM-DD start/end the Gateway report API expects.
 *
 * The dashboard range is half-open ([from, to)), matching the SQL `created_at <
 * to`. The Gateway API is inclusive on both ends, so `end_date` is the day
 * containing `to - 1ms` (i.e. the last day actually inside the range).
 *
 * Both dates are read via LOCAL calendar-day getters, NOT `toISOString()`.
 * resolveRange() on the page constructs these Dates with the local-time
 * constructor (`new Date(y, m, d)`), so each Date's *intended* calendar day is
 * its LOCAL one. `toISOString()` truncates the UTC day instead, which shifts a
 * day at the boundary under any non-UTC process TZ (e.g. TZ=America/New_York a
 * this_month July end lands on '2026-08-01' instead of '2026-07-31'; TZ=Asia/Tokyo
 * a start lands on '2026-06-30'). Local getters read the same calendar the Dates
 * were built in, so the conversion is correct regardless of process TZ — and
 * TZ-independent by construction (no per-TZ test matrix can express otherwise).
 */
export function toGatewayDateRange(from: Date, to: Date): {
  startDate: string
  endDate: string
} {
  const startDate = localDay(from)
  // to is exclusive — step back 1ms to land on the last included instant.
  const lastIncluded = new Date(to.getTime() - 1)
  const endDate = localDay(lastIncluded)
  return { startDate, endDate }
}

/** Local-time YYYY-MM-DD for a Date (calendar day in the process TZ, not UTC). */
function localDay(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Sum a numeric field across rows, coalescing absent values to 0. */
export function sumField(
  rows: GatewayReportRow[],
  field: keyof GatewayReportRow,
): number {
  let total = 0
  for (const row of rows) {
    const v = row[field]
    if (typeof v === 'number') total += v
  }
  return total
}

export interface GatewayTotals {
  marketCost: number
  totalCost: number
  surchargeCost: number
  gatewayCost: number
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  cacheCreationInputTokens: number
  reasoningTokens: number
  requestCount: number
}

/**
 * Aggregate totals across a set of rows (typically the group_by=day rows, which
 * partition the whole range with no overlap). Any group_by that partitions the
 * range gives the same totals; day is the canonical one.
 */
export function aggregateTotals(rows: GatewayReportRow[]): GatewayTotals {
  return {
    marketCost: sumField(rows, 'market_cost'),
    totalCost: sumField(rows, 'total_cost'),
    surchargeCost: sumField(rows, 'surcharge_cost'),
    gatewayCost: sumField(rows, 'gateway_cost'),
    inputTokens: sumField(rows, 'input_tokens'),
    outputTokens: sumField(rows, 'output_tokens'),
    cachedInputTokens: sumField(rows, 'cached_input_tokens'),
    cacheCreationInputTokens: sumField(rows, 'cache_creation_input_tokens'),
    reasoningTokens: sumField(rows, 'reasoning_tokens'),
    requestCount: sumField(rows, 'request_count'),
  }
}

/** Total input + output tokens for a single row (cached/reasoning shown separately). */
export function rowTokens(row: GatewayReportRow): number {
  return (row.input_tokens ?? 0) + (row.output_tokens ?? 0)
}

/**
 * Prefix parsing for tag-grouped rows. Phase A tags calls as `feature:<name>`
 * and `env:<production|development>`. A single request carries multiple
 * tags, so the same request_count appears under several tag rows — these
 * breakdowns are "requests that touched this tag", NOT a partition of the total.
 */
export const FEATURE_TAG_PREFIX = 'feature:'
export const ENV_TAG_PREFIX = 'env:'

export interface TagBreakdownEntry {
  /** The tag value with its prefix stripped (e.g. 'chat', 'production'). */
  label: string
  marketCost: number
  requestCount: number
}

/**
 * Pull the rows whose `tag` starts with `prefix`, strip the prefix for display,
 * and sort by market cost descending. Rows without a matching tag are dropped.
 */
export function tagBreakdown(
  rows: GatewayReportRow[],
  prefix: string,
): TagBreakdownEntry[] {
  const out: TagBreakdownEntry[] = []
  for (const row of rows) {
    if (typeof row.tag !== 'string' || !row.tag.startsWith(prefix)) continue
    out.push({
      label: row.tag.slice(prefix.length),
      marketCost: row.market_cost ?? 0,
      requestCount: row.request_count ?? 0,
    })
  }
  return out.sort((a, b) => b.marketCost - a.marketCost)
}

export interface UserRow {
  /** The `user` tag value — our auth userId, or the sentinel for untagged traffic. */
  userId: string
  /** True when this row aggregates traffic with no user tag (legacy/untagged). */
  untagged: boolean
  marketCost: number
  tokens: number
  requestCount: number
}

/** Sentinel id for rows that carry no `user` tag. Not a real userId. */
export const UNTAGGED_USER_ID = '__untagged__'

/**
 * Turn group_by=user rows into a sorted top-users list. Rows with no `user`
 * field (untagged/legacy traffic, which the Gateway returns with the grouping
 * field absent) fold into a single UNTAGGED_USER_ID bucket so the table always
 * accounts for 100% of spend. Sorted by market cost desc, capped at `limit`.
 */
export function topUsers(rows: GatewayReportRow[], limit = 15): UserRow[] {
  const untagged: UserRow = {
    userId: UNTAGGED_USER_ID,
    untagged: true,
    marketCost: 0,
    tokens: 0,
    requestCount: 0,
  }
  const tagged: UserRow[] = []

  for (const row of rows) {
    const market = row.market_cost ?? 0
    const tokens = rowTokens(row)
    const requests = row.request_count ?? 0
    if (typeof row.user === 'string' && row.user.length > 0) {
      tagged.push({
        userId: row.user,
        untagged: false,
        marketCost: market,
        tokens,
        requestCount: requests,
      })
    } else {
      untagged.marketCost += market
      untagged.tokens += tokens
      untagged.requestCount += requests
    }
  }

  const all = [...tagged]
  // Only surface the untagged bucket if it actually carries something.
  if (untagged.requestCount > 0 || untagged.marketCost > 0) all.push(untagged)

  return all.sort((a, b) => b.marketCost - a.marketCost).slice(0, limit)
}

/**
 * Distinct users with a real user tag across ALL group_by=user rows: the
 * "Active Users" count, which must not be read off topUsers' sliced list.
 */
export function countTaggedUsers(rows: GatewayReportRow[]): number {
  const ids = new Set<string>()
  for (const row of rows) {
    if (typeof row.user === 'string' && row.user.length > 0) ids.add(row.user)
  }
  return ids.size
}

export interface ModelRow {
  model: string
  marketCost: number
  tokens: number
  requestCount: number
}

/** group_by=model rows → sorted-by-cost model breakdown. */
export function modelBreakdown(rows: GatewayReportRow[]): ModelRow[] {
  return rows
    .map((row) => ({
      model: row.model ?? 'unknown',
      marketCost: row.market_cost ?? 0,
      tokens: rowTokens(row),
      requestCount: row.request_count ?? 0,
    }))
    .sort((a, b) => b.marketCost - a.marketCost)
}

export interface CredentialTypeRow {
  credentialType: 'byok' | 'system' | 'unknown'
  marketCost: number
  totalCost: number
  requestCount: number
}

/** group_by=credential_type rows → BYOK vs system breakdown. */
export function credentialBreakdown(rows: GatewayReportRow[]): CredentialTypeRow[] {
  return rows
    .map((row) => ({
      credentialType: row.credential_type ?? ('unknown' as const),
      marketCost: row.market_cost ?? 0,
      totalCost: row.total_cost ?? 0,
      requestCount: row.request_count ?? 0,
    }))
    .sort((a, b) => b.marketCost - a.marketCost)
}

/** Ascending-by-day view of the group_by=day rows for the per-day table. */
export function perDay(rows: GatewayReportRow[]): Array<{
  day: string
  marketCost: number
  tokens: number
  requestCount: number
}> {
  return rows
    .filter((row) => typeof row.day === 'string')
    .map((row) => ({
      day: row.day as string,
      marketCost: row.market_cost ?? 0,
      tokens: rowTokens(row),
      requestCount: row.request_count ?? 0,
    }))
    .sort((a, b) => a.day.localeCompare(b.day))
}
