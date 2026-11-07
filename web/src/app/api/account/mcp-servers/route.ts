import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { requireWorkspace } from '@/lib/api-auth'
import { badRequest, serverError } from '@/lib/api-errors'
import { encryptCredentialOrNull } from '@/lib/crypto/credentials'
import { listTools } from '@/lib/mcp-client'
import { assertSafeMcpUrl } from '@/lib/mcp-client/url-guard'
import { assertPublicHost } from '@/lib/mcp-client/url-guard-dns'
import type { ConnectedMcpServerRow } from '@/lib/mcp-client/types'
import { publicMcpServer } from '@/lib/mcp-client/public-row'
import { initialRequireApprovalTools, seedAllowedTools } from '@/lib/mcp-client/tool-access'
import { suggestedMcpServerFor } from '@/lib/mcp-client/suggested'

const CreateSchema = z.object({
  display_name: z.string().min(1).max(100),
  server_url: z.string().url(),
  transport: z.enum(['streamable_http', 'sse']).default('streamable_http'),
  auth_type: z.enum(['none', 'bearer']).default('none'),
  access_token: z.string().min(1).optional(),
  // The tools the person was SHOWN before adding it (the chat's Connect
  // card). Only these, and only if the server still lists them, are allowed;
  // anything it lists now that the card didn't show stays new (hidden).
  shown_tools: z.array(z.string().max(200)).max(500).optional(),
})

// GET /api/account/mcp-servers — list this user's connected external MCP servers.
export async function GET() {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user } = auth

  const { data, error } = await supabase
    .from('connected_mcp_server')
    // `*`, picked to the public columns: approval_free_tools is read only if
    // migration 339 has run (public-row.ts), so deploy order can't break this.
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })

  if (error) return serverError(error.message)
  return NextResponse.json({ servers: (data ?? []).map(publicMcpServer) })
}

// POST /api/account/mcp-servers — register a new external MCP server.
// Performs a tools/list probe before saving so we never persist a server
// the user can't actually reach.
export async function POST(req: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth

  let body: z.infer<typeof CreateSchema>
  try {
    body = CreateSchema.parse(await req.json())
  } catch (err) {
    return badRequest(
      'Invalid request',
      err instanceof z.ZodError ? err.flatten() : undefined,
    )
  }

  if (body.auth_type === 'bearer' && !body.access_token) {
    return badRequest('access_token is required when auth_type=bearer')
  }

  // SSRF guard. Reject any URL that resolves to a private / loopback /
  // metadata-service host before we open a connection. See url-guard.ts.
  const urlCheck = assertSafeMcpUrl(body.server_url)
  if (!urlCheck.ok) return badRequest(urlCheck.reason)
  // And every address the name resolves to must be public (url-guard-dns.ts).
  const resolved = await assertPublicHost(urlCheck.url)
  if (!resolved.ok) return badRequest(resolved.reason)

  const access_token_encrypted = encryptCredentialOrNull(body.access_token ?? null)

  // Build a minimal in-memory row for the connection probe — we haven't
  // inserted yet, so we synthesize the fields the client module needs.
  const probeServer: ConnectedMcpServerRow = {
    id: 'probe',
    user_id: user.id,
    workspace_id: workspaceId,
    display_name: body.display_name,
    server_url: body.server_url,
    transport: body.transport,
    auth_type: body.auth_type,
    access_token_encrypted,
    refresh_token_encrypted: null,
    token_expires_at: null,
    oauth_metadata: null,
    is_enabled: true,
    disabled_tools: [],
    // Empty: no explicit choice yet, so the default policy applies (every tool
    // that is not read-only needs approval, src/lib/mcp-client/approval-policy.ts).
    require_approval_tools: [],
    tools_cache: null,
    tools_cache_refreshed_at: null,
    last_health_check_at: null,
    last_error: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }

  let tools
  try {
    tools = await listTools(probeServer)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return badRequest(`Could not connect to MCP server: ${message}`)
  }

  const now = new Date().toISOString()
  const { data, error } = await supabase
    .from('connected_mcp_server')
    .insert({
      user_id: user.id,
      workspace_id: workspaceId,
      display_name: body.display_name,
      server_url: body.server_url,
      transport: body.transport,
      auth_type: body.auth_type,
      access_token_encrypted,
      tools_cache: tools,
      tools_cache_refreshed_at: now,
      last_health_check_at: now,
      last_error: null,
      // The tools listed now are the ones the person added; one the server
      // adds later stays new until they add it (migration 396).
      allowed_tools: body.shown_tools
        ? (() => {
            const shown = new Set(body.shown_tools)
            return tools.map((t) => t.name).filter((n) => shown.has(n))
          })()
        : seedAllowedTools(null, tools),
      // A server we don't know (not in the catalog) starts with every tool
      // that is not a plain read asking first (decision 23).
      require_approval_tools: initialRequireApprovalTools(!!suggestedMcpServerFor(body.server_url), tools),
    })
    .select('*')
    .single()

  if (error) {
    if (error.code === '23505') {
      // Two names with the same slug also collide here, not just exact
      // duplicates (e.g. "Atlassian Cloud" and "Atlassian-Cloud" both
      // → "atlassian_cloud"). Wording reflects that.
      return badRequest(
        'You already have a connected MCP server with that name (or a similar one — names are compared after stripping punctuation).',
      )
    }
    return serverError(error.message)
  }

  // The public columns only (never the encrypted token), approval_free_tools optional.
  return NextResponse.json({ server: publicMcpServer(data) })
}
