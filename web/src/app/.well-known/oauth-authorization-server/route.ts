import { NextResponse } from 'next/server'
import { mcpBaseUrl } from '@/lib/mcp/base-url'

/**
 * GET /.well-known/oauth-authorization-server
 *
 * OAuth 2.0 Authorization Server Metadata (RFC 8414).
 * Claude Code reads this to discover our OAuth endpoints.
 */
export async function GET(request: Request) {
  const baseUrl = mcpBaseUrl(request)

  return NextResponse.json({
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/api/mcp/oauth/authorize`,
    token_endpoint: `${baseUrl}/api/mcp/oauth/token`,
    registration_endpoint: `${baseUrl}/api/mcp/oauth/register`,
    // An app may name itself with an https URL to its metadata document
    // instead of registering (lib/mcp/client-metadata.ts).
    client_id_metadata_document_supported: true,
    scopes_supported: ['read', 'write'],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    service_documentation: `${baseUrl}/docs/mcp`,
  })
}
