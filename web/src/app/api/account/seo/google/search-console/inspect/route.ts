/**
 * /api/account/seo/google/search-console/inspect
 *
 *   POST  { urls: string[1..10], language_code? }: what Google knows about
 *         each page of the chosen site (indexed or not and why, last crawl,
 *         the canonical Google chose against the declared one, mobile and
 *         rich-result verdicts). Not a live test. One page's failure is its
 *         own row's `error`. Answers UrlInspectionResult.
 *
 * Any member may read it. Free: Google charges nothing.
 */
import { getServiceClient } from '@/lib/admin'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest } from '@/lib/api-errors'
import { inspectInput } from '@/lib/seo/google/input'
import { googleErrorResponse } from '@/lib/seo/google/respond'
import { inspectUrls } from '@/lib/seo/google/search-console'
import { NextResponse, type NextRequest } from 'next/server'

export async function POST(request: NextRequest) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const parsed = inspectInput.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success)
    return badRequest('Give 1 to 10 page addresses to inspect.')
  try {
    return NextResponse.json(
      await inspectUrls(
        getServiceClient(),
        { workspaceId: auth.workspaceId, userId: auth.user.id },
        parsed.data,
      ),
    )
  } catch (err) {
    return googleErrorResponse(err, 'url inspection')
  }
}
