import { inngest } from '@/lib/inngest/client'
import { conflict, forbidden, notFound, serverError } from '@/lib/api-errors'
import { loadDocumentAccess } from '@/lib/documents/access'
import { publishDraft, staleDraftMessage } from '@/lib/documents/publish'
import { DOCUMENT_CONFLICT_MESSAGE } from '@/lib/documents/write'
import { isNowDocument } from '@/lib/now/now-stamp'
import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { NextResponse, type NextRequest } from 'next/server'

/**
 * Publish flow (src/lib/documents/publish.ts):
 *   1. Read the current user's draft and the document, and check the user may
 *      edit the document (migration 359, src/lib/documents/access.ts): anyone
 *      may keep a draft of any page, but publishing it over the document needs
 *      edit access. Checked before anything is written.
 *   2. A draft made before the document's latest change would undo it: 409
 *      `STALE_DRAFT` unless the body says `overwrite: true` (migration 364).
 *   3. Drain the draft into the document with compare-and-swap on its
 *      revision (409 `CONFLICT` if another write landed meanwhile). The change
 *      trigger keeps the replaced version and this one in history.
 *   4. Delete the draft, re-sync wikilinks, re-index, extract claims.
 *
 * Returns the new revision_number and the updated document.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) return NextResponse.json({ error: 'No workspace' }, { status: 400 })

  const { id } = await params
  const body = await request.json().catch(() => ({}))
  const changeSummary: string | null = typeof body.change_summary === 'string' ? body.change_summary : null
  const overwrite = body.overwrite === true

  const { access, error: accessError } = await loadDocumentAccess(supabase, workspaceId, user.id, id)
  if (accessError) return serverError(accessError)
  if (!access) return notFound('Document not found')
  if (!access.memberId) return NextResponse.json({ error: 'Not a workspace member' }, { status: 403 })
  const memberId = access.memberId

  const result = await publishDraft<{ id: string; title: string | null; content: string | null }>(supabase, {
    documentId: id,
    workspaceId,
    access,
    userId: user.id,
    source: 'human',
    changeSummary,
    overwrite,
    select: 'id, title, content, slug, type, tags, project_id, published_status, published_at, updated_at',
  })

  if (!result.ok) {
    switch (result.reason) {
      case 'no_draft':
        return NextResponse.json({ error: 'No draft to publish' }, { status: 400 })
      case 'not_found':
        return notFound('Document not found')
      case 'refused':
        return forbidden(`${result.error} Your draft is saved.`)
      case 'stale_draft':
        return conflict(
          `${staleDraftMessage(result.draftBaseRevision, result.revision)} Your draft is saved.`,
          { draft_base_revision: result.draftBaseRevision, revision: result.revision },
          'STALE_DRAFT',
        )
      case 'conflict':
        return conflict(`${DOCUMENT_CONFLICT_MESSAGE} Your draft is saved; try again.`, { revision: result.currentRevision })
      default:
        return NextResponse.json({ error: result.error }, { status: 500 })
    }
  }

  // Knowledge: publishing is the moment a document's content is intentional —
  // extract its claims into the graph. Idempotent (extraction dedupes), so
  // republishing only picks up what changed. Never the Now file (migration
  // 440): its notes stay out of the graph, as they stay out of search.
  try {
    if (!isNowDocument(access.row.frontmatter)) await inngest.send({
      name: 'claim/extract-from-source',
      data: {
        workspaceId,
        userId: user.id,
        memberId,
        sourceType: 'document',
        sourceId: id,
        sourceLabel: result.document.title ?? 'Document',
      },
    })
  } catch {
    // Best-effort; never fail a publish for knowledge extraction.
  }

  return NextResponse.json({
    document: result.document,
    revision_number: result.revision,
  })
}
