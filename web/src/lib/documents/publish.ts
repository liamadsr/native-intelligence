/**
 * Publish a member's draft over the document: one flow for the publish route
 * and the publish_draft tool.
 *
 *   1. Read the caller's draft and the document as it is now.
 *   2. Edit access (src/lib/documents/access.ts), checked before any write.
 *   3. A draft based on an older revision than the document's (migration
 *      364, document_draft.base_revision) would revert the newer edits: it is
 *      refused as stale unless the caller says to overwrite. A draft with no
 *      base (made before 364) counts as stale.
 *   4. Write the draft in with compare-and-swap on the revision just read,
 *      with a summary, so the change trigger keeps a history row for it (the
 *      state it replaced included).
 *   5. Drop the draft, re-sync wikilinks, re-index (best-effort).
 *
 * Never throws; the caller turns the result into a response.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { withServerFrontmatter } from '@/lib/agent-events/prep-ref'
import { indexDocument } from '@/lib/ai/embeddings'
import { isNowDocument } from '@/lib/now/now-stamp'
import { documentUpdateRefusal, type DocumentAccess } from './access'
import { parseRevision, writeDocument, type DocumentEditSource } from './write'

export type PublishDraftResult<Row> =
  | { ok: true; document: Row; revision: number }
  | { ok: false; reason: 'no_draft' }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'refused'; error: string }
  | { ok: false; reason: 'stale_draft'; draftBaseRevision: number | null; revision: number }
  | { ok: false; reason: 'conflict'; baseRevision: number; currentRevision: number }
  | { ok: false; reason: 'error'; error: string }

/** The line a stale draft is refused with. */
export function staleDraftMessage(draftBase: number | null, revision: number): string {
  const from = draftBase === null ? 'an older version' : `revision ${draftBase}`
  return `The document changed since this draft was made (the draft is based on ${from}; the document is at revision ${revision}). Publishing it would undo the newer edits.`
}

export async function publishDraft<Row extends Record<string, unknown>>(
  supabase: SupabaseClient,
  args: {
    documentId: string
    workspaceId: string
    access: DocumentAccess
    userId: string
    source: DocumentEditSource
    changeSummary: string | null
    /** Publish even though the document changed since the draft was made. */
    overwrite?: boolean
    select: string
  },
): Promise<PublishDraftResult<Row>> {
  const memberId = args.access.memberId
  if (!memberId) return { ok: false, reason: 'refused', error: 'Not a workspace member' }

  const [{ data: draft, error: draftErr }, { data: doc, error: docErr }] = await Promise.all([
    supabase
      .from('document_draft')
      .select('title, content, content_json, frontmatter, tags, base_revision')
      .eq('document_id', args.documentId)
      .eq('author_id', memberId)
      .maybeSingle(),
    supabase
      .from('document')
      .select('title, content, frontmatter, revision')
      .eq('id', args.documentId)
      .eq('workspace_id', args.workspaceId)
      .maybeSingle(),
  ])
  if (draftErr) return { ok: false, reason: 'error', error: draftErr.message }
  if (docErr) return { ok: false, reason: 'error', error: docErr.message }
  if (!doc) return { ok: false, reason: 'not_found' }
  if (!draft) return { ok: false, reason: 'no_draft' }

  const updates: Record<string, unknown> = {
    published_status: 'published',
    published_at: new Date().toISOString(),
  }
  if (draft.title !== undefined && draft.title !== null) updates.title = draft.title
  if (draft.content !== undefined && draft.content !== null) updates.content = draft.content
  if (draft.content_json !== undefined && draft.content_json !== null) updates.content_json = draft.content_json
  if (draft.frontmatter !== undefined && draft.frontmatter !== null) {
    // The published document keeps its own meeting-prep stamp, whatever the draft says.
    const frontmatter = withServerFrontmatter(draft.frontmatter, (doc as { frontmatter?: unknown }).frontmatter)
    if (frontmatter) updates.frontmatter = frontmatter
  }
  if (Array.isArray(draft.tags)) updates.tags = draft.tags

  // Edit access, before anything is written. The draft stays either way.
  const refusal = documentUpdateRefusal(args.access, updates)
  if (refusal) return { ok: false, reason: 'refused', error: refusal }

  const revision = parseRevision((doc as { revision?: unknown }).revision) ?? 1
  const draftBase = parseRevision((draft as { base_revision?: unknown }).base_revision)
  if (!args.overwrite && draftBase !== revision) {
    return { ok: false, reason: 'stale_draft', draftBaseRevision: draftBase, revision }
  }

  const written = await writeDocument<Row>(supabase, {
    documentId: args.documentId,
    workspaceId: args.workspaceId,
    baseRevision: revision,
    patch: updates,
    source: args.source,
    memberId,
    summary: args.changeSummary ?? 'Published a draft',
    select: args.select,
  })
  if (!written.ok) {
    if (written.reason === 'conflict') return { ok: false, reason: 'conflict', baseRevision: revision, currentRevision: written.currentRevision }
    if (written.reason === 'not_found') return { ok: false, reason: 'not_found' }
    if (written.reason === 'refused') return { ok: false, reason: 'refused', error: 'Only the creator or an admin can publish over this document.' }
    return { ok: false, reason: 'error', error: written.error }
  }

  // Discard the draft just drained.
  await supabase.from('document_draft').delete().eq('document_id', args.documentId).eq('author_id', memberId)

  const row = written.row as Record<string, unknown>
  const content = typeof row.content === 'string' ? row.content : typeof updates.content === 'string' ? updates.content : null
  if (content !== null) {
    // Wikilinks against the newly published body.
    const { syncDocumentLinks } = await import('@/lib/wiki/wikilinks')
    // What the live body named before (the doc read above): only that is taken back.
    const before = (doc as { content?: unknown }).content
    const previous = typeof before === 'string' ? before : null
    await syncDocumentLinks(supabase, args.workspaceId, args.documentId, content, memberId, args.userId, previous)
    // The live body changed: re-index. Best-effort; never fails the publish.
    // The Now file is never embedded (migration 440).
    if (!isNowDocument(args.access.row.frontmatter)) {
      try {
        const projectId = typeof row.project_id === 'string' ? row.project_id : (args.access.row.project_id ?? null)
        await indexDocument(supabase, args.documentId, args.userId, projectId, content, args.workspaceId)
      } catch (err) {
        console.error('[documents.publish] re-index failed (non-fatal):', err)
      }
    }
  }

  return { ok: true, document: written.row, revision: written.revision }
}
