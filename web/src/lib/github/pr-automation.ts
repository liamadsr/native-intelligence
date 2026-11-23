/**
 * Actions that move with their pull requests (docs/plans/github-reviews.md,
 * phase 2; migration 694). Called by the GitHub webhook with the SERVICE
 * client, after its signature check.
 *
 *   branch created naming ENG-42          → in progress (first started state, only from Backlog/Todo)
 *   pull request opened or ready (no draft)→ in review (a started state named like "review";
 *                                            a team with none: its first started state)
 *   merged                                → done (first completed state), once no other
 *                                            open pull request linked to it holds it
 *   closed without merging                → back to the state it was in before the
 *                                            automation first moved it, if nobody moved it
 *                                            by hand since and nothing else holds it
 *
 * The fence, all of it, for every move:
 *   - the repository is one the action's workspace added (workspace_github_repo);
 *   - the pusher or the PR's author is that workspace's member (not a guest),
 *     known by the GitHub id their own sign-in answered (github_identity), and a
 *     PR's author is the repo's OWNER, MEMBER or COLLABORATOR;
 *   - the action's team has github_automation on;
 * so an identifier two workspaces share (ENG-1 in both) only ever moves the
 * one whose repository it is and whose member did the work.
 *
 * Idempotent: a redelivery finds the action already where it would go (every
 * write is guarded on the state it read), and an event older than the last
 * one the automation saw for that pull request (`updated_at`) moves nothing,
 * so a late "opened" after "merged" can't pull it back to review. A step only
 * ever goes forward (begin < review < done) except "back", which only a close
 * without a merge takes. Never throws.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { emitStatusChange } from '@/lib/flows/emit-status-change'
import { beginStateFor, doneStateFor, movedByHandSince, reviewStateFor, type TeamState } from '@/lib/actions/agent-finish'

/** The repo-side associations whose pull requests move actions (as the loops' rule, webhook LOOP_FIRING_AUTHORS). */
export const MOVING_ASSOCIATIONS: ReadonlySet<string> = new Set(['OWNER', 'MEMBER', 'COLLABORATOR'])

const TITLE_ID_RE = /\b([A-Z][A-Z0-9]{0,9}-\d{1,7})\b/g
const BRANCH_ID_RE = /(?:^|[^A-Za-z0-9])([A-Za-z][A-Za-z0-9]{0,9}-\d{1,7})(?![0-9])/g

/** Identifiers in a title or body: upper case, as written (ENG-42). */
export function identifiersInText(text: string | null | undefined): string[] {
  if (!text) return []
  return [...new Set([...text.matchAll(TITLE_ID_RE)].map((m) => m[1]))]
}

/** Identifiers in a branch name, any case (`eng-42-fix-login`, `dana/ENG-42`), upper-cased. */
export function identifiersInBranch(branch: string | null | undefined): string[] {
  if (!branch) return []
  return [...new Set([...branch.matchAll(BRANCH_ID_RE)].map((m) => m[1].toUpperCase()))]
}

export type Step = 'begin' | 'review' | 'done' | 'back'
const RANK: Record<Exclude<Step, 'back'>, number> = { begin: 1, review: 2, done: 3 }

/** Whether `next` may follow the step the automation last took for this pull request. Pure. */
export function stepAllowed(last: Step | null, next: Step): boolean {
  if (!last) return true
  if (next === 'back') return last !== 'done' && last !== 'back'
  if (last === 'back') return true // reopened after a close: it may move forward again
  return RANK[next] > RANK[last]
}

/** Whether an event is older than the newest the automation already applied. Pure. */
export function isStale(eventUpdatedAt: string | null | undefined, lastSeen: string | null | undefined): boolean {
  if (!eventUpdatedAt || !lastSeen) return false
  const a = Date.parse(eventUpdatedAt)
  const b = Date.parse(lastSeen)
  return Number.isFinite(a) && Number.isFinite(b) && a < b
}

export interface Eligible {
  workspaceId: string
  /** Our user whose GitHub account did the work. */
  userId: string
}

/**
 * The workspaces where this repo's event may move actions: those that added
 * the repo AND have the GitHub user as a (non-guest) member.
 */
export async function eligibleWorkspaces(svc: SupabaseClient, repoFullName: string, githubUserId: number | null | undefined): Promise<Eligible[]> {
  if (!githubUserId || !repoFullName) return []
  const { data: ident } = await svc.from('github_identity').select('user_id').eq('github_user_id', githubUserId).maybeSingle()
  const userId = (ident as { user_id?: string } | null)?.user_id
  if (!userId) return []
  const [repos, members] = await Promise.all([
    svc.from('workspace_github_repo').select('workspace_id').eq('repo_full_name', repoFullName.toLowerCase()),
    svc.from('member').select('workspace_id, role').eq('user_id', userId),
  ])
  if (repos.error || members.error) return []
  const added = new Set(((repos.data ?? []) as Array<{ workspace_id: string }>).map((r) => r.workspace_id))
  return ((members.data ?? []) as Array<{ workspace_id: string; role: string | null }>)
    .filter((m) => m.role !== 'guest' && added.has(m.workspace_id))
    .map((m) => ({ workspaceId: m.workspace_id, userId }))
}

interface ActionRow {
  id: string
  workspace_id: string
  team_id: string | null
  status_id: string | null
  identifier: string
}

/** The actions named, in one workspace, whose team has the switch on. */
async function actionsNamed(svc: SupabaseClient, workspaceId: string, identifiers: string[]): Promise<ActionRow[]> {
  if (identifiers.length === 0) return []
  const { data, error } = await svc
    .from('actions')
    .select('id, workspace_id, team_id, status_id, identifier')
    .eq('workspace_id', workspaceId)
    .in('identifier', identifiers)
  if (error) return []
  const rows = (data ?? []) as ActionRow[]
  const teamIds = [...new Set(rows.map((r) => r.team_id).filter((t): t is string => !!t))]
  if (teamIds.length === 0) return []
  const { data: teams, error: teamError } = await svc
    .from('team')
    .select('id')
    .eq('workspace_id', workspaceId)
    .in('id', teamIds)
    .eq('github_automation', true)
  if (teamError) return []
  const on = new Set(((teams ?? []) as Array<{ id: string }>).map((t) => t.id))
  return rows.filter((r) => r.team_id && on.has(r.team_id))
}

async function teamStates(svc: SupabaseClient, teamId: string | null): Promise<TeamState[]> {
  if (!teamId) return []
  const { data } = await svc.from('workflow_state').select('id, name, category, sort_order').eq('team_id', teamId).order('sort_order', { ascending: true })
  return (data ?? []) as TeamState[]
}

/** Move one action, guarded on the state it was read in. The state it moved to, or null. */
async function move(svc: SupabaseClient, action: ActionRow, to: string | null, actorUserId: string): Promise<string | null> {
  if (!to || to === action.status_id) return null
  let write = svc.from('actions').update({ status_id: to }).eq('id', action.id).eq('workspace_id', action.workspace_id)
  write = action.status_id ? write.eq('status_id', action.status_id) : write.is('status_id', null)
  const { data, error } = await write.select('id')
  if (error || ((data ?? []) as unknown[]).length === 0) return null
  emitStatusChange({
    entityType: 'action',
    entityId: action.id,
    workspaceId: action.workspace_id,
    teamId: action.team_id,
    fromStatusId: action.status_id,
    toStatusId: to,
    actorUserId,
    // GitHub's echo, one hop from the person's push.
    origin: { actor: 'sync', depth: 1 },
  })
  return to
}

// ── A branch created ─────────────────────────────────────────────────────────

export interface BranchEvent {
  repoFullName: string
  branch: string
  /** GitHub's id of whoever pushed it (`sender.id`). */
  senderId: number | null
}

/** A branch naming actions was pushed: remember it, and move each to in progress. Returns how many moved. */
export async function onBranchCreated(svc: SupabaseClient, ev: BranchEvent): Promise<number> {
  try {
    const ids = identifiersInBranch(ev.branch)
    if (ids.length === 0) return 0
    let moved = 0
    for (const ws of await eligibleWorkspaces(svc, ev.repoFullName, ev.senderId)) {
      for (const action of await actionsNamed(svc, ws.workspaceId, ids)) {
        // A pull request already moved it (a late "create"): nothing to begin.
        const { data: prs } = await svc.from('action_github_pr').select('auto_step').eq('action_id', action.id).not('auto_step', 'is', null).limit(1)
        if (((prs ?? []) as unknown[]).length > 0) continue
        const target = beginStateFor(await teamStates(svc, action.team_id), action.status_id)
        // Remember the branch, and the state before (kept from its first time: upsert ignores a repeat).
        await svc
          .from('action_github_branch')
          .upsert(
            { workspace_id: ws.workspaceId, action_id: action.id, repo_full_name: ev.repoFullName, branch: ev.branch, status_before_id: action.status_id },
            { onConflict: 'action_id,repo_full_name,branch', ignoreDuplicates: true },
          )
        const to = await move(svc, action, target, ws.userId)
        if (to) {
          await svc.from('action_github_branch').update({ auto_moved_at: new Date().toISOString() }).eq('action_id', action.id).eq('repo_full_name', ev.repoFullName).eq('branch', ev.branch)
          moved++
        }
      }
    }
    return moved
  } catch (err) {
    console.error('[pr-automation] branch move failed', err instanceof Error ? err.message : err)
    return 0
  }
}

// ── A pull request moved ─────────────────────────────────────────────────────

export interface PullEvent {
  /** GitHub's action: opened, reopened, ready_for_review, closed, edited, synchronize… */
  action: string
  repoFullName: string
  number: number
  url: string
  title: string
  body: string | null
  draft: boolean
  merged: boolean
  state: 'open' | 'closed'
  headBranch: string | null
  authorId: number | null
  authorAssociation: string | null
  updatedAt: string | null
  additions: number | null
  deletions: number | null
  changedFiles: number | null
}

/** The pull_request webhook payload as a PullEvent, or null when it isn't one. Pure. */
export function pullEventFrom(payload: unknown): PullEvent | null {
  const p = (payload ?? {}) as Record<string, unknown>
  const pr = (p.pull_request ?? null) as Record<string, unknown> | null
  const repo = (p.repository ?? null) as Record<string, unknown> | null
  if (!pr || !repo || typeof repo.full_name !== 'string' || typeof pr.number !== 'number') return null
  const user = (pr.user ?? {}) as Record<string, unknown>
  const head = (pr.head ?? {}) as Record<string, unknown>
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  return {
    action: String(p.action ?? ''),
    repoFullName: repo.full_name,
    number: pr.number,
    url: typeof pr.html_url === 'string' ? pr.html_url : `https://github.com/${repo.full_name}/pull/${pr.number}`,
    title: typeof pr.title === 'string' ? pr.title : '',
    body: typeof pr.body === 'string' ? pr.body : null,
    draft: pr.draft === true,
    merged: pr.merged === true,
    state: pr.state === 'closed' ? 'closed' : 'open',
    headBranch: typeof head.ref === 'string' ? head.ref : null,
    authorId: n(user.id),
    authorAssociation: typeof pr.author_association === 'string' ? pr.author_association : null,
    updatedAt: typeof pr.updated_at === 'string' ? pr.updated_at : null,
    additions: n(pr.additions),
    deletions: n(pr.deletions),
    changedFiles: n(pr.changed_files),
  }
}

/** The step a pull request event asks for, or null. Pure. */
export function stepFor(ev: Pick<PullEvent, 'action' | 'draft' | 'merged' | 'state'>): Step | null {
  if (ev.action === 'closed') return ev.merged ? 'done' : 'back'
  if ((ev.action === 'opened' || ev.action === 'reopened' || ev.action === 'ready_for_review') && !ev.draft && ev.state === 'open') return 'review'
  return null
}

interface LinkRow {
  id: string
  action_id: string
  pr_state: string | null
  pr_draft: boolean | null
  auto_step: Step | null
  status_before_id: string | null
  auto_moved_at: string | null
  pr_updated_at: string | null
}

/** Another pull request linked to the action is still open (a draft too): it holds the action where it is. */
async function otherOpenLinks(svc: SupabaseClient, actionId: string, ev: Pick<PullEvent, 'repoFullName' | 'number'>): Promise<boolean> {
  const { data, error } = await svc.from('action_github_pr').select('repo_full_name, pr_number, pr_state').eq('action_id', actionId)
  if (error) return true
  return ((data ?? []) as Array<{ repo_full_name: string; pr_number: number; pr_state: string | null }>).some(
    (r) => !(r.repo_full_name.toLowerCase() === ev.repoFullName.toLowerCase() && r.pr_number === ev.number) && r.pr_state !== 'merged' && r.pr_state !== 'closed',
  )
}

export interface PullOutcome {
  linked: number
  moved: number
}

/**
 * A pull request event: link the actions its branch names (fenced), keep
 * every fenced link's size and author, and move each action by the event's
 * step. The title and body links the webhook makes on its own (any
 * workspace with GitHub connected, as before) are moved only inside the
 * fence too.
 */
export async function onPullRequest(svc: SupabaseClient, ev: PullEvent): Promise<PullOutcome> {
  const out: PullOutcome = { linked: 0, moved: 0 }
  try {
    if (!MOVING_ASSOCIATIONS.has(ev.authorAssociation ?? '')) return out
    const eligible = await eligibleWorkspaces(svc, ev.repoFullName, ev.authorId)
    if (eligible.length === 0) return out
    const ids = [...new Set([...identifiersInBranch(ev.headBranch), ...identifiersInText(`${ev.title} ${ev.body ?? ''}`)])]
    const step = stepFor(ev)
    const prState = ev.merged ? 'merged' : ev.state
    for (const ws of eligible) {
      for (const action of await actionsNamed(svc, ws.workspaceId, ids)) {
        // The link, made or refreshed (the size and author are the server's; migration 694's guard).
        const { data: existing } = await svc
          .from('action_github_pr')
          .select('id, action_id, pr_state, pr_draft, auto_step, status_before_id, auto_moved_at, pr_updated_at')
          .eq('action_id', action.id)
          .eq('repo_full_name', ev.repoFullName)
          .eq('pr_number', ev.number)
          .maybeSingle()
        let link = existing as LinkRow | null
        const stale = isStale(ev.updatedAt, link?.pr_updated_at)
        const fields = {
          workspace_id: ws.workspaceId,
          action_id: action.id,
          pr_url: ev.url,
          repo_full_name: ev.repoFullName,
          pr_number: ev.number,
          author_github_id: ev.authorId,
          ...(stale
            ? {}
            : {
                pr_title: ev.title,
                pr_state: prState,
                pr_draft: ev.draft,
                head_branch: ev.headBranch,
                additions: ev.additions,
                deletions: ev.deletions,
                changed_files: ev.changedFiles,
                pr_updated_at: ev.updatedAt,
                last_synced_at: new Date().toISOString(),
              }),
        }
        if (link) {
          await svc.from('action_github_pr').update(fields).eq('id', link.id)
        } else {
          const { data: made } = await svc
            .from('action_github_pr')
            .upsert(fields, { onConflict: 'action_id,repo_full_name,pr_number' })
            .select('id, action_id, pr_state, pr_draft, auto_step, status_before_id, auto_moved_at, pr_updated_at')
            .maybeSingle()
          link = made as LinkRow | null
          if (link) out.linked++
        }
        if (!link || !step || stale) continue
        if (!stepAllowed(link.auto_step, step)) continue
        const states = await teamStates(svc, action.team_id)
        const current = states.find((s) => s.id === action.status_id)
        // A person closed it (Done or Canceled): never reopened from here.
        if (current && (current.category === 'completed' || current.category === 'canceled') && step !== 'done') continue
        if (link.auto_moved_at && (await movedByHandSince(svc, action.id, link.auto_moved_at))) continue
        let target: string | null = null
        if (step === 'review') target = reviewStateFor(states, action.status_id)
        else if (step === 'done') target = (await otherOpenLinks(svc, action.id, ev)) ? null : doneStateFor(states)
        // Back only from where the automation itself put it.
        else if (step === 'back') target = !link.auto_moved_at || (await otherOpenLinks(svc, action.id, ev)) ? null : link.status_before_id
        if (step === 'done' && current && (current.category === 'completed' || current.category === 'canceled')) target = null
        // Where it was before the automation first moved it: the branch's memory, else now.
        let before = link.status_before_id
        if (!before && step === 'review') {
          const { data: br } = await svc
            .from('action_github_branch')
            .select('status_before_id')
            .eq('action_id', action.id)
            .eq('repo_full_name', ev.repoFullName)
            .eq('branch', ev.headBranch ?? '')
            .maybeSingle()
          before = (br as { status_before_id?: string | null } | null)?.status_before_id ?? action.status_id
        }
        const to = await move(svc, action, target, ws.userId)
        await svc
          .from('action_github_pr')
          .update({
            auto_step: step,
            status_before_id: before,
            ...(to ? { auto_moved_at: new Date().toISOString() } : {}),
          })
          .eq('id', link.id)
        if (to) out.moved++
      }
    }
    return out
  } catch (err) {
    console.error('[pr-automation] pull request move failed', err instanceof Error ? err.message : err)
    return out
  }
}
