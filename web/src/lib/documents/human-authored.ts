/**
 * Which documents a person wrote (P8 review B1): the documents that may stand
 * as evidence for a graded claim (src/lib/marketing/claim-evidence.ts) or as
 * the person's own public pricing in a post (src/lib/content/post-sources.ts).
 *
 * An agent can create an ordinary, shared document in one call
 * (create_document), so "a shared doc" proves nothing. A document counts only
 * when:
 *   - it is in this workspace, shared (not private), an ordinary doc (not a
 *     loop's report or a meeting prep) and not a canon document;
 *   - it is not outside_derived (migration 397: its text came from outside);
 *   - a PERSON wrote its CURRENT text: its latest document_revision (the
 *     highest revision_number) has author_kind 'human' (migration 364's
 *     trigger stamps 'human' only for a signed-in caller's write; every tool
 *     and agent write is 'agent' or 'system'). An older human revision never
 *     vouches for an agent's later text (P8 verification B1). A person's edit
 *     on top of an agent's counts; a doc a person created but never edited
 *     has no revision row and never counts.
 *
 * Bounded (at most MAX_CHECKED ids), and a failed read counts nothing, which
 * only ever withholds.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

export const MAX_CHECKED = 20

export interface DocumentFacts {
  id: string
  canonKey: string | null
  /** A person wrote it, and it is a shared, ordinary, inside-the-workspace doc (see the module doc). */
  humanAuthored: boolean
}

/** The facts for each id found in this workspace (ids not found are absent). Never throws. */
export async function documentFacts(supabase: SupabaseClient, workspaceId: string, ids: readonly string[]): Promise<Map<string, DocumentFacts>> {
  const out = new Map<string, DocumentFacts>()
  const wanted = [...new Set(ids)].slice(0, MAX_CHECKED)
  if (!wanted.length) return out
  try {
    const { data, error } = await supabase
      .from('document')
      .select('id, visibility, kind, canon_key, outside_derived')
      .eq('workspace_id', workspaceId)
      .in('id', wanted)
    if (error) return out
    const rows = (data ?? []) as Array<{ id: string; visibility: string | null; kind: string | null; canon_key: string | null; outside_derived: boolean | null }>
    const eligible = rows.filter((d) => d.visibility !== 'private' && (d.kind ?? 'doc') === 'doc' && !d.canon_key && d.outside_derived !== true).map((d) => d.id)
    const human = new Set<string>()
    // Each document's latest revision, one bounded read each (at most MAX_CHECKED).
    const latest = await Promise.all(
      eligible.map(async (id) => {
        const { data: revs, error: revError } = await supabase
          .from('document_revision')
          .select('document_id, revision_number, author_kind')
          .eq('workspace_id', workspaceId)
          .eq('document_id', id)
          .order('revision_number', { ascending: false })
          .limit(1)
        if (revError) return null
        return ((revs ?? []) as Array<{ document_id: string; author_kind: string | null }>)[0] ?? null
      }),
    )
    for (const r of latest) if (r?.author_kind === 'human') human.add(r.document_id)
    for (const d of rows) out.set(d.id, { id: d.id, canonKey: d.canon_key, humanAuthored: human.has(d.id) })
  } catch {
    return new Map()
  }
  return out
}
