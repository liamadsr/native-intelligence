/**
 * Actions that move with their pull requests (docs/plans/github-reviews.md,
 * phase 2; pr-automation.ts): the fence (the workspace added the repo, the
 * author is its member, the team's switch is on), each step onto the team's
 * own states, and idempotence under redelivery and out-of-order events.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const emitted = vi.hoisted(() => [] as Array<{ entityId: string; toStatusId: string; origin?: unknown; actorUserId: string }>)
vi.mock('@/lib/flows/emit-status-change', () => ({ emitStatusChange: (a: { entityId: string; toStatusId: string; origin?: unknown; actorUserId: string }) => emitted.push(a) }))

import { memoryDb } from '@/test/memory-db'
import {
  identifiersInBranch,
  identifiersInText,
  isStale,
  onBranchCreated,
  onPullRequest,
  pullEventFrom,
  stepAllowed,
  stepFor,
  type PullEvent,
} from '../pr-automation'
import { branchNameFor } from '../branch-name'

type Row = Record<string, unknown>

const WS1 = 'ws-1'
const WS2 = 'ws-2'
const DANA = 'user-dana' // GitHub id 101, a member of both workspaces
const LEE = 'user-lee' // GitHub id 102, a member of ws-2 only

function states(team: string, withReview = true): Row[] {
  return [
    { id: `${team}-backlog`, team_id: team, name: 'Backlog', category: 'backlog', sort_order: 0 },
    { id: `${team}-todo`, team_id: team, name: 'Todo', category: 'unstarted', sort_order: 1 },
    { id: `${team}-doing`, team_id: team, name: 'In Progress', category: 'started', sort_order: 2 },
    ...(withReview ? [{ id: `${team}-review`, team_id: team, name: 'In Review', category: 'started', sort_order: 3 }] : []),
    { id: `${team}-done`, team_id: team, name: 'Done', category: 'completed', sort_order: 4 },
    { id: `${team}-canceled`, team_id: team, name: 'Canceled', category: 'canceled', sort_order: 5 },
  ]
}

let tables: Record<string, Row[]>
let db: ReturnType<typeof memoryDb>

beforeEach(() => {
  emitted.length = 0
  tables = {
    github_identity: [
      { user_id: DANA, github_user_id: 101, login: 'dana' },
      { user_id: LEE, github_user_id: 102, login: 'lee' },
      { user_id: 'user-gus', github_user_id: 103, login: 'gus' },
    ],
    member: [
      { id: 'm1', user_id: DANA, workspace_id: WS1, role: 'member' },
      { id: 'm2', user_id: DANA, workspace_id: WS2, role: 'member' },
      { id: 'm3', user_id: LEE, workspace_id: WS2, role: 'member' },
      { id: 'm4', user_id: 'user-gus', workspace_id: WS1, role: 'guest' },
    ],
    workspace_github_repo: [{ workspace_id: WS1, repo_full_name: 'acme/app' }],
    team: [
      { id: 't1', workspace_id: WS1, github_automation: true },
      { id: 't2', workspace_id: WS2, github_automation: true },
    ],
    workflow_state: [...states('t1'), ...states('t2')],
    // Both workspaces have an ENG-1.
    actions: [
      { id: 'a1', workspace_id: WS1, team_id: 't1', status_id: 't1-todo', identifier: 'ENG-1' },
      { id: 'a2', workspace_id: WS2, team_id: 't2', status_id: 't2-todo', identifier: 'ENG-1' },
    ],
    action_github_pr: [],
    action_github_branch: [],
    entity_activity: [],
  }
  db = memoryDb(tables)
})

const status = (id: string) => tables.actions.find((a) => a.id === id)!.status_id

function pull(over: Partial<PullEvent> = {}): PullEvent {
  return {
    action: 'opened',
    repoFullName: 'acme/app',
    number: 7,
    url: 'https://github.com/acme/app/pull/7',
    title: 'Fix the login',
    body: null,
    draft: false,
    merged: false,
    state: 'open',
    headBranch: 'eng-1-fix-the-login',
    authorId: 101,
    authorAssociation: 'MEMBER',
    updatedAt: '2026-11-20T10:00:00Z',
    additions: 12,
    deletions: 3,
    changedFiles: 2,
    ...over,
  }
}

describe('identifiers', () => {
  it('finds them in titles as written, and in branches in any case', () => {
    expect(identifiersInText('ENG-42: fix, see OPS-7 and eng-9')).toEqual(['ENG-42', 'OPS-7'])
    expect(identifiersInBranch('eng-42-fix-login')).toEqual(['ENG-42'])
    expect(identifiersInBranch('dana/ENG-42')).toEqual(['ENG-42'])
    expect(identifiersInBranch('feature/eng-42-and-ops-7')).toEqual(['ENG-42', 'OPS-7'])
    expect(identifiersInBranch('release-2026')).toEqual(['RELEASE-2026'])
    expect(identifiersInBranch('main')).toEqual([])
  })

  it('makes a branch name the webhook finds again', () => {
    const name = branchNameFor('ENG-42', 'Fix the login redirect — for Café users!')
    expect(name).toBe('eng-42-fix-the-login-redirect-for-cafe-users')
    expect(identifiersInBranch(name)).toEqual(['ENG-42'])
    expect(branchNameFor('ENG-42', '')).toBe('eng-42')
    const long = branchNameFor('ENG-42', 'a very long title '.repeat(10))
    expect(long.length).toBeLessThanOrEqual(60)
    expect(long.endsWith('-')).toBe(false)
  })
})

describe('steps', () => {
  it('only go forward, back only from an open pull request', () => {
    expect(stepAllowed(null, 'review')).toBe(true)
    expect(stepAllowed('review', 'done')).toBe(true)
    expect(stepAllowed('done', 'review')).toBe(false)
    expect(stepAllowed('review', 'review')).toBe(false)
    expect(stepAllowed('done', 'back')).toBe(false)
    expect(stepAllowed('review', 'back')).toBe(true)
    expect(stepAllowed('back', 'review')).toBe(true)
    expect(stepFor({ action: 'opened', draft: true, merged: false, state: 'open' })).toBeNull()
    expect(stepFor({ action: 'ready_for_review', draft: false, merged: false, state: 'open' })).toBe('review')
    expect(stepFor({ action: 'closed', draft: false, merged: true, state: 'closed' })).toBe('done')
    expect(stepFor({ action: 'closed', draft: false, merged: false, state: 'closed' })).toBe('back')
    expect(stepFor({ action: 'synchronize', draft: false, merged: false, state: 'open' })).toBeNull()
    expect(isStale('2026-11-20T09:00:00Z', '2026-11-20T10:00:00Z')).toBe(true)
    expect(isStale('2026-11-20T10:00:00Z', '2026-11-20T10:00:00Z')).toBe(false)
  })

  it('reads the webhook payload', () => {
    const ev = pullEventFrom({
      action: 'closed',
      repository: { full_name: 'acme/app' },
      pull_request: { number: 7, html_url: 'u', title: 'T', merged: true, state: 'closed', draft: false, head: { ref: 'eng-1' }, user: { id: 101 }, author_association: 'OWNER', updated_at: 'x', additions: 1, deletions: 2, changed_files: 3 },
    })
    expect(ev).toMatchObject({ action: 'closed', merged: true, state: 'closed', headBranch: 'eng-1', authorId: 101, authorAssociation: 'OWNER', additions: 1 })
    expect(pullEventFrom({})).toBeNull()
  })
})

describe('the fence: two workspaces share the ENG prefix', () => {
  it('moves only the workspace that added the repo, though the author is in both', async () => {
    await onPullRequest(db, pull())
    expect(status('a1')).toBe('t1-review')
    expect(status('a2')).toBe('t2-todo')
    expect(tables.action_github_pr.map((r) => r.workspace_id)).toEqual([WS1])
  })

  it('moves only where the author is a member, when both added the repo', async () => {
    tables.workspace_github_repo.push({ workspace_id: WS2, repo_full_name: 'acme/app' })
    await onPullRequest(db, pull({ authorId: 102 }))
    expect(status('a1')).toBe('t1-todo')
    expect(status('a2')).toBe('t2-review')
  })

  it('moves nothing for a guest, a stranger, an unknown GitHub user, another repo, or a team switched off', async () => {
    await onPullRequest(db, pull({ authorId: 103 })) // a guest of ws-1
    await onPullRequest(db, pull({ authorAssociation: 'CONTRIBUTOR' }))
    await onPullRequest(db, pull({ authorId: 999 }))
    await onPullRequest(db, pull({ repoFullName: 'acme/other' }))
    expect(status('a1')).toBe('t1-todo')
    expect(tables.action_github_pr).toHaveLength(0)
    tables.team[0].github_automation = false
    await onPullRequest(db, pull())
    expect(status('a1')).toBe('t1-todo')
  })

  it('matches the repo whatever its case on GitHub', async () => {
    await onPullRequest(db, pull({ repoFullName: 'Acme/App' }))
    expect(status('a1')).toBe('t1-review')
  })
})

describe('moves', () => {
  it('opened → in review, merged → done, as a sync from GitHub; size and author kept', async () => {
    await onPullRequest(db, pull())
    expect(status('a1')).toBe('t1-review')
    expect(emitted).toEqual([expect.objectContaining({ entityId: 'a1', toStatusId: 't1-review', actorUserId: DANA, origin: { actor: 'sync', depth: 1 } })])
    expect(tables.action_github_pr[0]).toMatchObject({ additions: 12, deletions: 3, changed_files: 2, author_github_id: 101, auto_step: 'review', status_before_id: 't1-todo' })
    await onPullRequest(db, pull({ action: 'closed', merged: true, state: 'closed', updatedAt: '2026-11-20T11:00:00Z' }))
    expect(status('a1')).toBe('t1-done')
  })

  it('is idempotent under a redelivery, and a late "opened" after the merge moves nothing', async () => {
    await onPullRequest(db, pull())
    await onPullRequest(db, pull())
    expect(emitted).toHaveLength(1)
    await onPullRequest(db, pull({ action: 'closed', merged: true, state: 'closed', updatedAt: '2026-11-20T11:00:00Z' }))
    // An older "opened" arriving late: stale, and review can't follow done anyway.
    await onPullRequest(db, pull({ updatedAt: '2026-11-20T10:00:00Z' }))
    await onPullRequest(db, pull({ action: 'reopened', updatedAt: '2026-11-20T09:00:00Z' }))
    expect(status('a1')).toBe('t1-done')
    expect(tables.action_github_pr[0].pr_state).toBe('merged')
    expect(emitted).toHaveLength(2)
  })

  it('a draft moves nothing until it is ready', async () => {
    await onPullRequest(db, pull({ draft: true }))
    expect(status('a1')).toBe('t1-todo')
    await onPullRequest(db, pull({ action: 'ready_for_review', updatedAt: '2026-11-20T10:05:00Z' }))
    expect(status('a1')).toBe('t1-review')
  })

  it('a team with no review state: in review is its first started state', async () => {
    tables.workflow_state = [...states('t1', false), ...states('t2')]
    await onPullRequest(db, pull())
    expect(status('a1')).toBe('t1-doing')
  })

  it('closed without merging: back where it was before', async () => {
    await onPullRequest(db, pull())
    await onPullRequest(db, pull({ action: 'closed', state: 'closed', updatedAt: '2026-11-20T11:00:00Z' }))
    expect(status('a1')).toBe('t1-todo')
    // Reopened: forward again.
    await onPullRequest(db, pull({ action: 'reopened', updatedAt: '2026-11-20T12:00:00Z' }))
    expect(status('a1')).toBe('t1-review')
  })

  it('never undoes a person’s hand move', async () => {
    await onPullRequest(db, pull())
    tables.actions[0].status_id = 't1-doing'
    tables.entity_activity.push({ entity_type: 'action', entity_id: 'a1', action: 'status_changed', actor_kind: 'member', created_at: '2999-01-01T00:00:00Z' })
    await onPullRequest(db, pull({ action: 'closed', state: 'closed', updatedAt: '2026-11-20T11:00:00Z' }))
    expect(status('a1')).toBe('t1-doing')
  })

  it('never reopens an action a person closed, nor moves a canceled one to done', async () => {
    tables.actions[0].status_id = 't1-canceled'
    await onPullRequest(db, pull())
    await onPullRequest(db, pull({ action: 'closed', merged: true, state: 'closed', updatedAt: '2026-11-20T11:00:00Z' }))
    expect(status('a1')).toBe('t1-canceled')
  })

  it('another open pull request linked to it holds it from done', async () => {
    tables.action_github_pr.push({ id: 'other', workspace_id: WS1, action_id: 'a1', repo_full_name: 'acme/app', pr_number: 8, pr_state: 'open' })
    await onPullRequest(db, pull())
    await onPullRequest(db, pull({ action: 'closed', merged: true, state: 'closed', updatedAt: '2026-11-20T11:00:00Z' }))
    expect(status('a1')).toBe('t1-review')
  })
})

describe('a branch created', () => {
  it('moves it in progress, remembers where it was, and a close goes back there', async () => {
    expect(await onBranchCreated(db, { repoFullName: 'acme/app', branch: 'eng-1-fix', senderId: 101 })).toBe(1)
    expect(status('a1')).toBe('t1-doing')
    expect(status('a2')).toBe('t2-todo')
    expect(tables.action_github_branch[0]).toMatchObject({ action_id: 'a1', status_before_id: 't1-todo' })
    // A redelivered create: no second move, the first memory kept.
    expect(await onBranchCreated(db, { repoFullName: 'acme/app', branch: 'eng-1-fix', senderId: 101 })).toBe(0)
    expect(tables.action_github_branch).toHaveLength(1)
    await onPullRequest(db, pull({ headBranch: 'eng-1-fix', title: 'Fix' }))
    expect(status('a1')).toBe('t1-review')
    expect(tables.action_github_pr[0].status_before_id).toBe('t1-todo')
    await onPullRequest(db, pull({ headBranch: 'eng-1-fix', title: 'Fix', action: 'closed', state: 'closed', updatedAt: '2026-11-20T11:00:00Z' }))
    expect(status('a1')).toBe('t1-todo')
  })

  it('moves nothing for an unknown pusher or a repo no workspace added', async () => {
    expect(await onBranchCreated(db, { repoFullName: 'acme/app', branch: 'eng-1-fix', senderId: 999 })).toBe(0)
    expect(await onBranchCreated(db, { repoFullName: 'acme/other', branch: 'eng-1-fix', senderId: 101 })).toBe(0)
    expect(status('a1')).toBe('t1-todo')
  })

  it('a late create after the pull request moved it begins nothing', async () => {
    await onPullRequest(db, pull())
    expect(await onBranchCreated(db, { repoFullName: 'acme/app', branch: 'eng-1-fix-the-login', senderId: 101 })).toBe(0)
    expect(status('a1')).toBe('t1-review')
  })
})
