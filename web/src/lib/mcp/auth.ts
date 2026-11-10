import crypto from 'crypto'
import { createClient } from '@supabase/supabase-js'
import { agentActivityHeaders } from '@/lib/activity-actor'
import { appHost } from '@/lib/app-url'
import { mcpBaseUrl } from '@/lib/mcp/base-url'

/**
 * Hash a token (access token, refresh token, auth code) for storage.
 */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex')
}

/**
 * Generate a cryptographically secure random token.
 */
export function generateToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url')
}

/**
 * Generate a client ID for Dynamic Client Registration.
 */
export function generateClientId(): string {
  return `mcp_${crypto.randomBytes(16).toString('hex')}`
}

function getServiceClient(headers?: Record<string, string>) {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false }, ...(headers ? { global: { headers } } : {}) },
  )
}

/**
 * Authenticate an MCP request using an OAuth Bearer token.
 * Returns the user ID, active workspace ID, and a Supabase service client.
 *
 * Throws a Response on auth failure.
 */
export async function authenticateMcpRequest(request: Request): Promise<{
  userId: string
  workspaceId: string
  supabase: any
  /** OAuth scopes granted to this token. Empty = legacy full-access token. */
  scopes: string[]
  /** mcp_oauth_token row id, for audit logging. */
  tokenId: string | null
}> {
  const authHeader = request.headers.get('authorization') || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  const baseUrl = mcpBaseUrl(request, process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000')

  if (!token) {
    throw new Response(
      JSON.stringify({
        error: 'unauthorized',
        error_description: 'Missing Authorization header. The MCP server requires OAuth authentication.',
      }),
      { status: 401, headers: { 'Content-Type': 'application/json', 'WWW-Authenticate': `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource/api/mcp"` } },
    )
  }

  const tokenHash = hashToken(token)
  const serviceClient = getServiceClient()

  const { data: tokenRecord, error } = await serviceClient
    .from('mcp_oauth_token')
    .select('id, user_id, client_id, scopes, active_workspace_id, expires_at')
    .eq('access_token_hash', tokenHash)
    .single()

  if (error || !tokenRecord) {
    throw new Response(
      JSON.stringify({ error: 'invalid_token', error_description: 'Invalid or expired access token.' }),
      { status: 401, headers: { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer error="invalid_token"' } },
    )
  }

  // Check expiry
  if (new Date(tokenRecord.expires_at) < new Date()) {
    throw new Response(
      JSON.stringify({ error: 'invalid_token', error_description: 'Access token has expired. Use a refresh token to obtain a new one.' }),
      { status: 401, headers: { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer error="invalid_token"' } },
    )
  }

  // Update last_used_at (fire-and-forget)
  serviceClient
    .from('mcp_oauth_token')
    .update({ last_used_at: new Date().toISOString() })
    .eq('access_token_hash', tokenHash)
    .then(() => {})

  // Resolve workspace: active_workspace_id, falling back to the user's first
  // workspace.
  let workspaceId = tokenRecord.active_workspace_id as string | null

  // The token's workspace must still be one the user is a member of. A member
  // who leaves (POST /api/account/workspace/leave) or is removed keeps their
  // tokens, and every tool runs on this SERVICE client, so without this a
  // connector kept reading and writing a workspace its user had left. It falls
  // back to the user's first workspace, as with no active one. A failed check
  // refuses, never lets through.
  if (workspaceId) {
    const { data: stillMember, error: memberError } = await serviceClient
      .from('member')
      .select('id')
      .eq('user_id', tokenRecord.user_id)
      .eq('workspace_id', workspaceId)
      .maybeSingle()
    if (memberError) {
      throw new Response(
        JSON.stringify({ error: 'temporarily_unavailable', error_description: 'Could not check workspace membership. Try again.' }),
        { status: 503, headers: { 'Content-Type': 'application/json' } },
      )
    }
    if (!stillMember) workspaceId = null
  }

  if (!workspaceId) {
    const { data: membership } = await serviceClient
      .from('member')
      .select('workspace_id')
      .eq('user_id', tokenRecord.user_id)
      .order('created_at', { ascending: true })
      .limit(1)
      .single()

    workspaceId = membership?.workspace_id || null
  }

  if (!workspaceId) {
    throw new Response(
      JSON.stringify({ error: 'no_workspace', error_description: `User has no workspace. Create one at ${appHost()}.` }),
      { status: 403, headers: { 'Content-Type': 'application/json' } },
    )
  }

  return {
    userId: tokenRecord.user_id as string,
    workspaceId,
    // The tools' client: what a connector changes is credited to an agent
    // working for this person in the activity log (migration 488).
    supabase: getServiceClient(agentActivityHeaders(tokenRecord.user_id as string)),
    scopes: (tokenRecord.scopes as string[] | null) ?? [],
    tokenId: (tokenRecord.id as string | null) ?? null,
  }
}

/**
 * Update the active workspace for an OAuth token.
 * Called by the ni_set_workspace tool.
 */
export async function setActiveWorkspace(accessTokenHash: string, workspaceId: string): Promise<void> {
  const serviceClient = getServiceClient()
  const { error } = await serviceClient
    .from('mcp_oauth_token')
    .update({ active_workspace_id: workspaceId })
    .eq('access_token_hash', accessTokenHash)
  // Throw on a real write failure so the caller (ni_set_workspace) can report
  // it instead of returning a false success.
  if (error) {
    throw new Error(`Failed to persist active workspace: ${error.message}`)
  }
}

/**
 * Verify PKCE code challenge (S256 method).
 */
export function verifyPkce(codeVerifier: string, codeChallenge: string): boolean {
  const computed = crypto
    .createHash('sha256')
    .update(codeVerifier)
    .digest('base64url')
  return computed === codeChallenge
}
