/**
 * Safe document writes (migration 364): compare-and-swap on the document's
 * `revision`, and the history row the change trigger keeps for every change.
 *
 * A writer names the revision it read. The update only lands while the
 * document is still at that revision; otherwise 0 rows change and the writer
 * gets a conflict ("changed since you read it") with the revision it is at
 * now. The trigger bumps `revision` on every change to the body or the title
 * and writes the history row from `edit_source` / `edit_summary`, which this
 * helper sets on every write.
 *
 * Who may write is the caller's check (src/lib/documents/access.ts), done
 * before this. On a session client a 0-row update can also be RLS refusing
 * it: the re-read tells the two apart (still at the base revision = refused).
 */
import type { SupabaseClient } from '@supabase/supabase-js'

/** Who a write is for, recorded on its history row. */
export type DocumentEditSource = 'human' | 'agent' | 'system'

/** The line a conflict says, everywhere (tools, routes, the editor). */
export const DOCUMENT_CONFLICT_MESSAGE = 'This document changed since you read it.'

export type DocumentWriteResult<Row> =
  | { ok: true; row: Row; revision: number }
  | { ok: false; reason: 'conflict'; currentRevision: number }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'refused' }
  | { ok: false; reason: 'error'; error: string; code?: string }

export interface DocumentWriteArgs {
  documentId: string
  workspaceId: string
  /** The revision the writer read. */
  baseRevision: number
  /** The columns to write (title, content, …). */
  patch: Record<string, unknown>
  source: DocumentEditSource
  /** The member the write is for; stamped as last_edited_by and on the history row. */
  memberId: string | null
  /** One line for the history list ("Replaced section Positioning"). */
  summary?: string | null
  /** Columns to read back; `revision` is always added. */
  select?: string
}

/** Keep a summary to one short line. */
export function clampSummary(summary: string | null | undefined): string | null {
  if (!summary) return null
  const line = summary.replace(/\s+/g, ' ').trim()
  if (!line) return null
  return line.length > 200 ? `${line.slice(0, 199)}…` : line
}

/**
 * Write `patch` only if the document is still at `baseRevision`. Never throws.
 */
export async function writeDocument<Row extends Record<string, unknown> = Record<string, unknown>>(
  supabase: SupabaseClient,
  args: DocumentWriteArgs,
): Promise<DocumentWriteResult<Row>> {
  const update: Record<string, unknown> = {
    ...args.patch,
    edit_source: args.source,
    edit_summary: clampSummary(args.summary),
  }
  if (args.memberId) update.last_edited_by = args.memberId
  const columns = withRevision(args.select ?? 'id')

  const { data, error } = await supabase
    .from('document')
    .update(update)
    .eq('id', args.documentId)
    .eq('workspace_id', args.workspaceId)
    .eq('revision', args.baseRevision)
    .select(columns)

  if (error) {
    const code = (error as { code?: string }).code
    if (code === '42501') return { ok: false, reason: 'refused' }
    return { ok: false, reason: 'error', error: error.message, ...(code ? { code } : {}) }
  }
  const rows = (Array.isArray(data) ? data : data ? [data] : []) as unknown as Row[]
  if (rows.length > 0) {
    const row = rows[0]
    const revision = Number((row as Record<string, unknown>).revision)
    return { ok: true, row, revision: Number.isFinite(revision) ? revision : args.baseRevision + 1 }
  }

  // Nothing changed: moved on (a conflict), gone, or refused by RLS.
  const current = await readDocumentRevision(supabase, args.documentId, args.workspaceId)
  if (current === null) return { ok: false, reason: 'not_found' }
  if (current !== args.baseRevision) return { ok: false, reason: 'conflict', currentRevision: current }
  return { ok: false, reason: 'refused' }
}

/** The document's current revision, or null when it isn't in the workspace. */
export async function readDocumentRevision(
  supabase: SupabaseClient,
  documentId: string,
  workspaceId: string,
): Promise<number | null> {
  const { data } = await supabase
    .from('document')
    .select('revision')
    .eq('id', documentId)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  const revision = (data as { revision?: unknown } | null)?.revision
  if (revision === undefined || revision === null) return data ? 1 : null
  const n = Number(revision)
  return Number.isFinite(n) ? n : 1
}

function withRevision(columns: string): string {
  const parts = columns.split(',').map((c) => c.trim()).filter(Boolean)
  return parts.includes('revision') ? parts.join(', ') : [...parts, 'revision'].join(', ')
}

/** A conflict as a tool result: what changed and what to do. */
export function conflictResult(baseRevision: number, currentRevision: number) {
  return {
    success: false as const,
    conflict: true as const,
    error: `${DOCUMENT_CONFLICT_MESSAGE} You read revision ${baseRevision}; it is now at revision ${currentRevision}. Read it again (get_document) and make the change against the new text.`,
    base_revision: baseRevision,
    current_revision: currentRevision,
  }
}

/** A positive integer revision from an API body or tool input, else null. */
export function parseRevision(value: unknown): number | null {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 ? n : null
}
