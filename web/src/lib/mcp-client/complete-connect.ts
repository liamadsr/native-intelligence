/**
 * The second half of an MCP connector's OAuth connect, after the state row
 * was consumed and its completion bound to the person who started it
 * (src/lib/mcp-client/oauth-binding.ts): exchange the code at the remembered
 * token endpoint, probe tools/list, then encrypt and persist (a new
 * connected_mcp_server row, or, for a reconnect (reconnectTarget), the
 * person's existing row, in place).
 *
 * Shared by the web callback (src/app/api/mcp-oauth/callback/route.ts) and
 * the desktop claim (src/app/api/account/mcp-servers/oauth/claim/route.ts).
 * Moved verbatim from the callback (security review 2026-10-31); each former
 * popup redirect is now a result the caller renders.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { decryptCredentialOrNull, encryptCredential } from '@/lib/crypto/credentials'
import { exchangeCodeForTokens } from '@/lib/mcp-client/oauth'
import { listTools } from '@/lib/mcp-client'
import type { ConnectedMcpServerRow } from '@/lib/mcp-client/types'
import { initialRequireApprovalTools, seedAllowedTools } from '@/lib/mcp-client/tool-access'
import { suggestedMcpServerFor } from '@/lib/mcp-client/suggested'
import { isMissingColumnError } from '@/lib/mcp-client/public-row'
import { reconnectTarget, type ExistingMcpServer } from '@/lib/mcp-client/reconnect'

/** A consumed `external_mcp_oauth_state` row (its columns as the start route writes them, migration 100). */
export interface McpOAuthStateRow {
  state: string
  user_id: string
  workspace_id: string
  display_name: string
  server_url: string
  transport: 'streamable_http' | 'sse'
  authorization_endpoint: string
  token_endpoint: string
  registration_endpoint: string | null
  client_id: string
  client_secret: string | null
  scopes: string[]
  redirect_uri: string
  code_verifier: string
  expires_at: string
}

export type CompleteMcpConnectResult =
  | { ok: true; name: string; toolCount: number }
  | { ok: false; error: string }

export async function completeMcpConnect(
  svc: SupabaseClient,
  stateRow: McpOAuthStateRow,
  code: string,
): Promise<CompleteMcpConnectResult> {
  const fail = (error: string): CompleteMcpConnectResult => ({ ok: false, error })

  // Exchange code for tokens. The client_secret stored in the state
  // row is encrypted; decrypt before passing to the provider.
  let tokens
  try {
    const clientSecret = decryptCredentialOrNull(stateRow.client_secret) ?? undefined
    tokens = await exchangeCodeForTokens({
      token_endpoint: stateRow.token_endpoint,
      client_id: stateRow.client_id,
      client_secret: clientSecret,
      code,
      code_verifier: stateRow.code_verifier,
      redirect_uri: stateRow.redirect_uri,
    })
  } catch (err) {
    return fail(err instanceof Error ? err.message : 'Token exchange failed')
  }

  // Encrypt + persist. Wrapped in try/catch so a missing
  // CREDENTIAL_ENCRYPTION_KEY (or any other late-stage failure)
  // surfaces as a result instead of bubbling up as a raw error.
  let access_token_encrypted: string
  let refresh_token_encrypted: string | null
  let client_secret_encrypted: string | null = null
  try {
    access_token_encrypted = encryptCredential(tokens.access_token)
    refresh_token_encrypted = tokens.refresh_token
      ? encryptCredential(tokens.refresh_token)
      : null
    // A secret the server issued at registration: its token endpoint wants it
    // on every refresh too (GEN-1171), so it is kept, encrypted (the state
    // row's copy is already encrypted with the same key).
    if (decryptCredentialOrNull(stateRow.client_secret)) client_secret_encrypted = stateRow.client_secret
  } catch (err) {
    return fail(err instanceof Error ? `Credential encryption failed: ${err.message}` : 'Credential encryption failed')
  }
  const token_expires_at = tokens.expires_in
    ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
    : null

  // Probe tools/list before saving — same contract as the manual add path.
  const probeServer: ConnectedMcpServerRow = {
    id: 'probe',
    user_id: stateRow.user_id,
    workspace_id: stateRow.workspace_id,
    display_name: stateRow.display_name,
    server_url: stateRow.server_url,
    transport: stateRow.transport,
    auth_type: 'oauth2',
    access_token_encrypted,
    refresh_token_encrypted,
    token_expires_at,
    oauth_metadata: {
      authorization_endpoint: stateRow.authorization_endpoint,
      token_endpoint: stateRow.token_endpoint,
      registration_endpoint: stateRow.registration_endpoint,
      client_id: stateRow.client_id,
      ...(client_secret_encrypted ? { client_secret_encrypted } : {}),
      scopes: stateRow.scopes,
    },
    is_enabled: true,
    disabled_tools: [],
    // Empty: no explicit choice yet, so the default policy applies (every tool
    // that is not read-only needs approval, src/lib/mcp-client/approval-policy.ts).
    require_approval_tools: [],
    tools_cache: null,
    tools_cache_refreshed_at: null,
    last_health_check_at: null,
    last_error: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }

  let tools: { name: string; description?: string }[] = []
  let probeError: string | null = null
  try {
    tools = await listTools(probeServer)
  } catch (err) {
    probeError = err instanceof Error ? err.message : String(err)
  }

  const nowIso = new Date().toISOString()

  // A reconnect renews the person's existing row in place: its own URL and
  // its tool choices (allowed, off, approvals) stay, the tools listed now
  // refresh its cache (one it didn't have yet stays new, hidden), and its mark
  // clears. A row whose allow-list was never seeded is seeded now, as
  // refresh-tools does.
  const { data: existingRows } = await svc
    .from('connected_mcp_server')
    .select('*')
    .eq('user_id', stateRow.user_id)
  const target = reconnectTarget((existingRows ?? []) as ExistingMcpServer[], stateRow) as
    | (ExistingMcpServer & { allowed_tools?: string[] | null; require_approval_tools?: string[] | null })
    | null
  if (target) {
    const allowed = probeError ? null : seedAllowedTools(target.allowed_tools, tools)
    const seeding = !Array.isArray(target.allowed_tools) && Array.isArray(allowed)
    const renewed: Record<string, unknown> = {
      auth_type: 'oauth2',
      access_token_encrypted,
      refresh_token_encrypted,
      token_expires_at,
      oauth_metadata: probeServer.oauth_metadata,
      last_health_check_at: nowIso,
      last_error: probeError,
      ...(probeError ? {} : { tools_cache: tools, tools_cache_refreshed_at: nowIso }),
      ...(seeding
        ? {
            allowed_tools: allowed,
            require_approval_tools: [
              ...new Set([...(target.require_approval_tools ?? []), ...initialRequireApprovalTools(!!suggestedMcpServerFor(target.server_url), tools)]),
            ],
          }
        : {}),
    }
    const update = (payload: Record<string, unknown>) => svc.from('connected_mcp_server').update(payload).eq('id', target.id).eq('user_id', stateRow.user_id)
    let { error: updateErr } = await update({ ...renewed, reauth_required_at: null })
    // Before migration 451: the renewed sign-in alone.
    if (updateErr && isMissingColumnError(updateErr, 'reauth_required_at')) {
      ;({ error: updateErr } = await update(renewed))
    }
    if (updateErr) return fail(updateErr.message)
    return { ok: true, name: target.display_name, toolCount: tools.length }
  }

  const { error: insertErr } = await svc.from('connected_mcp_server').insert({
    user_id: stateRow.user_id,
    workspace_id: stateRow.workspace_id,
    display_name: stateRow.display_name,
    server_url: stateRow.server_url,
    transport: stateRow.transport,
    auth_type: 'oauth2',
    access_token_encrypted,
    refresh_token_encrypted,
    token_expires_at,
    oauth_metadata: probeServer.oauth_metadata,
    tools_cache: tools,
    tools_cache_refreshed_at: nowIso,
    last_health_check_at: nowIso,
    last_error: probeError,
    // The tools listed now are the ones the person connected; one the server
    // adds later stays new until they add it (migration 396).
    allowed_tools: seedAllowedTools(null, tools),
    // A server we don't know (not in the catalog) starts with every tool that
    // is not a plain read asking first (decision 23); a catalog one follows
    // the default policy.
    require_approval_tools: initialRequireApprovalTools(!!suggestedMcpServerFor(stateRow.server_url), tools),
  })

  if (insertErr) {
    return fail(
      insertErr.code === '23505'
        ? `You already have a connected MCP server with the name "${stateRow.display_name}" (or a very similar one).`
        : insertErr.message,
    )
  }

  return { ok: true, name: stateRow.display_name, toolCount: tools.length }
}
