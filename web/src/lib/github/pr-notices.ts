/**
 * GitHub's news in the person's notifications (docs/plans/github-reviews.md,
 * phase 3; migration 695). Called by the GitHub webhook with the SERVICE
 * client, after its signature check.
 *
 *   pull_request.review_requested           → the requested reviewer: github_review_requested
 *   issue_comment.created (on a PR),
 *   pull_request_review.submitted (a body,
 *     or changes requested / approved),
 *   pull_request_review_comment.created     → the PR's author and every @login named: github_pr_comment
 *   check_suite.completed, failing, on a
 *     PR's head                             → the PR's author, once per head commit: github_checks_failed
 *
 * A GitHub user hears only as one of our people (github_identity: the id
 * GitHub answered for their own token), never the one who did it, and never
 * a guest. One notice per person, in the workspace where the pull request is
 * linked to an action they can see (its team's visibility), else the
 * workspace of their newest GitHub connection, else their first membership.
 * The notice names only linked actions they can see. A redelivered webhook
 * notifies nobody twice (the delivery id in metadata). Never throws.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { createNotification, type NotificationType } from '@/lib/notifications'
import { resolveVisibilityFence } from '@/lib/views/visibility-fence'

export interface PrRef {
  repo: string
  number: number
  url: string
  title: string
}

/** Text shortened for a notice body, on one line. Pure. */
export function snippet(text: string | null | undefined, max = 140): string {
  const t = (text ?? '').replace(/<!--[\s\S]*?-->/g, '').replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t
}

/** The @logins a comment names (GitHub's own login shape), lower case. Pure. */
export function mentionedLogins(text: string | null | undefined): string[] {
  if (!text) return []
  const out = new Set<string>()
  for (const m of text.matchAll(/(?:^|[^A-Za-z0-9_`/])@([A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38})(?![A-Za-z0-9-])/g)) out.add(m[1].toLowerCase())
  return [...out]
}

interface Person {
  userId: string
  githubId: number
}

async function peopleByGithubIds(svc: SupabaseClient, ids: number[]): Promise<Person[]> {
  if (ids.length === 0) return []
  const { data } = await svc.from('github_identity').select('user_id, github_user_id').in('github_user_id', ids)
  return ((data ?? []) as Array<{ user_id: string; github_user_id: number }>).map((r) => ({ userId: r.user_id, githubId: r.github_user_id }))
}

async function peopleByLogins(svc: SupabaseClient, logins: string[]): Promise<Person[]> {
  if (logins.length === 0) return []
  const { data } = await svc.from('github_identity').select('user_id, github_user_id, login')
    .in('login', [...new Set(logins.map((l) => l.toLowerCase()))])
  const want = new Set(logins.map((l) => l.toLowerCase()))
  return ((data ?? []) as Array<{ user_id: string; github_user_id: number; login: string }>)
    .filter((r) => want.has(r.login.toLowerCase()))
    .map((r) => ({ userId: r.user_id, githubId: r.github_user_id }))
}

export interface NoticePlace {
  workspaceId: string
  memberId: string
  /** The linked actions they can see in that workspace. */
  actionIds: string[]
}

/** Where a person hears of this pull request (the module's rule), or null when they are no one's member. */
export async function placeFor(svc: SupabaseClient, userId: string, pr: Pick<PrRef, 'repo' | 'number'>): Promise<NoticePlace | null> {
  const { data: members } = await svc.from('member').select('id, workspace_id, role').eq('user_id', userId)
  const seats = ((members ?? []) as Array<{ id: string; workspace_id: string; role: string | null }>).filter((m) => m.role !== 'guest')
  if (seats.length === 0) return null
  const wsIds = seats.map((s) => s.workspace_id)
  const { data: links } = await svc
    .from('action_github_pr')
    .select('workspace_id, action_id, repo_full_name')
    .in('workspace_id', wsIds)
    .eq('pr_number', pr.number)
  const ours = ((links ?? []) as Array<{ workspace_id: string; action_id: string; repo_full_name: string }>).filter((l) => l.repo_full_name.toLowerCase() === pr.repo.toLowerCase())
  for (const seat of seats) {
    const here = ours.filter((l) => l.workspace_id === seat.workspace_id).map((l) => l.action_id)
    if (here.length === 0) continue
    let visibleTeams: Set<string>
    try {
      visibleTeams = new Set((await resolveVisibilityFence(svc, seat.workspace_id, userId)).visibleTeamIds)
    } catch {
      continue
    }
    const { data: acts } = await svc.from('actions').select('id, team_id').eq('workspace_id', seat.workspace_id).in('id', here)
    const seen = ((acts ?? []) as Array<{ id: string; team_id: string | null }>).filter((a) => a.team_id && visibleTeams.has(a.team_id)).map((a) => a.id)
    if (seen.length > 0) return { workspaceId: seat.workspace_id, memberId: seat.id, actionIds: seen }
  }
  const { data: conns } = await svc
    .from('connected_account')
    .select('workspace_id, created_at')
    .eq('user_id', userId)
    .eq('provider', 'github')
    .order('created_at', { ascending: false })
    .limit(5)
  for (const c of (conns ?? []) as Array<{ workspace_id: string }>) {
    const seat = seats.find((s) => s.workspace_id === c.workspace_id)
    if (seat) return { workspaceId: seat.workspace_id, memberId: seat.id, actionIds: [] }
  }
  return { workspaceId: seats[0].workspace_id, memberId: seats[0].id, actionIds: [] }
}

async function alreadyTold(svc: SupabaseClient, memberId: string, type: NotificationType, deliveryId: string | null): Promise<boolean> {
  if (!deliveryId) return false
  const { data } = await svc.from('notification').select('id').eq('recipient_id', memberId).eq('type', type).eq('metadata->>delivery_id', deliveryId).limit(1)
  return ((data ?? []) as unknown[]).length > 0
}

/** Tell each person once (never the one who did it). How many were told. */
async function tell(
  svc: SupabaseClient,
  people: Person[],
  args: { type: NotificationType; pr: PrRef; title: string; body?: string; actorGithubId: number | null; deliveryId: string | null; extra?: Record<string, unknown> },
): Promise<number> {
  let told = 0
  const done = new Set<string>()
  for (const person of people) {
    if (done.has(person.userId) || (args.actorGithubId !== null && person.githubId === args.actorGithubId)) continue
    done.add(person.userId)
    const place = await placeFor(svc, person.userId, args.pr)
    if (!place) continue
    if (await alreadyTold(svc, place.memberId, args.type, args.deliveryId)) continue
    await createNotification({
      workspaceId: place.workspaceId,
      recipientId: place.memberId,
      type: args.type,
      title: args.title,
      body: args.body,
      targetType: 'github_pr',
      groupKey: `github_pr:${args.pr.repo.toLowerCase()}#${args.pr.number}`,
      metadata: {
        repo: args.pr.repo,
        number: args.pr.number,
        pr_url: args.pr.url,
        pr_title: args.pr.title,
        action_ids: place.actionIds,
        ...(args.deliveryId ? { delivery_id: args.deliveryId } : {}),
        ...(args.extra ?? {}),
      },
    })
    told++
  }
  return told
}

type Json = Record<string, unknown>
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {})
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)

function prOf(payload: Json, prKey: 'pull_request' | 'issue'): (PrRef & { authorId: number | null }) | null {
  const pr = obj(payload[prKey])
  const repo = str(obj(payload.repository).full_name)
  const number = num(pr.number)
  if (!repo || number === null) return null
  return {
    repo,
    number,
    url: str(pr.html_url) ?? `https://github.com/${repo}/pull/${number}`,
    title: str(pr.title) ?? '',
    authorId: num(obj(pr.user).id),
  }
}

/** Keep a pull request's author and head (every pull_request event), for its failing checks later. */
export async function recordPull(svc: SupabaseClient, payload: unknown): Promise<void> {
  try {
    const p = obj(payload)
    const pr = prOf(p, 'pull_request')
    if (!pr) return
    await svc.from('github_pull_request').upsert(
      {
        repo_full_name: pr.repo.toLowerCase(),
        pr_number: pr.number,
        author_github_id: pr.authorId,
        head_sha: str(obj(obj(p.pull_request).head).sha),
        title: pr.title,
        url: pr.url,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'repo_full_name,pr_number' },
    )
  } catch (err) {
    console.warn('[pr-notices] recording the pull request failed', err instanceof Error ? err.message : err)
  }
}

/** pull_request.review_requested: the reviewer asked (a person; a team request reaches nobody). */
export async function onReviewRequested(svc: SupabaseClient, payload: unknown, deliveryId: string | null): Promise<number> {
  try {
    const p = obj(payload)
    const pr = prOf(p, 'pull_request')
    const reviewer = num(obj(p.requested_reviewer).id)
    if (!pr || reviewer === null) return 0
    const sender = obj(p.sender)
    const who = str(sender.login) ?? 'Someone'
    return await tell(svc, await peopleByGithubIds(svc, [reviewer]), {
      type: 'github_review_requested',
      pr,
      title: `${who} asked for your review on ${pr.repo}#${pr.number}`,
      body: snippet(pr.title),
      actorGithubId: num(sender.id),
      deliveryId,
    })
  } catch (err) {
    console.warn('[pr-notices] review request notice failed', err instanceof Error ? err.message : err)
    return 0
  }
}

/** A comment, a review or a review comment on a pull request: its author and everyone named. */
export async function onPrComment(svc: SupabaseClient, event: string, payload: unknown, deliveryId: string | null): Promise<number> {
  try {
    const p = obj(payload)
    const action = str(p.action)
    let pr: (PrRef & { authorId: number | null }) | null = null
    let text: string | null = null
    let actorId: number | null = null
    let actor = 'Someone'
    let what = 'commented on'
    if (event === 'issue_comment') {
      if (action !== 'created' || !obj(p.issue).pull_request) return 0
      pr = prOf(p, 'issue')
      const c = obj(p.comment)
      text = str(c.body)
      actorId = num(obj(c.user).id)
      actor = str(obj(c.user).login) ?? actor
    } else if (event === 'pull_request_review') {
      if (action !== 'submitted') return 0
      pr = prOf(p, 'pull_request')
      const r = obj(p.review)
      const state = str(r.state)?.toLowerCase()
      text = str(r.body)
      // A bare comment review with no words says nothing worth a notice.
      if (!text?.trim() && state !== 'changes_requested' && state !== 'approved') return 0
      what = state === 'approved' ? 'approved' : state === 'changes_requested' ? 'requested changes on' : 'reviewed'
      actorId = num(obj(r.user).id)
      actor = str(obj(r.user).login) ?? actor
    } else if (event === 'pull_request_review_comment') {
      if (action !== 'created') return 0
      pr = prOf(p, 'pull_request')
      const c = obj(p.comment)
      text = str(c.body)
      actorId = num(obj(c.user).id)
      actor = str(obj(c.user).login) ?? actor
    } else {
      return 0
    }
    if (!pr) return 0
    const people = [
      ...(pr.authorId !== null ? await peopleByGithubIds(svc, [pr.authorId]) : []),
      ...(await peopleByLogins(svc, mentionedLogins(text))),
    ]
    return await tell(svc, people, {
      type: 'github_pr_comment',
      pr,
      title: `${actor} ${what} ${pr.repo}#${pr.number}`,
      body: snippet(text) || snippet(pr.title),
      actorGithubId: actorId,
      deliveryId,
      extra: { github_event: event },
    })
  } catch (err) {
    console.warn('[pr-notices] comment notice failed', err instanceof Error ? err.message : err)
    return 0
  }
}

const FAILED = new Set(['failure', 'timed_out', 'action_required', 'startup_failure'])

/** check_suite.completed, failing: the author of each pull request whose head it is, once per head commit. */
export async function onChecksFailed(svc: SupabaseClient, payload: unknown, deliveryId: string | null): Promise<number> {
  try {
    const p = obj(payload)
    const suite = obj(p.check_suite)
    const repo = str(obj(p.repository).full_name)
    const head = str(suite.head_sha)
    if (str(p.action) !== 'completed' || !FAILED.has(str(suite.conclusion) ?? '') || !repo || !head) return 0
    const numbers = (Array.isArray(suite.pull_requests) ? suite.pull_requests : []).map((x) => num(obj(x).number)).filter((n): n is number => n !== null)
    if (numbers.length === 0) return 0
    const { data } = await svc
      .from('github_pull_request')
      .select('pr_number, author_github_id, head_sha, title, url, checks_failed_sha')
      .eq('repo_full_name', repo.toLowerCase())
      .in('pr_number', numbers)
    let told = 0
    for (const row of (data ?? []) as Array<{ pr_number: number; author_github_id: number | null; head_sha: string | null; title: string | null; url: string | null; checks_failed_sha: string | null }>) {
      if (row.head_sha && row.head_sha !== head) continue // an older head's suite
      if (row.checks_failed_sha === head || row.author_github_id === null) continue
      const { data: claimed } = await svc
        .from('github_pull_request')
        .update({ checks_failed_sha: head })
        .eq('repo_full_name', repo.toLowerCase())
        .eq('pr_number', row.pr_number)
        .select('pr_number')
      if (((claimed ?? []) as unknown[]).length === 0) continue
      const pr: PrRef = { repo, number: row.pr_number, url: row.url ?? `https://github.com/${repo}/pull/${row.pr_number}`, title: row.title ?? '' }
      const app = str(obj(suite.app).name)
      told += await tell(svc, await peopleByGithubIds(svc, [row.author_github_id]), {
        type: 'github_checks_failed',
        pr,
        title: `Checks failed on ${repo}#${row.pr_number}`,
        body: snippet(app ? `${app}: ${pr.title}` : pr.title),
        actorGithubId: null,
        deliveryId,
        extra: { head_sha: head },
      })
    }
    return told
  } catch (err) {
    console.warn('[pr-notices] checks notice failed', err instanceof Error ? err.message : err)
    return 0
  }
}
