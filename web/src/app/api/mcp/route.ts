import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { authenticateMcpRequest, hashToken, setActiveWorkspace } from '@/lib/mcp/auth'
import { createMcpServer } from '@/lib/mcp/server'

/**
 * MCP Streamable HTTP endpoint.
 *
 * Claude Code connects here after completing OAuth:
 *   claude mcp add --transport http dial8 https://dial8.ai/api/mcp
 *
 * OAuth discovery happens automatically via:
 *   GET /.well-known/oauth-protected-resource/api/mcp
 *   GET /.well-known/oauth-authorization-server
 */

// The Streamable HTTP transport holds a long-lived GET stream (server→client
// notifications) open for the life of the client's MCP session. Without an
// explicit limit Vercel kills it at the platform default (~300s), which the
// connected `claude` CLI sees as the MCP server "dropping mid-session" — tools
// stop resolving partway through a chat. Pin the function to the plan ceiling so
// the stream survives a normal working session. (800s is the Pro/Enterprise max;
// the live-agent route uses the same headroom.)
export const maxDuration = 800
// Streaming transport — never let the platform cache or statically optimize it.
export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  try {
    const { userId, workspaceId, supabase, scopes, tokenId } = await authenticateMcpRequest(request)

    // Extract token hash so we can persist workspace changes
    const authHeader = request.headers.get('authorization') || ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
    const tokenHash = hashToken(token)

    // Persist a workspace switch to the token record. Routed through
    // setActiveWorkspace (not a hand-rolled update) so it throws on a failed
    // write and the dial8_set_workspace handler can report the failure instead
    // of a false success. The handler AWAITS this before replying (the switch must be
    // committed before the next stateless POST re-reads active_workspace_id).
    const onWorkspaceChanged = (newWorkspaceId: string) =>
      setActiveWorkspace(tokenHash, newWorkspaceId)

    const mcpServer = await createMcpServer(userId, supabase, workspaceId, onWorkspaceChanged, { scopes, tokenId })

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      // Return each tool-call result as a single JSON body, NOT an SSE stream.
      // The transport DEFAULTS to SSE for any POST carrying a request (it opens a
      // `text/event-stream`, writes the result, and relies on the stream closing
      // cleanly). On our stateless Vercel/Next setup that per-request stream can
      // stall — the result is written but the stream never delivers/closes, so the
      // connected `claude` CLI sits forever on "Running…" (e.g. a plain
      // dial8_list_workspaces never returns and the chat appears to die). Dial8 is
      // pure request/response — no server-initiated messages within a call — so the
      // SSE channel buys us nothing. JSON-response mode resolves a normal Promise
      // with the body and removes the hangable stream entirely. (Pairs with the
      // GET→405 change above, which killed the *standalone* SSE stream; this kills
      // the *per-request* one.)
      //
      // NOTE: enableJsonResponse only changes the RESPONSE shape — the SDK still
      // requires every POST to send `Accept: application/json, text/event-stream`
      // (it 406s otherwise, BEFORE this flag is consulted). Spec-compliant clients
      // incl. the `claude` CLI always send both, so this is safe; just don't expect
      // a json-only client to work against this endpoint.
      enableJsonResponse: true,
    })

    await mcpServer.connect(transport)
    return transport.handleRequest(request)
  } catch (err) {
    if (err instanceof Response) return err

    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error('MCP POST error:', message)

    // Provide actionable error messages for common failures
    const isRls = message.includes('row-level security') || message.includes('permission denied')
    const errorMessage = isRls
      // NOT "call dial8_set_workspace": the active workspace is a default, not a
      // fence, so the fix for a cross-workspace call is to route it (pass the
      // entity's own workspace_id) rather than to re-scope the whole session.
      ? "Permission denied — you may not be a member of that workspace. Pass the entity's workspace_id (it's on every row you read) so the call routes to the workspace it belongs to."
      : 'Internal server error'

    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32603, message: errorMessage },
        id: null,
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    )
  }
}

/**
 * GET opens the Streamable-HTTP "standalone SSE stream" — a long-lived channel
 * the server uses to PUSH notifications to the client. The Dial8 MCP server is
 * purely request/response (every result comes back on the POST that asked for
 * it); it never initiates a server→client message. Holding that idle stream open
 * gained us nothing and cost us everything: on Vercel the function eventually
 * hits its execution ceiling and the stream is torn down, which the connected
 * `claude` CLI experiences as the MCP connection "dropping mid-session".
 *
 * Per the MCP spec a server MAY decline the optional SSE stream by answering GET
 * with 405; spec-compliant clients (incl. Claude Code) then operate POST-only,
 * which is exactly our model. So we refuse the stream outright instead of opening
 * one that can only ever time out. (We still authenticate first so an
 * unauthenticated probe gets a 401, matching POST.)
 */
export async function GET(request: Request) {
  try {
    await authenticateMcpRequest(request)
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method Not Allowed: this MCP server does not offer a server-to-client SSE stream. Use POST.' },
        id: null,
      }),
      { status: 405, headers: { 'Content-Type': 'application/json', Allow: 'POST, DELETE' } },
    )
  } catch (err) {
    if (err instanceof Response) return err

    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error('MCP GET error:', message)
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    )
  }
}

export async function DELETE() {
  return new Response(null, { status: 200 })
}
