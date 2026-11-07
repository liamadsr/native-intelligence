/**
 * The entity tab's read (plan Part 2.1): every agent interaction with one
 * action, capture, project, contact (row 10), document, company, initiative or
 * email thread (row 12), one row per work item, newest first.
 *
 * Both reads run on the caller's SESSION client, so RLS is the fence:
 *   - `work_touch` is readable by any workspace member (migration 280), so the
 *     touches of every member's runs come back;
 *   - `tracked_job` SELECT is still owner-only (migration 170; row 7 kept it,
 *     with the query written so widening is a policy flip). A touch whose work
 *     item the caller cannot read is counted in `hidden`, never shown: the tab
 *     names only the caller's own runs until the ledger's SELECT widens, and
 *     then the same code names everyone's.
 *
 * An action's own runs count too (its coding runs and the work runs tracking
 * it, by `agent_run.action_id`, indexed): coding runs write no touches, so
 * without this an action's tab would miss the runs that worked on it. Such a
 * run with no touch on the action reads as "wrote".
 *
 * An email thread's drafts count too: before row 12 a drafting run touched only
 * the `email_draft` rows it delivered, never the thread (whose id in the tools
 * is the provider's, not a uuid; touch.ts now resolves it), so the thread's
 * tab also reads the touches on its drafts.
 *
 * The pending cards about the entity are not here: the tab takes them from the
 * attention hook (the rail's own data and channel), filtered by the card's
 * entity (card-entity.ts), so a card resolved on the rail leaves the tab too.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { WORK_ITEM_SELECT } from './queries'
import { groupTouches, type TouchGroup, type TouchLike } from './touch-summary'
import type { WorkItem } from './types'

/** The entity kinds the tab is offered on (plan 2.4: pages 1–3 in row 10, 4–6 in row 12). */
export const ENTITY_ACTIVITY_TYPES = [
  'action',
  'capture',
  'project',
  'contact',
  'document',
  'company',
  'initiative',
  'email_thread',
] as const
export type EntityActivityType = (typeof ENTITY_ACTIVITY_TYPES)[number]
export const isEntityActivityType = (v: unknown): v is EntityActivityType =>
  typeof v === 'string' && (ENTITY_ACTIVITY_TYPES as readonly string[]).includes(v)

/** How far back the tab reads: the most recent touches, then grouped. */
const TOUCH_LIMIT = 500
/** An email thread's drafts read for their touches (newest first). */
const THREAD_DRAFT_LIMIT = 50
export const ENTITY_ACTIVITY_ROWS = 50

export interface EntityActivityRow extends TouchGroup {
  work_item: WorkItem
  /** The tree's root when this item is a handoff (row 14): the tab groups a
   *  handoff's touches under the title of the work it was part of. */
  root?: { id: string; title: string } | null
}

export interface EntityActivity {
  rows: EntityActivityRow[]
  /** Work items that touched the entity but that the caller cannot read (another member's). */
  hidden: number
}

export async function loadEntityActivity(
  supabase: SupabaseClient,
  args: { workspaceId: string; entityType: EntityActivityType; entityId: string },
): Promise<EntityActivity | { error: string }> {
  const { data: touches, error } = await supabase
    .from('work_touch')
    .select('work_item_id, agent_run_id, verb, tool_name, at')
    .eq('workspace_id', args.workspaceId)
    .eq('entity_type', args.entityType)
    .eq('entity_id', args.entityId)
    .order('at', { ascending: false })
    .limit(TOUCH_LIMIT)
  if (error) return { error: error.message }

  const touchRows = [...((touches ?? []) as Array<TouchLike & { agent_run_id: string | null }>)]
  if (args.entityType === 'email_thread') {
    const drafted = await draftTouches(supabase, args.workspaceId, args.entityId)
    if ('error' in drafted) return drafted
    // A run that touched the thread itself already says what it did here; its
    // draft touches would count the same delivery twice.
    const direct = new Set(touchRows.map((t) => t.work_item_id))
    touchRows.push(...drafted.touches.filter((t) => !direct.has(t.work_item_id)))
    touchRows.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
  }
  const groups = groupTouches(touchRows)

  // An action's own runs (see above): agent_run is member-readable, its
  // ledger row owner-only, like any other.
  let runIds: string[] = []
  if (args.entityType === 'action') {
    const { data: runs, error: runsErr } = await supabase
      .from('agent_run')
      .select('id')
      .eq('workspace_id', args.workspaceId)
      .eq('action_id', args.entityId)
      .order('created_at', { ascending: false })
      .limit(ENTITY_ACTIVITY_ROWS)
    if (runsErr) return { error: runsErr.message }
    runIds = ((runs ?? []) as Array<{ id: string }>).map((r) => r.id)
  }
  if (groups.length === 0 && runIds.length === 0) return { rows: [], hidden: 0 }

  const items: WorkItem[] = []
  if (groups.length > 0) {
    const { data, error: itemsErr } = await supabase
      .from('tracked_job')
      .select(WORK_ITEM_SELECT)
      .eq('workspace_id', args.workspaceId)
      .in('id', groups.map((g) => g.work_item_id))
    if (itemsErr) return { error: itemsErr.message }
    items.push(...((data ?? []) as WorkItem[]))
  }
  if (runIds.length > 0) {
    const { data, error: runItemsErr } = await supabase
      .from('tracked_job')
      .select(WORK_ITEM_SELECT)
      .eq('workspace_id', args.workspaceId)
      .in('agent_run_id', runIds)
    if (runItemsErr) return { error: runItemsErr.message }
    items.push(...((data ?? []) as WorkItem[]))
  }
  const byId = new Map(items.map((it) => [it.id, it]))

  const rows: EntityActivityRow[] = []
  const hiddenItems = new Set<string>()
  const hiddenRuns = new Set<string>()
  for (const g of groups) {
    const work_item = byId.get(g.work_item_id)
    if (work_item) rows.push({ ...g, work_item })
    else {
      hiddenItems.add(g.work_item_id)
      for (const t of touchRows) if (t.work_item_id === g.work_item_id && t.agent_run_id) hiddenRuns.add(t.agent_run_id)
    }
  }
  const listed = new Set(rows.map((r) => r.work_item_id))
  const readableRuns = new Set(items.map((it) => it.agent_run_id).filter((id): id is string => !!id))
  for (const it of items) {
    if (listed.has(it.id) || !it.agent_run_id || !runIds.includes(it.agent_run_id)) continue
    rows.push({
      work_item_id: it.id,
      verbs: { wrote: 1 },
      tools: [],
      last_at: it.last_beat_at ?? it.started_at ?? it.created_at,
      work_item: it,
    })
    listed.add(it.id)
  }
  // Runs on the action whose ledger row the caller cannot read, not already counted.
  const hiddenRunsOnly = runIds.filter((id) => !readableRuns.has(id) && !hiddenRuns.has(id)).length

  rows.sort((a, b) => Date.parse(b.last_at) - Date.parse(a.last_at))
  const shown = rows.slice(0, ENTITY_ACTIVITY_ROWS)

  // A handoff's root, for its group header (row 14). A root the caller cannot
  // read (another member's) leaves the handoff ungrouped.
  const rootIds = Array.from(
    new Set(shown.map((r) => r.work_item.root_id).filter((id): id is string => !!id && !byId.has(id))),
  )
  const titles = new Map<string, string>(items.map((it) => [it.id, it.title]))
  if (rootIds.length > 0) {
    const { data: roots } = await supabase
      .from('tracked_job')
      .select('id, title')
      .eq('workspace_id', args.workspaceId)
      .in('id', rootIds)
    for (const r of (roots ?? []) as Array<{ id: string; title: string }>) titles.set(r.id, r.title)
  }
  for (const r of shown) {
    const rootId = r.work_item.root_id
    const title = rootId ? titles.get(rootId) : undefined
    r.root = rootId && title !== undefined ? { id: rootId, title } : null
  }
  return { rows: shown, hidden: hiddenItems.size + hiddenRunsOnly }
}

/** One group of the tab: a tree's rows under its root's title, or a lone row. */
export interface EntityActivityGroup {
  /** Set when the group holds a handoff: the work it was part of. */
  root: { id: string; title: string } | null
  rows: EntityActivityRow[]
}

/**
 * The tab's rows grouped by tree (row 14): every handoff with its root's other
 * rows under the root's title, newest group first; a row with no handoffs
 * around it stays a group of its own with no header.
 */
export function groupEntityActivity(rows: readonly EntityActivityRow[]): EntityActivityGroup[] {
  const groups = new Map<string, EntityActivityGroup>()
  for (const row of rows) {
    const key = row.root?.id ?? row.work_item.root_id ?? row.work_item.id
    let group = groups.get(key)
    if (!group) {
      group = { root: null, rows: [] }
      groups.set(key, group)
    }
    group.rows.push(row)
    if (row.root) group.root = row.root
  }
  const out = Array.from(groups.values())
  for (const g of out) {
    g.rows.sort((a, b) => Date.parse(b.last_at) - Date.parse(a.last_at))
    // The root touched this entity itself: its own row names the group.
    if (!g.root && g.rows.length > 1) {
      const own = g.rows.find((r) => !r.work_item.root_id)
      if (own) g.root = { id: own.work_item.id, title: own.work_item.title }
    }
  }
  const latest = (g: EntityActivityGroup) => Math.max(...g.rows.map((r) => Date.parse(r.last_at)))
  return out.sort((a, b) => latest(b) - latest(a))
}

/** The touches on an email thread's drafts (see the header). */
async function draftTouches(
  supabase: SupabaseClient,
  workspaceId: string,
  threadId: string,
): Promise<{ touches: Array<TouchLike & { agent_run_id: string | null }> } | { error: string }> {
  const { data: drafts, error } = await supabase
    .from('email_draft')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('email_thread_id', threadId)
    .order('created_at', { ascending: false })
    .limit(THREAD_DRAFT_LIMIT)
  if (error) return { error: error.message }
  const ids = ((drafts ?? []) as Array<{ id: string }>).map((d) => d.id)
  if (ids.length === 0) return { touches: [] }
  const { data, error: touchErr } = await supabase
    .from('work_touch')
    .select('work_item_id, agent_run_id, verb, tool_name, at')
    .eq('workspace_id', workspaceId)
    .eq('entity_type', 'email_draft')
    .in('entity_id', ids)
    .order('at', { ascending: false })
    .limit(TOUCH_LIMIT)
  if (touchErr) return { error: touchErr.message }
  return { touches: (data ?? []) as Array<TouchLike & { agent_run_id: string | null }> }
}
