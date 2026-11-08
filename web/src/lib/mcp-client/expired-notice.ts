/**
 * The person hears once that a connected app's sign-in expired (GEN-1171),
 * instead of only when a tool call fails: one `connection.needs_reconnect`
 * row in their agent's inbox, written the moment token-refresh.ts marks the
 * server (the mark flips once per sign-in, and the key carries its instant).
 * The router makes it a home-thread turn (agent-events/router.ts): the agent
 * says so in a line and puts up the app's Reconnect card. Never a token or a
 * server's own text: Native Intelligence's catalog name, else the name the person gave it.
 */
import { recordAgentEvents, type RecordAgentEventsDeps } from '@/lib/agent-events/record'
import { agentEventKey } from '@/lib/agent-events/types'
import { suggestedMcpServerFor } from './suggested'
import type { MarkedServer } from './token-refresh'

/** Record the event; true when its row newly landed. Never throws (recordAgentEvents doesn't). */
export async function recordMcpReconnectEvent(server: MarkedServer, deps: RecordAgentEventsDeps = {}): Promise<boolean> {
  // An app with no workspace has no home thread to be told in (the OAuth start route always sets one).
  if (!server.workspace_id) return false
  const catalog = suggestedMcpServerFor(server.server_url)
  const landed = await recordAgentEvents(
    [
      {
        workspaceId: server.workspace_id,
        userId: server.user_id,
        kind: 'connection.needs_reconnect',
        priority: 2,
        occursAt: server.reauth_required_at,
        refType: 'connected_mcp_server',
        refId: server.id,
        facts: { title: catalog?.display_name ?? server.display_name, ...(catalog ? { catalogId: catalog.id } : {}) },
        dedupeKey: agentEventKey.connectionNeedsReconnect(server.id, server.reauth_required_at),
      },
    ],
    undefined,
    deps,
  )
  return landed > 0
}
