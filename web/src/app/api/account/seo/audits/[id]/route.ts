/**
 * /api/account/seo/audits/[id]: one site audit.
 *
 *   GET     the audit and its findings counted by type, each with what it
 *           means and how to fix it. The page polls this while it runs.
 *   DELETE  delete an audit that has ended, with its pages and findings.
 */
import { NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/admin'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { conflict, notFound, serverError } from '@/lib/api-errors'
import { getSiteAuditDetail } from '@/lib/seo/audit/queries'
import { deleteSiteAudit } from '@/lib/seo/audit/start'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { id } = await params
  if (!UUID.test(id)) return notFound('Audit not found')
  try {
    const detail = await getSiteAuditDetail(getServiceClient(), auth.workspaceId, id)
    if (!detail) return notFound('Audit not found')
    return NextResponse.json(detail)
  } catch (err) {
    console.error('[seo-audit] read failed', err)
    return serverError('Could not load the audit just now.')
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { id } = await params
  if (!UUID.test(id)) return notFound('Audit not found')
  try {
    const out = await deleteSiteAudit(getServiceClient(), { workspaceId: auth.workspaceId }, id)
    if (out.ok) return NextResponse.json({ deleted: true })
    if (out.code === 'NOT_FOUND') return notFound('Audit not found')
    return conflict(out.message, undefined, out.code)
  } catch (err) {
    console.error('[seo-audit] delete failed', err)
    return serverError('Could not delete the audit just now.')
  }
}
