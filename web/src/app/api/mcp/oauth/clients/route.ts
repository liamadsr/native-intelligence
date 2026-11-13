import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createStatelessClient } from '@/lib/supabase/stateless'
import { cleanClientName } from '@/lib/mcp/client-metadata'

/**
 * GET /api/mcp/oauth/clients — List MCP clients with active tokens for the current user.
 * Returns client name, token creation date, last used, and token ID for revocation.
 */
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const serviceClient = createStatelessClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  )

  const { data: tokens, error } = await serviceClient
    .from('mcp_oauth_token')
    .select('id, client_id, created_at, last_used_at, expires_at, scopes, mcp_oauth_client!inner(client_name)')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const clients = (tokens || []).map((t) => {
    const clientRaw = t.mcp_oauth_client as unknown
    const client = (Array.isArray(clientRaw) ? clientRaw[0] : clientRaw) as { client_name: string } | null
    return {
      token_id: t.id,
      client_id: t.client_id,
      client_name: cleanClientName(client?.client_name, t.client_id),
      // An app named by its metadata document: the host that published it.
      client_host: t.client_id.startsWith('https://') ? new URL(t.client_id).host : null,
      created_at: t.created_at,
      last_used_at: t.last_used_at,
      expires_at: t.expires_at,
      scopes: t.scopes,
      is_expired: new Date(t.expires_at) < new Date(),
    }
  })

  return NextResponse.json({ clients })
}
