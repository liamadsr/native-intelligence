import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { getServiceClient } from '@/lib/admin'
import { apiError, badRequest, serverError } from '@/lib/api-errors'
import { isWorkerId, workerLabel } from '@/lib/environments/types'
import { findLiveActionRun } from '@/lib/agent-run/live-action-run'
import { launchWorkItem, snapshotResources } from '@/lib/work/start-work-item'
import { checkDelegate, memberIdForUser } from '@/lib/actions/delegate'
import { getDefault, getEnvironment } from '@/lib/environments/store'
import { lastActionPlace } from '@/lib/environments/last-action-place'
import { isUuid } from '@/lib/local-agent/store'
import { startActionOnMac, startInEnvironment } from '@/lib/environments/start'
import { liveActionMacJob, type PersonAgentChoice } from '@/lib/local-agent/unattended'
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
 * Body (optional, JSON): { worker?: string | null, environmentId?: string | null }.
 *
 * `environmentId`: where THIS Start runs, chosen on the action (the owner's
 * rule, 11-19: the place is per task; "Run my work here" is only the
 * default). Absent: their "Run my work here" for the project, as before;
 * null: the project's cloud environment; an id: one of the CALLER's own Macs
 * (getEnvironment reads only theirs), so a teammate's Start never reaches
 * another person's Mac. It is checked the way the default is: a Mac that
 * isn't theirs (or was removed) is refused (409 MAC_UNAVAILABLE), and on
 * their Mac an offline Mac or no folder linked to the repo is refused with
 * its sentence, never moved to the cloud. Only a coding Start runs on a
 * Mac: an id for any other is refused (409 MAC_NEEDS_CODING). Nothing is
 * stored: the run records where it ran (lastActionPlace reads it back).
 *
 * `folderId`: when no folder on the Mac is linked to the project's repo,
 * the folder the person picked at the Start to hold it. startActionOnMac
 * links it (the same write as Edit environment) and starts there, only for
 * a git folder of that Mac with edits allowed; without one it is refused
 * (NO_LINKED_FOLDER) as before. Ignored when a folder is already linked,
 * and on a cloud Start.
 *
 * `worker` (migration 658): who does the work when it runs on the person's Mac.
 *   no body, or no `worker`  Native Intelligence's own agent, exactly as
 *                 before this existed (every caller that doesn't choose:
 *                 accepting a proposed card, the attention verbs);
 *   `worker: null`  Native Intelligence's own agent, chosen;
 *   `worker: "<id>"`  one of the person's own coding agents on that Mac (the
 *                 worker-id shape, and one the Mac last said it offers).
 * Only the action panel's Start sends a choice, and only what its "with"
 * control shows the person (GET below says when it may). Only this route,
 * a signed-in person's own click, may put work on their own agent
 * (unattended.ts PersonAgentChoice); the Mac's saved choice is never read
 * here (a chat start reads it). An id asked for where the work can't run on
 * their Mac (no repo, not a developer agent, no "Run my work here") is
 * refused with the reason (409 OWN_AGENT_NEEDS_MAC), never moved to the
 * cloud. A live run on another agent than the one asked for (a cloud run, or
 * a Mac job) is refused (409 ACTION_BUSY), never silently reused; the Mac
 * refuses an agent it doesn't offer with its own sentence, and the job
 * fails with it.
 *
 * GET: where this person's Start of this action would run, for the
 * panel's "Run on" picker. { onMac, coding, last }:
 *   coding  { projectId, repo } when the Start is a coding run (a repo, a
 *           developer agent or one with no role); else null (a work run: it
 *           never runs on a Mac, and the rest is null too);
 *   onMac   { environmentId } when their "Run my work here" for the project
 *           names one of their Macs (the project default); else null;
 *   last    where they last ran THIS action and with whom ({ environmentId:
 *           a Mac's, or null for the cloud; worker }), or null when they
 *           never did. The picker opens on `last`, else on the default.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) return NextResponse.json({ error: 'No workspace' }, { status: 400 })
  const { data: action } = await supabase
    .from('actions')
    .select('id, project_id, assignee_ai_member_id, project:projects!project_id(github_repo)')
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  if (!action) return NextResponse.json({ error: 'Action not found' }, { status: 404 })
  const answer = (
    coding: { projectId: string; repo: string } | null,
    environmentId: string | null = null,
    last: { environmentId: string | null; worker: string | null } | null = null,
  ) => NextResponse.json({ onMac: environmentId ? { environmentId } : null, coding, last }, { headers: { 'Cache-Control': 'no-store' } })
  const repo = (action.project as unknown as { github_repo?: string | null } | null)?.github_repo ?? null
  const projectId = (action.project_id as string | null) ?? null
  if (!action.assignee_ai_member_id || !repo || !projectId) return answer(null)
  const agent = await checkDelegate(supabase, { userId: user.id, workspaceId, teammateId: action.assignee_ai_member_id as string })
  // The same rule POST runs by: a developer agent, or one with no role.
  if (!agent.ok || !(agent.role === null || agent.role === 'developer')) return answer(null)
  try {
    const svc = getServiceClient()
    const [environmentId, last] = await Promise.all([
      getDefault(svc, { userId: user.id, workspaceId, projectId }),
      lastActionPlace(svc, { userId: user.id, workspaceId, actionId: id }),
    ])
    return answer({ projectId, repo }, environmentId, last)
  } catch (err) {
    console.error('[start-agent] run-here lookup failed:', err instanceof Error ? err.message : err)
    return serverError()
  }
}
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const body = await readStartBody(request)
  if (body instanceof Response) return body
  const { asked, place, folderId } = body
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
    // Asked for one of the person's own agents while a cloud run (Native
    // Intelligence's own agent) works this card: never a silent reuse.
    if (asked && asked.worker !== null) {
      return apiError(
        `A ${live.kind === 'workspace' ? 'work run' : 'cloud coding run'} by Native Intelligence is already working on this card. Wait for it to finish, or stop it, then press Start again.`,
        { status: 409, code: 'ACTION_BUSY' },
      )
    }
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
    if (liveMac.userId !== user.id) return apiError('Native Intelligence is already working on this action on a teammate’s Mac.', { status: 409, code: 'ACTION_BUSY' })
    // Asked for another agent than the one already working it: never a silent reuse.
    if (asked && asked.worker !== liveMac.worker) {
      return apiError(
        `${liveMac.worker ? `Your own ${workerLabel(liveMac.worker)}` : 'Native Intelligence'} is already working on this action on ${liveMac.deviceName || 'your Mac'}. Wait for it to finish, or stop it, then press Start again.`,
        { status: 409, code: 'ACTION_BUSY' },
      )
    }
    return NextResponse.json({ mode: 'mac', worker: 'local_agent', agent: liveMac.worker, sessionId: liveMac.sessionId, reused: true })
  }
  // An agent of the person's own was asked for: it runs only on their Mac.
  const ownAgentAsked = !!asked && asked.worker !== null

  // ── Work run on this action (every non-coding delegate) ──
  // A Mac picked for this Start: only a coding run goes to a Mac.
  if (!coding && place && place.environmentId !== null) {
    return apiError(
      repo
        ? 'Only coding runs on your Mac, and this action’s agent isn’t a developer. Start it in the cloud instead.'
        : 'Only coding runs on your Mac: this action’s project has no GitHub repository. Start it in the cloud instead.',
      { status: 409, code: 'MAC_NEEDS_CODING' },
    )
  }
  if (!coding && ownAgentAsked) {
    return apiError(
      repo
        ? 'Your own coding agent works only on coding: this action’s agent isn’t a developer. Start it with Native Intelligence instead.'
        : 'Your own coding agent needs this action’s project to have a GitHub repository linked to a folder on your Mac. Nothing started.',
      { status: 409, code: 'OWN_AGENT_NEEDS_MAC' },
    )
  }
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
  if (place) {
    // Picked on the action for this Start: the cloud, or one of the CALLER's
    // own Macs (getEnvironment reads only theirs: a teammate's never resolves).
    if (place.environmentId !== null) {
      let env: Awaited<ReturnType<typeof getEnvironment>>
      try {
        env = await getEnvironment(service, { userId: user.id, workspaceId, environmentId: place.environmentId })
      } catch (err) {
        console.error('[start-agent] picked Mac lookup failed:', err instanceof Error ? err.message : err)
        return serverError()
      }
      if (!env || env.kind !== 'mac') {
        return apiError('That Mac isn’t one of yours in Native Intelligence any more. Pick another place to run it, then press Start again.', {
          status: 409,
          code: 'MAC_UNAVAILABLE',
        })
      }
      macEnvironmentId = env.id
    }
  } else if (projectId) {
    try {
      macEnvironmentId = await getDefault(service, { userId: user.id, workspaceId, projectId })
    } catch (err) {
      console.error('[start-agent] run-here lookup failed:', err instanceof Error ? err.message : err)
      return serverError()
    }
  }
  if (!macEnvironmentId && ownAgentAsked) {
    return apiError(
      'Your own coding agent runs on your Mac: pick your Mac where this action runs. Nothing started.',
      { status: 409, code: 'OWN_AGENT_NEEDS_MAC' },
    )
  }
  if (macEnvironmentId) {
    let onMac: Awaited<ReturnType<typeof startActionOnMac>>
    try {
      onMac = await startActionOnMac(service, {
        // A person's own click that named who does the work; none named: Native Intelligence's own agent.
        ...(asked ? { agent: asked } : {}),
        // The folder they picked to hold the repo when none is linked (only one of this Mac's).
        ...(folderId ? { folderId } : {}),
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
      agent: onMac.worker,
      ...(onMac.joined ? { joined: true } : {}),
    })
  }

  // Never a cloud run for a person on their own ChatGPT plan (the free tier):
  // a coding run is Sonnet in a cloud sandbox, all NI-paid. agentRunRequested
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
 * The body. `worker` as the person's agent choice: absent (no body, an
 * empty one, or no `worker` key) → undefined, Native Intelligence's own
 * agent as before; null → Native Intelligence's own agent, chosen; an id in
 * the worker-id shape → that agent. `environmentId` as the place picked for
 * this Start (see the route's doc). Anything else is a 400.
 */
async function readStartBody(
  request: Request,
): Promise<{ asked: PersonAgentChoice | undefined; place: { environmentId: string | null } | undefined; folderId: string | undefined } | Response> {
  const text = await request.text().catch(() => '')
  if (!text.trim()) return { asked: undefined, place: undefined, folderId: undefined }
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return badRequest('Invalid JSON')
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return badRequest('Expected a JSON object')
  let asked: PersonAgentChoice | undefined
  if ('worker' in body) {
    const worker = (body as { worker?: unknown }).worker
    if (worker === null) asked = { worker: null }
    else if (isWorkerId(worker)) asked = { worker }
    else return badRequest('worker must be a coding agent’s id (like claude-code), or null for Native Intelligence')
  }
  // Where this Start runs: absent → the project default; null → the cloud; an id → one of their Macs.
  let place: { environmentId: string | null } | undefined
  if ('environmentId' in body) {
    const environmentId = (body as { environmentId?: unknown }).environmentId
    if (environmentId === null) place = { environmentId: null }
    else if (isUuid(environmentId)) place = { environmentId }
    else return badRequest('environmentId must be one of your Macs’ environment ids, or null for the cloud')
  }
  // A folder picked at the Start to hold the repo (startActionOnMac takes it only on that Mac).
  let folderId: string | undefined
  if ('folderId' in body && (body as { folderId?: unknown }).folderId != null) {
    const id = (body as { folderId?: unknown }).folderId
    if (!isUuid(id)) return badRequest('folderId must be one of your Mac’s folder ids')
    folderId = id
  }
  return { asked, place, folderId }
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
