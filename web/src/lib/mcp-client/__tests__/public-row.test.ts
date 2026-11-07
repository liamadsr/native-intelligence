/**
 * The settings routes return a connected server's public columns only, with
 * approval_free_tools read optionally: before migration 339 runs the column
 * is absent, reads as [], and Settings > MCP keeps working.
 */
import { describe, expect, it } from 'vitest'
import { isMissingColumnError, publicMcpServer } from '../public-row'

const row = {
  id: 's1', display_name: 'Linear', server_url: 'https://mcp.linear.app', transport: 'streamable_http', auth_type: 'oauth2',
  is_enabled: true, disabled_tools: [], require_approval_tools: ['create_issue'], tools_cache: [], tools_cache_refreshed_at: null,
  last_health_check_at: null, last_error: null, token_expires_at: null, created_at: '2026-10-15',
  access_token_encrypted: 'secret', refresh_token_encrypted: 'secret', oauth_metadata: { client_id: 'x' }, user_id: 'u',
}

describe('publicMcpServer', () => {
  it('never returns the tokens or OAuth metadata', () => {
    const out = publicMcpServer(row)!
    for (const key of ['access_token_encrypted', 'refresh_token_encrypted', 'oauth_metadata', 'user_id']) expect(out).not.toHaveProperty(key)
    expect(out).toMatchObject({ id: 's1', display_name: 'Linear', require_approval_tools: ['create_issue'] })
  })

  it('reads approval_free_tools when the column exists, and [] before migration 339', () => {
    expect(publicMcpServer({ ...row, approval_free_tools: ['merge_pr'] })!.approval_free_tools).toEqual(['merge_pr'])
    expect(publicMcpServer(row)!.approval_free_tools).toEqual([])
    expect(publicMcpServer(null)).toBeNull()
  })
})

describe('isMissingColumnError', () => {
  it('spots a missing approval_free_tools column, and nothing else', () => {
    expect(isMissingColumnError({ code: '42703', message: 'column connected_mcp_server.approval_free_tools does not exist' }, 'approval_free_tools')).toBe(true)
    expect(isMissingColumnError({ code: 'PGRST204', message: "Could not find the 'approval_free_tools' column of 'connected_mcp_server'" }, 'approval_free_tools')).toBe(true)
    expect(isMissingColumnError({ code: '23505', message: 'duplicate key' }, 'approval_free_tools')).toBe(false)
    expect(isMissingColumnError(null, 'approval_free_tools')).toBe(false)
  })
})
