/**
 * Pure filtering / dedupe / scope logic for the Agents & Skills page.
 *
 * Extracted out of the React component so the tricky parts — the Discover
 * dedupe (which fixed a real "feels like duplicates" bug) and the scope
 * predicates — are unit-testable in isolation and can't silently regress when
 * the view is refactored. Nothing here touches React, fetch, or the DOM.
 */

import type { LibraryRow, LibraryScope, LibraryCategory } from './library-types'
import { isUnsetFilterValue, type ViewFilter, type SortConfig } from '@/lib/views/types'

/**
 * The three raw lists the page fetches, plus the identity of the current user's
 * created items. `mine`/`workspace` come from the account endpoints; `discover`
 * is the public marketplace catalog.
 */
export interface LibrarySources {
  discover: LibraryRow[]
  workspace: LibraryRow[]
  mine: LibraryRow[]
}

/**
 * Set of workspace row ids — items already installed in this workspace
 * (built-ins + prior forks + workspace-visible items). Used to hide Discover
 * entries that would otherwise read as duplicates of what's already here.
 */
export function workspaceIdSet(workspace: LibraryRow[]): Set<string> {
  return new Set(workspace.map((r) => r.id))
}

/**
 * Set of ORIGINAL ids that have been forked into this workspace. A forked item
 * lives under a NEW row id, so an id-match against the workspace list alone
 * misses it — we also subtract the public template the user already forked so a
 * forked skill doesn't reappear in Discover as if it were unclaimed.
 */
export function forkedFromSet(workspace: LibraryRow[]): Set<string> {
  return new Set(
    workspace.map((r) => r.forked_from).filter((x): x is string => !!x),
  )
}

/** Set of row ids the current user created (per the account `?mine=true` list). */
export function myIdSet(mine: LibraryRow[]): Set<string> {
  return new Set(mine.map((r) => r.id))
}

/**
 * The "All" scope: everything usable in this workspace — built-ins + workspace
 * items + the user's personal items — deduped by row id. Workspace and Mine
 * overlap heavily (a workspace-visible item the user created appears in both),
 * so we merge and dedupe rather than concatenate. Order is stable: workspace
 * first, then any personal-only items Mine adds on top.
 */
export function dedupeAll(workspace: LibraryRow[], mine: LibraryRow[]): LibraryRow[] {
  const seen = new Set<string>()
  const out: LibraryRow[] = []
  for (const r of [...workspace, ...mine]) {
    if (seen.has(r.id)) continue
    seen.add(r.id)
    out.push(r)
  }
  return out
}

/**
 * Discover dedupe — the careful one. Show a public item UNLESS it's already
 * represented in this workspace, WITH one deliberate exception: the user's own
 * published items always show, so publishing your own agent/skill and then not
 * seeing it in Discover never makes the page look broken.
 *
 * Concretely, hide an item when it's a system/installed item (id in the
 * workspace set) or one the user previously forked from someone else
 * (forked_from set) — the "no duplicates" case — but never hide the user's own
 * listings.
 */
export function filterDiscover(
  discover: LibraryRow[],
  wsIds: Set<string>,
  forkedIds: Set<string>,
  myIds: Set<string>,
): LibraryRow[] {
  return discover.filter((r) => {
    if (myIds.has(r.id)) return true // always show own published items
    return !wsIds.has(r.id) && !forkedIds.has(r.id)
  })
}

/**
 * Resolve the base list for a scope. Discover applies its dedupe; All merges
 * workspace + mine; Mine and Workspace pass through their raw lists.
 */
export function itemsForScope(scope: LibraryScope, sources: LibrarySources): LibraryRow[] {
  const { discover, workspace, mine } = sources
  switch (scope) {
    case 'discover':
      return filterDiscover(
        discover,
        workspaceIdSet(workspace),
        forkedFromSet(workspace),
        myIdSet(mine),
      )
    case 'mine':
      return mine
    case 'workspace':
      return workspace
    case 'all':
    default:
      return dedupeAll(workspace, mine)
  }
}

/** Keep only rows of the active type (agent | skill). */
export function filterByType(rows: LibraryRow[], category: LibraryCategory): LibraryRow[] {
  return rows.filter((r) => r.category === category)
}

/**
 * Case-insensitive substring match over name, description, and slug. Slug is
 * included so a user who thinks in `/plan-week` finds the skill by its command.
 * An empty/whitespace query matches everything.
 */
export function matchesSearch(row: LibraryRow, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return (
    row.name.toLowerCase().includes(q) ||
    (!!row.description && row.description.toLowerCase().includes(q)) ||
    (!!row.slug && row.slug.toLowerCase().includes(q))
  )
}

/** Apply a search query to a list of rows. */
export function filterBySearch(rows: LibraryRow[], query: string): LibraryRow[] {
  return rows.filter((r) => matchesSearch(r, query))
}

/**
 * The full pipeline the view renders: pick the scope's base list, narrow to the
 * active type, then apply the search query. One entry point so the component
 * stays declarative and the whole chain is testable end-to-end.
 */
export function selectDisplayedItems(
  sources: LibrarySources,
  scope: LibraryScope,
  category: LibraryCategory,
  query: string,
): LibraryRow[] {
  const scoped = itemsForScope(scope, sources)
  const typed = filterByType(scoped, category)
  return filterBySearch(typed, query)
}

/** A saved view keeps Collection explicit, so a view made in Discover still
 * uses the catalog's dedupe and Add flow when reopened. */
export function libraryScopeForFilters(filters: ViewFilter[]): LibraryScope {
  const filter = filters.find(f => f.field === 'library_scope' && f.operator === 'is')
  return isLibraryScope(filter?.value) ? filter.value : 'all'
}

function isLibraryScope(value: unknown): value is LibraryScope {
  return value === 'all' || value === 'mine' || value === 'workspace' || value === 'discover'
}

/** Apply shared view filters to the existing, already-authorized source lists.
 * The collection predicates remain itemsForScope's, including fork dedupe. */
export function selectLibraryViewItems(
  sources: LibrarySources,
  category: LibraryCategory,
  query: string,
  filters: ViewFilter[],
  ordering: SortConfig[],
): LibraryRow[] {
  const collections = new Map<LibraryScope, Set<string>>(
    (['all', 'mine', 'workspace', 'discover'] as const).map(scope =>
      [scope, new Set(itemsForScope(scope, sources).map(row => row.id))],
    ),
  )
  const scopeFilters = filters.filter(f => f.field === 'library_scope' && !isUnsetFilterValue(f.value))
  // Preserve each endpoint's order for the four defaults, including Mine.
  const firstScope = scopeFilters[0]
  const base = firstScope?.operator === 'is' && isLibraryScope(firstScope.value)
    ? itemsForScope(firstScope.value, sources)
    : scopeFilters.length
      ? dedupeAll(itemsForScope('all', sources), itemsForScope('discover', sources))
      : itemsForScope('all', sources)

  const rows = filterBySearch(filterByType(base, category), query).filter(row => filters.every(filter => {
    const { field, operator, value } = filter
    if (!['is_empty', 'is_not_empty'].includes(operator) && isUnsetFilterValue(value)) return true
    const values = Array.isArray(value) ? value : [value]
    if (field === 'library_scope') {
      const matches = values.some(scope => isLibraryScope(scope) && collections.get(scope)?.has(row.id))
      return operator === 'is_not' || operator === 'is_none_of' ? !matches : matches
    }
    if (!['name', 'description', 'slug', 'visibility', 'is_system'].includes(field)) return true
    const raw = row[field as 'name' | 'description' | 'slug' | 'visibility' | 'is_system']
    const text = String(raw ?? '').toLowerCase()
    const target = String(value).toLowerCase()
    const equal = values.some(v => typeof raw === 'boolean' ? raw === v : text === String(v).toLowerCase())
    switch (operator) {
      case 'is': case 'is_any_of': return equal
      case 'is_not': case 'is_none_of': return !equal
      case 'contains': return text.includes(target)
      case 'does_not_contain': return !text.includes(target)
      case 'starts_with': return text.startsWith(target)
      case 'ends_with': return text.endsWith(target)
      case 'is_empty': return raw == null || raw === ''
      case 'is_not_empty': return raw != null && raw !== ''
      default: return true
    }
  }))
  if (!ordering.length) return rows
  return rows.sort((a, b) => {
    for (const { field, direction } of ordering) {
      if (!['name', 'description', 'slug', 'visibility', 'is_system'].includes(field)) continue
      const key = field as 'name' | 'description' | 'slug' | 'visibility' | 'is_system'
      const result = String(a[key] ?? '').localeCompare(String(b[key] ?? ''), undefined, { numeric: true, sensitivity: 'base' })
      if (result) return direction === 'asc' ? result : -result
    }
    return 0
  })
}
