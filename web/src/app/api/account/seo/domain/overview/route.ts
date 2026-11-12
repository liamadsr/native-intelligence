/**
 * POST /api/account/seo/domain/overview: a domain's estimated organic
 * traffic, ranked-keyword count, top keywords and top pages in one country.
 *
 *   body  { domain?, location_code?, language_code?, refresh? }
 *         no domain: the workspace's own website (400 VALIDATION_ERROR when
 *         it has none on file).
 *   200   DomainOverview (src/lib/seo/domain/view.ts)
 *
 * A stored overview (12 hours; one with no rankings, `has_data` false, 3
 * hours; one whose top keywords or pages failed carries `partial`) answers
 * for free; otherwise this SPENDS: 503
 * SEO_NOT_CONFIGURED, 403 FREE_PLAN, 402 SPEND_LIMIT_REACHED. 400
 * VALIDATION_ERROR for a bad domain, or a country domain data does not cover.
 */
import { getServiceClient } from '@/lib/admin'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest } from '@/lib/api-errors'
import { getDomainOverview } from '@/lib/seo/domain/overview'
import { seoRefusalResponse } from '@/lib/seo/http'
import { seoFailureResponse } from '@/lib/seo/paid'
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'

const Body = z.object({
  domain: z.string().trim().max(2048).nullish(),
  location_code: z.number().int().positive().nullish(),
  language_code: z.string().trim().min(2).max(10).nullish(),
  refresh: z.boolean().optional(),
})

export async function POST(request: NextRequest) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const parsed = Body.safeParse((await request.json().catch(() => null)) ?? {})
  if (!parsed.success)
    return badRequest(parsed.error.issues[0]?.message ?? 'Invalid request')
  try {
    const out = await getDomainOverview(
      getServiceClient(),
      { workspaceId: auth.workspaceId, userId: auth.user.id },
      parsed.data,
    )
    if (!out.ok) return seoRefusalResponse(out)
    return NextResponse.json(out.result)
  } catch (err) {
    return seoFailureResponse(err, 'domain overview')
  }
}
