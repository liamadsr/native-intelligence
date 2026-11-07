import { NextResponse } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { serverError } from '@/lib/api-errors'
import { isAgentRunTerminal } from '@/lib/agent-run/types'

/**
 * GET /api/account/actions/[id]/agent-runs
 *
 * Returns the cloud (Vercel Sandbox) agent runs for this action, newest first.
 * Powers the action detail panel's "Cloud run" view: it polls this while a run
 * is in flight to show live status + streaming logs, then settles on the final
 * outcome + PR link (coding runs) or the work summary + deliverables + follow-up
 * chat (Loops v3 workspace runs).
 *
 * RLS scopes agent_run to the caller's workspaces; we additionally pin the
 * workspace + action so the route never leaks another workspace's runs.
 *
 * `session_state` (mig 200) is the eve continuation token — a SEND handle for the
 * run's parked session. It is SERVER-ONLY and must NEVER reach the browser. We
 * select it ONLY to derive `can_chat` per run (terminal && session_state present),
 * then strip it from every row before returning (asserted in the route test).
 * `pending_input` (the parked question) is safe to return: the drill-in / Cloud
 * view render it when a run is `needs_input`.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth

  const { data, error } = await supabase
    .from('agent_run')
    .select(
      `id, status, sandbox_id, repo_full_name, pr_url, branch,
       error_message, log_tail, created_at, started_at, finished_at,
       kind, task_prompt, result_summary, deliverables, resources,
       attention_item_id, pending_input, session_state,
       agent:ai_team_member!ai_team_member_id(id, name, avatar_url),
       action:actions!action_id(id, title, identifier)`,
    )
    .eq('workspace_id', workspaceId)
    .eq('action_id', id)
    .order('created_at', { ascending: false })
    .limit(20)

  if (error) {
    return serverError(error.message)
  }

  // Derive `can_chat` per run, then DROP session_state from every payload row so
  // the eve send handle never crosses to the client. can_chat = terminal AND a
  // parked session exists (a non-null session_state). PostgREST embeds the to-one
  // `agent` relation as an array — normalize it to a single object so the client
  // reads run.agent?.name identically to the by-id route.
  const runs = (data ?? []).map((row) => {
    const { session_state, agent, ...rest } = row as typeof row & {
      session_state: unknown
    }
    const canChat = isAgentRunTerminal(rest.status as string) && session_state != null
    return {
      ...rest,
      can_chat: canChat,
      agent: Array.isArray(agent) ? agent[0] ?? null : agent,
    }
  })

  return NextResponse.json({ runs })
}
