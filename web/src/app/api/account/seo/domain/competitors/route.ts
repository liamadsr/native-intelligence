/**
 * POST /api/account/seo/domain/competitors: the domains competing in Google
 * for a set of keywords in one country.
 *
 *   body  { keywords (1-100), location_code?, language_code?, result_types?,
 *           include_subdomains?, exclude_domains?, sort_by?, limit?, refresh? }
 *   200   SerpCompetitorsResult (src/lib/seo/domain/view.ts); the
 *         workspace's own site's row is marked own_site.
 *
 * Stored (12 hours) by keywords, market, result types, subdomains and limit;
 * a different sort or excluded domains re-use the stored rows for free.
 * Otherwise this SPENDS: 503 SEO_NOT_CONFIGURED, 403 FREE_PLAN, 402
 * SPEND_LIMIT_REACHED. 400 VALIDATION_ERROR for a bad list or a country
 * domain data does not cover.
 */
import { getServiceClient } from '@/lib/admin'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest } from '@/lib/api-errors'
import { findSerpCompetitors } from '@/lib/seo/domain/competitors'
import {
  SERP_COMPETITOR_KEYWORDS_MAX,
  SERP_COMPETITOR_RESULT_TYPES,
  SERP_COMPETITOR_SORTS,
} from '@/lib/seo/domain/view'
import { seoRefusalResponse } from '@/lib/seo/http'
import { seoFailureResponse } from '@/lib/seo/paid'
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'

const Body = z.object({
  keywords: z
    .array(z.string().trim().min(1).max(200))
    .min(1)
    .max(SERP_COMPETITOR_KEYWORDS_MAX),
  location_code: z.number().int().positive().nullish(),
  language_code: z.string().trim().min(2).max(10).nullish(),
  result_types: z
    .array(z.enum(SERP_COMPETITOR_RESULT_TYPES))
    .min(1)
    .max(4)
    .optional(),
  include_subdomains: z.boolean().optional(),
  exclude_domains: z
    .array(z.string().trim().min(1).max(255))
    .max(50)
    .optional(),
  sort_by: z.enum(SERP_COMPETITOR_SORTS).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  refresh: z.boolean().optional(),
})

export async function POST(request: NextRequest) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const parsed = Body.safeParse(await request.json().catch(() => null))
  if (!parsed.success)
    return badRequest(parsed.error.issues[0]?.message ?? 'Invalid request')
  try {
    const out = await findSerpCompetitors(
      getServiceClient(),
      { workspaceId: auth.workspaceId, userId: auth.user.id },
      parsed.data,
    )
    if (!out.ok) return seoRefusalResponse(out)
    return NextResponse.json(out.result)
  } catch (err) {
    return seoFailureResponse(err, 'serp competitors')
  }
}
