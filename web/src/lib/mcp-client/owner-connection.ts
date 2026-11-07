/**
 * One person's connected app and one of its tools, as a loop's step reads
 * them (F4): the flow's call_tool steps (src/lib/flows/call-tool.ts), a skill
 * run's connections (the skill-run tool route) and the accept-time re-check
 * of a held call (src/lib/safety/approvals.ts) all ask the same questions:
 * is it theirs, is it on, does it list the tool, and may the agent see it
 * (P5's allow-list and switches, tool-access.ts).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { isMcpToolHidden } from './tool-access'
import { GITHUB_INTEGRATION_SERVER_ID } from './github-server'
import type { ConnectedMcpServerRow, McpToolDescriptor } from './types'

/** One tool of a connection, as its cache lists it. */
export function toolOf(server: Pick<ConnectedMcpServerRow, 'tools_cache'>, tool: string): McpToolDescriptor | null {
  return (server.tools_cache ?? []).find((t) => t && t.name === tool) ?? null
}

/**
 * The person's connection, by id (never another person's). Null on a read
 * error. The GitHub integration's id is built from their own integration
 * (github-integration.ts), so a loop step or a held call on GitHub finds it.
 */
export async function loadOwnerConnection(
  supabase: SupabaseClient,
  ownerUserId: string,
  connectionId: string,
): Promise<ConnectedMcpServerRow | null> {
  if (connectionId === GITHUB_INTEGRATION_SERVER_ID) {
    const { loadGitHubIntegrationServer } = await import('./github-integration')
    return loadGitHubIntegrationServer(supabase, ownerUserId)
  }
  const { data, error } = await supabase
    .from('connected_mcp_server')
    .select('*')
    .eq('id', connectionId)
    .eq('user_id', ownerUserId)
    .maybeSingle<ConnectedMcpServerRow>()
  if (error) return null
  return data ?? null
}

/** Why a connection or tool can't be used by its owner now, or null. */
export function connectionProblem(server: ConnectedMcpServerRow | null, tool: string): string | null {
  if (!server) return "That connection is gone, or isn't the loop owner's (list_connections shows theirs)"
  if (!server.is_enabled) return `${server.display_name} is switched off`
  if (!toolOf(server, tool)) return `${server.display_name} has no tool "${tool}" (refresh its tools in Settings, or pick one list_connections shows)`
  if (isMcpToolHidden(server, tool)) return `${tool} on ${server.display_name} is off or not added yet; the owner turns it on in Settings or with set_tool_access`
  return null
}

/** The text a connected app's result carries: its text parts and resource texts, raw (unfenced). */
export function mcpContentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return content === undefined || content === null ? '' : JSON.stringify(content)
  const parts: string[] = []
  for (const part of content) {
    if (!part || typeof part !== 'object') continue
    const p = part as Record<string, unknown>
    if (p.type === 'text' && typeof p.text === 'string') parts.push(p.text)
    else if (p.type === 'resource' && p.resource && typeof p.resource === 'object' && typeof (p.resource as { text?: unknown }).text === 'string') {
      parts.push((p.resource as { text: string }).text)
    }
  }
  return parts.join('\n')
}
