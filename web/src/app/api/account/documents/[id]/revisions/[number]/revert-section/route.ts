import { badRequest, conflict, forbidden, notFound, serverError, unauthorized, noWorkspace } from '@/lib/api-errors'
import { revertSectionEdit } from '@/lib/documents/canon-edit'
import { createClient } from '@/lib/supabase/server'
import { getServiceClient } from '@/lib/supabase/service'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { NextResponse, type NextRequest } from 'next/server'

/**
 * POST /api/account/documents/[id]/revisions/[number]/revert-section
 *
 * "Revert just this edit" (canon D2, decision 16): the section that version's
 * change touched goes back to how it was before it, as a new revision; every
 * other section stays as it is now. The section is the one the edit recorded
 * (document_revision.edit_meta, migration 376), else the one section the
 * change touched; a change across several sections is a 400 (restore the
 * version instead). Needs edit access (migration 359), checked by the
 * person's user id; filed as theirs.
 */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string; number: string }> }) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return unauthorized()
  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) return noWorkspace()
  const { id, number } = await params
  const revision = Number(number)
  if (!Number.isInteger(revision) || revision < 1) return badRequest('Invalid revision number')

  // The service client: what follows the write (the section's freshness
  // stamp, the claims kept in step) writes tables a person can't. The
  // person's edit access is checked by their user id inside, as on every
  // canon write, and the write is filed as theirs (source 'human').
  const result = await revertSectionEdit(getServiceClient(), { workspaceId, userId: user.id, documentId: id, revision, source: 'human' })
  if (!result.ok) {
    switch (result.reason) {
      case 'not_found':
        return notFound('Document not found')
      case 'revision_not_found':
        return notFound('That version is no longer in the history. Refresh the list.')
      case 'not_section':
        return badRequest(result.error)
      case 'refused':
        return forbidden(result.error)
      case 'conflict':
        return conflict(result.error)
      default:
        return serverError(result.error)
    }
  }
  const { data } = await supabase.from('document').select('title, content, revision').eq('id', id).eq('workspace_id', workspaceId).maybeSingle()
  const doc = data as { title: string | null; content: string | null; revision: number } | null
  return NextResponse.json({
    revision: result.revision,
    section: result.section,
    unchanged: result.unchanged === true,
    later_changes_to_section: result.laterChangesToSection,
    document: { id, title: doc?.title ?? null, content: doc?.content ?? null, revision: doc?.revision ?? result.revision },
  })
}
