/**
 * Work trees — a delegated run's ledger row nests under the row that handed it
 * the work (plan Part 3.4; Part 5 row 14). The ledger carries the tree on every
 * row (`parent_id`, `root_id`, `depth`, written by the recorder at start); a
 * ROOT stores `root_id = NULL`, so a row's tree is `root_id ?? id`.
 *
 * Everything here is pure and works on whatever rows a surface has loaded: a
 * child whose parent is not in the list nests under its root if the root is
 * there, and is its own root otherwise (an orphan: its root aged out of the
 * feed, or another surface loaded only part of the tree).
 */
import { isWorkLive, workNeedsYou, type WorkItem, type WorkStatus } from './types'
import { WORK_ROLE_LABELS, isWorkRole } from './roles'

/** The id of the tree a row belongs to. */
export function treeRootId(item: Pick<WorkItem, 'id' | 'root_id'>): string {
  return item.root_id ?? item.id
}

/** A row that another row handed work to. */
export function isHandoff(item: Pick<WorkItem, 'parent_id' | 'origin'>): boolean {
  return !!item.parent_id || item.origin === 'delegation'
}

export interface WorkTree {
  item: WorkItem
  /** Its handoffs, oldest first, each with its own. */
  children: WorkTree[]
}

const byCreated = (a: WorkTree, b: WorkTree) => (a.item.created_at < b.item.created_at ? -1 : a.item.created_at > b.item.created_at ? 1 : 0)

/**
 * The rows as trees, in the rows' own order for the roots. A child nests under
 * its parent when the parent is loaded, else under its root, else it is a root.
 */
export function buildWorkForest(items: readonly WorkItem[]): WorkTree[] {
  const nodes = new Map<string, WorkTree>()
  for (const item of items) nodes.set(item.id, { item, children: [] })
  const roots: WorkTree[] = []
  for (const item of items) {
    const node = nodes.get(item.id)!
    const parent =
      (item.parent_id && item.parent_id !== item.id ? nodes.get(item.parent_id) : undefined) ??
      (item.root_id && item.root_id !== item.id ? nodes.get(item.root_id) : undefined)
    if (parent && !isAncestor(node, parent, nodes)) parent.children.push(node)
    else roots.push(node)
  }
  for (const node of nodes.values()) node.children.sort(byCreated)
  return roots
}

/** Guards a malformed cycle (a row that is its own ancestor) from nesting. */
function isAncestor(node: WorkTree, candidate: WorkTree, nodes: Map<string, WorkTree>): boolean {
  let cur: WorkItem | undefined = candidate.item
  const seen = new Set<string>()
  while (cur && !seen.has(cur.id)) {
    if (cur.id === node.item.id) return true
    seen.add(cur.id)
    const up: string | null | undefined = cur.parent_id ?? (cur.root_id !== cur.id ? cur.root_id : null)
    cur = up ? nodes.get(up)?.item : undefined
  }
  return false
}

/** Every row of a tree below its root, depth first. */
export function descendantsOf(tree: WorkTree): WorkItem[] {
  const out: WorkItem[] = []
  const walk = (t: WorkTree) => {
    for (const c of t.children) {
      out.push(c.item)
      walk(c)
    }
  }
  walk(tree)
  return out
}

/** Every row of a tree, root first. */
export function rowsOf(tree: WorkTree): WorkItem[] {
  return [tree.item, ...descendantsOf(tree)]
}

/**
 * Whether a child waiting on review is reviewed WITH its root rather than on
 * its own: while the root is still working or itself waits on the person, the
 * root is the unit (reviewing the root settles its handoffs too). Once the
 * root settled some other way (done, failed, stopped), the child's own output
 * is the thing to review, so it stands alone. Only known roots fold: a surface
 * that did not load the root shows the child on its own.
 */
export function foldsIntoRoot(
  item: Pick<WorkItem, 'id' | 'root_id' | 'status'>,
  rootStatus: (rootId: string) => WorkStatus | string | null | undefined,
): boolean {
  if (item.status !== 'needs_review') return false
  const rootId = item.root_id
  if (!rootId || rootId === item.id) return false
  const status = rootStatus(rootId)
  if (!status) return false
  return isWorkLive(status) || workNeedsYou(status)
}

/** A lookup of the statuses a surface knows, for `foldsIntoRoot`. */
export function statusLookup(items: readonly Pick<WorkItem, 'id' | 'status'>[]): (id: string) => string | undefined {
  const map = new Map(items.map((i) => [i.id, i.status as string]))
  return (id) => map.get(id)
}

/**
 * The one line a settled root shows for its subtree: "1 handoff",
 * "2 handoffs · 1 refused", "Handed to Researcher". Null for a row with none.
 */
export function subtreeSummary(tree: WorkTree): string | null {
  const below = descendantsOf(tree)
  if (below.length === 0) return null
  const refused = below.filter((c) => c.status === 'skipped').length
  const ran = below.length - refused
  if (ran === 1 && refused === 0) {
    const only = below[0]
    const role = only.teammate?.role
    if (role && isWorkRole(role)) return `Handed to ${WORK_ROLE_LABELS[role]}`
  }
  const parts: string[] = []
  if (ran > 0) parts.push(`${ran} ${ran === 1 ? 'handoff' : 'handoffs'}`)
  if (refused > 0) parts.push(`${refused} refused`)
  return parts.join(' · ')
}
