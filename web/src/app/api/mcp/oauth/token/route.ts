import { NextResponse } from 'next/server'
import { createStatelessClient } from '@/lib/supabase/stateless'
import { generateToken, hashToken, verifyPkce } from '@/lib/mcp/auth'
import { sameRedirectUri } from '@/lib/mcp/oauth-client'

const ACCESS_TOKEN_TTL_SECONDS = 14 * 24 * 3600  // 14 days
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 3600  // 30 days

/**
 * POST /api/mcp/oauth/token — OAuth 2.1 Token Endpoint.
 *
 * Supports:
 * - grant_type=authorization_code — exchange auth code for access + refresh tokens
 * - grant_type=refresh_token — exchange refresh token for new access token
 */
export async function POST(request: Request) {
  const contentType = request.headers.get('content-type') || ''

  let params: Record<string, string>
  if (contentType.includes('application/x-www-form-urlencoded')) {
    const text = await request.text()
    params = Object.fromEntries(new URLSearchParams(text))
  } else if (contentType.includes('application/json')) {
    let body: unknown
    try {
      body = await request.json()
    } catch {
      body = null
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json(
        { error: 'invalid_request', error_description: 'Request body must be a JSON object' },
        { status: 400 },
      )
    }
    params = body as Record<string, string>
  } else {
    // Try form-encoded as default (OAuth spec default)
    const text = await request.text()
    params = Object.fromEntries(new URLSearchParams(text))
  }

  const grantType = params.grant_type

  if (grantType === 'authorization_code') {
    return handleAuthorizationCodeGrant(params)
  }

  if (grantType === 'refresh_token') {
    return handleRefreshTokenGrant(params)
  }

  return NextResponse.json(
    { error: 'unsupported_grant_type', error_description: 'Supported: authorization_code, refresh_token' },
    { status: 400 },
  )
}

async function handleAuthorizationCodeGrant(params: Record<string, string>) {
  const { code, client_id, code_verifier, redirect_uri } = params

  if (!code || !client_id || !code_verifier) {
    return NextResponse.json(
      { error: 'invalid_request', error_description: 'Missing required parameters: code, client_id, code_verifier' },
      { status: 400 },
    )
  }

  const supabase = createStatelessClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  )

  // Look up the authorization code
  const { data: authCode, error } = await supabase
    .from('mcp_auth_code')
    .select('*')
    .eq('code', code)
    .eq('client_id', client_id)
    .eq('consumed', false)
    .single()

  if (error || !authCode) {
    return NextResponse.json(
      { error: 'invalid_grant', error_description: 'Invalid or expired authorization code' },
      { status: 400 },
    )
  }

  // Check expiry
  if (new Date(authCode.expires_at) < new Date()) {
    // Mark as consumed to prevent replay
    await supabase.from('mcp_auth_code').update({ consumed: true }).eq('code', code)
    return NextResponse.json(
      { error: 'invalid_grant', error_description: 'Authorization code has expired' },
      { status: 400 },
    )
  }

  // Verify redirect_uri matches (a loopback callback may come back as its localhost form, see sameRedirectUri)
  if (redirect_uri && !sameRedirectUri(redirect_uri, authCode.redirect_uri)) {
    return NextResponse.json(
      { error: 'invalid_grant', error_description: 'redirect_uri does not match' },
      { status: 400 },
    )
  }

  // Verify PKCE
  if (!verifyPkce(code_verifier, authCode.code_challenge)) {
    return NextResponse.json(
      { error: 'invalid_grant', error_description: 'PKCE verification failed' },
      { status: 400 },
    )
  }

  // Claim the code atomically: only the request that flips consumed from
  // false wins. Two concurrent exchanges of one code both pass the read above,
  // and a code must be single-use (RFC 6749 4.1.2).
  const { data: claimed, error: claimError } = await supabase
    .from('mcp_auth_code')
    .update({ consumed: true })
    .eq('code', code)
    .eq('consumed', false)
    .select('code')

  if (claimError) {
    console.error('Failed to consume MCP authorization code:', claimError)
    return NextResponse.json(
      { error: 'server_error', error_description: 'Failed to consume authorization code' },
      { status: 500 },
    )
  }
  if (!claimed || claimed.length === 0) {
    return NextResponse.json(
      { error: 'invalid_grant', error_description: 'Invalid or expired authorization code' },
      { status: 400 },
    )
  }

  // Generate tokens
  const accessToken = generateToken()
  const refreshToken = generateToken()

  const { error: tokenError } = await supabase
    .from('mcp_oauth_token')
    .insert({
      user_id: authCode.user_id,
      client_id: client_id,
      access_token_hash: hashToken(accessToken),
      refresh_token_hash: hashToken(refreshToken),
      scopes: authCode.scopes,
      expires_at: new Date(Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000).toISOString(),
    })

  if (tokenError) {
    console.error('Failed to create MCP OAuth token:', tokenError)
    return NextResponse.json(
      { error: 'server_error', error_description: 'Failed to create token' },
      { status: 500 },
    )
  }

  return NextResponse.json({
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: refreshToken,
    scope: (authCode.scopes as string[]).join(' '),
  })
}

async function handleRefreshTokenGrant(params: Record<string, string>) {
  const { refresh_token, client_id } = params

  if (!refresh_token || !client_id) {
    return NextResponse.json(
      { error: 'invalid_request', error_description: 'Missing required parameters: refresh_token, client_id' },
      { status: 400 },
    )
  }

  const supabase = createStatelessClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  )

  const refreshHash = hashToken(refresh_token)

  // Look up the existing token by refresh token hash
  const { data: existingToken, error } = await supabase
    .from('mcp_oauth_token')
    .select('*')
    .eq('refresh_token_hash', refreshHash)
    .eq('client_id', client_id)
    .single()

  if (error || !existingToken) {
    return NextResponse.json(
      { error: 'invalid_grant', error_description: 'Invalid refresh token' },
      { status: 400 },
    )
  }

  // Enforce the refresh token's own lifetime. Access and refresh tokens are
  // always minted together, so the refresh token was issued at
  // expires_at - ACCESS_TTL and expires REFRESH_TTL after that. Each refresh
  // rotates both, so this is a sliding idle window.
  const refreshExpiresMs =
    new Date(existingToken.expires_at as string).getTime() +
    (REFRESH_TOKEN_TTL_SECONDS - ACCESS_TOKEN_TTL_SECONDS) * 1000
  if (!(refreshExpiresMs > Date.now())) {
    return NextResponse.json(
      { error: 'invalid_grant', error_description: 'Refresh token expired' },
      { status: 400 },
    )
  }

  // Generate new access token (rotate refresh token too for security)
  const newAccessToken = generateToken()
  const newRefreshToken = generateToken()

  // Rotate only if the refresh token is still the one presented: of two
  // concurrent refreshes with one token, the loser matches no row instead of
  // overwriting the winner's hashes and handing back dead tokens.
  const { data: rotated, error: updateError } = await supabase
    .from('mcp_oauth_token')
    .update({
      access_token_hash: hashToken(newAccessToken),
      refresh_token_hash: hashToken(newRefreshToken),
      expires_at: new Date(Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000).toISOString(),
      last_used_at: new Date().toISOString(),
    })
    .eq('id', existingToken.id)
    .eq('refresh_token_hash', refreshHash)
    .select('id')

  if (updateError) {
    console.error('Failed to refresh MCP OAuth token:', updateError)
    return NextResponse.json(
      { error: 'server_error', error_description: 'Failed to refresh token' },
      { status: 500 },
    )
  }
  if (!rotated || rotated.length === 0) {
    return NextResponse.json(
      { error: 'invalid_grant', error_description: 'Invalid refresh token' },
      { status: 400 },
    )
  }

  return NextResponse.json({
    access_token: newAccessToken,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: newRefreshToken,
    scope: (existingToken.scopes as string[]).join(' '),
  })
}
