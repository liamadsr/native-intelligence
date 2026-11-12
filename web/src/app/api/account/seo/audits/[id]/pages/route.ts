/**
 * GET /api/account/seo/audits/[id]/pages?show=&offset=&limit=
 * An audit's crawled pages, a page at a time. `show` narrows them: errors,
 * redirects, noindex, not_in_sitemap (default: all).
 */
import { NextResponse, type NextRequest } from 'next/server'
import { getServiceClient } from '@/lib/admin'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest, notFound, serverError } from '@/lib/api-errors'
import { AUDIT_PAGE_FILTERS, getSiteAudit, listSiteAuditPages, type AuditPageFilter } from '@/lib/seo/audit/queries'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function numberParam(value: string | null): number | undefined {
  if (value === null || value.trim() === '') return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { id } = await params
  if (!UUID.test(id)) return notFound('Audit not found')
  const search = request.nextUrl.searchParams
  const show = search.get('show') ?? 'all'
  if (!(AUDIT_PAGE_FILTERS as readonly string[]).includes(show)) return badRequest('Unknown filter')
  try {
    const svc = getServiceClient()
    if (!(await getSiteAudit(svc, auth.workspaceId, id))) return notFound('Audit not found')
    const page = await listSiteAuditPages(svc, auth.workspaceId, id, {
      show: show as AuditPageFilter,
      offset: numberParam(search.get('offset')),
      limit: numberParam(search.get('limit')),
    })
    return NextResponse.json({ pages: page.rows, next_offset: page.next_offset })
  } catch (err) {
    console.error('[seo-audit] pages failed', err)
    return serverError('Could not load the pages just now.')
  }
}
