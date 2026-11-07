/**
 * How an entity's agent activity reads (plan Part 2.5, the entity tab; Part
 * 1.5, the Agents page's entity chips). Plain data, client-safe: the loader
 * (entity-activity.ts), the route, the tab and the page all share it.
 *
 * A work item that touched an entity several times collapses to ONE row, its
 * verbs counted ("wrote 2 · read 3"). Reads and writes read differently: a row
 * whose touches are all reads is a "looked at" row.
 */
export const TOUCH_VERB_ORDER = ['created', 'wrote', 'delivered', 'proposed', 'read'] as const
export type SummaryVerb = (typeof TOUCH_VERB_ORDER)[number]
export type VerbCounts = Partial<Record<SummaryVerb, number>>

/** Tool names the writers stamp for touches no model tool made. */
const INTERNAL_TOOLS = new Set(['backfill', 'declared', 'finish', 'verdict', 'extraction'])

export interface TouchLike {
  work_item_id: string
  verb: string
  tool_name: string | null
  at: string
}

export interface TouchGroup {
  work_item_id: string
  verbs: VerbCounts
  /** Model tools that touched it, most recent first (the writers' own stamps left out). */
  tools: string[]
  last_at: string
}

const isVerb = (v: string): v is SummaryVerb => (TOUCH_VERB_ORDER as readonly string[]).includes(v)

/** Touches → one group per work item, most recently touched first. */
export function groupTouches(touches: readonly TouchLike[]): TouchGroup[] {
  const byItem = new Map<string, TouchGroup>()
  const sorted = [...touches].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
  for (const t of sorted) {
    if (!t.work_item_id || !isVerb(t.verb)) continue
    let g = byItem.get(t.work_item_id)
    if (!g) {
      g = { work_item_id: t.work_item_id, verbs: {}, tools: [], last_at: t.at }
      byItem.set(t.work_item_id, g)
    }
    g.verbs[t.verb] = (g.verbs[t.verb] ?? 0) + 1
    if (t.tool_name && !INTERNAL_TOOLS.has(t.tool_name) && !g.tools.includes(t.tool_name)) g.tools.push(t.tool_name)
  }
  return [...byItem.values()]
}

/** One more touch on a known group (the realtime patch). Returns a new group. */
export function addTouch(group: TouchGroup, t: TouchLike): TouchGroup {
  if (!isVerb(t.verb)) return group
  const verbs = { ...group.verbs, [t.verb]: (group.verbs[t.verb] ?? 0) + 1 }
  const tools =
    t.tool_name && !INTERNAL_TOOLS.has(t.tool_name) && !group.tools.includes(t.tool_name)
      ? [t.tool_name, ...group.tools]
      : group.tools
  const last_at = Date.parse(t.at) > Date.parse(group.last_at) ? t.at : group.last_at
  return { ...group, verbs, tools, last_at }
}

/** Every touch was a read: the run looked at the entity and changed nothing. */
export function isReadOnly(verbs: VerbCounts): boolean {
  return TOUCH_VERB_ORDER.every((v) => v === 'read' || !verbs[v])
}

/** "created 1 · read 3", writes first; a single touch is just its verb. */
export function summarizeVerbs(verbs: VerbCounts): string {
  const parts = TOUCH_VERB_ORDER.filter((v) => verbs[v]).map((v) => ({ v, n: verbs[v]! }))
  if (parts.length === 1 && parts[0].n === 1) return parts[0].v === 'read' ? 'looked at' : parts[0].v
  return parts.map(({ v, n }) => `${v === 'read' ? 'read' : v} ${n}`).join(' · ')
}

/** A tool name as words: "update_action" → "update action". */
export function toolLabel(tool: string): string {
  return tool.replace(/_/g, ' ')
}

// ── The Agents page's entity chips (plan 1.5: "↳ contact") ──────────────────

/** Entity kinds a chip can open (each has a detail panel in its own view). */
export const CHIP_ENTITY_TYPES = ['action', 'capture', 'contact', 'company', 'document', 'project', 'initiative'] as const
export type ChipEntityType = (typeof CHIP_ENTITY_TYPES)[number]
const isChipType = (v: string): v is ChipEntityType => (CHIP_ENTITY_TYPES as readonly string[]).includes(v)

export interface EntityTouchLike {
  work_item_id: string
  entity_type: string
  entity_id: string
  verb: string
  at: string
}

export interface EntityChip {
  entity_type: ChipEntityType
  entity_id: string
  /** It changed the entity (created, wrote, delivered, proposed), not only read it. */
  wrote: boolean
  /** Filled by the route from the entity's own row; a chip whose label cannot be read is dropped. */
  label?: string
}

/**
 * The entities a work item touched, as at most `max` chips per item: the ones
 * it changed first, then the ones it only read, most recent first within each.
 */
export function pickEntityChips(touches: readonly EntityTouchLike[], max = 3): Map<string, EntityChip[]> {
  const perItem = new Map<string, Map<string, { chip: EntityChip; at: number }>>()
  for (const t of touches) {
    if (!t.work_item_id || !isChipType(t.entity_type) || !t.entity_id) continue
    const key = `${t.entity_type}:${t.entity_id}`
    const at = Date.parse(t.at) || 0
    const wrote = t.verb !== 'read'
    let items = perItem.get(t.work_item_id)
    if (!items) perItem.set(t.work_item_id, (items = new Map()))
    const seen = items.get(key)
    if (!seen) items.set(key, { chip: { entity_type: t.entity_type, entity_id: t.entity_id, wrote }, at })
    else {
      if (wrote) seen.chip.wrote = true
      if (at > seen.at) seen.at = at
    }
  }
  const out = new Map<string, EntityChip[]>()
  for (const [itemId, items] of perItem) {
    const chips = [...items.values()]
      .sort((a, b) => Number(b.chip.wrote) - Number(a.chip.wrote) || b.at - a.at)
      .slice(0, max)
      .map((c) => c.chip)
    out.set(itemId, chips)
  }
  return out
}
