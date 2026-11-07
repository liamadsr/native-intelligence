import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceIdSafe } from '@/lib/workspace'
import { AgentRunDetail } from './agent-run-detail'

export const dynamic = 'force-dynamic'

/**
 * /account/agent-runs/[id] — standalone deep-link view of ONE cloud agent run,
 * keyed on the run id (not an action), so it serves FLOW-origin runs (run_agent
 * flow action). This is where the Flows run-history "View agent run" chip lands.
 * We fetch the run server-side for a fast first paint + an honest 404; the
 * client detail component polls for live status once mounted.
 */
export default async function AgentRunPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const workspaceId = await getCurrentWorkspaceIdSafe()
  if (!workspaceId) {
    return <div className="p-8 text-sm text-muted-foreground">No workspace selected.</div>
  }

  const { data: run } = await supabase
    .from('agent_run')
    .select(
      `id, status, sandbox_id, repo_full_name, pr_url, branch,
       error_message, log_tail, created_at, started_at, finished_at,
       action_id, flow_id,
       kind, task_prompt, result_summary, deliverables, resources, attention_item_id,
       agent:ai_team_member!ai_team_member_id(id, name, avatar_url),
       agent_recipe:recipe!agent_recipe_id(id, name),
       flow:flow!flow_id(id, name),
       action:actions!action_id(id, title, identifier)`,
    )
    .eq('workspace_id', workspaceId)
    .eq('id', id)
    .maybeSingle()

  if (!run) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-16 text-center text-sm text-muted-foreground">
        Agent run not found in this workspace.
      </div>
    )
  }

  // Supabase types the embedded to-one relations as arrays; the client view
  // expects single objects (the FK is to-one). Normalize the initial payload.
  const normalized = {
    ...run,
    agent: Array.isArray(run.agent) ? run.agent[0] ?? null : run.agent,
    agent_recipe: Array.isArray(run.agent_recipe) ? run.agent_recipe[0] ?? null : run.agent_recipe,
    flow: Array.isArray(run.flow) ? run.flow[0] ?? null : run.flow,
    action: Array.isArray(run.action) ? run.action[0] ?? null : run.action,
  } as Parameters<typeof AgentRunDetail>[0]['initialRun']

  return <AgentRunDetail runId={id} initialRun={normalized} />
}
