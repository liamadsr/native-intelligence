/**
 * Whether a connected MCP server's sign-in needs the person (GEN-1171): the
 * refresh path marked it (`reauth_required_at`, migration 451,
 * ./token-refresh.ts). Before that migration (no such key on the row) its
 * `last_error` being the expired-token message stands in: McpTokenExpiredError's,
 * as refresh-tools and the mark store it. Once the column exists it alone
 * decides, so an old message left in `last_error` never shows a healthy
 * server as expired. Pure and client-safe: Settings, the Connections panel,
 * list_connections and the Connect card all read it.
 */
const MCP_EXPIRED_ERROR = /token expired|needs to be reconnected/i

/** Is this text McpTokenExpiredError's message? */
export function isMcpExpiredMessage(text: unknown): boolean {
  return typeof text === 'string' && MCP_EXPIRED_ERROR.test(text)
}

export function mcpNeedsReconnect(server: { reauth_required_at?: unknown; last_error?: unknown }): boolean {
  if ('reauth_required_at' in server) return typeof server.reauth_required_at === 'string' && server.reauth_required_at.length > 0
  return isMcpExpiredMessage(server.last_error)
}
