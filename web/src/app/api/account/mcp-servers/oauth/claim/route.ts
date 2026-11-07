import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { badRequest, forbidden } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/supabase/service'
import { completeMcpConnect, type McpOAuthStateRow } from '@/lib/mcp-client/complete-connect'
import { MCP_CLAIM_GRACE_MS, isDesktopMcpState, mcpClaimSecret, mcpSecretsEqual } from '@/lib/mcp-client/oauth-binding'

/**
 * POST /api/account/mcp-servers/oauth/claim  { code, state, claim_secret }
 *
 * The second half of a DESKTOP MCP connector connect (security review
 * 2026-10-31; lib/mcp-client/oauth-binding.ts). The consent finishes in the
 * system browser, whose callback never completes a desktop flow: it deep-links
 * the code back, and the window that started the connect posts it here. The
 * connect completes only when:
 *   - the state is a desktop flow's, and `claim_secret` is that flow's (only
 *     the start route's answer to the starting window carried it);
 *   - the signed-in person (this route is under /api/account, behind the
 *     session) owns the state row, which is consumed here, once.
 *
 * In the attack (an attacker's consent link opened by a victim), the code
 * lands on the victim's machine, which holds neither the attacker's claim
 * secret nor the attacker's session.
 *
 * 200 `{ success: true, name, tool_count }`; else `{ success: false, error }`
 * with 400 (bad body), 403 (not this flow's secret, or not your flow) or 502.
 */
export async function POST(req: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { user } = auth

  let body: { code?: unknown; state?: unknown; claim_secret?: unknown }
  try {
    body = (await req.json()) as typeof body
  } catch {
    return badRequest('Invalid request')
  }
  const { code, state } = body
  if (typeof code !== 'string' || !code || typeof state !== 'string' || !isDesktopMcpState(state)) {
    return badRequest('Invalid request')
  }
  // Checked before the row is touched: a wrong secret never consumes it.
  if (!mcpSecretsEqual(body.claim_secret, mcpClaimSecret(state))) {
    return forbidden('This connection was started in another window')
  }

  const svc = getServiceClient()
  // Atomically consume the row, and only the signed-in person's own. The
  // claim follows a callback that passed the row's expiry; it may finish.
  const { data: rows, error } = await svc
    .from('external_mcp_oauth_state')
    .delete()
    .eq('state', state)
    .eq('user_id', user.id)
    .gt('expires_at', new Date(Date.now() - MCP_CLAIM_GRACE_MS).toISOString())
    .select('*')
  const stateRow = rows?.[0] as McpOAuthStateRow | undefined
  if (error || !stateRow) {
    return forbidden('This connection is not yours, or it has expired. Start it again.')
  }

  let result
  try {
    result = await completeMcpConnect(svc, stateRow, code)
  } catch (err) {
    // Safe fields only: a fetch error can carry the code or partial tokens.
    console.error('[mcp-servers/oauth/claim] unhandled error:', {
      name: err instanceof Error ? err.name : typeof err,
      message: err instanceof Error ? err.message : String(err),
    })
    return NextResponse.json({ success: false, error: 'The connection could not be completed. Start it again.' }, { status: 502 })
  }
  if (!result.ok) {
    return NextResponse.json({ success: false, error: result.error }, { status: 502 })
  }
  return NextResponse.json({ success: true, name: result.name, tool_count: result.toolCount })
}
