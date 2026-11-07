import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { getServiceClient } from '@/lib/admin'
import { apiError, serverError } from '@/lib/api-errors'
import { findLiveActionRun } from '@/lib/agent-run/live-action-run'
import { launchWorkItem, snapshotResources } from '@/lib/work/start-work-item'
import { checkDelegate, memberIdForUser } from '@/lib/actions/delegate'
import { getDefault } from '@/lib/environments/store'
import { startActionOnMac, startInEnvironment } from '@/lib/environments/start'
import { liveActionMacJob } from '@/lib/local-agent/unattended'
import { chatgptPlanFor } from '@/lib/chatgpt/plan-route'
import { CHATGPT_PLAN_NO_CODING_REASON } from '@/lib/chatgpt/plan-models'

/**
 * POST /api/account/actions/[id]/start-agent
 *
 * Starts the action's delegate agent on it (decision 9, the delegate model:
 * the person stays responsible, the agent works it). Start runs the right
 * worker for the action:
 *
 *   - CODING when the action's project has a GitHub repo and the agent's role
 *     (migration 280) is `developer` or unset (agents made before roles keep
 *     coding). Where it runs is the STARTER's choice for that project
 *     (docs/plans/environments.md §3, §7 Q7):
 *       - their "Run my work here" (a per-person environment_default naming
 *         their own Mac): a job on their Mac, in the folder linked to the
 *         project's repo, unattended (the action's title and description are
 *         fenced as untrusted, and the reviewer holds every risky call as
 *         their card). Returns { mode: 'mac', worker: 'local_agent',
 *         sessionId, environmentId, mac, folder }. With no folder linked to
 *         the repo, or the Mac offline, it is refused with a plain sentence
 *         (409), never moved to the cloud;
 *       - otherwise the project's cloud environment, as before: an agent_run
 *         row (its environment_id recorded) and `agent/run.requested`; the
 *         eve coding agent runs it and opens a PR. Returns { mode: 'server',
 *         worker: 'coding_run', agentRunId }.
 *     A teammate's Start reads THEIR choice, so it never reaches your Mac.
 *   - WORK, for an agent with an explicit non-developer role or a project with
 *     no repo: a work run on the EXISTING action (launchWorkItem with
 *     existingActionId, the area's skills and the agent's persona). Returns
 *     { mode: 'server', kind: 'work', worker:
 *     'work_run', reason: 'no_repo' | 'not_a_developer', agentRunId }, so the
 *     caller can say a work run ran instead of the coding agent.
 *
 * The delegate must be an agent the caller can hand work to (checkDelegate:
 * assignable and visible), or the Start is refused 403.
 *
 * One live run per action, of any kind: when one is already going, it returns
 * THAT run ({ mode: 'server', agentRunId, kind, reused: true }, or for a job on
 * the caller's Mac { mode: 'mac', worker: 'local_agent', sessionId, reused:
 * true }) and starts nothing; one on a teammate's Mac is a 409.
 *
 * When the agent finishes, the action goes to review, not Done; the person
 * marks it Done (src/lib/actions/agent-finish.ts).
 *
 * No body.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) return NextResponse.json({ error: 'No workspace' }, { status: 400 })

  // Load the action with its agent assignee + project repo info.
  const { data: action, error: actionErr } = await supabase
    .from('actions')
    .select(
      `id, identifier, title, description, status_id, team_id, project_id,
       assignee_ai_member_id, agent_run_status,
       project:projects!project_id(github_repo)`,
    )
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .single()

  if (actionErr || !action) {
    return NextResponse.json({ error: 'Action not found' }, { status: 404 })
  }

  if (!action.assignee_ai_member_id) {
    return NextResponse.json(
      { error: 'This action is not assigned to an agent' },
      { status: 400 },
    )
  }

  // The delegate must be an agent this caller can hand work to (assignable,
  // and visible: a private team's agents only for its members), whoever set it.
  const agent = await checkDelegate(supabase, {
    userId: user.id,
    workspaceId,
    teammateId: action.assignee_ai_member_id as string,
  })
  if (!agent.ok) {
    return NextResponse.json(
      { error: agent.reason === 'not_found' ? 'Assigned agent could not be loaded' : "You can't start this agent" },
      { status: agent.reason === 'not_found' ? 400 : 403 },
    )
  }

  // Which worker: the coding agent on a project with a repo, unless the agent
  // holds an explicit role other than developer (an agent with no role, as
  // every agent made before roles has, codes as it always did). A work run on
  // this action for everyone else, and the response says why.
  const repo = (action.project as unknown as { github_repo?: string | null } | null)?.github_repo ?? null
  const coding = !!repo && (agent.role === null || agent.role === 'developer')
  const workReason: 'no_repo' | 'not_a_developer' = repo ? 'not_a_developer' : 'no_repo'

  // One live run per action, of any kind. A second Start — a double press, a
  // retried request, Start from another surface while a run is going — gets
  // the run already in flight rather than a second agent working the same
  // action. This is check-then-insert with no constraint behind it, so two
  // requests inside one round trip can still both insert.
  const { run: live, error: liveErr } = await findLiveActionRun(supabase, { workspaceId, actionId: id })
  if (liveErr) {
    return NextResponse.json({ error: liveErr.message }, { status: 500 })
  }
  if (live) {
    return NextResponse.json({
      mode: 'server',
      agentRunId: live.id,
      ...(live.kind === 'workspace' ? { kind: 'work', worker: 'work_run' } : { worker: 'coding_run' }),
      reused: true,
    })
  }
  // …and a job an earlier Start put on a Mac (environments E2).
  const service = getServiceClient()
  let liveMac: Awaited<ReturnType<typeof liveActionMacJob>>
  try {
    liveMac = await liveActionMacJob(service, { workspaceId, actionId: id })
  } catch (err) {
    console.error('[start-agent] live Mac job lookup failed:', err instanceof Error ? err.message : err)
    return serverError()
  }
  if (liveMac) {
    if (liveMac.userId === user.id) return NextResponse.json({ mode: 'mac', worker: 'local_agent', sessionId: liveMac.sessionId, reused: true })
    return apiError('Dial8 is already working on this action on a teammate’s Mac.', { status: 409, code: 'ACTION_BUSY' })
  }

  // ── Work run on this action (every non-coding delegate) ──
  if (!coding) {
    const memberId = await memberIdForUser(supabase, user.id, workspaceId)
    if (!memberId) return NextResponse.json({ error: 'Not a member of this workspace' }, { status: 403 })
    const identifier = (action.identifier as string | null) || id
    const resources = await snapshotResources(
      supabase,
      [{ type: 'action', id, label: `${identifier} ${action.title as string}` }],
      workspaceId,
    )
    const launched = await launchWorkItem(supabase, service, {
      workspaceId,
      userId: user.id,
      memberId,
      title: action.title as string,
      task: delegateTask({
        identifier,
        title: action.title as string,
        description: (action.description as string | null) ?? null,
      }),
      plan: {
        teamId: action.team_id as string,
        statusId: action.status_id as string,
        resources,
      },
      existingActionId: id,
      aiTeamMemberId: action.assignee_ai_member_id as string,
      ledgerTitle: action.title as string,
    })
    if (!launched.ok) {
      return NextResponse.json({ error: launched.error }, { status: launched.stage === 'action' ? 404 : 500 })
    }
    return NextResponse.json({
      mode: 'server',
      kind: 'work',
      // A work run ran, not the coding agent: say so, and why.
      worker: 'work_run',
      reason: workReason,
      agentRunId: launched.agentRunId,
      ...(launched.reused ? { reused: true } : {}),
    })
  }

  // ── Coding: where the person who pressed Start runs this project's work ──
  // Their "Run my work here" (environments §3): a default for this project
  // naming one of THEIR Macs (getDefault reads only their own rows, and only
  // a Mac they own). A teammate's Start reads the teammate's, so it never
  // reaches this person's Mac.
  const projectId = (action.project_id as string | null) ?? null
  let macEnvironmentId: string | null = null
  if (projectId) {
    try {
      macEnvironmentId = await getDefault(service, { userId: user.id, workspaceId, projectId })
    } catch (err) {
      console.error('[start-agent] run-here lookup failed:', err instanceof Error ? err.message : err)
      return serverError()
    }
  }
  if (macEnvironmentId) {
    let onMac: Awaited<ReturnType<typeof startActionOnMac>>
    try {
      onMac = await startActionOnMac(service, {
        userId: user.id,
        workspaceId,
        environmentId: macEnvironmentId,
        repo: repo as string,
        action: {
          id,
          identifier: (action.identifier as string | null) || id,
          title: action.title as string,
          description: (action.description as string | null) ?? null,
        },
      })
    } catch (err) {
      console.error('[start-agent] Mac start failed:', err instanceof Error ? err.message : err)
      return serverError('Could not start it on your Mac. Try again.')
    }
    if (onMac.status === 'refused') return apiError(onMac.reason, { status: onMac.httpStatus, code: onMac.code })
    return NextResponse.json({
      mode: 'mac',
      worker: 'local_agent',
      sessionId: onMac.sessionId,
      environmentId: onMac.environmentId,
      mac: onMac.mac,
      folder: onMac.folder,
      ...(onMac.joined ? { joined: true } : {}),
    })
  }

  // Never a cloud run for a person on their own ChatGPT plan (the free tier):
  // a coding run is Sonnet in a cloud sandbox, all Dial8-paid. agentRunRequested
  // refuses it too, for every other way a coding run starts. (A job on their
  // own Mac, above, carries the plan in its claim and model token.)
  if (await chatgptPlanFor(user.id)) {
    return NextResponse.json({ error: CHATGPT_PLAN_NO_CODING_REASON, code: 'CHATGPT_PLAN_NO_CODING' }, { status: 403 })
  }

  // The project's cloud environment: the eve coding agent, queued through
  // Inngest. The run records the environment it starts in (migration 420):
  // the project's, else the workspace default.
  let started: Awaited<ReturnType<typeof startInEnvironment>>
  try {
    started = await startInEnvironment(service, {
      kind: 'cloud',
      db: supabase,
      workspaceId,
      userId: user.id,
      actionId: id,
      actionTitle: action.title as string | null,
      aiTeamMemberId: action.assignee_ai_member_id as string,
      repo: repo as string,
      projectId,
    })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Could not create run' }, { status: 500 })
  }
  if (started.kind !== 'cloud') return serverError()
  return NextResponse.json({ mode: 'server', worker: 'coding_run', agentRunId: started.agentRunId })
}

/**
 * The work run's task for a delegated action: the action itself, and the
 * delegate's rule that the person marks it Done (the run's finish moves it to
 * review on its own).
 */
function delegateTask(action: { identifier: string; title: string; description: string | null }): string {
  const lines = [
    `Work on ${action.identifier}: ${action.title}`,
    '',
    `You are the delegate on this action; the person who assigned it stays responsible for it.`,
  ]
  if (action.description?.trim()) lines.push('', 'The action says:', action.description.trim())
  lines.push(
    '',
    `When you finish, call finish_work: the action moves to review on its own, and the person marks it Done. Do not complete ${action.identifier} yourself.`,
  )
  return lines.join('\n')
}
