/**
 * POST /api/account/seo/audits/[id]/cancel: stop a queued or running audit.
 * What it already found stays readable.
 */
import { NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/admin'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { conflict, notFound, serverError } from '@/lib/api-errors'
import { cancelSiteAudit } from '@/lib/seo/audit/start'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { id } = await params
  if (!UUID.test(id)) return notFound('Audit not found')
  try {
    const out = await cancelSiteAudit(getServiceClient(), { workspaceId: auth.workspaceId }, id)
    if (out.ok) return NextResponse.json({ audit: out.audit })
    if (out.code === 'NOT_FOUND') return notFound('Audit not found')
    return conflict(out.message, undefined, out.code)
  } catch (err) {
    console.error('[seo-audit] cancel failed', err)
    return serverError('Could not stop the audit just now.')
  }
}
