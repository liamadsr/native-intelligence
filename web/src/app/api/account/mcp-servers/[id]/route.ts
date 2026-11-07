import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { requireWorkspace } from '@/lib/api-auth'
import { badRequest, notFound, serverError } from '@/lib/api-errors'
import { encryptCredentialOrNull } from '@/lib/crypto/credentials'
import { isMissingColumnError, publicMcpServer } from '@/lib/mcp-client/public-row'
import { toolPermissionColumns, type McpPermissionRow } from '@/lib/mcp-client/tool-permissions'

const PatchSchema = z.object({
  display_name: z.string().min(1).max(100).optional(),
  is_enabled: z.boolean().optional(),
  // Allow rotating the bearer token without re-creating the row.
  access_token: z.string().min(1).nullable().optional(),
  // Per-tool user controls. Replaces (not merges) the existing array — the
  // UI sends the full set every time.
  disabled_tools: z.array(z.string()).optional(),
  require_approval_tools: z.array(z.string()).optional(),
  // The person's explicit "run without asking" choices (migration 339;
  // approval is the default for every tool that is not read-only,
  // src/lib/mcp-client/approval-policy.ts).
  approval_free_tools: z.array(z.string()).optional(),
  // The allow-list (migration 396): the person adding a new tool, from their
  // own Settings. Replaces the list, like the others.
  allowed_tools: z.array(z.string()).optional(),
  // One Tool permissions change from Settings › Connectors (Always allow /
  // Needs approval / Blocked for these tools: tool-permissions.ts), applied to
  // the row as it is NOW. A page loaded before another change (the agent
  // pinning a tool to ask, another tab) then never writes stale lists back.
  // Not combinable with the four list fields above.
  tool_permission: z
    .object({
      tools: z.array(z.string().min(1)).min(1).max(500),
      permission: z.enum(['allow', 'ask', 'blocked']),
    })
    .optional(),
})

const LIST_FIELDS = ['disabled_tools', 'require_approval_tools', 'approval_free_tools', 'allowed_tools'] as const

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user } = auth
  const { id } = await ctx.params

  let body: z.infer<typeof PatchSchema>
  try {
    body = PatchSchema.parse(await req.json())
  } catch (err) {
    return badRequest(
      'Invalid request',
      err instanceof z.ZodError ? err.flatten() : undefined,
    )
  }

  const updates: Record<string, unknown> = {}
  if (body.display_name !== undefined) updates.display_name = body.display_name
  if (body.is_enabled !== undefined) updates.is_enabled = body.is_enabled
  if (body.access_token !== undefined) {
    updates.access_token_encrypted = encryptCredentialOrNull(body.access_token)
  }
  if (body.disabled_tools !== undefined) updates.disabled_tools = body.disabled_tools
  if (body.require_approval_tools !== undefined) {
    updates.require_approval_tools = body.require_approval_tools
  }
  if (body.approval_free_tools !== undefined) {
    updates.approval_free_tools = body.approval_free_tools
  }
  if (body.allowed_tools !== undefined) updates.allowed_tools = body.allowed_tools

  if (body.tool_permission) {
    if (LIST_FIELDS.some((f) => body[f] !== undefined)) {
      return badRequest('Send tool_permission or the tool lists, not both')
    }
    const { data: row, error: readErr } = await supabase
      .from('connected_mcp_server')
      .select('*')
      .eq('id', id)
      .eq('user_id', user.id)
      .maybeSingle()
    if (readErr) return serverError(readErr.message)
    if (!row) return notFound('MCP server not found')
    Object.assign(updates, toolPermissionColumns(row as McpPermissionRow, body.tool_permission.tools, body.tool_permission.permission))
  }

  if (Object.keys(updates).length === 0) {
    return badRequest('No updatable fields provided')
  }

  const { data, error } = await supabase
    .from('connected_mcp_server')
    .update(updates)
    .eq('id', id)
    .eq('user_id', user.id)
    .select('*')
    .maybeSingle()

  if (error) {
    // Migration 339 not applied yet: the approval-free choice has nowhere to go.
    if (isMissingColumnError(error, 'approval_free_tools')) {
      return serverError('Choosing tools that run without approval needs a database update that has not run yet. Nothing changed; try again later.')
    }
    return serverError(error.message)
  }
  if (!data) return notFound('MCP server not found')
  return NextResponse.json({ server: publicMcpServer(data) })
}

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user } = auth
  const { id } = await ctx.params

  const { error } = await supabase
    .from('connected_mcp_server')
    .delete()
    .eq('id', id)
    .eq('user_id', user.id)

  if (error) return serverError(error.message)
  return NextResponse.json({ ok: true })
}
