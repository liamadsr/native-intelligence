/**
 * GET /api/account/seo/audits/[id]/issues?type=&severity=&offset=&limit=
 * An audit's findings, a page at a time, optionally of one type or severity.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { getServiceClient } from '@/lib/admin'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest, notFound, serverError } from '@/lib/api-errors'
import { getSiteAudit, listSiteAuditIssues } from '@/lib/seo/audit/queries'
import { isAuditIssueType, isIssueSeverity } from '@/lib/seo/audit/view'

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
  const type = search.get('type')
  const severity = search.get('severity')
  if (type !== null && !isAuditIssueType(type)) return badRequest('Unknown issue type')
  if (severity !== null && !isIssueSeverity(severity)) return badRequest('Unknown severity')
  try {
    const svc = getServiceClient()
    if (!(await getSiteAudit(svc, auth.workspaceId, id))) return notFound('Audit not found')
    const page = await listSiteAuditIssues(svc, auth.workspaceId, id, {
      type: type ?? undefined,
      severity: severity && isIssueSeverity(severity) ? severity : undefined,
      offset: numberParam(search.get('offset')),
      limit: numberParam(search.get('limit')),
    })
    return NextResponse.json({ issues: page.rows, next_offset: page.next_offset })
  } catch (err) {
    console.error('[seo-audit] issues failed', err)
    return serverError('Could not load the findings just now.')
  }
}
