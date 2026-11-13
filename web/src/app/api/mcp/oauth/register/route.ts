import { NextResponse } from 'next/server'
import { createStatelessClient } from '@/lib/supabase/stateless'
import { generateClientId } from '@/lib/mcp/auth'
import { isAllowedRedirectUri } from '@/lib/mcp/redirect-uri'

/**
 * POST /api/mcp/oauth/register — Dynamic Client Registration (RFC 7591).
 *
 * MCP clients (Claude Code, Cursor, etc.) call this to register themselves
 * before starting the OAuth flow. Returns a client_id they use for authorization:
 * always `mcp_…`, never an https URL, which would name a client metadata
 * document instead (lib/mcp/client-metadata.ts).
 */
export async function POST(request: Request) {
  try {
    const body = await request.json()

    const redirectUris = body.redirect_uris
    if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
      return NextResponse.json(
        { error: 'invalid_client_metadata', error_description: 'redirect_uris is required' },
        { status: 400 },
      )
    }

    // Validate redirect URIs
    for (const uri of redirectUris) {
      if (!isAllowedRedirectUri(uri)) {
        return NextResponse.json(
          { error: 'invalid_redirect_uri', error_description: `Invalid redirect URI: ${uri}` },
          { status: 400 },
        )
      }
    }

    const clientId = generateClientId()
    const clientName = body.client_name || 'MCP Client'
    const grantTypes = body.grant_types || ['authorization_code', 'refresh_token']
    const tokenEndpointAuthMethod = body.token_endpoint_auth_method || 'none'

    const supabase = createStatelessClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    )

    const { error } = await supabase
      .from('mcp_oauth_client')
      .insert({
        client_id: clientId,
        redirect_uris: redirectUris,
        client_name: clientName,
        grant_types: grantTypes,
        token_endpoint_auth_method: tokenEndpointAuthMethod,
      })

    if (error) {
      console.error('Failed to register MCP OAuth client:', error)
      return NextResponse.json(
        { error: 'server_error', error_description: 'Failed to register client' },
        { status: 500 },
      )
    }

    return NextResponse.json({
      client_id: clientId,
      client_name: clientName,
      redirect_uris: redirectUris,
      grant_types: grantTypes,
      token_endpoint_auth_method: tokenEndpointAuthMethod,
    }, { status: 201 })
  } catch {
    return NextResponse.json(
      { error: 'invalid_client_metadata', error_description: 'Invalid request body' },
      { status: 400 },
    )
  }
}
