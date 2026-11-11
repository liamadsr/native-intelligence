import { badRequest, conflict, forbidden, notFound, serverError, unauthorized, noWorkspace } from '@/lib/api-errors'
import { loadDocumentAccess } from '@/lib/documents/access'
import { restoreDocumentRevision } from '@/lib/documents/revision'
import { DOCUMENT_CONFLICT_MESSAGE, parseRevision } from '@/lib/documents/write'
import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { NextResponse, type NextRequest } from 'next/server'

/**
 * POST /api/account/documents/[id]/revisions/[number]/restore
 * Body: { base_revision } — the revision the person is looking at.
 *
 * Puts that version's title and body back as a new revision (so the restore
 * is in history too, and can itself be undone). Needs edit access (migration
 * 359); a document that moved on since base_revision is a 409.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string; number: string }> }) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return unauthorized()
  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) return noWorkspace()
  const { id, number } = await params
  const revisionNumber = Number(number)
  if (!Number.isInteger(revisionNumber) || revisionNumber < 1) return badRequest('Invalid revision number')
  const body = await request.json().catch(() => ({}))

  // Restoring a version is an edit: an edit grant (512) may, as the creator could.
  const { access, error: accessError } = await loadDocumentAccess(supabase, workspaceId, user.id, id, { editGrants: true })
  if (accessError) return serverError(accessError)
  if (!access) return notFound('Document not found')

  const result = await restoreDocumentRevision(supabase, {
    documentId: id,
    workspaceId,
    access,
    userId: user.id,
    revisionNumber,
    baseRevision: parseRevision(body.base_revision),
    source: 'human',
  })
  if (!result.ok) {
    switch (result.reason) {
      case 'not_found':
        return notFound('Document not found')
      case 'revision_not_found':
        return notFound('That version is no longer in the history (a later save folded it in). Refresh the list.')
      case 'refused':
        return forbidden(result.error)
      case 'conflict':
        return conflict(`${DOCUMENT_CONFLICT_MESSAGE} Look at the latest version before restoring.`, {
          revision: result.currentRevision,
          base_revision: result.baseRevision,
        })
      default:
        return serverError(result.error)
    }
  }
  return NextResponse.json({
    revision: result.revision,
    restored_from: result.restoredFrom,
    unchanged: result.unchanged === true,
    document: { id, title: result.title, content: result.content, revision: result.revision },
  })
}
