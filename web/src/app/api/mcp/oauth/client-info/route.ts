import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { requireUser } from '@/lib/api-auth'
import { cleanClientName } from '@/lib/mcp/client-metadata'
import { checkMcpClient } from '@/lib/mcp/oauth-client'

/**
 * POST /api/mcp/oauth/client-info — what the consent page
 * (src/app/mcp/authorize/page.tsx) shows about the app asking: its name, and
 * for an app named by its metadata document the host that published it,
 * checked the way approve checks them. The page's own query is anyone's to
 * write, so a name read from it could say anything beside a real "Published
 * by" line; this is the only name the page shows.
 *
 * Auth: requireUser() (cookie OR `Authorization: Bearer`), as approve and deny.
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => null)) as { client_id?: unknown; redirect_uri?: unknown } | null
    const clientId = typeof body?.client_id === 'string' ? body.client_id : null
    const redirectUri = typeof body?.redirect_uri === 'string' ? body.redirect_uri : null

    const auth = await requireUser()
    if (auth instanceof Response) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const serviceClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    )
    const checked = await checkMcpClient(serviceClient, clientId, redirectUri, { requester: auth.user.id })
    if (!checked.ok) {
      return NextResponse.json({ error: checked.error, error_description: checked.description }, { status: 400 })
    }

    const { client } = checked
    return NextResponse.json({
      client_name: cleanClientName(client.client_name, 'MCP Client'),
      // Host and path: on a shared host (a package CDN, a storage bucket) the
      // path says whose document it is.
      publisher_host: client.metadata ? new URL(client.metadata.client_id).host : null,
      publisher_path: client.metadata ? new URL(client.metadata.client_id).pathname : null,
      redirect_uri: checked.redirectUri,
    })
  } catch (err) {
    console.error('MCP OAuth client-info error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
