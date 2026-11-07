/**
 * A document's version history (document_revision, migrations 110 and 364):
 * read it, and restore an earlier version.
 *
 * The change trigger (364) writes every row: one per change to the title or
 * body, holding the document AS IT BECAME, numbered by the document's
 * revision (so the newest row's number is the document's revision now), with
 * who it was for (`author_kind` human / agent / system, `author_id` the
 * member) and a one-line summary. A person's autosaves fold into one row per
 * 10 minutes. A baseline row (no author_kind) is the state before the first
 * tracked change.
 *
 * Restoring is an ordinary write of the old title and body (compare-and-swap,
 * src/lib/documents/write.ts), so it is itself a new revision and can be
 * undone the same way.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { indexDocument } from '@/lib/ai/embeddings'
import { isNowDocument } from '@/lib/now/now-stamp'
import { documentUpdateRefusal, type DocumentAccess } from './access'
import { parseRevision, readDocumentRevision, writeDocument, type DocumentEditSource } from './write'
import type { RevisionDetail, RevisionSummary } from './revision-format'

export { describeRevisionAuthor, type RevisionDetail, type RevisionSummary } from './revision-format'

const SUMMARY_COLUMNS =
  'revision_number, title, author_kind, author_id, change_summary, edit_meta, created_at, updated_at, author:member!author_id(display_name)'

/** What a section edit recorded on its revision (migration 376), as the list shows it. */
function editMetaFields(meta: unknown): Pick<RevisionSummary, 'section' | 'reason' | 'sources' | 'outside'> {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return {}
  const m = meta as Record<string, unknown>
  return {
    ...(typeof m.section === 'string' ? { section: m.section } : {}),
    ...(typeof m.reason === 'string' ? { reason: m.reason } : {}),
    // The outside text the edit rested on, in a few words (canon-sources.ts canonOutsideLabel).
    ...(typeof m.outside === 'string' && m.outside ? { outside: m.outside } : {}),
    // Kind, row id, web address and an email's domain only, whatever was
    // stored (a sender's address or a note never reaches the history list).
    ...(Array.isArray(m.sources)
      ? {
          sources: (m.sources.filter((s) => s && typeof s === 'object') as Array<Record<string, unknown>>).map((s) => ({
            kind: s.kind,
            ...(typeof s.id === 'string' ? { id: s.id } : {}),
            ...(s.kind === 'web' && typeof s.url === 'string' ? { url: s.url } : {}),
            ...(typeof s.domain === 'string' ? { domain: s.domain } : {}),
          })),
        }
      : {}),
  }
}

function toSummary(row: Record<string, unknown>): RevisionSummary {
  const author = Array.isArray(row.author) ? row.author[0] : row.author
  return {
    revision_number: Number(row.revision_number),
    title: (row.title as string | null) ?? null,
    author_kind: (row.author_kind as string | null) ?? null,
    author_id: (row.author_id as string | null) ?? null,
    author_name: ((author as { display_name?: string | null } | null)?.display_name as string | null) ?? null,
    change_summary: (row.change_summary as string | null) ?? null,
    ...editMetaFields(row.edit_meta),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at ?? row.created_at),
  }
}

/** Newest first; `before` pages back (revision numbers below it). */
export async function listDocumentRevisions(
  supabase: SupabaseClient,
  documentId: string,
  workspaceId: string,
  opts: { limit?: number; before?: number | null } = {},
): Promise<{ revisions: RevisionSummary[]; error: string | null }> {
  const limit = Math.max(1, Math.min(100, Math.floor(opts.limit ?? 30)))
  let query = supabase
    .from('document_revision')
    .select(SUMMARY_COLUMNS)
    .eq('document_id', documentId)
    .eq('workspace_id', workspaceId)
    .order('revision_number', { ascending: false })
    .limit(limit)
  if (opts.before) query = query.lt('revision_number', opts.before)
  const { data, error } = await query
  if (error) return { revisions: [], error: error.message }
  return { revisions: ((data ?? []) as Record<string, unknown>[]).map(toSummary), error: null }
}

/**
 * One revision with its text, and the one before it (for "what this change
 * did"), or null when there is none.
 */
export async function getDocumentRevision(
  supabase: SupabaseClient,
  documentId: string,
  workspaceId: string,
  revisionNumber: number,
): Promise<{ revision: RevisionDetail | null; previous: RevisionDetail | null; error: string | null }> {
  const { data, error } = await supabase
    .from('document_revision')
    .select(`${SUMMARY_COLUMNS}, content, frontmatter`)
    .eq('document_id', documentId)
    .eq('workspace_id', workspaceId)
    .lte('revision_number', revisionNumber)
    .order('revision_number', { ascending: false })
    .limit(2)
  if (error) return { revision: null, previous: null, error: error.message }
  const rows = ((data ?? []) as Record<string, unknown>[]).map((row) => ({
    ...toSummary(row),
    content: (row.content as string | null) ?? null,
    frontmatter: row.frontmatter ?? {},
  }))
  const revision = rows[0]?.revision_number === revisionNumber ? rows[0] : null
  return { revision, previous: revision ? (rows[1] ?? null) : null, error: null }
}

export type RestoreResult =
  | { ok: true; revision: number; restoredFrom: number; title: string | null; content: string | null; unchanged?: boolean }
  | { ok: false; reason: 'not_found' | 'revision_not_found' }
  | { ok: false; reason: 'refused'; error: string }
  | { ok: false; reason: 'conflict'; baseRevision: number; currentRevision: number }
  | { ok: false; reason: 'error'; error: string }

/**
 * Put a revision's title and body back, as a new revision. `baseRevision` is
 * the revision the caller is looking at (a conflict when the document moved
 * on since); without one, the revision read just now.
 */
export async function restoreDocumentRevision(
  supabase: SupabaseClient,
  args: {
    documentId: string
    workspaceId: string
    access: DocumentAccess
    userId: string
    revisionNumber: number
    baseRevision: number | null
    source: DocumentEditSource
  },
): Promise<RestoreResult> {
  const [{ revision, error }, current] = await Promise.all([
    getDocumentRevision(supabase, args.documentId, args.workspaceId, args.revisionNumber),
    supabase
      .from('document')
      .select('title, content, revision, project_id')
      .eq('id', args.documentId)
      .eq('workspace_id', args.workspaceId)
      .maybeSingle(),
  ])
  if (error) return { ok: false, reason: 'error', error }
  if (current.error) return { ok: false, reason: 'error', error: current.error.message }
  if (!current.data) return { ok: false, reason: 'not_found' }
  if (!revision) return { ok: false, reason: 'revision_not_found' }

  const doc = current.data as { title: string | null; content: string | null; revision?: unknown; project_id?: string | null }
  const now = parseRevision(doc.revision) ?? (await readDocumentRevision(supabase, args.documentId, args.workspaceId)) ?? 1
  const base = args.baseRevision ?? now
  if (base !== now) return { ok: false, reason: 'conflict', baseRevision: base, currentRevision: now }

  const patch: Record<string, unknown> = { content: revision.content ?? '' }
  if (revision.title) patch.title = revision.title
  const refusal = documentUpdateRefusal(args.access, patch)
  if (refusal) return { ok: false, reason: 'refused', error: refusal }

  if ((doc.content ?? '') === (revision.content ?? '') && (!revision.title || doc.title === revision.title)) {
    return { ok: true, revision: now, restoredFrom: args.revisionNumber, title: doc.title, content: doc.content, unchanged: true }
  }

  const written = await writeDocument<{ title: string | null; content: string | null }>(supabase, {
    documentId: args.documentId,
    workspaceId: args.workspaceId,
    baseRevision: base,
    patch,
    source: args.source,
    memberId: args.access.memberId,
    summary: `Restored revision ${args.revisionNumber}`,
    select: 'id, title, content',
  })
  if (!written.ok) {
    if (written.reason === 'conflict') return { ok: false, reason: 'conflict', baseRevision: base, currentRevision: written.currentRevision }
    if (written.reason === 'not_found') return { ok: false, reason: 'not_found' }
    if (written.reason === 'refused') return { ok: false, reason: 'refused', error: 'Only the creator or an admin can edit this document.' }
    return { ok: false, reason: 'error', error: written.error }
  }

  // The body changed: re-index. Best-effort. The Now file is never embedded (migration 440).
  if (!isNowDocument(args.access.row.frontmatter)) {
    try {
      await indexDocument(supabase, args.documentId, args.userId, doc.project_id ?? null, written.row.content ?? null, args.workspaceId)
    } catch (err) {
      console.error('[documents.restore] re-index failed (non-fatal):', err)
    }
  }
  return {
    ok: true,
    revision: written.revision,
    restoredFrom: args.revisionNumber,
    title: written.row.title ?? null,
    content: written.row.content ?? null,
  }
}
