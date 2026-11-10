import { NextResponse } from 'next/server'
import { mcpBaseUrl } from '@/lib/mcp/base-url'

/**
 * GET /.well-known/oauth-protected-resource/api/mcp
 *
 * OAuth 2.0 Protected Resource Metadata (RFC 9728).
 * Claude Code reads this first to discover which authorization server protects /api/mcp.
 */
export async function GET(request: Request) {
  const baseUrl = mcpBaseUrl(request)

  return NextResponse.json({
    resource: `${baseUrl}/api/mcp`,
    authorization_servers: [baseUrl],
    scopes_supported: ['read', 'write'],
    resource_name: 'Native Intelligence MCP Server',
    resource_documentation: `${baseUrl}/docs/mcp`,
  })
}
