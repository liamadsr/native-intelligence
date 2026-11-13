import { NextResponse, type NextRequest } from 'next/server'
import { createStatelessClient } from '@/lib/supabase/stateless'
import { requireCronSecret } from '@/lib/api-auth'
import { getGatewayUsageReport, type GatewayReportRow } from '@/lib/ai/gateway-report'
import * as Sentry from '@sentry/nextjs'

/**
 * GET /api/cron/billing-reconciliation
 *
 * Weekly health check on the billing ledger (P3-2, invariant §8):
 *   1. Wallet drift — any user whose cached ai_user_credits.balance_usd doesn't
 *      match the sum of their ai_credit_ledger rows (should never happen; the
 *      RPCs maintain both in one transaction).
 *   2. Fallback pricing — usage rows priced with cost_source='fallback_conservative'
 *      in the last week, which means a model is missing from ai_model_costs and
 *      is being charged at the punitive $15/$75 per-Mtok fallback.
 *   3. Gate honesty — any user whose period cost exceeds plan limit + wallet by
 *      more than a request's slack (the invariant should make this impossible).
 *   4. Gateway cost drift — per model, compare what WE priced (sum of
 *      ai_usage_logs.estimated_cost_usd) against the Vercel AI Gateway's
 *      authoritative market cost (/v1/report, group_by=model) over the same 7-day
 *      window. The Gateway is the source of truth for real spend; our local
 *      derivation (list-price table + the eve path's null-cost fallback, since
 *      eve 0.22.4 surfaces no per-turn cost) can drift from it. This catches a
 *      systematic mispricing (e.g. a stale ai_model_costs row) without touching
 *      the insert-only ai_usage_logs.
 *
 * Findings are returned and, when non-trivial, alerted to Sentry.
 *
 * Schedule: weekly via Vercel cron.
 */
export const maxDuration = 120

/** Alert when |ours - gateway_market| / gateway_market exceeds this AND the… */
const DRIFT_ALERT_RATIO = 0.1
/** …absolute gap exceeds this (avoids alerting on sub-dollar rounding noise). */
const DRIFT_ALERT_MIN_ABS_USD = 0.5
/** PostgREST's per-response row cap; usage-log reads page at this size. */
const USAGE_PAGE_SIZE = 1000

/** One model's ours-vs-gateway comparison, surfaced in the response + alerts. */
interface ModelDrift {
  model: string
  ours_usd: number
  gateway_market_usd: number
  abs_gap_usd: number
  drift_ratio: number
  alerted: boolean
}

export async function GET(request: NextRequest) {
  const denied = requireCronSecret(request)
  if (denied) return denied

  const supabase = createStatelessClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  )

  // 1. Wallet drift: cached balance vs ledger sum.
  const { data: drift } = await supabase.rpc('billing_wallet_drift')

  // 2. Fallback pricing over the last 7 days.
  const weekAgoMs = Date.now() - 7 * 24 * 60 * 60 * 1000
  const weekAgo = new Date(weekAgoMs).toISOString()
  const { count: fallbackCount } = await supabase
    .from('ai_usage_logs')
    .select('id', { count: 'exact', head: true })
    .eq('cost_source', 'fallback_conservative')
    .gte('created_at', weekAgo)

  // 3. Gate honesty: users over plan + wallet.
  const { data: overspend } = await supabase.rpc('billing_overspenders')

  const driftCount = Array.isArray(drift) ? drift.length : 0
  const overspendCount = Array.isArray(overspend) ? overspend.length : 0

  // 4. Per-model gateway cost drift. Isolated + best-effort: any failure here
  //    (missing AI_GATEWAY_API_KEY in this env, 403 plan-gating, network) is
  //    caught and noted — it must NOT fail the wallet/fallback checks above.
  const gatewayDrift: ModelDrift[] = []
  let gatewayDriftError: string | undefined
  let gatewayDriftAlerted = 0
  try {
    // The report groups by ONE dimension; group_by=model gives us per-model
    // market cost. Dates are inclusive UTC YYYY-MM-DD; trailing 7 days ending today.
    const startDate = new Date(weekAgoMs).toISOString().slice(0, 10)
    const endDate = new Date().toISOString().slice(0, 10)
    const report = await getGatewayUsageReport({ startDate, endDate, groupBy: 'model' })

    // Gateway market cost per bare model id. The report's `model` may be a
    // provider-qualified slug (e.g. 'moonshotai/kimi-k2.6'); we match on the bare
    // id (the segment after the last '/') because ai_usage_logs stores the bare
    // model. Sum in case the report ever returns multiple rows per model.
    const gatewayByModel = new Map<string, number>()
    for (const row of report as GatewayReportRow[]) {
      if (typeof row.model !== 'string' || !row.model) continue
      const bare = bareModelId(row.model)
      const market = typeof row.market_cost === 'number' ? row.market_cost : 0
      gatewayByModel.set(bare, (gatewayByModel.get(bare) ?? 0) + market)
    }

    if (gatewayByModel.size > 0) {
      // Sum OUR priced cost per model over the SAME window. We only compare
      // models present in the gateway report (bare-id match) — Deepgram and any
      // direct-provider fallback don't flow through the Gateway, so they never
      // appear in the report and are correctly excluded by the join.
      // Paged: PostgREST caps one response at 1000 rows, and a truncated sum
      // reads as false drift on the busiest models.
      const ours: Array<{ model: string; estimated_cost_usd: number | string }> = []
      for (let from = 0; ; from += USAGE_PAGE_SIZE) {
        const { data: page, error: pageError } = await supabase
          .from('ai_usage_logs')
          .select('model, estimated_cost_usd')
          .gte('created_at', weekAgo)
          .order('id', { ascending: true })
          .range(from, from + USAGE_PAGE_SIZE - 1)
        // A partial sum would read as false drift: skip the check instead.
        if (pageError) throw new Error(`usage read failed: ${pageError.message}`)
        const rows = (page ?? []) as Array<{ model: string; estimated_cost_usd: number | string }>
        ours.push(...rows)
        if (rows.length < USAGE_PAGE_SIZE) break
      }

      const oursByModel = new Map<string, number>()
      for (const r of ours) {
        const bare = bareModelId(r.model)
        if (!gatewayByModel.has(bare)) continue // only models the gateway priced
        oursByModel.set(bare, (oursByModel.get(bare) ?? 0) + (Number(r.estimated_cost_usd) || 0))
      }

      for (const [model, gatewayMarket] of gatewayByModel) {
        if (gatewayMarket <= 0) continue // can't compute a ratio against 0
        const oursUsd = oursByModel.get(model) ?? 0
        const absGap = Math.abs(oursUsd - gatewayMarket)
        const ratio = absGap / gatewayMarket
        const alerted = ratio > DRIFT_ALERT_RATIO && absGap > DRIFT_ALERT_MIN_ABS_USD
        if (alerted) {
          gatewayDriftAlerted += 1
          Sentry.captureMessage(
            `[billing-reconciliation] gateway cost drift for ${model}: ours $${oursUsd.toFixed(
              2,
            )} vs gateway market $${gatewayMarket.toFixed(2)} (${Math.round(ratio * 100)}% gap)`,
            {
              level: 'warning',
              extra: {
                model,
                ours_usd: oursUsd,
                gateway_market_usd: gatewayMarket,
                abs_gap_usd: absGap,
                drift_ratio: ratio,
                window: { start: startDate, end: endDate },
              },
            },
          )
        }
        gatewayDrift.push({
          model,
          ours_usd: round2(oursUsd),
          gateway_market_usd: round2(gatewayMarket),
          abs_gap_usd: round2(absGap),
          drift_ratio: Number(ratio.toFixed(4)),
          alerted,
        })
      }
    }
  } catch (err) {
    // Graceful degradation — the gateway report is optional infrastructure.
    gatewayDriftError = err instanceof Error ? err.message : String(err)
    console.warn('[billing-reconciliation] gateway drift check skipped:', gatewayDriftError)
  }

  if (driftCount > 0 || overspendCount > 0) {
    Sentry.captureMessage(
      `[billing-reconciliation] drift=${driftCount} overspenders=${overspendCount} fallback_priced_7d=${fallbackCount ?? 0}`,
      'error',
    )
  } else if ((fallbackCount ?? 0) > 0) {
    Sentry.captureMessage(
      `[billing-reconciliation] ${fallbackCount} usage rows priced at conservative fallback in the last 7d — populate ai_model_costs`,
      'warning',
    )
  }

  return NextResponse.json({
    success: true,
    wallet_drift: drift ?? [],
    overspenders: overspend ?? [],
    fallback_priced_last_7d: fallbackCount ?? 0,
    gatewayDrift,
    gateway_drift_alerted: gatewayDriftAlerted,
    ...(gatewayDriftError ? { gateway_drift_error: gatewayDriftError } : {}),
  })
}

/** Bare model id = the segment after the last '/' (provider-qualified → bare). */
function bareModelId(model: string): string {
  const i = model.lastIndexOf('/')
  return i >= 0 ? model.slice(i + 1) : model
}

/** Round a USD amount to cents for the response payload (not for the ratio math). */
function round2(n: number): number {
  return Math.round(n * 100) / 100
}
