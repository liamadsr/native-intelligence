/**
 * Which of the person's connected apps a new sign-in renews (GEN-1171:
 * reconnect without disconnecting first). The OAuth callback
 * (src/app/api/mcp-oauth/callback/route.ts) updates that row in place, its
 * tool choices kept, instead of inserting a second one.
 */
import { mcpServerSlug } from './adapter'
import { suggestedMcpServerFor } from './suggested'
import { normalizeServerUrl } from '@/lib/connections/connect-target'

export type ExistingMcpServer = { id: string; display_name: string; server_url: string; reauth_required_at?: string | null }

/**
 * The row for the same app (a catalog app's host, else the same URL) under
 * the same name (the slug the unique index keys on). Every Reconnect (the
 * Connect card, the Connections panel, the app's Settings page) signs in
 * under the row's own name and URL, so it lands here. Null: a new connection,
 * which inserts as before (a same name for another app is still refused by
 * the index, never a different server's row overwritten), and a second
 * account under another name gets its own row. Pure.
 */
export function reconnectTarget(
  existing: readonly ExistingMcpServer[],
  incoming: { display_name: string; server_url: string },
): ExistingMcpServer | null {
  const slug = mcpServerSlug(incoming.display_name)
  const catalog = suggestedMcpServerFor(incoming.server_url)
  const sameApp = (s: ExistingMcpServer) =>
    catalog ? suggestedMcpServerFor(s.server_url)?.id === catalog.id : normalizeServerUrl(s.server_url) === normalizeServerUrl(incoming.server_url)
  return existing.find((s) => mcpServerSlug(s.display_name) === slug && sameApp(s)) ?? null
}
