/**
 * GET /api/account/seo/lookups?kind=&limit=: the workspace's recent paid
 * lookups, newest first (SeoLookupSummary[], src/lib/seo/lookup-view.ts):
 * id, kind, label, when and by whom, never the result. `kind` narrows them
 * (keyword_research, keyword_metrics, serp_results, domain_overview,
 * ranked_keywords, serp_competitors, and kinds other SEO areas add); without
 * it, every kind. GET /api/account/seo/lookups/[id] reads one whole. Free.
 */
import { getServiceClient } from '@/lib/admin'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest, serverError } from '@/lib/api-errors'
import { isLookupKind, listLookups } from '@/lib/seo/lookup-cache'
import { NextResponse, type NextRequest } from 'next/server'

export async function GET(request: NextRequest) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const kind = request.nextUrl.searchParams.get('kind')
  if (kind !== null && !isLookupKind(kind)) return badRequest('Unknown kind')
  const limitParam = Number(request.nextUrl.searchParams.get('limit') ?? '')
  try {
    const lookups = await listLookups(
      getServiceClient(),
      auth.workspaceId,
      kind,
      {
        limit: Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 20,
      },
    )
    return NextResponse.json({ lookups })
  } catch (err) {
    console.error('[seo-lookup] list failed', err)
    return serverError('Could not load recent lookups just now.')
  }
}
