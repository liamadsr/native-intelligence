/**
 * Which `recipe` rows a member may SEE, for code that reads them on the
 * SERVICE client.
 *
 * The chat, skill-run and work-run tool routes (/api/internal/{chat,skill-run,
 * work-run}/tool) and the MCP server all run their tools on the service role,
 * so the `recipe_select_visibility` RLS policy (migration 079) never fires for
 * them. A query scoped only to "system rows ∪ this workspace" then carries every
 * member's PERSONAL skills and agents: their names and descriptions in a list,
 * their prompts in a get.
 *
 * The rule here is that policy intersected with the invocable surface
 * (is_system ∪ this workspace), the same one `rebuildChatSkills`
 * (src/lib/chat/chat-run-rebuild.ts) applies. A row is visible iff:
 *   • is_system, OR
 *   • it belongs to THIS workspace AND
 *       – visibility 'workspace' or 'public' (any member), or
 *       – visibility 'personal' AND created_by = the caller.
 * Another workspace's public rows are Discover's, not this surface's.
 *
 * Feature-gated system rows are a separate fence (./feature-gate.ts): callers
 * apply both.
 */

/** The rule as one PostgREST `or` group, for `.or(...)` on a `recipe` query. */
export function visibleRecipesFilter(workspaceId: string, userId: string): string {
  return [
    'is_system.eq.true',
    `and(workspace_id.eq.${workspaceId},visibility.in.(workspace,public))`,
    `and(workspace_id.eq.${workspaceId},visibility.eq.personal,created_by.eq.${userId})`,
  ].join(',')
}

/**
 * The same rule for a row already in hand. Fails closed on a missing row, and
 * on a row read without its `visibility` / `created_by` columns.
 */
export function isRecipeVisibleTo(
  row:
    | {
        is_system?: boolean | null
        workspace_id?: string | null
        visibility?: string | null
        created_by?: string | null
      }
    | null
    | undefined,
  workspaceId: string,
  userId: string,
): boolean {
  if (!row) return false
  if (row.is_system === true) return true
  if (row.workspace_id !== workspaceId) return false
  if (row.visibility === 'workspace' || row.visibility === 'public') return true
  return row.visibility === 'personal' && row.created_by === userId
}
