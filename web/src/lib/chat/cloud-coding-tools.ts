/**
 * start_cloud_coding_run, the chat's cloud counterpart of start_local_agent
 * (docs/plans/environments.md §3, E2), run by the main chat's tool route
 * (/api/internal/chat/tool) with eve's ids. The schema twin is
 * src/lib/ai/tools/cloud-coding.ts.
 *
 * It files an action in the repo's project (the person's own, confirmed, the
 * request as its description) and starts that action's coding run through
 * startInEnvironment: today's action path, with agent_run.environment_id
 *   - the chat's environment, when it is a cloud one (§7 Q7: "anything else
 *     from a chat runs in the chat's environment");
 *   - else the one the person names (environment_id: an offline Mac's
 *     cloud_fallback names its project's). A chat on a Mac has no cloud
 *     default: without one it refuses, listing the choices, and the agent
 *     asks;
 *   - always a SHARED one: project work never runs in an "only me"
 *     environment, since the run and its pull request are the team's.
 * The repo is a project's `github_repo` in the chat's workspace, never one
 * the model makes up: a cloud environment holds no repos (§3, Q9).
 *
 * Typed turns only, like start_local_agent, and keyed on eve's ids
 * (agent_run.fire_key), so a retried call returns the run it started. A
 * refusal the model should read comes back as `status: 'refused'`; only an
 * unexpected failure throws.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { memberIdForUser } from '@/lib/actions/delegate'
import { ensureRoleTeammates, resolveRoleTeammate } from '@/lib/work/role-routing'
import { resolveChatEnvironment } from '@/lib/environments/chat'
import { listCloudEnvironments } from '@/lib/environments/store'
import { ONLY_ME_ENVIRONMENT_CODE, ONLY_ME_PROJECT_REASON, startInEnvironment } from '@/lib/environments/start'
import { EnvironmentError, isRepoFullName, type CloudEnvironment, type NetworkAccess } from '@/lib/environments/types'
import { hasGithub } from '@/lib/local-agent/cloud-fallback'
import { AGENT_PAUSED_CODE, AGENT_PAUSED_REASON, helperStartPaused } from '@/lib/work/agent-paused'
import type { StartCloudCodingRunInput } from '@/lib/ai/tools/cloud-coding'
import type { ChatRunTokenClaims } from './chat-run-token'
import type { LocalAgentLaunch } from './local-agent-tools'

type Svc = SupabaseClient
type Output = Record<string, unknown>

export interface CloudCodingDeps {
  /** The kill switch (src/lib/work/agent-paused.ts); injectable for tests. */
  paused?: (svc: Svc, workspaceId: string) => Promise<boolean>
  /** The GitHub sign-in check; injectable for tests. */
  github?: (svc: Svc, userId: string) => Promise<boolean>
  /** The run's start (startInEnvironment); injectable for tests. */
  start?: typeof startInEnvironment
}

/** A key part: no colon, so the key reads back unambiguously. */
const KEY_PART_RE = /^[^:]{1,200}$/

/** The run's fire_key: one run per (conversation, eve session, turn, call). */
export function cloudCodingFireKey(conversationId: string, launch: LocalAgentLaunch): string {
  return `chat-coding:${conversationId}:session:${launch.sessionId}:turn:${launch.turnId}:call:${launch.callId}`
}

function refused(code: string, reason: string, extra: Output = {}): Output {
  return { status: 'refused', code, reason, ...extra }
}

/** A name someone in the workspace wrote, as quoted data on one line. */
function quoted(text: string | null | undefined, fallback: string): string {
  const t = (text ?? '').replace(/\p{Cc}+/gu, ' ').replace(/\s+/g, ' ').trim().replace(/"/g, "'")
  const one = t.length <= 80 ? t : `${t.slice(0, 79)}…`
  return `"${one || fallback}"`
}

/** Who the run is for: the person, in the workspace it runs in. */
type Who = Pick<ChatRunTokenClaims, 'userId' | 'workspaceId'>

/** What the run is asked to do: the action's title (default: the request's first line) and description. */
interface CodingRequest {
  title?: string
  request: string
}

/**
 * What the filed action records about where it came from. Its source_type is
 * never set: the person asked for the run, so the action is their own and the
 * column keeps its default ('user'). The column's CHECK lists no value for a
 * chat, and an insert with one is refused.
 */
interface FiledFrom {
  contextData?: Record<string, unknown>
}

function titleOf(input: CodingRequest): string {
  const first = (input.title ?? input.request).split('\n').map((l) => l.trim()).find(Boolean) ?? 'Coding run'
  return first.length <= 200 ? first : `${first.slice(0, 199)}…`
}

/** The project's columns the run needs. A project belongs to the workspace, not to a team (migration 019 dropped projects.team_id). */
const PROJECT_FIELDS = 'id, name, github_repo'

interface ProjectRow {
  id: string
  name: string | null
  github_repo: string | null
}

/** A helper's value, or the refusal the model reads instead. */
type Found<T> = { ok: true; value: T } | { ok: false; output: Output }

const no = (output: Output): { ok: false; output: Output } => ({ ok: false, output })

interface RunEnvironmentChoice {
  environmentId: string
  name: string
  networkAccess: NetworkAccess
  /** The chat's own, or one the person chose for this run. */
  source: 'chat' | 'chosen'
}

/** The project (and its repo) the run works on, or the refusal the model reads. */
async function projectFor(svc: Svc, workspaceId: string, input: Pick<StartCloudCodingRunInput, 'project_id' | 'repo'>): Promise<Found<ProjectRow & { github_repo: string }>> {
  if (input.project_id) {
    const { data, error } = await svc.from('projects').select(PROJECT_FIELDS).eq('id', input.project_id).eq('workspace_id', workspaceId).maybeSingle()
    if (error) throw new Error(`project read failed: ${error.message}`)
    const p = data as ProjectRow | null
    if (!p) return no(refused('NOT_FOUND', 'No project with that project_id in this workspace. Nothing was started; the environment section and list_projects list them.'))
    if (!p.github_repo?.trim()) {
      return no(refused('NO_REPO', `Project ${quoted(p.name, 'that project')} has no GitHub repository, so there is nothing to run a coding run on. Nothing was started; tell the person.`))
    }
    // Any member can write the field (projects UPDATE RLS): only an owner/repo runs, or reaches the model.
    if (!isRepoFullName(p.github_repo.trim())) {
      return no(refused('BAD_REPO', `Project ${quoted(p.name, 'that project')}'s GitHub repository isn't a plain owner/repo. Nothing was started; the person fixes it on the project.`))
    }
    return { ok: true, value: { ...p, github_repo: p.github_repo.trim() } }
  }
  const want = (input.repo ?? '').trim().toLowerCase()
  const { data, error } = await svc.from('projects').select(PROJECT_FIELDS).eq('workspace_id', workspaceId).not('github_repo', 'is', null).limit(200)
  if (error) throw new Error(`projects read failed: ${error.message}`)
  const matches = ((data ?? []) as ProjectRow[]).filter((p) => isRepoFullName(p.github_repo?.trim()) && p.github_repo!.trim().toLowerCase() === want)
  if (matches.length === 0) {
    return no(refused('NOT_A_PROJECT_REPO', `${input.repo} isn't the GitHub repository of any project in this workspace. Nothing was started; a coding run works only on a project's repository (the environment section lists them).`))
  }
  if (matches.length > 1) {
    return no(refused('SEVERAL_PROJECTS', `Several projects use ${input.repo}. Nothing was started; call again with the project_id of the one the person means.`, {
      projects: matches.map((p) => ({ project_id: p.id, name: p.name ?? '' })),
    }))
  }
  return { ok: true, value: { ...matches[0], github_repo: (matches[0].github_repo ?? '').trim() } }
}

/** Where the run goes (§7 Q7, and the E2 review's S4 and S7), or the refusal the model reads. */
async function environmentFor(
  svc: Svc,
  claims: ChatRunTokenClaims,
  explicit: string | undefined,
): Promise<Found<RunEnvironmentChoice>> {
  const [chat, cloud] = await Promise.all([
    // Resolving it for a start pins it on the chat (chat.ts).
    resolveChatEnvironment(svc, { userId: claims.userId, workspaceId: claims.workspaceId, conversationId: claims.conversationId, pin: true }),
    listCloudEnvironments(svc, { userId: claims.userId, workspaceId: claims.workspaceId }),
  ])
  const shared = cloud.filter((e) => e.shared)
  const onlyMe = no(refused(ONLY_ME_ENVIRONMENT_CODE, ONLY_ME_PROJECT_REASON))
  const pick = (e: CloudEnvironment, source: RunEnvironmentChoice['source']): Found<RunEnvironmentChoice> => ({
    ok: true,
    value: { environmentId: e.id, name: e.name, networkAccess: e.networkAccess, source },
  })
  if (explicit) {
    // One the person named (or an offline Mac's fallback named): any shared,
    // live cloud environment of this workspace; never an "only me" one.
    const named = cloud.find((e) => e.id === explicit)
    if (named && !named.shared) return onlyMe
    if (!named) {
      return no(refused('ENVIRONMENT_NOT_ALLOWED', 'That isn’t a cloud environment of this workspace that this run can use. Nothing was started.', { environments: choices(shared) }))
    }
    return pick(named, chat.environmentId === named.id ? 'chat' : 'chosen')
  }
  const chatCloud = chat.environment?.kind === 'cloud' ? chat.environment : null
  if (chatCloud) return chatCloud.shared ? pick(chatCloud, 'chat') : onlyMe
  // A chat on a Mac (or on nothing): the person says which cloud environment.
  return no(
    refused('NEEDS_ENVIRONMENT', 'This chat isn’t on a cloud environment. Nothing was started. Ask the person which cloud environment to use, then pass it as environment_id.', {
      environments: choices(shared),
    }),
  )
}

/** The cloud environments the person may pick from, as the model reads them (names are data). */
function choices(envs: CloudEnvironment[]): Output[] {
  return envs.slice(0, 20).map((e) => ({ environment_id: e.id, name: quoted(e.name, 'Cloud'), network_access: e.networkAccess }))
}

/**
 * The workspace's coding agent (its Developer) this person can hand work to:
 * role routing for a person's Start, fenced to the teams they can see. A
 * workspace whose teammates hold no role yet gets its role teammates first,
 * as an attempt does (coding/proactive.ts).
 */
async function developerFor(svc: Svc, claims: Who): Promise<Found<string>> {
  const route = () => resolveRoleTeammate(svc, { workspaceId: claims.workspaceId, role: 'developer', purpose: 'start', requestingUserId: claims.userId })
  let routed = await route()
  if (!('error' in routed) && !routed.teammate && routed.reason === 'no_teammate') {
    const ensured = await ensureRoleTeammates(svc, { workspaceId: claims.workspaceId, createdBy: claims.userId })
    if (!('error' in ensured) && ensured.seeded > 0) routed = await route()
  }
  if ('error' in routed) throw new Error(`coding agent lookup failed: ${routed.error}`)
  if (!routed.teammate) {
    return no(
      refused(
        'NO_CODING_AGENT',
        routed.reason === 'teammate_off'
          ? "This workspace's coding agent is switched off. Nothing was started; the person turns it back on in Agents."
          : 'This workspace has no coding agent (a Developer) this person can hand work to. Nothing was started; tell the person.',
      ),
    )
  }
  return { ok: true, value: routed.teammate.id }
}

/**
 * The team the action is filed in: the workspace's first that this person may
 * see (a public team, or a private one they are on). A project has no team of
 * its own to prefer. The service client sees every team, so it checks.
 */
async function teamFor(svc: Svc, workspaceId: string, memberId: string | null): Promise<string | null> {
  const [teams, mine] = await Promise.all([
    svc.from('team').select('id, is_private, created_at').eq('workspace_id', workspaceId).order('created_at', { ascending: true }).limit(50),
    memberId ? svc.from('team_member').select('team_id').eq('member_id', memberId) : Promise.resolve({ data: [], error: null }),
  ])
  if (teams.error) throw new Error(`teams read failed: ${teams.error.message}`)
  if (mine.error) throw new Error(`team membership read failed: ${mine.error.message}`)
  const onTeam = new Set(((mine.data ?? []) as Array<{ team_id: string }>).map((t) => t.team_id))
  const visible = ((teams.data ?? []) as Array<{ id: string; is_private: boolean | null }>).filter((t) => t.is_private === false || onTeam.has(t.id))
  return visible[0]?.id ?? null
}

/** The action the run works on: the person's own, confirmed, in the project, in the default team's default state. */
async function fileAction(
  svc: Svc,
  claims: Who,
  project: ProjectRow,
  input: CodingRequest,
  developerId: string,
  from: FiledFrom,
): Promise<Found<{ id: string; identifier: string | null; title: string }>> {
  const memberId = await memberIdForUser(svc, claims.userId, claims.workspaceId)
  const teamId = await teamFor(svc, claims.workspaceId, memberId)
  if (!teamId) return no(refused('NO_TEAM', 'This workspace has no team this person can file the action in. Nothing was started; tell the person.'))
  const { data: state } = await svc.from('workflow_state').select('id').eq('team_id', teamId).eq('is_default', true).maybeSingle()
  const statusId = (state as { id?: string } | null)?.id
  if (!statusId) return no(refused('NO_STATE', 'The team has no default board column to file the action in. Nothing was started; tell the person.'))
  const title = titleOf(input)
  const { data, error } = await svc
    .from('actions')
    .insert({
      user_id: claims.userId,
      workspace_id: claims.workspaceId,
      team_id: teamId,
      project_id: project.id,
      title,
      description: input.request,
      priority: 'none',
      status_id: statusId,
      confirmation: 'confirmed',
      ...(from.contextData ? { context_data: from.contextData } : {}),
      all_day: true,
      links: [],
      // The person stays responsible; their coding agent works it (decision 9).
      assignee_ai_member_id: developerId,
      ...(memberId ? { assignee_id: memberId } : {}),
    })
    .select('id, identifier')
    .single()
  if (error || !data) throw new Error(`action insert failed: ${error?.message ?? 'no row'}`)
  const row = data as { id: string; identifier: string | null }
  if (memberId) {
    const { error: assigneeError } = await svc.from('action_assignee').insert({ action_id: row.id, member_id: memberId })
    if (assigneeError) {
      // An action half-made is no action: take it back, and say it didn't start.
      await svc.from('actions').delete().eq('id', row.id).eq('workspace_id', claims.workspaceId)
      throw new Error(`action assignee insert failed: ${assigneeError.message}`)
    }
  }
  return { ok: true, value: { id: row.id, identifier: row.identifier, title } }
}

async function runByFireKey(svc: Svc, workspaceId: string, fireKey: string): Promise<{ id: string; action_id: string | null; status: string | null } | null> {
  const { data, error } = await svc.from('agent_run').select('id, action_id, status').eq('workspace_id', workspaceId).eq('fire_key', fireKey).maybeSingle()
  if (error) throw new Error(`run read failed: ${error.message}`)
  return (data as { id: string; action_id: string | null; status: string | null } | null) ?? null
}

/** Why this call's run never started (it failed to dispatch, and the run was marked so). */
const NOT_STARTED_REASON = 'This call’s coding run never started (it failed to dispatch). Nothing is running; tell the person, who can ask again.'

/**
 * start_cloud_coding_run: a typed turn's coding run in the cloud. Never a
 * server turn (the route refuses one first; this holds whoever calls).
 */
export async function startCloudCodingRun(
  svc: Svc,
  claims: ChatRunTokenClaims,
  launch: LocalAgentLaunch,
  input: StartCloudCodingRunInput,
  deps: CloudCodingDeps = {},
): Promise<Output> {
  if (claims.surface || claims.teammateId || claims.relay || claims.server) {
    return refused('TYPED_TURNS_ONLY', 'A coding run starts only from a message the person typed. Nothing was started; tell the person what you would start.')
  }
  if (typeof launch.callId !== 'string' || !launch.callId.trim() || launch.callId.length > 200) throw new Error('A durable tool call id is required')
  if (typeof launch.turnId !== 'string' || !KEY_PART_RE.test(launch.turnId)) throw new Error('A durable turn id is required')
  if (typeof launch.sessionId !== 'string' || !KEY_PART_RE.test(launch.sessionId)) throw new Error('A durable session id is required')
  const fireKey = cloudCodingFireKey(claims.conversationId, launch)

  // A retried call (eve lost the first answer): the run it already started.
  const earlier = await runByFireKey(svc, claims.workspaceId, fireKey)
  // A run this call wrote that never dispatched is not "started".
  if (earlier && (earlier.status === 'failed' || earlier.status === 'canceled')) return refused('NOT_STARTED', NOT_STARTED_REASON)
  if (earlier) {
    return { status: 'started', reused: true, agent_run_id: earlier.id, ...(earlier.action_id ? { action_id: earlier.action_id } : {}), note: 'Already started by this call; it opens a pull request when done.' }
  }

  if (await (deps.paused ?? helperStartPaused)(svc, claims.workspaceId)) {
    return refused(AGENT_PAUSED_CODE, `${AGENT_PAUSED_REASON}. Nothing was started; tell the person.`)
  }
  const found = await projectFor(svc, claims.workspaceId, input)
  if (!found.ok) return found.output
  const chosen = await environmentFor(svc, claims, input.environment_id)
  if (!chosen.ok) return chosen.output
  return launchCodingRun(svc, claims, found.value, chosen.value, input, { fireKey, from: {} }, deps)
}

/**
 * The run itself, once the project and the environment are settled: the
 * person's GitHub, the workspace's coding agent, the action it works (filed
 * in the project), and the start. Shared by the chat's tool, a work card's
 * Start in a cloud environment (startCardCodingRun) and a website change
 * (startSiteCodingRun).
 */
async function launchCodingRun(
  svc: Svc,
  claims: Who,
  project: ProjectRow & { github_repo: string },
  env: RunEnvironmentChoice,
  input: CodingRequest,
  opts: { fireKey?: string; from: FiledFrom },
  deps: CloudCodingDeps,
): Promise<Output> {
  const { fireKey } = opts
  const repo = project.github_repo
  if (!(await (deps.github ?? hasGithub)(svc, claims.userId))) {
    return refused('NO_GITHUB', 'A coding run pushes to GitHub as the person, and they have not connected GitHub. Nothing was started; they connect it in Settings → Connections.')
  }
  // The coding agent that works it: a coding run needs one (spec-rebuild's
  // persona precondition), and the action is delegated to it, as a Start would.
  const dev = await developerFor(svc, claims)
  if (!dev.ok) return dev.output

  const filedResult = await fileAction(svc, claims, project, input, dev.value, opts.from)
  if (!filedResult.ok) return filedResult.output
  const filed = filedResult.value
  const dropAction = async () => {
    const { error } = await svc.from('actions').delete().eq('id', filed.id).eq('workspace_id', claims.workspaceId)
    if (error) console.warn('[cloud-coding] removing an unstarted action failed:', error.message)
  }

  let started: Awaited<ReturnType<typeof startInEnvironment>>
  try {
    started = await (deps.start ?? startInEnvironment)(svc, {
      kind: 'cloud',
      db: svc,
      workspaceId: claims.workspaceId,
      userId: claims.userId,
      actionId: filed.id,
      actionTitle: filed.title,
      aiTeamMemberId: dev.value,
      repo,
      projectId: project.id,
      environmentId: env.environmentId,
      ...(fireKey ? { fireKey } : {}),
    })
  } catch (err) {
    // A run written before the dispatch failed reads as failed, so a retry
    // (or a failed take-back below) never reports it as started.
    if (fireKey) {
      const { error: markError } = await svc
        .from('agent_run')
        .update({ status: 'failed', error_message: 'It failed to dispatch from the chat.' })
        .eq('workspace_id', claims.workspaceId)
        .eq('fire_key', fireKey)
        .eq('status', 'queued')
      if (markError) console.warn('[cloud-coding] marking an undispatched run failed:', markError.message)
    }
    await dropAction()
    if (err instanceof EnvironmentError) return refused(String((err.details as { code?: unknown } | undefined)?.code ?? 'ENVIRONMENT_UNUSABLE'), err.message)
    throw err
  }
  if (started.kind !== 'cloud') throw new Error('expected a cloud run')
  // A retry of this call won the race to the run: its action is the one, not this.
  if (started.reused) {
    await dropAction()
    return { status: 'started', reused: true, agent_run_id: started.agentRunId, note: 'Already started by this call; it opens a pull request when done.' }
  }

  const where = `in the cloud, ${quoted(env.name, 'its environment')} (${env.networkAccess} network)`
  return {
    status: 'started',
    agent_run_id: started.agentRunId,
    action: { id: filed.id, identifier: filed.identifier },
    project: { id: project.id, name: project.name ?? '' },
    repo,
    environment: { id: env.environmentId, name: env.name, network_access: env.networkAccess, from: env.source },
    note:
      `Filed ${filed.identifier || filed.id} in project ${quoted(project.name, 'project')} and started a coding run on ${quoted(repo, 'repo')} ${where}. ` +
      "It works on the repository on GitHub (not on changes the person hasn't pushed), opens a pull request when done, and reports on the action. Tell the person where it runs; don't claim it is done.",
  }
}

// ── A work card's Start in a cloud environment ─────────────────────────────

/** What the person reads when a card's cloud Start didn't start, by refusal code. */
const CARD_REFUSALS: Record<string, string> = {
  [AGENT_PAUSED_CODE]: `${AGENT_PAUSED_REASON}.`,
  NOT_FOUND: 'That project isn’t in this workspace any more. Pick another place for this work.',
  NO_REPO: 'That project has no GitHub repository any more. Pick another place for this work.',
  BAD_REPO: 'That project’s GitHub repository isn’t a plain owner/repo. Fix it on the project, then press Start again.',
  ENVIRONMENT_NOT_ALLOWED: 'That cloud environment was archived or can’t be used here. Pick another place for this work.',
  [ONLY_ME_ENVIRONMENT_CODE]: ONLY_ME_PROJECT_REASON,
  NO_GITHUB: 'A coding run pushes to GitHub as you. Connect GitHub in Settings → Connections, then press Start again.',
  NO_CODING_AGENT: 'This workspace has no coding agent (a Developer) you can hand this to, or it’s switched off. Check Agents, then press Start again.',
  NO_TEAM: 'This workspace has no team you can file the action in.',
  NO_STATE: 'The team has no default board column to file the action in.',
}

/** Any other refusal (an environment that stopped being usable on the way). */
const CARD_REFUSAL_FALLBACK = 'Couldn’t start it in that cloud environment. Pick another place for this work, or try again.'

/**
 * A work card's Start in the cloud environment and project repo the person
 * picked on the card (src/lib/attention/settle-card.ts): the chat tool's run,
 * filed as the card's action. The environment is the one named, and only a
 * shared, live one of the card's workspace; the repo, the project's. Every
 * refusal is the sentence the person reads, never the model's.
 */
export async function startCardCodingRun(
  svc: Svc,
  who: Who,
  input: { projectId: string; environmentId: string; title: string; request: string; attentionItemId: string },
  deps: CloudCodingDeps = {},
): Promise<Output> {
  const out = await cardCodingRun(svc, who, input, deps)
  if (out.status !== 'refused') return out
  const code = String(out.code)
  return refused(code, CARD_REFUSALS[code] ?? CARD_REFUSAL_FALLBACK)
}

// ── A business's website (roadmap track E, src/lib/website/start.ts) ───────

/**
 * A coding run on a business's connected website repo: the chat tool's run,
 * filed in the site's project and run in the site's cloud environment, both
 * set up when the site connected. Keyed on the website change (fire key
 * `website-change:<id>`), so a retried start returns the run it started.
 * The refusal codes are the chat tool's; src/lib/website/start.ts says them
 * to the owner in plain words.
 */
export async function startSiteCodingRun(
  svc: Svc,
  who: Who,
  input: { projectId: string; environmentId: string; title: string; request: string; changeId: string },
  deps: CloudCodingDeps = {},
): Promise<Output> {
  if (await (deps.paused ?? helperStartPaused)(svc, who.workspaceId)) return refused(AGENT_PAUSED_CODE, AGENT_PAUSED_REASON)
  const found = await projectFor(svc, who.workspaceId, { project_id: input.projectId })
  if (!found.ok) return found.output
  const cloud = await listCloudEnvironments(svc, { userId: who.userId, workspaceId: who.workspaceId })
  const named = cloud.find((e) => e.id === input.environmentId)
  if (!named) return refused('ENVIRONMENT_NOT_ALLOWED', 'not a usable cloud environment of this workspace')
  if (!named.shared) return refused(ONLY_ME_ENVIRONMENT_CODE, ONLY_ME_PROJECT_REASON)
  return launchCodingRun(
    svc,
    who,
    found.value,
    { environmentId: named.id, name: named.name, networkAccess: named.networkAccess, source: 'chosen' },
    { title: input.title, request: input.request },
    { fireKey: `website-change:${input.changeId}`, from: { contextData: { website_change_id: input.changeId } } },
    deps,
  )
}

async function cardCodingRun(
  svc: Svc,
  who: Who,
  input: { projectId: string; environmentId: string; title: string; request: string; attentionItemId: string },
  deps: CloudCodingDeps,
): Promise<Output> {
  if (await (deps.paused ?? helperStartPaused)(svc, who.workspaceId)) return refused(AGENT_PAUSED_CODE, AGENT_PAUSED_REASON)
  const found = await projectFor(svc, who.workspaceId, { project_id: input.projectId })
  if (!found.ok) return found.output
  const cloud = await listCloudEnvironments(svc, { userId: who.userId, workspaceId: who.workspaceId })
  const named = cloud.find((e) => e.id === input.environmentId)
  if (!named) return refused('ENVIRONMENT_NOT_ALLOWED', 'not a usable cloud environment of this workspace')
  if (!named.shared) return refused(ONLY_ME_ENVIRONMENT_CODE, ONLY_ME_PROJECT_REASON)
  return launchCodingRun(
    svc,
    who,
    found.value,
    { environmentId: named.id, name: named.name, networkAccess: named.networkAccess, source: 'chosen' },
    { title: input.title, request: input.request },
    { from: { contextData: { attention_item_id: input.attentionItemId } } },
    deps,
  )
}
