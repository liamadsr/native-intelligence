import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'

/**
 * GET /api/account/agent-runs/[id]
 *
 * Returns ONE cloud (Vercel Sandbox) agent run by id, scoped to the caller's
 * current workspace. Unlike /api/account/actions/[id]/agent-runs (action-scoped,
 * for the action detail panel), this is keyed on the run id alone — so it serves
 * FLOW-origin runs (run_agent flow action; action_id NULL, flow_id set) which
 * have no action to hang off. Powers the /account/agent-runs/[id] deep-link the
 * flow run-history "View agent run" chip points at.
 *
 * RLS scopes agent_run to the caller's workspaces; we additionally pin
 * workspace_id so the route never leaks another workspace's run.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) return NextResponse.json({ error: 'No workspace' }, { status: 400 })

  // `pending_input` + `session_state` (Loops v3 interactive work runs, mig 200):
  // pending_input is present iff status='needs_input' (the parked question the
  // drill-in renders); session_state is the follow-up-chat cursor. session_state
  // is SERVER-ONLY — it carries the eve continuation token, never returned to the
  // browser. We select it ONLY to derive `can_chat` (terminal && session_state
  // present), then strip it below.
  const { data, error } = await supabase
    .from('agent_run')
    .select(
      `id, status, sandbox_id, repo_full_name, pr_url, branch,
       error_message, log_tail, created_at, started_at, finished_at,
       action_id, flow_id,
       kind, task_prompt, result_summary, deliverables, resources, attention_item_id,
       pending_input, session_state,
       agent:ai_team_member!ai_team_member_id(id, name, avatar_url),
       agent_recipe:recipe!agent_recipe_id(id, name),
       flow:flow!flow_id(id, name),
       action:actions!action_id(id, title, identifier)`,
    )
    .eq('workspace_id', workspaceId)
    .eq('id', id)
    .maybeSingle()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  if (!data) {
    return NextResponse.json({ error: 'Agent run not found' }, { status: 404 })
  }

  // Derive can_chat, then DROP session_state from the payload — it must never
  // reach the browser (the eve continuation token is a send handle). Terminal =
  // completed/failed (a canceled run's session is torn down; a live run isn't
  // chattable yet). Presence of a non-null session_state means the run parked a
  // follow-up handle.
  const terminal = data.status === 'completed' || data.status === 'failed'
  const canChat = terminal && data.session_state != null
  const { session_state: _sessionState, ...rest } = data

  // PostgREST types embedded to-one relations as arrays; normalize to single
  // objects so the client (which reads run.agent?.name etc.) matches the server
  // page's initial-render shape. Without this, the client's poll response would
  // carry arrays and the origin label would vanish on the first live update.
  const run = {
    ...rest,
    can_chat: canChat,
    agent: Array.isArray(data.agent) ? data.agent[0] ?? null : data.agent,
    agent_recipe: Array.isArray(data.agent_recipe) ? data.agent_recipe[0] ?? null : data.agent_recipe,
    flow: Array.isArray(data.flow) ? data.flow[0] ?? null : data.flow,
    action: Array.isArray(data.action) ? data.action[0] ?? null : data.action,
  }

  return NextResponse.json({ run })
}
