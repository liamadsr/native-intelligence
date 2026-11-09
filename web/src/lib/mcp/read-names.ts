/**
 * Read-shaped tool names: the name classifier the Native Intelligence MCP guard falls back
 * on (src/lib/mcp/guard.ts classifyToolAccess) for a tool neither the registry
 * nor the MCP-only map knows. Shared with the external-MCP approval policy
 * (src/lib/mcp-client/approval-policy.ts), which applies it to a connected
 * server's own tool names when the server says nothing about readOnlyHint.
 * No imports, so it is safe in client code.
 */
export const READ_NAME_PATTERNS: readonly RegExp[] = Object.freeze([
  /^get_/,
  /^list_/,
  /^read_/,
  /^find$/,
  /^search/,
  /^deep_search$/,
  /^traverse$/,
  /^download_/,
])

/** True when the bare name matches a known read shape. */
export function isReadShapedName(name: string): boolean {
  return READ_NAME_PATTERNS.some((pattern) => pattern.test(name))
}

/**
 * The verbs a connected app's read tool starts with. Outside servers name
 * tools in every style (Atlassian: getJiraIssue, lookupJiraAccountId, fetch;
 * others: list_issues, search-code), so the external approval policy
 * (src/lib/mcp-client/approval-policy.ts) accepts each verb on its own, or
 * followed by `_`, `-`, `.`, `:`, or a capital letter or digit (camelCase).
 * Kept apart from READ_NAME_PATTERNS, which classify Native Intelligence's own tools for
 * the MCP guard.
 */
const EXTERNAL_READ_VERBS = [
  'get', 'list', 'search', 'read', 'fetch', 'lookup', 'find', 'describe', 'view', 'show',
  'retrieve', 'download', 'browse', 'count', 'inspect',
] as const
// Not `query`: some database servers' `query` runs any SQL, writes included.
const EXTERNAL_READ_NAME = new RegExp(`^(?:${EXTERNAL_READ_VERBS.join('|')})(?:$|[_\\-.:]|[A-Z0-9])`)

/** True when a connected app's tool name reads as a read: snake, kebab, camel or Pascal case. */
export function isReadShapedExternalName(name: string): boolean {
  const trimmed = name.trim()
  if (!trimmed) return false
  // PascalCase (GetJiraIssue) reads like camelCase once its first letter is lowered.
  const normalized = trimmed[0].toLowerCase() + trimmed.slice(1)
  return EXTERNAL_READ_NAME.test(normalized) || isReadShapedName(trimmed)
}
