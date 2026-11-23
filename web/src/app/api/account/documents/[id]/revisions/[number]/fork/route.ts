import { badRequest, forbidden, notFound, serverError, unauthorized, noWorkspace } from '@/lib/api-errors'
import { loadDocumentAccess } from '@/lib/documents/access'
import { getDocumentRevision } from '@/lib/documents/revision'
import { forkTitle } from '@/lib/documents/revision-sessions'
import { indexDocument } from '@/lib/ai/embeddings'
import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { NextResponse, type NextRequest } from 'next/server'

/**
 * POST /api/account/documents/[id]/revisions/[number]/fork
 *
 * "Fork into a new document" (docs/plans/doc-editor-extras.md, phase 4): a new
 * document holding that version's text, named "<title> (version N)", in the
 * original's project, team, Drive folder and visibility. The original is not
 * touched.
 *
 * Everything runs on the person's own client, so their row security decides:
 * the original and the version must be readable by them (a private document
 * is its creator's, or an edit grant's), the new document is created as them
 * (a private original makes a fork private to whoever forks it), and the fork
 * is filed only in a folder they can read. Per-person grants on the original
 * are NOT copied: a copy never reaches anyone the original's owner didn't
 * choose. A folder that refuses the filing leaves the fork unfiled (said in
 * `filed: false`), never undone.
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
  const revisionNumber = Number(number)
  if (!Number.isInteger(revisionNumber) || revisionNumber < 1) return badRequest('Invalid revision number')

  const { access, error: accessError } = await loadDocumentAccess(supabase, workspaceId, user.id, id, { editGrants: true })
  if (accessError) return serverError(accessError)
  if (!access) return notFound('Document not found')
  if (!access.memberId) return forbidden('Only a member of this workspace can fork its documents.')

  const [{ revision, error: revisionError }, original, folder] = await Promise.all([
    getDocumentRevision(supabase, id, workspaceId, revisionNumber),
    supabase.from('document').select('title, project_id, team_id, visibility, type, tags').eq('id', id).eq('workspace_id', workspaceId).maybeSingle(),
    supabase.from('drive_folder_item').select('folder_id').eq('item_type', 'document').eq('item_id', id).eq('workspace_id', workspaceId).maybeSingle(),
  ])
  if (revisionError) return serverError(revisionError)
  if (original.error) return serverError(original.error.message)
  if (!original.data) return notFound('Document not found')
  if (!revision) return notFound('That version is no longer in the history (a later save folded it in). Refresh the list.')

  const source = original.data as { title: string | null; project_id: string | null; team_id: string | null; visibility: string | null; type: string | null; tags: string[] | null }
  const insert: Record<string, unknown> = {
    workspace_id: workspaceId,
    title: forkTitle(revision.title ?? source.title, revisionNumber),
    content: revision.content ?? '',
    created_by: access.memberId,
    last_edited_by: access.memberId,
    status: 'active',
    visibility: source.visibility === 'private' ? 'private' : 'workspace',
  }
  if (source.project_id) insert.project_id = source.project_id
  if (source.team_id) insert.team_id = source.team_id
  if (source.type) insert.type = source.type
  if (Array.isArray(source.tags) && source.tags.length) insert.tags = source.tags

  const { data: created, error: createError } = await supabase
    .from('document')
    .insert(insert)
    .select('id, title, content, project_id, visibility, revision')
    .single()
  if (createError || !created) {
    if (createError?.code === '42501') return forbidden('You can’t create documents in this workspace.')
    return serverError(createError?.message ?? 'Couldn’t create the copy')
  }

  // Filed where the original is, when it is filed and the folder takes it.
  let filed: boolean | null = null
  const folderId = (folder.data as { folder_id?: string } | null)?.folder_id
  if (folderId) {
    const { error: fileError } = await supabase
      .from('drive_folder_item')
      .insert({ item_type: 'document', item_id: created.id, folder_id: folderId, workspace_id: workspaceId, added_by: access.memberId })
    filed = !fileError
    if (fileError) console.error('[documents.fork] filing failed (the fork stays unfiled):', fileError.message)
  }

  // Searchable like any new document; never fails the fork.
  if (typeof created.content === 'string' && created.content.length > 0) {
    try {
      await indexDocument(supabase, created.id, user.id, created.project_id ?? null, created.content, workspaceId)
    } catch (err) {
      console.error('[documents.fork] index failed (non-fatal):', err)
    }
  }

  return NextResponse.json({ document: created, forked_from: { id, revision: revisionNumber }, filed }, { status: 201 })
}
