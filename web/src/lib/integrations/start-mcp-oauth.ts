/**
 * Start an external MCP server's OAuth flow and return its authorize URL.
 *
 * MCP servers don't go through `/api/oauth/{provider}/authorize`: the start
 * route discovers the server's auth server, registers a client (DCR) and
 * persists the in-flight state. Pair it with `useConnectProvider().connectWithUrl`,
 * which owns the popup / system-browser step and the return:
 *
 *   connectWithUrl(key, () => startMcpOAuth(suggested))
 *
 * The completion is bound to whoever started it (security review 2026-10-31,
 * src/lib/mcp-client/oauth-binding.ts): on the web the start route sets this
 * browser's bind cookie; in the desktop app it answers this window with the
 * flow's state and claim secret, held here until the deep link brings the
 * code back (desktop-oauth-claims.ts claimDesktopMcp).
 *
 * Throws an Error carrying the route's message when the flow can't start (the
 * hook reports it through `onReturn` as `{ success: false, error }`).
 */
import { isDesktopApp } from '@/lib/platform'
import { holdDesktopMcpClaim } from './desktop-oauth-claims'

export async function startMcpOAuth(server: {
  display_name: string
  server_url: string
  transport: 'streamable_http' | 'sse'
}): Promise<string> {
  const desktop = isDesktopApp()
  let res: Response
  try {
    res = await fetch('/api/account/mcp-servers/oauth/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        display_name: server.display_name,
        server_url: server.server_url,
        transport: server.transport,
        source: desktop ? 'desktop' : 'web',
      }),
    })
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : 'Network error starting OAuth')
  }
  let json: { authorize_url?: string; state?: string; claim_secret?: string; error?: string } = {}
  try {
    json = await res.json()
  } catch {
    // A non-JSON body (an upstream 502 page): fall through to the generic error.
  }
  if (!res.ok || !json.authorize_url) {
    throw new Error(json.error || 'Failed to start OAuth flow')
  }
  if (desktop) {
    // Without the claim secret the connect could never be finished here.
    if (!json.state || !json.claim_secret) throw new Error('Failed to start OAuth flow')
    holdDesktopMcpClaim(json.state, json.claim_secret)
  }
  return json.authorize_url
}
