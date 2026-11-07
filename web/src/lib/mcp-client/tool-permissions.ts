/**
 * A connected MCP server's Tool permissions, as Settings › Connectors shows
 * them (mcp-connector-view.tsx), in Claude's words and grouping:
 *
 *   Always allow    runs without asking        (tool-access.ts 'read_only')
 *   Needs approval  each call waits for a card ('ask')
 *   Blocked         the agent can't see it     ('off', and a 'new' tool not added yet)
 *
 * Tools are grouped Read-only / Write & delete by the approval policy's own
 * read-only test for this server (approval-policy.ts isReadOnlyForServer), and
 * a group can be set at once. Every write goes through withToolAccess, the
 * same lists the agent's set_tool_access writes, so the page, the agent and
 * the outward gate always agree. A catalog app's always-ask tool can't be set
 * to Always allow (catalogAlwaysAsks): a group set skips it.
 *
 * Pure, no server imports: safe in client code.
 */
import {
  catalogAlwaysAsks,
  isReadOnlyForServer,
  type McpServerApprovalLists,
  type McpToolForPolicy,
} from './approval-policy'
import {
  asksByDefault,
  mcpToolState,
  withToolAccess,
  type McpAccessLists,
  type McpAccessUpdate,
  type McpToolAccess,
} from './tool-access'

export type ToolPermission = 'allow' | 'ask' | 'blocked'

export const TOOL_PERMISSIONS: readonly { id: ToolPermission; label: string; access: McpToolAccess }[] = [
  { id: 'allow', label: 'Always allow', access: 'read_only' },
  { id: 'ask', label: 'Needs approval', access: 'ask' },
  { id: 'blocked', label: 'Blocked', access: 'off' },
]

const ACCESS: Record<ToolPermission, McpToolAccess> = { allow: 'read_only', ask: 'ask', blocked: 'off' }

/**
 * A tool's name as a person reads it (Claude's "Get draft email"): the
 * server's own title, else the name split at underscores, dashes and
 * camelCase, first letter up (get_draft_email, getDraftEmail → Get draft email).
 */
export function toolDisplayName(tool: { name: string; annotations?: { title?: string } | null }): string {
  const title = tool.annotations?.title?.trim()
  if (title) return title
  const words = tool.name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_\-.]+/)
    .filter(Boolean)
    .map((w) => (w === w.toUpperCase() && w.length > 1 ? w : w.toLowerCase()))
  if (words.length === 0) return tool.name
  const sentence = words.join(' ')
  return sentence.charAt(0).toUpperCase() + sentence.slice(1)
}

/** The server lists these rules read. */
export type McpPermissionLists = McpAccessLists & McpServerApprovalLists

/** One tool's permission now. A new tool (not added yet) is Blocked: the agent can't see it. */
export function toolPermission(tool: McpToolForPolicy, server: McpPermissionLists): ToolPermission {
  const state = mcpToolState(tool, server)
  if (state === 'read_only') return 'allow'
  if (state === 'ask') return 'ask'
  return 'blocked'
}

/** False for a catalog app's tool that always asks, whatever anyone chose. */
export function canAlwaysAllow(tool: McpToolForPolicy, server: Pick<McpServerApprovalLists, 'server_url'>): boolean {
  return !catalogAlwaysAsks(server.server_url, tool)
}

/** The tools split as Claude's page splits them: read-only, then write & delete. */
export function groupToolsByType<T extends McpToolForPolicy>(
  tools: readonly T[],
  server: Pick<McpServerApprovalLists, 'server_url'>,
): { readOnly: T[]; write: T[] } {
  const readOnly: T[] = []
  const write: T[] = []
  for (const tool of tools) (isReadOnlyForServer(tool, server) ? readOnly : write).push(tool)
  return { readOnly, write }
}

/** A group's permission: the one its tools share, or 'mixed'. Null for an empty group. */
export function groupPermission(
  tools: readonly McpToolForPolicy[],
  server: McpPermissionLists,
): ToolPermission | 'mixed' | null {
  const seen = new Set(tools.map((t) => toolPermission(t, server)))
  if (seen.size === 0) return null
  return seen.size === 1 ? [...seen][0] : 'mixed'
}

/**
 * The lists after setting `tools` to `permission`, one tool after another
 * through withToolAccess. Always allow skips a tool that can't take it (it
 * keeps its own permission). `allowed_tools` stays null on a server whose
 * allow-list isn't seeded yet: the caller leaves it out of the PATCH.
 */
export function withToolPermission(
  server: McpPermissionLists,
  tools: readonly McpToolForPolicy[],
  permission: ToolPermission,
): McpAccessUpdate {
  let lists: McpPermissionLists = server
  for (const tool of tools) {
    if (permission === 'allow' && !canAlwaysAllow(tool, server)) continue
    lists = { ...lists, ...withToolAccess(lists, tool.name, ACCESS[permission], asksByDefault(tool, server)) }
  }
  return {
    disabled_tools: [...(lists.disabled_tools ?? [])],
    allowed_tools: Array.isArray(lists.allowed_tools) ? [...lists.allowed_tools] : null,
    require_approval_tools: [...(lists.require_approval_tools ?? [])],
    approval_free_tools: [...(lists.approval_free_tools ?? [])],
  }
}

/** A connected server's row as a permission change reads it: its lists and its listed tools. */
export type McpPermissionRow = McpPermissionLists & { tools_cache?: readonly McpToolForPolicy[] | null }

/**
 * The columns setting `toolNames` to `permission` writes, from the row as it
 * is now (never from a page's or a card's copy): each tool with its listed
 * annotations (the policy reads them; a name the listing no longer has still
 * gets its lists set), and `allowed_tools` only once seeded (otherwise the
 * next listing seeds it). Settings › Connectors' PATCH and an approval card's
 * Always allow (always-allow.ts) both write through it.
 */
export function toolPermissionColumns(
  row: McpPermissionRow,
  toolNames: readonly string[],
  permission: ToolPermission,
): Record<string, string[]> {
  const cache = row.tools_cache ?? []
  const tools = toolNames.map((name) => cache.find((t) => t?.name === name) ?? { name })
  const { allowed_tools, ...lists } = withToolPermission(row, tools, permission)
  return allowed_tools ? { ...lists, allowed_tools } : lists
}
