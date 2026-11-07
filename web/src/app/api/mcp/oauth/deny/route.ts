import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { requireUser } from '@/lib/api-auth'
import { checkMcpClient, oauthErrorUrl } from '@/lib/mcp/oauth-client'

/**
 * POST /api/mcp/oauth/deny — Called when the user clicks "Deny" on the
 * consent page (src/app/mcp/authorize/page.tsx). Answers where to send the
 * browser: the client's own redirect_uri with `error=access_denied`, but only
 * once the client is known and the URI is one it registered, as approve
 * checks. The consent page used to send the browser to the raw `redirect_uri`
 * query param, so any link to /mcp/authorize was a one-click open redirect.
 *
 * Auth: requireUser() (cookie OR `Authorization: Bearer`), as approve.
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { client_id?: unknown; redirect_uri?: unknown; state?: unknown }
    const clientId = typeof body.client_id === 'string' ? body.client_id : null
    const redirectUri = typeof body.redirect_uri === 'string' ? body.redirect_uri : null
    const state = typeof body.state === 'string' && body.state ? body.state : null

    const auth = await requireUser()
    if (auth instanceof Response) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }
    const { user } = auth

    const serviceClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    )
    const checked = await checkMcpClient(serviceClient, clientId, redirectUri, { requester: user.id })
    if (!checked.ok) {
      return NextResponse.json({ error: checked.error, error_description: checked.description }, { status: 400 })
    }

    const redirectUrl = oauthErrorUrl(checked.redirectUri, 'access_denied', 'User denied the authorization request', state)
    if (!redirectUrl) return NextResponse.json({ error: 'Invalid redirect_uri' }, { status: 400 })
    return NextResponse.json({ redirect_url: redirectUrl })
  } catch (err) {
    console.error('MCP OAuth deny error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
