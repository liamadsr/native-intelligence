/**
 * Which external (connected-app) MCP tools need the person's approval before
 * they run (always-on safety fixes, 2026-10-15).
 *
 * Before: a tool needed approval only when the person had listed it in
 * `require_approval_tools`, and every connection started with that list
 * empty, so an injected email could have the agent call any write tool of a
 * connected app directly. Now approval is the default for anything that is
 * not read-only:
 *   1. the person listed it in `require_approval_tools`  → approval (their yes wins);
 *   2. the person listed it in `approval_free_tools`     → no approval (their explicit choice, migration 339);
 *   3. otherwise, a read-only tool                        → no approval;
 *   4. otherwise                                          → approval.
 * Read-only means the server's `annotations.readOnlyHint === true`, or, when
 * the server says nothing either way, a read-shaped name in any naming style
 * (getJiraIssue, list_issues, search-code, fetch: src/lib/mcp/read-names.ts
 * isReadShapedExternalName). A cache saved before annotations were kept is
 * re-listed once on first use (adapter.ts). An explicit
 * `readOnlyHint: false` or `destructiveHint: true` is never read-only.
 *
 * The server enforces this (src/lib/safety/outward-gate.ts, beside the
 * reviewer at every door), the adapter's description follows it, and the
 * settings page shows the same answer. No server imports: safe in client code.
 */
import { isReadShapedExternalName } from '@/lib/mcp/read-names'
import { isGitHubReadOnlyServerUrl } from './github-server'
import { suggestedMcpServerFor } from './suggested'

/** MCP tool annotations (the spec's hints; a server's own claims, not guarantees). */
export interface McpToolAnnotations {
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
  title?: string
}

export interface McpToolForPolicy {
  name: string
  annotations?: McpToolAnnotations | null
}

export interface McpServerApprovalLists {
  /** The server's URL: a catalog app's always-ask tools are read from it (suggested.ts). */
  server_url?: string | null
  require_approval_tools?: readonly string[] | null
  /** Absent until migration 339 is applied: treated as empty (approval stays the default). */
  approval_free_tools?: readonly string[] | null
}

/** A tool the server marks read-only, or (with no hint either way) one with a read-shaped name. */
export function isReadOnlyMcpTool(tool: McpToolForPolicy): boolean {
  const hints = tool.annotations ?? {}
  if (hints.readOnlyHint === true) return true
  if (hints.readOnlyHint === false || hints.destructiveHint === true) return false
  return isReadShapedExternalName(tool.name)
}

/**
 * A plain read, judged without trusting the server: a read-shaped name AND no
 * hint saying otherwise. A server's readOnlyHint alone is its own claim, so it
 * never frees a write-shaped tool. The rule for every server not in the
 * catalog (decision 23), and for a catalog app's always-ask writes.
 */
export function isPlainReadForUnknownServer(tool: McpToolForPolicy): boolean {
  const hints = tool.annotations ?? {}
  if (hints.readOnlyHint === false || hints.destructiveHint === true) return false
  return isReadShapedExternalName(tool.name)
}

/** A server in the catalog (suggested.ts, matched by host): its hints are trusted, as before. */
export function isCatalogServer(serverUrl: string | null | undefined): boolean {
  return !!serverUrl && !!suggestedMcpServerFor(serverUrl)
}

/**
 * Read-only for THIS server: on GitHub's read-only endpoint every tool is (the
 * server runs no write there, github-server.ts), unless it says otherwise; a
 * catalog server's hints count (isReadOnlyMcpTool); any other server's never
 * do (isPlainReadForUnknownServer), and neither does a server whose URL the
 * caller did not pass (fail closed).
 */
export function isReadOnlyForServer(tool: McpToolForPolicy, server: Pick<McpServerApprovalLists, 'server_url'>): boolean {
  if (isGitHubReadOnlyServerUrl(server.server_url)) {
    const hints = tool.annotations ?? {}
    return hints.readOnlyHint !== false && hints.destructiveHint !== true
  }
  return isCatalogServer(server.server_url) ? isReadOnlyMcpTool(tool) : isPlainReadForUnknownServer(tool)
}

/**
 * A catalog app's tool that always asks, whatever anyone chose (suggested.ts
 * `alwaysAskWrites`): for Typefully, every tool that is not a plain read
 * (decision 2, "user always approves" posts; create_draft with a publish_at
 * publishes). By shape, never by a list of names, and never by the server's
 * own hints. Read from the server's URL, so a renamed server keeps it.
 */
export function catalogAlwaysAsks(serverUrl: string | null | undefined, tool: McpToolForPolicy | string): boolean {
  if (!serverUrl || !suggestedMcpServerFor(serverUrl)?.alwaysAskWrites) return false
  return !isPlainReadForUnknownServer(typeof tool === 'string' ? { name: tool } : tool)
}

/** Does this tool need the person's approval before each call? */
export function mcpToolRequiresApproval(tool: McpToolForPolicy, server: McpServerApprovalLists): boolean {
  if (catalogAlwaysAsks(server.server_url, tool)) return true
  if ((server.require_approval_tools ?? []).includes(tool.name)) return true
  if ((server.approval_free_tools ?? []).includes(tool.name)) return false
  return !isReadOnlyForServer(tool, server)
}

/**
 * The lists after the person flips one tool's approval (the settings page's
 * shield). Turning approval off for a tool that needs it by default records an
 * explicit approval-free choice; turning it on for a read-only tool records an
 * explicit approval-required one. Each tool sits in at most one list.
 */
export function toggledApprovalLists(
  tool: McpToolForPolicy,
  server: McpServerApprovalLists,
): { require_approval_tools: string[]; approval_free_tools: string[] } {
  const required = new Set(server.require_approval_tools ?? [])
  const free = new Set(server.approval_free_tools ?? [])
  const wasRequired = mcpToolRequiresApproval(tool, server)
  required.delete(tool.name)
  free.delete(tool.name)
  const byDefault = !isReadOnlyForServer(tool, server)
  if (wasRequired && byDefault) free.add(tool.name)
  if (!wasRequired && !byDefault) required.add(tool.name)
  return { require_approval_tools: [...required], approval_free_tools: [...free] }
}
