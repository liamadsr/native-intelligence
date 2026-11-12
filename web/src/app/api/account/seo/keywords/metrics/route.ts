/**
 * POST /api/account/seo/keywords/metrics: metrics for keywords someone
 * already has (up to 700): volume, CPC, competition, difficulty, intent and
 * the 12-month trend.
 *
 *   body  { keywords: string[], location_code?, language_code?, clickstream?, refresh? }
 *   200   KeywordMetricsResult (src/lib/seo/keywords/view.ts)
 *
 * Saved keywords in the same market take the fresh numbers too, so this is
 * also how the saved list's "refresh metrics" works (send its keywords). A
 * fresh stored result (24 hours) answers for free; otherwise this SPENDS:
 * 503 SEO_NOT_CONFIGURED, 403 FREE_PLAN, 402 SPEND_LIMIT_REACHED as for
 * research. 400 VALIDATION_ERROR for a bad list or market.
 */
import { getServiceClient } from '@/lib/admin'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest } from '@/lib/api-errors'
import { seoRefusalResponse } from '@/lib/seo/http'
import {
  getKeywordMetrics,
  KEYWORD_METRICS_MAX,
} from '@/lib/seo/keywords/metrics'
import { seoFailureResponse } from '@/lib/seo/paid'
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'

const Body = z.object({
  keywords: z.array(z.string().max(200)).min(1).max(KEYWORD_METRICS_MAX),
  location_code: z.number().int().positive().nullish(),
  language_code: z.string().trim().min(2).max(10).nullish(),
  clickstream: z.boolean().optional(),
  refresh: z.boolean().optional(),
})

export async function POST(request: NextRequest) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const parsed = Body.safeParse(await request.json().catch(() => null))
  if (!parsed.success)
    return badRequest(parsed.error.issues[0]?.message ?? 'Invalid request')
  try {
    const out = await getKeywordMetrics(
      getServiceClient(),
      { workspaceId: auth.workspaceId, userId: auth.user.id },
      parsed.data,
    )
    if (!out.ok) return seoRefusalResponse(out)
    return NextResponse.json(out.result)
  } catch (err) {
    return seoFailureResponse(err, 'keyword metrics')
  }
}
