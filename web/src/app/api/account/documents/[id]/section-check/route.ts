import { requireWorkspace } from '@/lib/api-auth'
import { badRequest, conflict, forbidden, notFound } from '@/lib/api-errors'
import { documentUpdateRefusal, loadDocumentAccess } from '@/lib/documents/access'
import { markSectionChecked } from '@/lib/documents/canon-freshness'
import { getServiceClient } from '@/lib/supabase/service'
import { NextResponse, type NextRequest } from 'next/server'

/**
 * POST /api/account/documents/[id]/section-check { section }
 *
 * "Mark checked" on a canon document's "not checked since" marker (canon D3):
 * the section is stamped confirmed today, by the person who clicked. It
 * replaces the "still true?" card (decision 16: nothing waits on a card). Only
 * a canon document that isn't archived has the marker, so only one takes the
 * stamp; it needs edit access (migration 359), checked by the person's user
 * id. The stamp is written with the service client (document_section_check is
 * server-written, 377).
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth
  const { id } = await params
  const body = (await request.json().catch(() => null)) as { section?: unknown } | null
  const section = typeof body?.section === 'string' ? body.section.trim() : ''
  if (!section) return badRequest('Send JSON: { section } (the section heading).')

  const { access } = await loadDocumentAccess(supabase, workspaceId, user.id, id)
  if (!access) return notFound('Document not found')
  if (!access.row.canon_key) return badRequest('Only a canon document tracks when its sections were checked.')
  if (access.row.status === 'archived') return conflict('This document is archived: restore it first.')
  const refusal = documentUpdateRefusal(access, { content: '' })
  if (refusal) return forbidden(refusal)
  if (!access.memberId) return forbidden('Not a workspace member')

  const ok = await markSectionChecked(getServiceClient(), { workspaceId, documentId: id, section, memberId: access.memberId })
  if (!ok) return notFound(`No section "${section}" in this document.`)
  return NextResponse.json({ ok: true, section })
}
