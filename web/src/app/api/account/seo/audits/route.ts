/**
 * /api/account/seo/audits: the workspace's site audits.
 *
 *   GET    the audits, newest first, and the workspace's own site (the
 *          start form's default).
 *   POST   { url?, max_pages? }: start an audit of that site (or the
 *          workspace's own). The crawl runs in the background lane; this
 *          only writes the row and sends the event. A second start while one
 *          is running is a 409 that carries the live audit; a start past the
 *          workspace's daily limit is a 429 (AUDIT_LIMIT_REACHED).
 *
 * Any member may read and start. Nothing here costs money.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { getServiceClient } from '@/lib/admin'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { apiError, badRequest, conflict, serverError } from '@/lib/api-errors'
import { DEFAULT_AUDIT_PAGES, MAX_AUDIT_PAGES, MIN_AUDIT_PAGES } from '@/lib/seo/audit/limits'
import { listSiteAudits } from '@/lib/seo/audit/queries'
import { startSiteAudit } from '@/lib/seo/audit/start'
import { workspaceSiteUrl } from '@/lib/seo/site'

export async function GET() {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  try {
    const svc = getServiceClient()
    const [audits, site] = await Promise.all([listSiteAudits(svc, auth.workspaceId), workspaceSiteUrl(svc, auth.workspaceId)])
    return NextResponse.json({
      audits,
      default_url: site,
      limits: { min_pages: MIN_AUDIT_PAGES, default_pages: DEFAULT_AUDIT_PAGES, max_pages: MAX_AUDIT_PAGES },
    })
  } catch (err) {
    console.error('[seo-audit] list failed', err)
    return serverError('Could not load your audits just now.')
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const body = (await request.json().catch(() => null)) as { url?: unknown; max_pages?: unknown } | null
  if (body?.url !== undefined && body.url !== null && typeof body.url !== 'string') return badRequest('That isn’t a website address.')
  try {
    const out = await startSiteAudit(
      getServiceClient(),
      { workspaceId: auth.workspaceId, userId: auth.user.id },
      { url: typeof body?.url === 'string' ? body.url.slice(0, 2100) : null, maxPages: body?.max_pages },
    )
    if (out.ok) return NextResponse.json({ audit: out.audit }, { status: 201 })
    if (out.code === 'AUDIT_ALREADY_RUNNING') return conflict(out.message, { audit: out.audit }, out.code)
    if (out.code === 'AUDIT_LIMIT_REACHED') return apiError(out.message, { status: 429, code: out.code })
    if (out.code === 'START_FAILED') return serverError(out.message)
    return badRequest(out.message, { code: out.code })
  } catch (err) {
    console.error('[seo-audit] start failed', err)
    return serverError('Could not start the audit just now.')
  }
}
