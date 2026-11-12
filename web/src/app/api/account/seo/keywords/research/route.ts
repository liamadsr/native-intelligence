/**
 * POST /api/account/seo/keywords/research: keyword ideas around one seed.
 *
 *   body  { seed, location_code?, language_code?, mode?, result_limit?,
 *           clickstream?, group_keywords?, refresh? }
 *   200   KeywordResearchResult (src/lib/seo/keywords/view.ts)
 *
 * A fresh stored result (24 hours) answers for free (`from_cache: true`);
 * otherwise this SPENDS: the access check runs first (503 SEO_NOT_CONFIGURED,
 * 403 FREE_PLAN), then the workspace's monthly ceiling (402
 * SPEND_LIMIT_REACHED). `refresh: true` buys again. When one source of the
 * auto blend failed after the other was bought, the rows bought come back
 * (and are stored) with `partial` saying what is missing. 400 VALIDATION_ERROR for
 * a seed, country or language the provider would reject. Any member may ask.
 */
import { getServiceClient } from '@/lib/admin'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest } from '@/lib/api-errors'
import { seoRefusalResponse } from '@/lib/seo/http'
import { researchKeywords } from '@/lib/seo/keywords/research'
import { KEYWORD_RESEARCH_MODES } from '@/lib/seo/keywords/view'
import { seoFailureResponse } from '@/lib/seo/paid'
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'

const Body = z.object({
  seed: z.string().trim().min(1).max(200),
  location_code: z.number().int().positive().nullish(),
  language_code: z.string().trim().min(2).max(10).nullish(),
  mode: z.enum(KEYWORD_RESEARCH_MODES).optional(),
  result_limit: z
    .union([z.literal(150), z.literal(300), z.literal(500)])
    .optional(),
  clickstream: z.boolean().optional(),
  group_keywords: z.boolean().optional(),
  refresh: z.boolean().optional(),
})

export async function POST(request: NextRequest) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const parsed = Body.safeParse(await request.json().catch(() => null))
  if (!parsed.success)
    return badRequest(parsed.error.issues[0]?.message ?? 'Invalid request')
  try {
    const out = await researchKeywords(
      getServiceClient(),
      { workspaceId: auth.workspaceId, userId: auth.user.id },
      parsed.data,
    )
    if (!out.ok) return seoRefusalResponse(out)
    return NextResponse.json(out.result)
  } catch (err) {
    return seoFailureResponse(err, 'keyword research')
  }
}
