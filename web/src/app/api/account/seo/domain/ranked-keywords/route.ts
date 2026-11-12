/**
 * POST /api/account/seo/domain/ranked-keywords: the keywords a domain, folder
 * or page ranks for, a page at a time.
 *
 *   body  { target?, scope?, location_code?, language_code?, limit?, offset?,
 *           sort_by?, min_search_volume?, max_rank?, exclude_terms?, refresh? }
 *         no target: the workspace's own website. scope: domain,
 *         subdomains, subfolder or exact_url (default from the target).
 *   200   RankedKeywordsPage (src/lib/seo/domain/view.ts); pass next_offset
 *         back as offset for the next page.
 *
 * Each page is stored (12 hours) and answers for free; otherwise this
 * SPENDS: 503 SEO_NOT_CONFIGURED, 403 FREE_PLAN, 402 SPEND_LIMIT_REACHED. 400
 * VALIDATION_ERROR for a bad target, too many filters, or a country domain
 * data does not cover.
 */
import { getServiceClient } from '@/lib/admin'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest } from '@/lib/api-errors'
import { getRankedKeywords } from '@/lib/seo/domain/ranked-keywords'
import {
  RANKED_KEYWORD_SORTS,
  RANKED_KEYWORDS_OFFSET_MAX,
  RANKED_KEYWORDS_PAGE_MAX,
  RESEARCH_SCOPES,
} from '@/lib/seo/domain/view'
import { seoRefusalResponse } from '@/lib/seo/http'
import { seoFailureResponse } from '@/lib/seo/paid'
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'

const Body = z.object({
  target: z.string().trim().max(2048).nullish(),
  scope: z.enum(RESEARCH_SCOPES).optional(),
  location_code: z.number().int().positive().nullish(),
  language_code: z.string().trim().min(2).max(10).nullish(),
  limit: z.number().int().min(1).max(RANKED_KEYWORDS_PAGE_MAX).optional(),
  offset: z.number().int().min(0).max(RANKED_KEYWORDS_OFFSET_MAX).optional(),
  sort_by: z.enum(RANKED_KEYWORD_SORTS).optional(),
  min_search_volume: z.number().int().min(0).optional(),
  max_rank: z.number().int().min(1).max(100).optional(),
  exclude_terms: z.array(z.string().trim().min(1).max(80)).max(10).optional(),
  refresh: z.boolean().optional(),
})

export async function POST(request: NextRequest) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const parsed = Body.safeParse((await request.json().catch(() => null)) ?? {})
  if (!parsed.success)
    return badRequest(parsed.error.issues[0]?.message ?? 'Invalid request')
  try {
    const out = await getRankedKeywords(
      getServiceClient(),
      { workspaceId: auth.workspaceId, userId: auth.user.id },
      parsed.data,
    )
    if (!out.ok) return seoRefusalResponse(out)
    return NextResponse.json(out.result)
  } catch (err) {
    return seoFailureResponse(err, 'ranked keywords')
  }
}
