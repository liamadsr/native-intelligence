import { getServiceClient } from '@/lib/admin'
import { requireWorkspace } from '@/lib/api-auth'
import { badRequest, notFound, serverError } from '@/lib/api-errors'
import { productDocIdOf } from '@/lib/workspace/product-doc'
import { filterVisibleAttachments } from '@/lib/attachments/visibility'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * GET /api/account/attachments/[id]: one file's name and the record it hangs
 * off (its capture, else its task, else its project), for a mention of it to
 * open that record's card. Read on the caller's client (RLS), with the
 * attachments rule kept explicit (src/lib/attachments/visibility.ts): a file
 * the caller may not read answers 404, as a missing one does.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth
  const { id } = await params
  if (!UUID_RE.test(id)) return badRequest('Invalid attachment id')

  const { data, error } = await supabase
    .from('attachments')
    .select('id, file_name, user_id, note_id, action_id, project_id')
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  if (error) return serverError(error.message)
  const row = data as { id: string; file_name: string | null; user_id: string | null; note_id: string | null; action_id: string | null; project_id: string | null } | null
  if (!row || (await filterVisibleAttachments(supabase, { workspaceId, userId: user.id }, [row])).length === 0) {
    return notFound('Attachment not found')
  }
  const parent = row.note_id
    ? { type: 'capture', id: row.note_id }
    : row.action_id
      ? { type: 'action', id: row.action_id }
      : row.project_id
        ? { type: 'project', id: row.project_id }
        : null
  return Response.json({ attachment: { id: row.id, file_name: row.file_name, parent } })
}

/**
 * DELETE /api/account/attachments/[id]
 *
 * Fully removes an attachment: the storage object (+ thumbnail), the row
 * (attachment_chunks cascade with it), any graph edges that reference it,
 * and archives reference wiki pages generated from it — their verbatim
 * content would otherwise claim provenance from a file that no longer
 * exists. RLS (128) scopes who can delete: the owner or any workspace
 * member.
 *
 * The generated pages are spec pages (type 'spec'), machine-written: since
 * migration 359 only an owner or admin may change one from a client, so the
 * archive runs on the SERVICE client, and only once the attachment delete
 * itself went through (that delete is this route's authorization).
 *
 * Storage objects are removed BEFORE the row: the workspace storage
 * policies authorize through the attachments row, so it must still exist.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth
  const { id } = await params
  if (!UUID_RE.test(id)) return badRequest('Invalid attachment id')

  const { data: attachment, error } = await supabase
    .from('attachments')
    .select('id, storage_path, thumbnail_path, storage_bucket')
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  if (error) return serverError(error.message)
  if (!attachment) return notFound('Attachment not found')

  const bucket = (attachment.storage_bucket as string | null) ?? 'attachments'
  const paths = [attachment.storage_path, attachment.thumbnail_path].filter(
    (p): p is string => typeof p === 'string' && p.length > 0,
  )
  if (paths.length > 0) {
    // Best-effort: a missing object must not strand the row.
    await supabase.storage.from(bucket).remove(paths)
  }

  // Tear down the knowledge graph derived from this attachment: hard-delete
  // claims whose only evidence was this file, prune shared-claim evidence
  // (claim_source rows source_type='attachment'), and delete every entity_link
  // edge touching the attachment. claim_source/entity_link are polymorphic with
  // no FK to attachments (migration 109), so none of this cascades on the row
  // delete below. This supersedes the older entity_link-only cleanup that lived
  // here — the RPC (migration 178) covers edges AND claim evidence.
  const { error: cleanupError } = await supabase.rpc('cleanup_attachment_knowledge', {
    p_attachment_id: id,
    p_workspace_id: workspaceId,
    p_user_id: user.id,
  })
  if (cleanupError) return serverError(cleanupError.message)

  const { error: deleteError, count } = await supabase
    .from('attachments')
    .delete({ count: 'exact' })
    .eq('id', id)
    .eq('workspace_id', workspaceId)
  if (deleteError) return serverError(deleteError.message)
  if (!count) return notFound('Attachment not found or not deletable')

  // Archive the reference pages generated from it (see the header): service
  // client, scoped to this workspace and this attachment. Best-effort, as
  // before: the attachment is already gone.
  // A system document (migration 366: a canon_key, or the product doc) is
  // never archived, and one refused row would fail the whole update.
  const service = getServiceClient()
  const productDocId = await productDocIdOf(service, workspaceId)
  let archive = service
    .from('document')
    .update({ status: 'archived', updated_at: new Date().toISOString() })
    .eq('workspace_id', workspaceId)
    .contains('frontmatter', { generated: true, source_attachment_id: id })
    .is('canon_key', null)
  if (productDocId) archive = archive.neq('id', productDocId)
  const { error: archiveError } = await archive
  if (archiveError) console.warn(`[attachments] archiving the pages of ${id} failed:`, archiveError.message)

  return Response.json({ ok: true })
}
