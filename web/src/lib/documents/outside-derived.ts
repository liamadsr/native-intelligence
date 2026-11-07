/**
 * document.outside_derived (migration 397, F3 review R2): a document whose
 * text came from outside the workspace is marked by the server, for good, so
 * its words can't reach canon unlabelled through a stored artifact. Agents
 * read it inside an outside-text fence (documents.ts documentContentForModel),
 * and that fence makes the read count as outside text (outside-text.ts).
 *
 * Where it is set:
 *   - a file or reference ingest's generated pages (reference-ingest.ts);
 *   - a loop run's report when the run read outside text (run-skill.ts
 *     deliverSkillOutput);
 *   - a document a work run writes once that run has read outside text (the
 *     work-run tool route, after each document write: markIfRunReadOutside).
 * Known gaps: a document written during a loop run's own turn (its reads are
 * judged from the stream only once the run ends), or in an attended chat
 * turn, is not marked; nor are search excerpts of a marked document fenced.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { runReadOutsideText } from './canon-sources'

/** The document writes a run can make (their result names the document). */
export const DOCUMENT_WRITE_TOOLS: ReadonlySet<string> = new Set([
  'create_document',
  'update_document',
  'edit_document_content',
  'edit_document_lines',
  'append_to_section',
  'replace_section',
  'insert_section_after',
  'remove_section',
  'restore_document_revision',
])

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The document a write touched: its result's id, else the input's. Pure. */
export function writtenDocumentId(input: unknown, output: unknown): string | null {
  const pick = (v: unknown) => (typeof v === 'string' && UUID_RE.test(v) ? v : null)
  const out = (output && typeof output === 'object' ? output : {}) as Record<string, unknown>
  const doc = (out.document && typeof out.document === 'object' ? out.document : {}) as Record<string, unknown>
  const inp = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  return pick(out.document_id) ?? pick(doc.id) ?? pick(out.id) ?? pick(inp.document_id)
}

/** Mark a document outside-derived (service role). Never throws. */
export async function markOutsideDerived(supabase: SupabaseClient, ref: { workspaceId: string; documentId: string }): Promise<void> {
  try {
    await supabase.from('document').update({ outside_derived: true }).eq('id', ref.documentId).eq('workspace_id', ref.workspaceId)
  } catch (err) {
    console.warn('[outside-derived] could not mark a document:', err instanceof Error ? err.message : err)
  }
}

/**
 * After a work run's document write: mark the document when the run has read
 * outside text (agent_run.outside_reads). One read of the run row, only on a
 * document write. Never throws.
 */
export async function markIfRunReadOutside(
  supabase: SupabaseClient,
  args: { workspaceId: string; agentRunId: string; toolName: string; input: unknown; output: unknown },
): Promise<boolean> {
  if (!DOCUMENT_WRITE_TOOLS.has(args.toolName.replace(/^dial8_/, ''))) return false
  const out = args.output as { success?: unknown } | null
  if (out && typeof out === 'object' && out.success === false) return false
  const documentId = writtenDocumentId(args.input, args.output)
  if (!documentId) return false
  if (!(await runReadOutsideText(supabase, args.workspaceId, args.agentRunId))) return false
  await markOutsideDerived(supabase, { workspaceId: args.workspaceId, documentId })
  return true
}
