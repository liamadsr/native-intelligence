/**
 * Which of a connected app's tools reach the agent (flows-connectors F2;
 * pattern P8, docs/plans/eve-templates-lessons.md §3b; migration 396).
 *
 * A server's tool list is an ALLOW-LIST, not a deny-list:
 *   - `allowed_tools`: the tools the person has seen and kept. A tool the
 *     server lists that is not here is NEW: invisible to every agent until the
 *     person adds it, so a server can't slip a tool in on a refresh. Null
 *     means not seeded yet (the first listing found nothing); the next
 *     listing that finds tools seeds it (seedAllowedTools).
 *   - `disabled_tools`: tools the person switched off. Still hidden.
 *
 * Every reader of a server's tools goes through isMcpToolHidden: the chat's
 * adapter, the call-by-id path, the chat prompt's server block, the live
 * agent's catalog and block, Settings and list_connections.
 *
 * Pure, no server imports: safe in client code.
 */
import { isPlainReadForUnknownServer, mcpToolRequiresApproval, type McpServerApprovalLists, type McpToolForPolicy } from './approval-policy'

/** The part of a connected_mcp_server row these rules read. */
export interface McpToolLists {
  disabled_tools?: readonly string[] | null
  /** Absent (a row read before migration 396) or null: no allow-list yet. */
  allowed_tools?: readonly string[] | null
}

/** True when this tool is on the allow-list, or there is no allow-list yet. */
export function isMcpToolAllowed(server: McpToolLists, toolName: string): boolean {
  const allowed = server.allowed_tools
  return !Array.isArray(allowed) || allowed.includes(toolName)
}

/** A tool the server lists that the person has not added yet. */
export function isNewMcpTool(server: McpToolLists, toolName: string): boolean {
  return !isMcpToolAllowed(server, toolName)
}

/** Hidden from the agent: switched off, or new (not on the allow-list). */
export function isMcpToolHidden(server: McpToolLists, toolName: string): boolean {
  if ((server.disabled_tools ?? []).includes(toolName)) return true
  return !isMcpToolAllowed(server, toolName)
}

/** The tools of `tools` the agent may see. */
export function visibleMcpTools<T extends { name: string }>(server: McpToolLists, tools: readonly T[] | null | undefined): T[] {
  return (tools ?? []).filter((t) => t && typeof t.name === 'string' && !isMcpToolHidden(server, t.name))
}

/** The tools of `tools` the person has not added yet. */
export function newMcpTools<T extends { name: string }>(server: McpToolLists, tools: readonly T[] | null | undefined): T[] {
  return (tools ?? []).filter((t) => t && typeof t.name === 'string' && isNewMcpTool(server, t.name))
}

/**
 * The allow-list after a listing: unchanged once seeded (a new tool waits to
 * be added); seeded with the listed names when there was none and the listing
 * found some; still null when it found none.
 */
export function seedAllowedTools(
  current: readonly string[] | null | undefined,
  tools: ReadonlyArray<{ name: string }> | null | undefined,
): string[] | null {
  if (Array.isArray(current)) return [...current]
  const names = (tools ?? []).map((t) => t?.name).filter((n): n is string => typeof n === 'string' && n.length > 0)
  return names.length ? [...new Set(names)] : null
}

// ── Per-tool access (list_connections, set_tool_access) ─────────────────────

/**
 * One tool's access, as the person and the agent name it:
 *   off        the agent can't see or call it;
 *   ask        every call waits for the person's approval card;
 *   read_only  it runs without asking (what a read does; on a write it is
 *              "dropping the approval", which only the person's card grants).
 * A tool's state is also 'new': listed by the server, not added yet (hidden).
 */
export const MCP_TOOL_ACCESS_LEVELS = ['off', 'ask', 'read_only'] as const
export type McpToolAccess = (typeof MCP_TOOL_ACCESS_LEVELS)[number]
export type McpToolState = McpToolAccess | 'new'

/** How much a state lets the agent do: a move up is a loosening. */
const RANK: Record<McpToolState, number> = { new: 0, off: 0, ask: 1, read_only: 2 }

/** True when going from `from` to `to` lets the agent do more (a card, never at once). */
export function isLoosening(from: McpToolState, to: McpToolState): boolean {
  return RANK[to] > RANK[from]
}

/** The lists one tool's access is stored in (a row's own columns). */
export interface McpAccessLists extends McpToolLists {
  require_approval_tools?: readonly string[] | null
  approval_free_tools?: readonly string[] | null
}

/** The lists after setting one tool's access. Each tool sits in at most one approval list. */
export interface McpAccessUpdate {
  disabled_tools: string[]
  allowed_tools: string[] | null
  require_approval_tools: string[]
  approval_free_tools: string[]
}

/**
 * The stored lists after `tool` is set to `access`. `requiresApprovalByDefault`
 * is the policy's answer with neither approval list naming it (approval-policy.ts:
 * not read-only, or a catalog tool that always asks), so `read_only` on such a
 * tool records an explicit approval-free choice and `ask` on a read records an
 * explicit approval-required one. Setting any access adds the tool to the
 * allow-list (the person has now seen it); `off` adds it switched off.
 */
export function withToolAccess(
  lists: McpAccessLists,
  tool: string,
  access: McpToolAccess,
  requiresApprovalByDefault: boolean,
): McpAccessUpdate {
  const disabled = new Set(lists.disabled_tools ?? [])
  const required = new Set(lists.require_approval_tools ?? [])
  const free = new Set(lists.approval_free_tools ?? [])
  const allowed = Array.isArray(lists.allowed_tools) ? new Set(lists.allowed_tools) : null
  allowed?.add(tool)
  free.delete(tool)
  if (access === 'off') {
    // Off keeps (and, for a tool that asks by default, adds) its approval pin,
    // so switching it back on anywhere (Settings' switch included) never frees it.
    disabled.add(tool)
    if (requiresApprovalByDefault) required.add(tool)
  } else {
    required.delete(tool)
    disabled.delete(tool)
    // Pinned, even when it asks by default, so a server's changed hint can't free it.
    if (access === 'ask') required.add(tool)
    if (access === 'read_only' && requiresApprovalByDefault) free.add(tool)
  }
  return {
    disabled_tools: [...disabled],
    allowed_tools: allowed ? [...allowed] : null,
    require_approval_tools: [...required],
    approval_free_tools: [...free],
  }
}

/** One tool's state now: new, off, ask (the policy holds it for a card) or read_only (it runs). */
export function mcpToolState(tool: McpToolForPolicy, server: McpAccessLists & McpServerApprovalLists): McpToolState {
  if (isNewMcpTool(server, tool.name)) return 'new'
  if ((server.disabled_tools ?? []).includes(tool.name)) return 'off'
  return mcpToolRequiresApproval(tool, server) ? 'ask' : 'read_only'
}

/** Would the policy hold this tool for a card with neither approval list naming it? */
export function asksByDefault(tool: McpToolForPolicy, server: McpServerApprovalLists): boolean {
  return mcpToolRequiresApproval(tool, { ...server, require_approval_tools: [], approval_free_tools: [] })
}

// ── A server from a URL (decision 23) ───────────────────────────────────────

/** A plain read, judged without trusting the server (approval-policy.ts, where the policy uses it). */
export { isPlainReadForUnknownServer }

/**
 * The require_approval_tools a NEW connection starts with (decision 23: a
 * URL server's write tools start as ask until the person changes them). A
 * catalog server starts with none (the default policy holds its writes); a
 * server we don't know has every tool that is not a plain read pinned to ask.
 */
export function initialRequireApprovalTools(
  isCatalogServer: boolean,
  tools: ReadonlyArray<McpToolForPolicy> | null | undefined,
): string[] {
  if (isCatalogServer) return []
  return [...new Set((tools ?? []).filter((t) => t && typeof t.name === 'string' && !isPlainReadForUnknownServer(t)).map((t) => t.name))]
}
