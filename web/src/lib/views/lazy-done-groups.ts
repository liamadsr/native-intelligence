/**
 * Finished groups, loaded only when opened.
 *
 * An action list grouped by status (a grouped list, and every board, which
 * always groups by status) used to fetch every row of every group, up to 500
 * a page. On a workspace with a long history most of those were Done or
 * Canceled, and each also paid for its embeds and the sub-action lookup.
 *
 * Now the views route (api/account/views/query) leaves the completed and
 * canceled groups' rows out of that page and sends each such group with its
 * COUNT only (`metadata.lazy`, `metadata.count`). Its rows come, a page at a
 * time, when the person opens it: a list shows the group collapsed at the
 * bottom ("Done · 312") and loads it on expand; a board loads a column's first
 * page when the column scrolls into view and more as it is scrolled
 * (view-board.tsx).
 *
 * The count is the same query as the rows (filters, scope, team, search, the
 * completed window), narrowed to the group's states and counted, so the
 * number and the rows can never disagree about what the view holds. A group's
 * page is the same query again, narrowed the same way (`status_ids` on the
 * request), so its rows are exactly the ones the count counted.
 *
 * Not lazy: a list with a sub-grouping (the finished rows would have to be
 * sub-grouped on the client), and any grouping other than status (there the
 * finished rows are spread over every group, and the completed window is what
 * keeps them few).
 */

/** Rows per page of a finished group. */
export const LAZY_GROUP_PAGE_SIZE = 50

/** The most state ids a group's page may name (a category column merges every team's). */
export const MAX_GROUP_STATUS_IDS = 200

export interface DoneState {
  id: string
  name: string
  category: string
  sort_order?: number | null
  team_id: string
}

export interface LazyGroupPlan {
  key: string
  label: string
  /** Every member state, in scope: what the count and the group's pages are narrowed to. */
  statusIds: string[]
  /** team id → that team's (first) state in the group: where a card dropped here goes. */
  statusIdByTeam: Record<string, string>
}

/** The metadata a lazy group carries (GroupedResults.metadata). */
export interface LazyGroupMetadata {
  lazy: true
  /** How many rows the group holds, on the server, under the view's filters. */
  count: number
  status_ids: string[]
  status_id: string
  status_id_by_team: Record<string, string>
}

/**
 * The finished groups a status grouping makes of these states, keyed as
 * groupResults keys them: by category alone on a cross-team board, by
 * `category::name` otherwise.
 */
export function planLazyDoneGroups(
  states: readonly DoneState[],
  crossTeam: boolean,
  categoryLabels: Record<string, string>,
): LazyGroupPlan[] {
  const sorted = [...states].sort((a, b) =>
    a.category.localeCompare(b.category)
    || (a.sort_order ?? 0) - (b.sort_order ?? 0)
    || a.id.localeCompare(b.id),
  )
  const byKey = new Map<string, LazyGroupPlan>()
  for (const s of sorted) {
    const key = crossTeam ? s.category : `${s.category}::${s.name}`
    let plan = byKey.get(key)
    if (!plan) {
      plan = { key, label: crossTeam ? categoryLabels[s.category] ?? s.category : s.name, statusIds: [], statusIdByTeam: {} }
      byKey.set(key, plan)
    }
    plan.statusIds.push(s.id)
    if (!plan.statusIdByTeam[s.team_id]) plan.statusIdByTeam[s.team_id] = s.id
  }
  return [...byKey.values()]
}

export function lazyMetadata(plan: LazyGroupPlan, count: number): LazyGroupMetadata {
  return {
    lazy: true,
    count,
    status_ids: plan.statusIds,
    status_id: plan.statusIds[0],
    status_id_by_team: plan.statusIdByTeam,
  }
}

/** A finished group's loading, as the list and board read it (useViewResults' lazyGroupState). */
export interface GroupLoadState { loading: boolean; hasMore: boolean; loaded: boolean }

/** Is this group's row set loaded only when opened? */
export function isLazyGroup(group: { metadata?: Record<string, unknown> } | null | undefined): boolean {
  return group?.metadata?.lazy === true
}

/** The count a group's header shows: the server's count for a lazy group, else its rows. */
export function groupCount(group: { items?: unknown[]; metadata?: Record<string, unknown> }): number {
  if (isLazyGroup(group) && typeof group.metadata?.count === 'number') return group.metadata.count
  return group.items?.length ?? 0
}

/**
 * Should a request ask for lazy finished groups? Actions grouped by status,
 * and no sub-grouping (a board never sends one).
 */
export function wantsLazyDoneGroups(body: {
  entity_type: string
  grouping?: { field?: string } | null
  sub_grouping?: { field?: string } | null
}): boolean {
  return body.entity_type === 'action' && body.grouping?.field === 'status_id' && !body.sub_grouping?.field
}

// ── Client-side merging ──────────────────────────────────────────────────────

type Row = Record<string, unknown>
interface Group { key: string; label: string; items: Row[]; subGroups?: Group[]; metadata?: Record<string, unknown> }

/** Ids of every row in a non-lazy group: an open action is never also shown as finished. */
function openIds(groups: readonly Group[]): Set<unknown> {
  const ids = new Set<unknown>()
  for (const g of groups) if (!isLazyGroup(g)) for (const it of g.items ?? []) ids.add(it.id)
  return ids
}

function dedupe(rows: readonly Row[], exclude: Set<unknown>): Row[] {
  const seen = new Set<unknown>()
  const out: Row[] = []
  for (const r of rows) {
    if (exclude.has(r.id) || seen.has(r.id)) continue
    seen.add(r.id)
    out.push(r)
  }
  return out
}

/**
 * A fresh page (a refetch) over the rows already open in the finished groups:
 * a refetch sends those groups without rows, and dropping what the person had
 * open would collapse it under them. The rows are kept until the group's own
 * reload replaces them, less any row the fresh page now has in an open group
 * (it was reopened).
 */
export function carryLazyItems<G extends Group>(prev: readonly G[], next: readonly G[]): G[] {
  const open = openIds(next)
  const prevByKey = new Map(prev.map(g => [g.key, g]))
  return next.map(g => {
    if (!isLazyGroup(g)) return g
    const before = prevByKey.get(g.key)
    if (!before?.items?.length) return g
    return { ...g, items: dedupe([...(g.items ?? []), ...before.items], open) }
  })
}

/**
 * A finished group's page into the groups: appended (`replace: false`, the
 * next page) or in place of what it held (`replace: true`, a reload). Never a
 * row an open group holds, never one twice.
 */
export function mergeGroupPage<G extends Group>(groups: readonly G[], key: string, rows: readonly Row[], { replace }: { replace: boolean }): G[] {
  const open = openIds(groups)
  return groups.map(g => {
    if (g.key !== key) return g
    const base = replace ? [] : g.items ?? []
    return { ...g, items: dedupe([...base, ...rows], open) }
  })
}

/** A lazy group's count moved by `delta` (a card dragged in or out, a row removed). */
export function withCountDelta<G extends Group>(group: G, delta: number): G {
  if (!isLazyGroup(group) || typeof group.metadata?.count !== 'number') return group
  return { ...group, metadata: { ...group.metadata, count: Math.max(0, group.metadata.count + delta) } }
}
