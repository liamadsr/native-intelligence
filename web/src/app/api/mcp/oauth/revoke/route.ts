import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createStatelessClient } from '@/lib/supabase/stateless'

/**
 * POST /api/mcp/oauth/revoke — Revoke an MCP OAuth token.
 * Body: { token_id: string } or { all: true }
 * Requires authenticated Native Intelligence user session.
 */
export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json()

  const serviceClient = createStatelessClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  )

  if (body.all === true) {
    // Revoke all tokens for this user
    const { error } = await serviceClient
      .from('mcp_oauth_token')
      .delete()
      .eq('user_id', user.id)

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ success: true, revoked: 'all' })
  }

  const tokenId = body.token_id
  if (!tokenId) {
    return NextResponse.json({ error: 'token_id is required' }, { status: 400 })
  }

  // Revoke a specific token (ensure user owns it)
  const { error } = await serviceClient
    .from('mcp_oauth_token')
    .delete()
    .eq('id', tokenId)
    .eq('user_id', user.id)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true, revoked: tokenId })
}
