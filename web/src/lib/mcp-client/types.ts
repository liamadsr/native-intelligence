import type { McpToolAnnotations } from './approval-policy'

/**
 * Shape of a row in the connected_mcp_server table after the credential
 * fields have been resolved (decrypted) for use by the client module.
 *
 * Never serialize this to a response — the access_token is plaintext here.
 */
export interface ConnectedMcpServerRow {
  id: string
  user_id: string
  workspace_id: string | null
  display_name: string
  server_url: string
  transport: 'streamable_http' | 'sse'
  auth_type: 'none' | 'bearer' | 'oauth2'
  access_token_encrypted: string | null
  refresh_token_encrypted: string | null
  token_expires_at: string | null
  oauth_metadata: Record<string, unknown> | null
  is_enabled: boolean
  disabled_tools: string[]
  require_approval_tools: string[]
  /**
   * Tools the person explicitly runs without approval (migration 339; see
   * approval-policy.ts). Optional: absent until that migration is applied.
   */
  approval_free_tools?: string[]
  /**
   * The tools the person has seen and kept (migration 396; tool-access.ts):
   * a listed tool not here is new and hidden. Null: not seeded yet.
   */
  allowed_tools?: string[] | null
  tools_cache: McpToolDescriptor[] | null
  /**
   * Request headers the transport sends to this server. Never a column: only a
   * server Dial8 builds itself has them (github-integration.ts, GitHub's
   * toolsets). Never Authorization, which is the token's alone.
   */
  extra_headers?: Readonly<Record<string, string>>
  tools_cache_refreshed_at: string | null
  last_health_check_at: string | null
  last_error: string | null
  /**
   * When the provider refused this server's refresh token for good (migration
   * 450, token-refresh.ts): it needs the person to sign in again. Null:
   * healthy. Optional: absent until that migration is applied.
   */
  reauth_required_at?: string | null
  /** A refresh in flight holds this lease until then (migration 451, token-refresh.ts). */
  refresh_lease_until?: string | null
  created_at: string
  updated_at: string
}

/** Subset of the MCP tools/list response shape we care about. */
export interface McpToolDescriptor {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
  /** The server's hints (readOnlyHint decides approval, approval-policy.ts). Absent on a cache from before 2026-10-15. */
  annotations?: McpToolAnnotations
}

/** Result of a tools/call invocation, normalized. */
export interface McpCallToolResult {
  content: unknown
  isError: boolean
}
