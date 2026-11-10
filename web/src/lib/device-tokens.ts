/**
 * Device tokens — long-lived, named, revocable bearer credentials for
 * headless clients (the XIAO ESP32S3 capture device and similar).
 *
 * Format: `nid_<base64url(32 random bytes)>`. The `nid_` prefix lets the
 * Bearer-auth path cheaply tell a device token apart from a Supabase JWT
 * (which is `eyJ…`) so we only hit the device_token table for tokens that
 * are actually device tokens — no wasted round-trips on JWT requests.
 *
 * We store only the SHA-256 hash (see migration 112), mirroring the
 * mcp_oauth_token design. The plaintext is returned to the caller exactly
 * once, at mint time, and never persisted.
 */
import crypto from 'crypto'
import { getServiceClient } from '@/lib/supabase/service'

/** Prefix of the device tokens this server mints. */
const DEVICE_TOKEN_PREFIX = 'nid_'
// TODO(rename-compat): tokens minted before the rename start with `d8d_`. They sit on
// hardware until it is paired again, so this stays until device_token holds none.
const LEGACY_DEVICE_TOKEN_PREFIX = 'd8d_'

/** True if a bearer string looks like a device token (vs. a Supabase JWT). */
export function isDeviceToken(token: string): boolean {
  return token.startsWith(DEVICE_TOKEN_PREFIX) || token.startsWith(LEGACY_DEVICE_TOKEN_PREFIX)
}

/** SHA-256 hex of the full plaintext token, for storage + lookup. */
function hashDeviceToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex')
}

/**
 * Mint a fresh plaintext device token. Returned to the caller once; only its
 * hash is stored. The display prefix is the first 12 chars (e.g. `nid_a1b2c3`).
 */
export function generateDeviceToken(): {
  token: string
  hash: string
  displayPrefix: string
} {
  const token = DEVICE_TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url')
  return {
    token,
    hash: hashDeviceToken(token),
    displayPrefix: token.slice(0, 12),
  }
}

export interface ResolvedDeviceToken {
  userId: string
  /**
   * Workspace the token is currently scoped to. This is the token's
   * `active_workspace_id` if set, otherwise the owner's oldest workspace as a
   * fallback (mirrors mcp_oauth_token resolution). Null only if the owner has
   * no workspaces at all.
   */
  workspaceId: string | null
}

/**
 * Validate a device token and resolve the owning user + active workspace.
 * Returns null if the token is unknown or expired. Touches last_used_at as a
 * fire-and-forget side effect for the "Devices" settings UI.
 *
 * Workspace resolution mirrors authenticateMcpRequest: use the token's
 * `active_workspace_id` if set, else fall back to the owner's OLDEST workspace
 * (deterministic `order by created_at` — NOT an unordered limit(1)). The
 * device's on-screen workspace picker updates active_workspace_id via
 * setActiveDeviceWorkspace, so subsequent requests resolve to the chosen one.
 *
 * This is the single resolution point used by every Bearer-auth helper
 * (api-auth, workspace, ai/auth) so device-token support is consistent
 * everywhere.
 *
 * Kept in sync with resolveDeviceTokenSession in agents/chat-agent/lib/auth.ts
 * (the eve bundle cannot import this): /api/device/ask registers its session
 * under the workspace resolved HERE, and the chat-agent's ACL admits the device
 * under the workspace resolved THERE. Change both together —
 * agents/chat-agent/lib/__tests__/device-token-resolver-drift.test.ts runs the
 * two over the same rows and fails on any disagreement.
 */
export async function resolveDeviceToken(
  token: string,
): Promise<ResolvedDeviceToken | null> {
  if (!isDeviceToken(token)) return null

  const service = getServiceClient()
  const tokenHash = hashDeviceToken(token)

  const { data: row, error } = await service
    .from('device_token')
    .select('id, user_id, active_workspace_id, expires_at')
    .eq('token_hash', tokenHash)
    .maybeSingle<{
      id: string
      user_id: string
      active_workspace_id: string | null
      expires_at: string | null
    }>()

  if (error || !row) return null
  if (row.expires_at && new Date(row.expires_at) < new Date()) return null

  // Fire-and-forget: record usage for the settings UI; correctness doesn't
  // depend on it landing. Swallow rejections so a transient failure here can't
  // surface as an unhandled rejection in the auth hot path.
  service
    .from('device_token')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', row.id)
    .then(() => {}, () => {})

  // Resolve the active workspace, falling back to the owner's oldest workspace.
  let workspaceId = row.active_workspace_id
  if (!workspaceId) {
    const { data: membership } = await service
      .from('member')
      .select('workspace_id')
      .eq('user_id', row.user_id)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle<{ workspace_id: string }>()
    workspaceId = membership?.workspace_id ?? null
  }

  return { userId: row.user_id, workspaceId }
}

/**
 * True when the device token's owner still has a member row in the workspace
 * the token resolved to. `resolveDeviceToken` checks the pin only when it is
 * SET (setActiveDeviceWorkspace), so a person removed from that workspace
 * later keeps a stale pin; every caller that acts in the resolved workspace
 * checks it here (api-auth runs the same service-role read inline).
 *
 * Kept OUT of resolveDeviceToken on purpose: that function is drift-locked to
 * resolveDeviceTokenSession in agents/chat-agent/lib/auth.ts.
 *
 * Service-role (a device request has no Supabase session, so member RLS would
 * hide the row), fenced on the token's own user id. Throws on a query error so
 * the caller surfaces a 500, never a false "not a member".
 */
export async function isDeviceWorkspaceMember(
  userId: string,
  workspaceId: string,
): Promise<boolean> {
  const { data, error } = await getServiceClient()
    .from('member')
    .select('id')
    .eq('user_id', userId)
    .eq('workspace_id', workspaceId)
    .maybeSingle<{ id: string }>()
  if (error) {
    console.error('[device-tokens] workspace membership query failed:', error)
    throw new Error('Device workspace membership query failed')
  }
  return !!data
}

/**
 * Switch a device token's active workspace. Validates that the token's owner is
 * a member of the target workspace before writing it — the device's workspace
 * picker calls the endpoint that wraps this. Mirrors mcp/auth setActiveWorkspace
 * but with the membership check inlined here (single source of truth).
 *
 * Returns true on success, false if the token doesn't exist or the user isn't a
 * member of the target workspace (caller maps that to 403/404).
 */
export async function setActiveDeviceWorkspace(
  token: string,
  workspaceId: string,
): Promise<boolean> {
  if (!isDeviceToken(token)) return false

  const service = getServiceClient()
  const tokenHash = hashDeviceToken(token)

  const { data: row } = await service
    .from('device_token')
    .select('id, user_id')
    .eq('token_hash', tokenHash)
    .maybeSingle<{ id: string; user_id: string }>()
  if (!row) return false

  // Membership check: a token can only be pointed at a workspace its owner
  // actually belongs to.
  const { data: member } = await service
    .from('member')
    .select('id')
    .eq('user_id', row.user_id)
    .eq('workspace_id', workspaceId)
    .maybeSingle<{ id: string }>()
  if (!member) return false

  const { error } = await service
    .from('device_token')
    .update({ active_workspace_id: workspaceId })
    .eq('id', row.id)

  return !error
}
