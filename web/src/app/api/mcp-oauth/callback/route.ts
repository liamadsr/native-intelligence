import { NextResponse, type NextRequest } from 'next/server'
import { getServiceClient } from '@/lib/supabase/service'
import { deepLinkPage } from '@/lib/auth/deep-link-page'
import { bindingCookieOptions } from '@/lib/oauth/state'
import { completeMcpConnect, type McpOAuthStateRow } from '@/lib/mcp-client/complete-connect'
import { isDesktopMcpState, mcpBindCookie, mcpSecretsEqual, readCookie } from '@/lib/mcp-client/oauth-binding'

/**
 * GET /api/mcp-oauth/callback?code=...&state=...
 *
 * This route is intentionally NOT under /api/account/* — the routing
 * middleware (src/proxy.ts) gates that prefix behind a Native Intelligence session,
 * and OAuth callbacks must be reachable in a fresh browser context
 * (no Native Intelligence cookies). The `state` (random, issued by us, looked up in the
 * database) proves the flow is ours; it does NOT prove who is finishing it.
 *
 * Binding the completer to the initiator (security review 2026-10-31,
 * lib/mcp-client/oauth-binding.ts): otherwise an attacker could start a
 * connect for their own account, send the consent link to a victim, and store
 * the victim's connector tokens under the attacker.
 *   - WEB flow: the row is consumed and completed only for the browser that
 *     started it: its per-flow binding cookie, `__Host-` in production so no
 *     subdomain can plant one. A matching session does not stand in for it
 *     (a subdomain could toss its owner's session cookie).
 *   - DESKTOP flow (`desk.` state): never completed here. The code is
 *     deep-linked back (dial8desktop://mcp-oauth/complete) with the row left in
 *     place, and the claim route (/api/account/mcp-servers/oauth/claim)
 *     completes it for the starting window. PKCE binds the code to this row.
 *
 * Flow (web): consume the state row, check the binding, then
 * completeMcpConnect (exchange, probe tools/list, persist), then redirect to
 * /mcp-oauth-popup-callback so the opener window can refresh.
 */

function popupRedirect(req: NextRequest, params: Record<string, string>): NextResponse {
  const url = new URL('/mcp-oauth-popup-callback', req.url)
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v)
  }
  return NextResponse.redirect(url)
}

/**
 * Back to the desktop app by deep link (the scheme registered in
 * tauri.conf.json), from a page that says so: the system browser would
 * otherwise sit on a blank tab once the app takes the link.
 */
function desktopRedirect(path: 'complete' | 'error', params: Record<string, string>): NextResponse {
  const done = path === 'complete'
  return new NextResponse(
    deepLinkPage({
      title: done ? 'Connecting to Native Intelligence...' : 'Connection failed',
      deepLink: `dial8desktop://mcp-oauth/${path}?${new URLSearchParams(params)}`,
      body: `<p>${done ? 'Finishing the connection in Native Intelligence...' : "The connection didn't complete."}</p>
    <p style="color: #888; font-size: 14px; margin-top: 8px;">You can close this window.</p>`,
    }),
    { headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' } },
  )
}

export async function GET(req: NextRequest) {
  try {
    return await handleCallback(req)
  } catch (err) {
    // Defensive: anything reaching here is an unanticipated failure.
    // Always redirect to the popup page with a message instead of
    // letting Next.js render its own error UI — desktop users would
    // see that page in the system browser with no path back.
    // Log only safe, structured fields. The raw `err` object can hold
    // request/response bodies via fetch error wrappers — which in an
    // OAuth context may include the auth code or partial tokens. Never
    // log it directly; Sentry's auto-capture would inhale the lot.
    console.error('[mcp-oauth/callback] unhandled error:', {
      name: err instanceof Error ? err.name : typeof err,
      message: err instanceof Error ? err.message : String(err),
    })
    return popupRedirect(req, {
      success: 'false',
      error: err instanceof Error ? err.message : 'Unexpected callback error',
    })
  }
}

async function handleCallback(req: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(req.url)
  const code = searchParams.get('code')
  const state = searchParams.get('state')
  const errorParam = searchParams.get('error')
  const desktop = !!state && isDesktopMcpState(state)

  if (errorParam) {
    const error = searchParams.get('error_description') || errorParam
    // A desktop flow's window waits for its own state's answer.
    if (desktop) return desktopRedirect('error', { state: state!, error })
    return popupRedirect(req, { success: 'false', error })
  }

  if (!code || !state) {
    return popupRedirect(req, { success: 'false', error: 'Missing code or state' })
  }

  const svc = getServiceClient()

  if (desktop) {
    // Never completed here: hand the code back to the app, leaving the row
    // for the claim route to consume. Checked so a dead state says so now.
    const { data: live } = await svc
      .from('external_mcp_oauth_state')
      .select('state')
      .eq('state', state)
      .gt('expires_at', new Date().toISOString())
      .maybeSingle<{ state: string }>()
    if (!live) return desktopRedirect('error', { state, error: 'Invalid or expired state. Please retry.' })
    return desktopRedirect('complete', { code, state })
  }

  // Atomically consume the state row. DELETE...RETURNING is a single
  // database statement, so two concurrent callbacks with the same `state`
  // (network retry, replay attempt) cannot both see the row — at most one
  // gets it. Combining the `expires_at` filter into the WHERE means an
  // expired row is also not consumed; it stays for the cron cleanup and
  // the caller gets a clean "invalid or expired" error.
  const { data: stateRows, error: fetchErr } = await svc
    .from('external_mcp_oauth_state')
    .delete()
    .eq('state', state)
    .gt('expires_at', new Date().toISOString())
    .select('*')

  const stateRow = stateRows?.[0] as McpOAuthStateRow | undefined
  if (fetchErr || !stateRow) {
    return popupRedirect(req, {
      success: 'false',
      error: 'Invalid or expired state. Please retry.',
    })
  }

  // The browser finishing a web flow must be the one that started it.
  const bind = mcpBindCookie(state)
  if (!mcpSecretsEqual(readCookie(req.headers.get('cookie'), bind.name), bind.value)) {
    return popupRedirect(req, {
      success: 'false',
      error: 'This connection was started in another browser. Start it again here.',
    })
  }

  const result = await completeMcpConnect(svc, stateRow, code)
  const res = result.ok
    ? popupRedirect(req, { success: 'true', name: result.name, tool_count: String(result.toolCount) })
    : popupRedirect(req, { success: 'false', error: result.error })
  // The flow's binding cookie is spent either way.
  res.cookies.set(bind.name, '', { ...bindingCookieOptions(0) })
  return res
}
