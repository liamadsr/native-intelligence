import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { notFound, serverError } from '@/lib/api-errors'
import { listTools, McpTokenExpiredError } from '@/lib/mcp-client'
import type { ConnectedMcpServerRow } from '@/lib/mcp-client/types'
import { publicMcpServer } from '@/lib/mcp-client/public-row'
import { initialRequireApprovalTools, newMcpTools, seedAllowedTools } from '@/lib/mcp-client/tool-access'
import { isCatalogServer } from '@/lib/mcp-client/approval-policy'

/** How long a refresh's tools/list may take. */
const REFRESH_TIMEOUT_MS = 6_000

// POST /api/account/mcp-servers/[id]/refresh-tools
// Re-runs tools/list against the server and updates the cached schema.
// Also doubles as a manual "test connection" — health fields are updated
// regardless of success/failure. A tool the server added since stays NEW
// (hidden until the person adds it: tool-access.ts, migration 396); a
// connection with no allow-list yet is seeded with what this listing found.
export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user } = auth
  const { id } = await ctx.params

  const { data: server, error: fetchError } = await supabase
    .from('connected_mcp_server')
    .select('*')
    .eq('id', id)
    .eq('user_id', user.id)
    .maybeSingle<ConnectedMcpServerRow>()

  if (fetchError) return serverError(fetchError.message)
  if (!server) return notFound('MCP server not found')

  const now = new Date().toISOString()
  try {
    // A time bound, like connect's: a server that never finishes its list is cut off.
    const tools = await listTools(server, { signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS) })
    const allowed = seedAllowedTools(server.allowed_tools, tools)
    // Seeding now (the first listing that found tools): a server we don't know
    // gets the same ask-first pins a connection with tools gets at connect
    // (decision 23), merged with any the person already set.
    const seeding = !Array.isArray(server.allowed_tools) && Array.isArray(allowed)
    const pins = seeding
      ? [...new Set([...(server.require_approval_tools ?? []), ...initialRequireApprovalTools(isCatalogServer(server.server_url), tools)])]
      : null
    const { data: updated } = await supabase
      .from('connected_mcp_server')
      .update({
        tools_cache: tools,
        tools_cache_refreshed_at: now,
        last_health_check_at: now,
        last_error: null,
        allowed_tools: allowed,
        ...(pins ? { require_approval_tools: pins } : {}),
      })
      .eq('id', id)
      .select('*')
      .single()
    return NextResponse.json({
      server: publicMcpServer(updated),
      tool_count: tools.length,
      new_tools: newMcpTools({ allowed_tools: allowed }, tools).map((t) => t.name),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[mcp-servers/refresh-tools] probe failed:', {
      server_id: id,
      name: err instanceof Error ? err.name : typeof err,
      message,
    })
    await supabase
      .from('connected_mcp_server')
      .update({ last_health_check_at: now, last_error: message })
      .eq('id', id)
    if (err instanceof McpTokenExpiredError) {
      return NextResponse.json(
        { error: message, code: 'MCP_TOKEN_EXPIRED' },
        { status: 401 },
      )
    }
    return NextResponse.json(
      { error: `Failed to refresh: ${message}`, code: 'MCP_PROBE_FAILED' },
      { status: 502 },
    )
  }
}
