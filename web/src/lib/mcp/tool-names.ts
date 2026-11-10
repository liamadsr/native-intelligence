/**
 * The names tools carry on the MCP surface: a chat tool `read_email` is listed
 * there as `ni_read_email`. Everything that takes a tool name from outside (an
 * MCP call, a stored approval, an old conversation, an audit row) reads it
 * through here, so the prefix is defined once.
 */

/** The prefix of every tool this server lists. */
export const MCP_TOOL_PREFIX = 'ni_'

// TODO(rename-compat): before the rename the prefix was `dial8_`. Clients that
// fetched their tool list back then still call those names, and rows written
// back then (approvals, conversations, audit) still hold them. Drop this once
// neither is around.
export const LEGACY_MCP_TOOL_PREFIX = 'dial8_'

/** `ni_read_email` (or the older `dial8_read_email`) → `read_email`. Other names come back as they are. */
export function bareToolName(name: string): string {
  if (name.startsWith(MCP_TOOL_PREFIX)) return name.slice(MCP_TOOL_PREFIX.length)
  if (name.startsWith(LEGACY_MCP_TOOL_PREFIX)) return name.slice(LEGACY_MCP_TOOL_PREFIX.length)
  return name
}

/** `read_email` → `ni_read_email`. */
export function mcpToolName(bare: string): string {
  return `${MCP_TOOL_PREFIX}${bare}`
}

/**
 * How a hint names a tool to a client whose tool list may be from before the
 * rename: `ni_call_tool (dial8_call_tool on a tool list from before the rename)`.
 * A client can only call the names in its own list, and the hints about an
 * out-of-date list go to exactly the clients that still have the older one.
 */
// TODO(rename-compat): hints name the older prefix too, until no client has a tool list from before the rename.
export function toolNameInHints(bare: string): string {
  return `${MCP_TOOL_PREFIX}${bare} (${LEGACY_MCP_TOOL_PREFIX}${bare} on a tool list from before the rename)`
}

/** A name as this server lists it now: the older `dial8_read_email` → `ni_read_email`. Other names come back as they are. */
export function currentMcpToolName(name: string): string {
  return name.startsWith(LEGACY_MCP_TOOL_PREFIX) ? mcpToolName(name.slice(LEGACY_MCP_TOOL_PREFIX.length)) : name
}

/**
 * A JSON-RPC body (one message or a batch) with every `tools/call` naming an
 * older `dial8_*` tool pointed at the tool's current name. Anything else comes
 * back untouched.
 */
export function withCurrentToolNames(body: unknown): unknown {
  if (Array.isArray(body)) return body.map(withCurrentToolNames)
  if (!body || typeof body !== 'object') return body
  const message = body as { method?: unknown; params?: { name?: unknown } }
  if (message.method !== 'tools/call' || typeof message.params?.name !== 'string') return body
  const name = currentMcpToolName(message.params.name)
  return name === message.params.name ? body : { ...message, params: { ...message.params, name } }
}
