/**
 * Vercel AI Gateway usage/spend report client (Phase B of the gateway-usage
 * tracking plan — docs/plans/gateway-usage-tracking.md).
 *
 * The Gateway's `/v1/report` endpoint is an ASYNC aggregation over the tokens
 * and cost of every Gateway-routed request. It's the reporting source of truth
 * for the admin AI-usage dashboard — but it is NOT usable for the synchronous
 * 429 gate (freshness is "a few minutes"), so nothing here feeds enforcement.
 *
 * We deliberately hand-roll `fetch` instead of leaning on the `ai` package's
 * `gateway.getSpendReport`: as of @ai-sdk/gateway@4, its `GatewaySpendReportRow`
 * type omits `surcharge_cost`/`gateway_cost` and its params omit `tags_match`
 * (plus the extra `group_by` dimensions the report supports). We want the full
 * field surface, so we own the shape here and keep OUR row type as the seam —
 * the dashboard only ever sees `GatewayReportRow`, never Vercel's types.
 *
 * Cost fields, plainly:
 *   - `market_cost`   — list price of the tokens INCLUDING BYOK. This is what we
 *                       bill users against, so it's the headline number.
 *   - `total_cost`    — what Vercel actually charged us (0 on BYOK).
 *   - `surcharge_cost`/`gateway_cost` — Vercel's markup / infra fee components.
 *
 * Each query costs money ($5/1k), so callers keep page-load queries bounded and
 * never poll.
 */

const GATEWAY_REPORT_URL = 'https://ai-gateway.vercel.sh/v1/report'

/**
 * The dimension a report is grouped by. Mirrors the Gateway's `group_by` param.
 * The grouping value lands in the same-named row field (e.g. `group_by=user`
 * → `row.user`).
 */
export type GatewayReportGroupBy =
  | 'day'
  | 'user'
  | 'model'
  | 'tag'
  | 'provider'
  | 'credential_type'
  | 'zero_data_retention'
  | 'api_key_name'

/**
 * One aggregated row from `/v1/report`. The grouping fields are all optional
 * because only the field matching the request's `group_by` is present; the
 * numeric fields are the aggregates for that group.
 *
 * Numbers are typed as `number` — the raw API returns them as JSON numbers.
 * Some numeric fields can be absent for a row (e.g. a day with no reasoning
 * tokens), so they're optional; callers coalesce with `?? 0`.
 */
export interface GatewayReportRow {
  // Grouping fields — exactly one is present, matching the request's group_by.
  day?: string
  hour?: string
  user?: string
  model?: string
  tag?: string
  provider?: string
  credential_type?: 'byok' | 'system'
  zero_data_retention?: boolean
  api_key_name?: string

  // Cost aggregates (USD).
  total_cost: number
  market_cost?: number
  surcharge_cost?: number
  gateway_cost?: number

  // Token aggregates.
  input_tokens?: number
  output_tokens?: number
  cached_input_tokens?: number
  cache_creation_input_tokens?: number
  reasoning_tokens?: number

  // Volume.
  request_count?: number
}

/**
 * Error thrown by getGatewayUsageReport. Carries the HTTP `status` so the caller
 * can distinguish plan-gating (403 — the reporting API is Pro/Enterprise only)
 * from other failures (auth, network, 5xx). `status` is undefined for pre-flight
 * errors that never hit the network (e.g. missing API key).
 */
export class GatewayReportError extends Error {
  readonly status?: number
  readonly body?: string

  constructor(message: string, opts?: { status?: number; body?: string }) {
    super(message)
    this.name = 'GatewayReportError'
    this.status = opts?.status
    this.body = opts?.body
  }
}

export interface GetGatewayUsageReportOptions {
  /** Inclusive UTC start date, YYYY-MM-DD. */
  startDate: string
  /** Inclusive UTC end date, YYYY-MM-DD. */
  endDate: string
  /** Aggregation dimension. Defaults to 'day' (the API default). */
  groupBy?: GatewayReportGroupBy
  /** Filter to one user's spend (our auth userId, as tagged in Phase A). */
  userId?: string
  /** Filter to requests carrying these tags. */
  tags?: string[]
  /** With multiple tags: match ANY (default) or require ALL. */
  tagsMatch?: 'any' | 'all'
}

/**
 * Fetches an aggregated usage report from the Vercel AI Gateway.
 *
 * Throws GatewayReportError (never returns a partial/empty result on failure):
 *   - missing AI_GATEWAY_API_KEY → error with no `status` (config problem, not HTTP)
 *   - non-2xx response → error carrying the HTTP `status` (403 = plan-gated)
 *
 * @param opts.startDate / opts.endDate — inclusive UTC YYYY-MM-DD (both required)
 */
export async function getGatewayUsageReport(
  opts: GetGatewayUsageReportOptions,
): Promise<GatewayReportRow[]> {
  const apiKey = process.env.AI_GATEWAY_API_KEY
  if (!apiKey) {
    // Pre-flight config error — no `status`, so callers won't mistake it for a 403.
    throw new GatewayReportError(
      'AI_GATEWAY_API_KEY is not set — cannot query the Vercel AI Gateway report API.',
    )
  }

  const params = new URLSearchParams()
  // start_date/end_date are required and INCLUSIVE (UTC).
  params.set('start_date', opts.startDate)
  params.set('end_date', opts.endDate)
  if (opts.groupBy) params.set('group_by', opts.groupBy)
  if (opts.userId) params.set('user_id', opts.userId)
  if (opts.tags && opts.tags.length > 0) {
    params.set('tags', opts.tags.join(','))
    // tags_match only matters with tags present; default is 'any' server-side.
    if (opts.tagsMatch) params.set('tags_match', opts.tagsMatch)
  }

  let res: Response
  try {
    res = await fetch(`${GATEWAY_REPORT_URL}?${params.toString()}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
    })
  } catch (err) {
    // Network-level failure (DNS, connection reset) — no HTTP status to carry.
    throw new GatewayReportError(
      `Failed to reach the Vercel AI Gateway report API: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
  }

  if (!res.ok) {
    // Read the body best-effort for the error message; never throw from here.
    const body = await res.text().catch(() => '')
    throw new GatewayReportError(
      `Gateway report API returned ${res.status} ${res.statusText}`.trim(),
      { status: res.status, body },
    )
  }

  const json = (await res.json()) as { results?: GatewayReportRow[] }
  // The API wraps rows in { results: [...] }; an empty/absent list is a valid
  // "no data" answer (e.g. before Phase A tagging is rolled out).
  return json.results ?? []
}
