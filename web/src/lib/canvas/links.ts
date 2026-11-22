/**
 * A record card on a canvas is a link in the graph: the canvas mentions the
 * record, so the record's "Referenced in" names the canvas, and taking the
 * card off takes the link away. Kept in step after every write that touches
 * a card.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { isMentionableType, type MentionRef } from '@/lib/entity-links/mentionable'
import { syncMentions } from '@/lib/entity-links/mentions'
import type { CanvasItemRow } from './types'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The records a canvas's cards point at, each once. */
export function recordRefs(rows: ReadonlyArray<Pick<CanvasItemRow, 'kind' | 'data'>>): MentionRef[] {
  const seen = new Set<string>()
  const out: MentionRef[] = []
  for (const row of rows) {
    if (row.kind !== 'record') continue
    const ref = (row.data as { ref?: { type?: unknown; id?: unknown } } | null)?.ref
    if (!ref || typeof ref.type !== 'string' || typeof ref.id !== 'string') continue
    if (!isMentionableType(ref.type) || !UUID.test(ref.id)) continue
    const key = `${ref.type}:${ref.id}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ type: ref.type, id: ref.id })
  }
  return out
}

/** Does this write add, change or remove something that could be a card? */
export function touchesRecords(write: { upsert?: ReadonlyArray<{ kind?: string }>; remove?: readonly string[] }): boolean {
  return !!write.remove?.length || !!write.upsert?.some((r) => r.kind === 'record')
}

/**
 * Make the canvas's mention edges match its cards. Targets are fenced for the
 * person (a card to something they cannot read writes no edge). Never throws:
 * a link is not worth failing a save.
 */
export async function syncCanvasRecordLinks(
  db: SupabaseClient,
  input: { workspaceId: string; canvasId: string; userId: string; memberId: string | null },
): Promise<{ added: number; removed: number; error?: string }> {
  try {
    const { data, error } = await db.from('canvas_item').select('kind, data').eq('canvas_id', input.canvasId).eq('kind', 'record').limit(1000)
    if (error) return { added: 0, removed: 0, error: error.message }
    const result = await syncMentions(db, {
      workspaceId: input.workspaceId,
      source: { type: 'canvas', id: input.canvasId },
      targets: recordRefs((data ?? []) as Array<Pick<CanvasItemRow, 'kind' | 'data'>>),
      userId: input.userId,
      memberId: input.memberId,
    })
    return { added: result.added, removed: result.removed, ...(result.error ? { error: result.error } : {}) }
  } catch (e) {
    return { added: 0, removed: 0, error: e instanceof Error ? e.message : 'unknown' }
  }
}
