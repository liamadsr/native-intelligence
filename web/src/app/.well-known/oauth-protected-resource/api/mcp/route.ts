import { NextResponse } from 'next/server'

/**
 * GET /.well-known/oauth-protected-resource/api/mcp
 *
 * OAuth 2.0 Protected Resource Metadata (RFC 9728).
 * Claude Code reads this first to discover which authorization server protects /api/mcp.
 */
export async function GET() {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://dial8.ai'

  return NextResponse.json({
    resource: `${baseUrl}/api/mcp`,
    authorization_servers: [baseUrl],
    scopes_supported: ['read', 'write'],
    resource_name: 'Dial8 MCP Server',
    resource_documentation: `${baseUrl}/docs/mcp`,
  })
}
