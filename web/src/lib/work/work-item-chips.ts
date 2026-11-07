/**
 * The Agents page's entity chips (plan 1.5, "↳ contact"; deferred from row 7
 * to row 10 with work_touch's read path): for each work item on the page, the
 * entities it touched, named.
 *
 * On the caller's SESSION client: `work_touch` is member-readable, and each
 * label is read from the entity's own table (resolveEntityLabels, the knowledge
 * map's resolver), so an entity the caller cannot see yields no label and no
 * chip. Fail-soft: a failed read logs and returns no chips; it never fails the
 * page.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveEntityLabels } from '@/lib/knowledge/graph-map/source'
import { pickEntityChips, type EntityChip, type EntityTouchLike } from './touch-summary'

const ID_CHUNK = 200
const TOUCH_LIMIT = 5000

export async function loadWorkItemChips(
  supabase: SupabaseClient,
  items: ReadonlyArray<{ id: string; workspace_id: string }>,
): Promise<Record<string, EntityChip[]>> {
  if (items.length === 0) return {}
  try {
    const touches: EntityTouchLike[] = []
    for (let i = 0; i < items.length; i += ID_CHUNK) {
      const chunk = items.slice(i, i + ID_CHUNK).map((it) => it.id)
      const { data, error } = await supabase
        .from('work_touch')
        .select('work_item_id, entity_type, entity_id, verb, at')
        .in('work_item_id', chunk)
        .order('at', { ascending: false })
        .limit(TOUCH_LIMIT)
      if (error) throw new Error(error.message)
      touches.push(...((data ?? []) as EntityTouchLike[]))
    }
    const chips = pickEntityChips(touches)

    // Labels, per workspace (the resolver fences on workspace_id).
    const workspaceOf = new Map(items.map((it) => [it.id, it.workspace_id]))
    const wanted = new Map<string, Map<string, Set<string>>>()
    for (const [itemId, list] of chips) {
      const ws = workspaceOf.get(itemId)
      if (!ws) continue
      if (!wanted.has(ws)) wanted.set(ws, new Map())
      const byType = wanted.get(ws)!
      for (const c of list) {
        if (!byType.has(c.entity_type)) byType.set(c.entity_type, new Set())
        byType.get(c.entity_type)!.add(c.entity_id)
      }
    }
    const labels = new Map<string, string>()
    await Promise.all(
      [...wanted].map(async ([ws, byType]) => {
        try {
          const got = await resolveEntityLabels(supabase, ws, byType)
          for (const [k, v] of got) labels.set(`${ws}|${k}`, v)
        } catch (err) {
          console.error('[agent-work] chip labels failed:', ws, err instanceof Error ? err.message : err)
        }
      }),
    )

    const out: Record<string, EntityChip[]> = {}
    for (const [itemId, list] of chips) {
      const ws = workspaceOf.get(itemId)
      const named = list
        .map((c) => ({ ...c, label: labels.get(`${ws}|${c.entity_type}:${c.entity_id}`) }))
        .filter((c): c is EntityChip & { label: string } => !!c.label)
      if (named.length > 0) out[itemId] = named
    }
    return out
  } catch (err) {
    console.error('[agent-work] chips read failed:', err instanceof Error ? err.message : err)
    return {}
  }
}
