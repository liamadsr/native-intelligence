import type { SupabaseClient } from '@supabase/supabase-js'
import { rehomeRunSuggestions } from './stage'
import { suggestionMarker, SUGGESTION_MARKER_RE } from './types'

/**
 * A run's suggestions land in the document it delivers
 * (docs/plans/suggestions-everywhere.md, "A run doesn't have its document yet").
 * The run stages them while it works, before the document exists; delivery
 * re-homes them onto the document, then makes sure each pending one is placed:
 * one whose marker the text didn't carry is appended under "Suggested changes",
 * so none is staged and never seen. Best-effort: delivery never fails for it.
 */
export const SUGGESTED_CHANGES_HEADING = '## Suggested changes'

/** The markdown with every id in `ids` placed: missing markers appended under the heading. */
export function placeMarkers(markdown: string, ids: string[]): string {
  const present = new Set([...markdown.matchAll(SUGGESTION_MARKER_RE)].map((m) => m[1]))
  const missing = ids.filter((id) => !present.has(id))
  if (missing.length === 0) return markdown
  const tail = missing.map(suggestionMarker).join('\n')
  const hasHeading = markdown.includes(SUGGESTED_CHANGES_HEADING)
  return `${markdown.trimEnd()}\n\n${hasHeading ? '' : `${SUGGESTED_CHANGES_HEADING}\n\n`}${tail}\n`
}

export async function placeRunSuggestions(
  supabase: SupabaseClient,
  args: { trackedJobId: string; documentId: string },
): Promise<{ placed: number }> {
  try {
    await rehomeRunSuggestions(supabase, args)
    const { data: rows } = await supabase
      .from('proposed_change')
      .select('id')
      .eq('document_id', args.documentId)
      .eq('status', 'pending')
      .order('sort_order', { ascending: true })
    const ids = ((rows as Array<{ id: string }> | null) ?? []).map((r) => r.id)
    if (ids.length === 0) return { placed: 0 }

    const { data: doc } = await supabase.from('document').select('content').eq('id', args.documentId).maybeSingle()
    const content = (doc as { content: string | null } | null)?.content ?? ''
    const next = placeMarkers(content, ids)
    if (next !== content) {
      await supabase.from('document').update({ content: next }).eq('id', args.documentId)
    }
    return { placed: ids.length }
  } catch (err) {
    console.warn('[suggestions] placing a run’s suggestions failed:', err instanceof Error ? err.message : err)
    return { placed: 0 }
  }
}
