import { NextResponse } from 'next/server'
import { createStatelessClient } from '@/lib/supabase/stateless'
import { createClient as createServerClient } from '@/lib/supabase/server'
import { clientIdUrlProblem, isMetadataClientId } from '@/lib/mcp/client-metadata'
import { mcpBaseUrl } from '@/lib/mcp/base-url'
import { checkMcpClient } from '@/lib/mcp/oauth-client'
import { grantedScopes } from '@/lib/mcp/scopes'

/**
 * GET /api/mcp/oauth/authorize — OAuth 2.1 Authorization Endpoint.
 *
 * Validates the OAuth params, checks the user is logged in,
 * then redirects to the branded consent page at /mcp/authorize.
 *
 * Nothing here redirects to the client. A registered redirect_uri is not a
 * trusted one (/register is open, and a metadata document is anyone's to
 * publish), so a request error is a 400 on Native Intelligence's own page, never a bounce
 * to the client's URI: that would send a browser to any registered site with
 * no consent shown (RFC 9700 §4.11.2). Only the person's Allow or Deny on the
 * consent page sends them back to the client.
 */
export async function GET(request: Request) {
  const url = new URL(request.url)
  const clientId = url.searchParams.get('client_id')
  const redirectUri = url.searchParams.get('redirect_uri')
  const codeChallenge = url.searchParams.get('code_challenge')
  const codeChallengeMethod = url.searchParams.get('code_challenge_method') || 'S256'
  const state = url.searchParams.get('state')
  // Only `read` and `write` (write brings read): anything else is dropped here, and a request for neither is refused below.
  const scopes = grantedScopes(url.searchParams.get('scope'))

  // Check if user is authenticated (Supabase session via cookies)
  const supabase = await createServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  const baseUrl = mcpBaseUrl(request, process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000')
  // User is not logged in — redirect to Native Intelligence login page with return URL
  const toLogin = () => NextResponse.redirect(`${baseUrl}/login?redirect=${encodeURIComponent(request.url)}`)

  // A client named by its metadata document (an https client_id) is fetched
  // only for a signed-in person: an anonymous request can't make Native Intelligence fetch
  // URLs. Until then only the URL's shape is checked, and the only redirect
  // is to Native Intelligence's own login, which comes back here.
  if (clientId && isMetadataClientId(clientId) && !user) {
    const problem = clientIdUrlProblem(clientId)
    if (problem) return NextResponse.json({ error: 'invalid_client', error_description: problem }, { status: 400 })
    if (!redirectUri) {
      return NextResponse.json({ error: 'invalid_request', error_description: 'Missing required parameters: client_id, redirect_uri' }, { status: 400 })
    }
    return toLogin()
  }

  // The client and its redirect_uri first, before anything redirects
  // (RFC 6749 §4.1.2.1): until a registered client says the URI is its own,
  // an error is a 400 here, never a redirect to whatever the URL named. This
  // path is one a sign-in may resume (src/lib/auth/login-redirect.ts), so an
  // unchecked redirect_uri made it an open redirect.
  const serviceClient = createStatelessClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  )
  const checked = await checkMcpClient(serviceClient, clientId, redirectUri, user ? { requester: user.id } : {})
  if (!checked.ok) {
    return NextResponse.json({ error: checked.error, error_description: checked.description }, { status: 400 })
  }
  const { client } = checked
  // The URI the client registered, for the consent page (for a 127.0.0.1
  // callback, not the localhost this request reads, see checkMcpClient).
  const validRedirectUri = checked.redirectUri

  if (!codeChallenge) {
    return NextResponse.json({ error: 'invalid_request', error_description: 'Missing required parameter: code_challenge' }, { status: 400 })
  }

  if (codeChallengeMethod !== 'S256') {
    return NextResponse.json({ error: 'invalid_request', error_description: 'Only S256 code challenge method is supported' }, { status: 400 })
  }

  if (!scopes) {
    return NextResponse.json({ error: 'invalid_scope', error_description: 'Supported scopes: read, write' }, { status: 400 })
  }

  if (!user) return toLogin()

  // User is authenticated — redirect to branded consent page. Its name and
  // publisher it asks the server for (client-info), never from this URL.
  const consentParams = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: validRedirectUri,
    code_challenge: codeChallenge,
    code_challenge_method: codeChallengeMethod,
    scope: scopes.join(' '),
    ...(state && { state }),
  })

  return NextResponse.redirect(`${baseUrl}/mcp/authorize?${consentParams}`)
}
