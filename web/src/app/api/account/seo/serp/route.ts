/**
 * POST /api/account/seo/serp: live Google results for one keyword, read three
 * times and merged.
 *
 *   body  { keyword, location_code?, language_code?, device?, depth?, refresh? }
 *   200   SerpResult (src/lib/seo/keywords/view.ts)
 *
 * Answers within about a minute: what is back after 40 seconds is merged and
 * returned with `status` partial (more reads coming) or collecting (none yet).
 * Then poll GET /api/account/seo/serp/[lookup_id] every few seconds (free)
 * until `status` is complete. A stored check (12 hours; one that found
 * nothing, `complete` with no items, 3 hours) answers for free; `refresh`
 * while a check of a few minutes is still collecting collects that one,
 * free, instead of buying again. Otherwise this SPENDS: 503
 * SEO_NOT_CONFIGURED, 403 FREE_PLAN, 402 SPEND_LIMIT_REACHED; 502
 * UPSTREAM_UNAVAILABLE when every read failed.
 */
import { getServiceClient } from '@/lib/admin'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest } from '@/lib/api-errors'
import { seoRefusalResponse } from '@/lib/seo/http'
import { getSerpResults } from '@/lib/seo/keywords/serp'
import { seoFailureResponse } from '@/lib/seo/paid'
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'

const Body = z.object({
  keyword: z.string().trim().min(1).max(200),
  location_code: z.number().int().positive().nullish(),
  language_code: z.string().trim().min(2).max(10).nullish(),
  device: z.enum(['desktop', 'mobile']).optional(),
  depth: z.number().int().min(10).max(100).multipleOf(10).optional(),
  refresh: z.boolean().optional(),
})

export async function POST(request: NextRequest) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const parsed = Body.safeParse(await request.json().catch(() => null))
  if (!parsed.success)
    return badRequest(parsed.error.issues[0]?.message ?? 'Invalid request')
  try {
    const out = await getSerpResults(
      getServiceClient(),
      { workspaceId: auth.workspaceId, userId: auth.user.id },
      parsed.data,
    )
    if (!out.ok) return seoRefusalResponse(out)
    return NextResponse.json(out.result)
  } catch (err) {
    return seoFailureResponse(err, 'serp results')
  }
}
