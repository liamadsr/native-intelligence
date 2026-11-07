/**
 * WHICH WORKSPACE A ROW BELONGS TO — and what that means for requests made
 * about it.
 *
 * With "Show all workspaces" on (ViewConfig.workspace_scope === 'all') a list mixes
 * rows from every workspace the user is a member of. Two things then stop being
 * true for the rows that aren't from the active one: they need a badge to say
 * where they came from (workspace-badge.tsx), and every request ABOUT them has
 * to name their workspace, or it resolves against the active one and 404s.
 *
 * Kept as a plain module rather than living beside the badge component so the
 * non-React callers — the mutation paths in unified-view-layout, the bulk hook,
 * the hover prefetch — can use it without pulling a component in.
 */

import { DISPLAY_PROPERTIES } from '@/lib/views/types'
import type { EditablePickerKind, ViewEntityType } from '@/lib/views/types'

/**
 * The workspace a row belongs to, as the views query embeds it on every ACTION
 * row (`workspace:workspace!workspace_id(id, name, slug, logo_url)` — see
 * ACTION_VIEW_SELECT). Present in BOTH workspace scopes, so a row never has to
 * know which scope produced the list it is in.
 */
export interface RowWorkspace {
  id: string
  name: string
  slug?: string | null
  logo_url?: string | null
}

/**
 * Read the embedded workspace off a row, or null when the row doesn't carry
 * one. Defensive rather than typed-through: only actions are selected with the
 * embed today, a row can arrive from a cached page fetched before it shipped,
 * and a supabase embed is `null` (not absent) when the FK is null.
 */
export function rowWorkspace(item: Record<string, unknown> | undefined | null): RowWorkspace | null {
  const ws = item?.workspace
  if (!ws || typeof ws !== 'object' || Array.isArray(ws)) return null
  const { id, name } = ws as Record<string, unknown>
  if (typeof id !== 'string' || !id) return null
  return {
    id,
    name: typeof name === 'string' && name ? name : 'Workspace',
    slug: typeof (ws as RowWorkspace).slug === 'string' ? (ws as RowWorkspace).slug : null,
    logo_url: typeof (ws as RowWorkspace).logo_url === 'string' ? (ws as RowWorkspace).logo_url : null,
  }
}

/**
 * Is this row from somewhere other than the workspace the user is in?
 *
 * `activeWorkspaceId === null` (the cache hasn't loaded, or there is no
 * provider at all) answers NO: an unknown active workspace makes every row look
 * foreign, and a list that momentarily badges all of its own rows — or, worse,
 * starts naming a workspace on requests it has no reason to — reads as a bug.
 * The default path is the safe one to fall back to.
 */
export function isForeignWorkspace(
  workspace: RowWorkspace | null,
  activeWorkspaceId: string | null,
): boolean {
  return !!workspace && !!activeWorkspaceId && workspace.id !== activeWorkspaceId
}

/**
 * The header a request ABOUT this row must carry, spread into the call site's
 * own headers:
 *
 *     headers: { 'Content-Type': 'application/json', ...rowWorkspaceHeaders(row, activeId) }
 *
 * Empty for a row in the active workspace — which is every row in the default
 * scope — so the overwhelmingly common request goes out byte-for-byte as it
 * always has.
 *
 * For a foreign row it names that row's workspace. The fetch interceptor
 * (`lib/workspace-fetch.ts`) fills `x-workspace-id` in only when the CALLER
 * hasn't, so naming it here wins; and every account route resolves the
 * workspace through the same header → cookie → oldest-membership chain and
 * re-verifies membership, so this widens nothing: it says WHICH of the user's
 * workspaces to act in, not whether they may. Exactly the override the
 * attention rail uses to act on a card raised in another workspace.
 */
export function rowWorkspaceHeaders(
  item: Record<string, unknown> | undefined | null,
  activeWorkspaceId: string | null,
): Record<string, string> {
  const ws = rowWorkspace(item)
  if (!isForeignWorkspace(ws, activeWorkspaceId)) return {}
  return { 'x-workspace-id': ws!.id }
}

/**
 * Pickers whose options are ROWS OF A WORKSPACE-SCOPED TABLE — a status, a
 * member, a project, an initiative, a company, a label. Everything else
 * ('priority', 'date', 'enum', 'boolean', 'text') is a literal value that means
 * the same thing in any workspace.
 */
const WORKSPACE_SCOPED_PICKERS: ReadonlySet<EditablePickerKind> = new Set([
  'status', 'member', 'project', 'initiative', 'company', 'label',
])

/**
 * May this property be edited inline on a row from ANOTHER workspace?
 *
 * Only for values that don't come out of a workspace-scoped table. The inline
 * pickers are fed by `usePickerContext`, which loads ONE workspace's lookups —
 * the active one. Before the workspace header existed, choosing this
 * workspace's project for a foreign action produced a PATCH that 404'd and
 * rolled back: wrong, but harmless. Now that the PATCH reaches the row's own
 * workspace, the same gesture would send it a `project_id` from a DIFFERENT
 * workspace — a write the route may or may not reject, and a dangling
 * cross-workspace reference if it doesn't.
 *
 * So the lookup-valued cells go read-only on foreign rows until the pickers can
 * offer the RIGHT workspace's options, and the fields that are just values
 * (priority, due date) stay editable — which is most of what a user reaches for
 * in a list. A WHITELIST by picker kind, deliberately: a property added later
 * is non-editable across workspaces until someone decides otherwise, rather
 * than silently writing a foreign id.
 */
export function isCrossWorkspaceEditable(entityType: ViewEntityType, property: string): boolean {
  const descriptor = DISPLAY_PROPERTIES[entityType]?.find((p) => p.field === property)?.editable
  if (!descriptor) return false
  return !WORKSPACE_SCOPED_PICKERS.has(descriptor.picker)
}
