/**
 * An approval card's "Always allow" (Claude's Allow once / Always allow):
 * once the person approves a held connected-app call on its card, that tool is
 * set to Always allow on its server (tool-permissions.ts), so from then on it
 * runs without a card. Settings › Connectors shows it, and sets it back.
 *
 * What it changes is never the request's word: the server and tool come from
 * the held call as the server stored it (approvals.ts NewApproval.alwaysAllow,
 * raised only in the person's own chat: mcp_confirm_call's card and the
 * outward gate's, for a tool its own permission held), the held call must be
 * a chat call of exactly that tool on that server, and the server row is the
 * person's own, read now. Never freed: a catalog app's always-ask tool
 * (canAlwaysAllow), or a tool the person has switched off or not added since
 * (a block set while the call ran stands).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { namespacedToolName } from './adapter'
import { isMcpToolHidden } from './tool-access'
import { canAlwaysAllow, toolPermissionColumns, type McpPermissionRow } from './tool-permissions'

/** The held call's offer, as approvals.ts stores it in its context. */
export interface AlwaysAllowOffer {
  serverId: string
  tool: string
}

/** The offer a stored context carries, when it is well formed. */
export function alwaysAllowOfferOf(context: unknown): AlwaysAllowOffer | null {
  const offer = (context as { alwaysAllow?: unknown } | null | undefined)?.alwaysAllow as Partial<AlwaysAllowOffer> | undefined
  if (!offer || typeof offer.serverId !== 'string' || typeof offer.tool !== 'string' || !offer.serverId || !offer.tool) return null
  return { serverId: offer.serverId, tool: offer.tool }
}

/**
 * Set the approved call's tool to Always allow. True when it was saved; false
 * when the call carries no offer, the server is gone or not the person's, the
 * tool always asks, or the write failed (the call already ran either way).
 */
export async function alwaysAllowHeldTool(supabase: SupabaseClient, userId: string, approvalId: string): Promise<boolean> {
  if (!approvalId) return false
  const { data: approval } = await supabase
    .from('tool_approval')
    .select('door, tool, context')
    .eq('id', approvalId)
    .eq('user_id', userId)
    .maybeSingle<{ door: string | null; tool: string | null; context: unknown }>()
  const offer = alwaysAllowOfferOf(approval?.context)
  if (!offer || approval?.door !== 'chat') return false
  const { data: server } = await supabase
    .from('connected_mcp_server')
    .select('*')
    .eq('id', offer.serverId)
    .eq('user_id', userId)
    .maybeSingle()
  if (!server) return false
  const row = server as McpPermissionRow & { display_name?: string | null }
  // The offer names exactly the tool the person approved on this server.
  if (namespacedToolName(String(row.display_name ?? ''), offer.tool) !== approval.tool) return false
  if (isMcpToolHidden(row, offer.tool)) return false
  const tool = (row.tools_cache ?? []).find((t) => t?.name === offer.tool) ?? { name: offer.tool }
  if (!canAlwaysAllow(tool, row)) return false
  const { data: written, error } = await supabase
    .from('connected_mcp_server')
    .update(toolPermissionColumns(row, [offer.tool], 'allow'))
    .eq('id', offer.serverId)
    .eq('user_id', userId)
    .select('id')
  return !error && Array.isArray(written) && written.length > 0
}
