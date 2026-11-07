/**
 * Archiving and restoring documents for the agent (GEN-1169: archive_document,
 * restore_document, archive_reports). The same rules as the app's own archive
 * (DELETE /api/account/documents/[id] without ?permanent, and the bulk route):
 *
 *   archive  delete-level (canDeleteDocument: owner or admin, or the creator
 *            except the product doc). Never a system document (a canon key or
 *            the product doc, migration 366; its guard refuses one too).
 *   restore  edit-level, like the bulk route's un-archive (documentUpdateRefusal
 *            with status 'active').
 *
 * Archived is status 'archived': out of the lists and search, never deleted,
 * revisions kept. Its id still opens it, and restoring it puts it back as it
 * was. Nothing here changes the text, so no revision is written.
 *
 * Fenced to one workspace and the caller's own access (the tools run on a
 * service-role client: this is the gate). A document the caller can't see
 * (someone else's private one, or any private one when `omitPrivate`) reads
 * as not found.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { canDeleteDocument, documentUpdateRefusal, isPrivateDocument, isSystemDocument, loadDocumentsAccess } from './access'
import { SYSTEM_DOCUMENT_REFUSAL, SYSTEM_DOCUMENT_SQLSTATE } from './system-document'

/** The most documents one archive or restore call changes. */
export const ARCHIVE_MAX_DOCUMENTS = 200

export const ARCHIVE_REFUSAL = 'Only the creator or an admin can archive this document.'
const NOT_FOUND = 'Document not found'
const DAY_MS = 24 * 60 * 60 * 1000

export interface ArchiveOutcome {
  /** Archived (or restored) by this call. */
  changed: string[]
  /** Already in the state asked for. */
  unchanged: string[]
  refused: Array<{ id: string; reason: string }>
  /** A write that failed outright (nothing in `allowed` was changed). */
  error?: string
}

/**
 * Archive (`archived: true`) or restore (`archived: false`) documents in one
 * workspace, each by the caller's own access. One read for the access, one
 * write for the allowed ones. Never throws.
 */
export async function setDocumentsArchived(
  supabase: SupabaseClient,
  args: { userId: string; workspaceId: string; ids: readonly string[]; archived: boolean; omitPrivate?: boolean },
): Promise<ArchiveOutcome> {
  // Postgres hands ids back in lowercase: match them that way.
  const ids = [...new Set(args.ids.map((id) => id.toLowerCase()))]
  const out: ArchiveOutcome = { changed: [], unchanged: [], refused: [] }
  if (ids.length === 0) return out
  try {
    const { access, error } = await loadDocumentsAccess(supabase, args.workspaceId, args.userId, ids)
    if (error) return { ...out, error }
    const to = args.archived ? 'archived' : 'active'
    const allowed: string[] = []
    let memberId: string | null = null
    for (const id of ids) {
      const a = access.get(id)
      // Not a member of that workspace reads as not found, like a foreign id.
      if (!a || !a.role || (args.omitPrivate && isPrivateDocument(a.row))) {
        out.refused.push({ id, reason: NOT_FOUND })
        continue
      }
      if ((a.row.status === 'archived') === args.archived) {
        out.unchanged.push(id)
        continue
      }
      const refusal = args.archived
        ? isSystemDocument(a)
          ? SYSTEM_DOCUMENT_REFUSAL
          : canDeleteDocument(a)
            ? null
            : ARCHIVE_REFUSAL
        : documentUpdateRefusal(a, { status: to })
      if (refusal) {
        out.refused.push({ id, reason: refusal })
        continue
      }
      memberId = a.memberId
      allowed.push(id)
    }
    if (allowed.length === 0) return out

    // A restore is an edit, so it names its editor, as the single PATCH does.
    const patch: Record<string, unknown> = args.archived ? { status: to } : { status: to, ...(memberId ? { last_edited_by: memberId } : {}) }
    const { data, error: writeError } = await supabase
      .from('document')
      .update(patch)
      .eq('workspace_id', args.workspaceId)
      .eq('status', args.archived ? 'active' : 'archived')
      .in('id', allowed)
      .select('id')
    if (writeError) {
      const system = (writeError as { code?: string }).code === SYSTEM_DOCUMENT_SQLSTATE
      return { ...out, error: system ? SYSTEM_DOCUMENT_REFUSAL : writeError.message }
    }
    const written = new Set(((data ?? []) as Array<{ id: string }>).map((r) => r.id))
    // A row not written changed state in between (someone else archived or restored it).
    for (const id of allowed) (written.has(id) ? out.changed : out.unchanged).push(id)
    return out
  } catch (err) {
    return { ...out, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Which reports archive_reports matches. */
export interface ReportFilter {
  /** 'report' (skill and loop reports), 'prep' (meeting preps). */
  kind: 'report' | 'prep'
  /** Created more than this many days ago. */
  olderThanDays?: number
  /** Created at or after (ISO). */
  since?: string | null
  /** Created at or before (ISO). */
  until?: string | null
  /** Title contains this (case ignored): the skill's name, as in "{skill} — {date}". */
  title?: string
  /** The skill that wrote it (frontmatter.skill_id). */
  skillId?: string
  /** Only those this member created (the person's own reports); unset: anyone's. */
  createdBy?: string | null
  /** Pinned or not (archive_reports reads the unpinned ones to archive, the pinned ones to say they were left alone). */
  pinned: boolean
}

export interface ReportMatch {
  id: string
  title: string | null
  created_at: string
  is_pinned: boolean
}

/** LIKE metacharacters matched literally. */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`)
}

/**
 * A title filter as the query can take it: PostgREST reads every `*` in a
 * like value as `%` and can't escape one, so `*` is dropped (a title of only
 * `*` filters nothing, and the caller must not count it as a filter).
 */
export function reportTitleFilter(title: string | undefined): string {
  return (title ?? '').replace(/\*/g, '').trim()
}

/**
 * The active reports (or preps) in a workspace that match, oldest first, at
 * most `limit`, pinned or not as asked. Never a system document. `requester` is the caller's member id
 * for their own private ones (null: workspace documents only). Never throws:
 * a failed read is an error string.
 */
export async function findReports(
  supabase: SupabaseClient,
  args: { workspaceId: string; requester: string | null; filter: ReportFilter; limit: number; nowMs?: number },
): Promise<{ rows: ReportMatch[]; error: string | null }> {
  const f = args.filter
  let q = supabase
    .from('document')
    .select('id, title, created_at, is_pinned')
    .eq('workspace_id', args.workspaceId)
    .eq('status', 'active')
    .eq('kind', f.kind)
    .eq('is_pinned', f.pinned)
    .is('canon_key', null)
  q = args.requester ? q.or(`visibility.eq.workspace,created_by.eq.${args.requester}`) : q.eq('visibility', 'workspace')
  if (typeof f.olderThanDays === 'number') q = q.lt('created_at', new Date((args.nowMs ?? Date.now()) - f.olderThanDays * DAY_MS).toISOString())
  if (f.since) q = q.gte('created_at', f.since)
  if (f.until) q = q.lte('created_at', f.until)
  const title = reportTitleFilter(f.title)
  if (title) q = q.ilike('title', `%${escapeLike(title)}%`)
  if (f.skillId) q = q.eq('frontmatter->>skill_id', f.skillId)
  if (f.createdBy) q = q.eq('created_by', f.createdBy)
  try {
    const { data, error } = await q.order('created_at', { ascending: true }).order('id', { ascending: true }).limit(args.limit)
    if (error) return { rows: [], error: error.message }
    return {
      rows: ((data ?? []) as Array<{ id: string; title: string | null; created_at: string; is_pinned: boolean | null }>).map((r) => ({
        id: r.id,
        title: r.title,
        created_at: r.created_at,
        is_pinned: r.is_pinned === true,
      })),
      error: null,
    }
  } catch (err) {
    return { rows: [], error: err instanceof Error ? err.message : String(err) }
  }
}
