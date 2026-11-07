import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { displayName } from '@/lib/ai/tools/_shared'
import { withActiveWorkspace } from './envelope'

/**
 * Workspace-specific tools that aren't part of the AI SDK tool registry.
 * These give Claude context about the user's workspace(s) and allow switching.
 *
 * @param onWorkspaceChanged - callback invoked when dial8_set_workspace is called,
 *   so the caller can persist the switch. MUST be awaited: it does the durable
 *   write to `mcp_oauth_token.active_workspace_id`, and the next MCP request
 *   (stateless — fresh server per POST) re-reads that field to scope itself. If
 *   the tool returns before the write commits, the follow-up call reads the OLD
 *   workspace and the agent silently operates in the wrong scope (the root cause
 *   of "chat dies when I switch workspaces" — the agent loops on empty/wrong data
 *   until the CLI process exits). May reject (DB error) — the handler surfaces
 *   that as a tool error rather than a false `success`.
 *
 * @param workspaceName - display name of the ACTIVE workspace, threaded from
 *   registerTools (which already looked it up) purely so these hand-registered
 *   tools can stamp `active_workspace` the way the bridged tools do. Optional
 *   and nullable: a caller that doesn't have it still gets the id.
 */
export function registerWorkspaceTools(
  server: McpServer,
  userId: string,
  supabase: SupabaseClient,
  workspaceId: string,
  onWorkspaceChanged?: (newWorkspaceId: string) => void | Promise<void>,
  workspaceName?: string | null,
) {
  /**
   * Hand-registered tools build their own `content`, so the adapter loop in
   * ./index.ts never sees them and they were the only results in the catalog
   * that didn't say which workspace they came from. Stamp them here with the
   * SAME helper the bridged path uses, so a result is indistinguishable
   * whichever way the tool was registered. Errors keep their existing payloads
   * untouched.
   */
  const active = { id: workspaceId, name: workspaceName ?? null }
  const ok = (payload: unknown) => ({
    content: [{
      type: 'text' as const,
      text: JSON.stringify(withActiveWorkspace(payload, active), null, 2),
    }],
  })

  /**
   * The one refusal shape for "you may not read that workspace". Deliberately
   * identical for a workspace that doesn't exist and one the user isn't a
   * member of — the reply must never tell the caller which.
   */
  const notAMember = () => ({
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        error: 'You are not a member of this workspace. Use dial8_list_workspaces to see your available workspaces.',
      }),
    }],
    isError: true,
  })

  server.tool(
    'dial8_list_workspaces',
    'List all workspaces the authenticated user is a member of. Returns workspace name, slug, and the user\'s role in each.',
    async () => {
      const { data, error } = await supabase
        .from('member')
        .select('workspace_id, role, workspace:workspace!workspace_id(id, name, slug)')
        .eq('user_id', userId)

      if (error) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: error.message }) }],
          isError: true,
        }
      }

      const workspaces = (data || []).map((m) => {
        // Supabase returns joined relations as arrays or objects depending on cardinality
        const wsRaw = m.workspace as unknown
        const ws = (Array.isArray(wsRaw) ? wsRaw[0] : wsRaw) as { id: string; name: string; slug: string } | null
        return {
          id: ws?.id,
          name: ws?.name,
          // Friendly label that falls back to slug → id when name is empty.
          // Agents should prefer this for user-facing output; `name` is still
          // returned raw so callers can detect bad data.
          display_name: displayName(ws?.name, ws?.slug, ws?.id),
          slug: ws?.slug,
          role: m.role,
          is_active: ws?.id === workspaceId,
        }
      })

      return ok({ workspaces })
    },
  )

  server.tool(
    'dial8_get_workspace',
    'Get details about the current workspace including teams, members, and each team\'s workflow states ' +
      '(id, name, category, color, sort_order). Workflow states define the columns of a team\'s board ' +
      '(e.g. Backlog → Todo → In Progress → In Review → Done → Canceled) and are customizable per team. ' +
      'Use the returned state id or name with dial8_update_action (status_id / status_name) to move an ' +
      'action between states. Call this before moving an action so you know the valid options for that team.',
    {
      workspace_id: z.string().optional().describe('Workspace ID. Defaults to the active workspace.'),
    },
    async ({ workspace_id }) => {
      const wsId = workspace_id || workspaceId

      // The MCP client is service-role, so RLS doesn't fence the three reads
      // below — an explicit `workspace_id` has to be authorised here. The
      // active workspace needs no probe: auth already resolved it from this
      // token.
      if (workspace_id && workspace_id !== workspaceId) {
        const { data: membership, error: memberError } = await supabase
          .from('member')
          .select('workspace_id, role')
          .eq('user_id', userId)
          .eq('workspace_id', workspace_id)
          .single()

        if (memberError || !membership) return notAMember()
      }

      // Fetch workspace info
      const { data: workspace, error: wsError } = await supabase
        .from('workspace')
        .select('id, name, slug')
        .eq('id', wsId)
        .single()

      if (wsError || !workspace) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Workspace not found' }) }],
          isError: true,
        }
      }

      // Fetch teams and their workflow states
      const { data: teams } = await supabase
        .from('team')
        .select('id, name, issue_prefix, workflow_state(id, name, category, color, sort_order)')
        .eq('workspace_id', wsId)
        .order('created_at', { ascending: true })

      // Fetch members
      const { data: members } = await supabase
        .from('member')
        .select('id, user_id, role, display_name')
        .eq('workspace_id', wsId)

      // Defensively patch display labels onto the workspace/teams/members
      // payload so agents producing user-facing output don't have to special-case
      // empty names. `name` is preserved raw alongside.
      const teamRows = (teams || []).map((t) => ({
        ...t,
        display_name: displayName(t.name, t.issue_prefix, t.id),
      }))
      const memberRows = (members || []).map((m) => ({
        ...m,
        display_label: displayName(m.display_name, m.user_id, m.id),
      }))
      const workspacePayload = {
        ...workspace,
        display_name: displayName(workspace.name, workspace.slug, workspace.id),
      }

      return ok({
        workspace: workspacePayload,
        teams: teamRows,
        members: memberRows,
      })
    },
  )

  server.tool(
    'dial8_set_workspace',
    'Switch the active workspace for this MCP session. Use dial8_list_workspaces first to see available workspaces. All subsequent tool calls will be scoped to the selected workspace.',
    {
      workspace_id: z.string().describe('The workspace ID to switch to.'),
    },
    async ({ workspace_id }) => {
      // Verify the user is a member of this workspace
      const { data: membership, error } = await supabase
        .from('member')
        .select('workspace_id, role')
        .eq('user_id', userId)
        .eq('workspace_id', workspace_id)
        .single()

      // Same refusal as dial8_get_workspace's — if the two ever diverge, the
      // difference itself tells a caller which workspaces exist.
      if (error || !membership) return notAMember()

      // Persist the switch BEFORE returning. The MCP server is stateless — the
      // next tool call is a fresh POST that re-reads active_workspace_id to scope
      // itself — so this write must be committed (awaited) by the time we reply
      // `success`. Fire-and-forget here let the response (and, on Vercel, the
      // whole function) resolve before the write landed: the follow-up call read
      // the OLD workspace, the agent ran in the wrong scope on empty/wrong data,
      // looped, and the chat appeared to die. If the write fails, say so instead
      // of falsely reporting success.
      if (onWorkspaceChanged) {
        try {
          await onWorkspaceChanged(workspace_id)
        } catch (err) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                error: `Failed to switch workspace: ${err instanceof Error ? err.message : 'could not persist the change'}. Try again.`,
              }),
            }],
            isError: true,
          }
        }
      }

      // Fetch workspace name for confirmation
      const { data: ws } = await supabase
        .from('workspace')
        .select('name, slug')
        .eq('id', workspace_id)
        .single()

      // The one tool whose `active_workspace` must NOT be the workspace the call
      // started in: by the time this returns, the switch is committed, so the
      // stamp names the workspace every SUBSEQUENT call will run in. Setting the
      // key explicitly also makes `ok`'s stamp a no-op here (withActiveWorkspace
      // never overwrites a key the tool set itself).
      return ok({
        success: true,
        message: `Switched to workspace "${ws?.name || workspace_id}". All subsequent tool calls are now scoped to this workspace.`,
        workspace_id,
        workspace_name: ws?.name,
        workspace_slug: ws?.slug,
        active_workspace: { id: workspace_id, name: ws?.name ?? null },
      })
    },
  )
}
