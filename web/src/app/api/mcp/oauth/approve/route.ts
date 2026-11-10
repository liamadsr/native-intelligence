import { NextResponse } from 'next/server'
import crypto from 'crypto'
import { createClient } from '@supabase/supabase-js'
import { requireUser } from '@/lib/api-auth'
import { checkMcpClient, saveMetadataClient } from '@/lib/mcp/oauth-client'
import { grantedScopes } from '@/lib/mcp/scopes'

/**
 * POST /api/mcp/oauth/approve — Called when the user clicks "Allow" on the consent page.
 * Generates an authorization code and redirects back to the MCP client.
 *
 * Auth: requireUser() (cookie OR `Authorization: Bearer` Supabase access token),
 * the same as every Native Intelligence API route. The browser consent page sends a cookie;
 * the desktop app's webview carries no nativeintelligence.dev cookie, so a consent page
 * opened there authenticates with the Bearer header its fetch adds.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json()
    const { client_id, redirect_uri, code_challenge, code_challenge_method, scope, state } = body

    if (!client_id || !redirect_uri || !code_challenge) {
      return NextResponse.json({ error: 'Missing required parameters' }, { status: 400 })
    }
    // The same rule as authorize (the consent page's query is anyone's to
    // write), checked before anything is fetched or saved.
    const scopes = grantedScopes(scope)
    if (!scopes) return NextResponse.json({ error: 'Supported scopes: read, write' }, { status: 400 })

    // Verify user is authenticated (cookie or Bearer).
    const auth = await requireUser()
    if (auth instanceof Response) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }
    const { user } = auth

    // Verify client exists and redirect_uri matches
    const serviceClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    )

    // The consent page navigates to the returned URL, so the same check as
    // authorize and deny: a registered URI, never a script/data scheme.
    const checked = await checkMcpClient(serviceClient, client_id, redirect_uri, { requester: user.id })
    if (!checked.ok) {
      return NextResponse.json({ error: checked.error === 'invalid_client' ? 'Invalid client' : 'Invalid redirect_uri' }, { status: 400 })
    }
    const validRedirectUri = checked.redirectUri

    // A client named by its metadata document becomes a row now, as the
    // person says yes: the code and token rows point at it.
    if (checked.client.metadata && !(await saveMetadataClient(serviceClient, checked.client.metadata))) {
      return NextResponse.json({ error: 'Failed to generate authorization code' }, { status: 500 })
    }

    // Generate authorization code
    const authCode = crypto.randomBytes(32).toString('base64url')

    const { error: insertError } = await serviceClient
      .from('mcp_auth_code')
      .insert({
        code: authCode,
        client_id,
        user_id: user.id,
        redirect_uri: validRedirectUri,
        code_challenge,
        code_challenge_method: code_challenge_method || 'S256',
        scopes,
        expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      })

    if (insertError) {
      console.error('Failed to create auth code:', insertError)
      return NextResponse.json({ error: 'Failed to generate authorization code' }, { status: 500 })
    }

    // Build the redirect URL
    const callbackUrl = new URL(validRedirectUri)
    callbackUrl.searchParams.set('code', authCode)
    if (state) callbackUrl.searchParams.set('state', state)

    return NextResponse.json({ redirect_url: callbackUrl.toString() })
  } catch (err) {
    console.error('MCP OAuth approve error:', err)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
