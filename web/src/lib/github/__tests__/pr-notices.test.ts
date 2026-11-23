/**
 * GitHub's news in the person's notifications (docs/plans/github-reviews.md,
 * phase 3; pr-notices.ts): who hears what, in which workspace, naming only
 * actions they can see, never the one who did it, once per delivery.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Row = Record<string, unknown>
const h = vi.hoisted(() => ({ tables: null as unknown as Record<string, Row[]>, visible: {} as Record<string, string[]> }))
vi.mock('@/lib/notifications', () => ({
  createNotification: async (p: { workspaceId: string; recipientId: string; type: string; title: string; body?: string; metadata?: Row; targetType?: string }) => {
    h.tables.notification.push({ workspace_id: p.workspaceId, recipient_id: p.recipientId, type: p.type, title: p.title, body: p.body, target_type: p.targetType, metadata: p.metadata ?? {} })
  },
}))
vi.mock('@/lib/views/visibility-fence', () => ({
  resolveVisibilityFence: async (_db: unknown, ws: string, user: string) => ({ visibleTeamIds: h.visible[`${ws}:${user}`] ?? [] }),
}))

import { memoryDb } from '@/test/memory-db'
import { mentionedLogins, onChecksFailed, onPrComment, onReviewRequested, placeFor, recordPull, snippet } from '../pr-notices'

let db: ReturnType<typeof memoryDb>

beforeEach(() => {
  h.tables = {
    github_identity: [
      { user_id: 'dana', github_user_id: 101, login: 'dana' },
      { user_id: 'lee', github_user_id: 102, login: 'lee' },
      { user_id: 'gus', github_user_id: 103, login: 'gus' },
    ],
    member: [
      { id: 'm-dana-1', user_id: 'dana', workspace_id: 'ws-1', role: 'member' },
      { id: 'm-dana-2', user_id: 'dana', workspace_id: 'ws-2', role: 'member' },
      { id: 'm-lee-2', user_id: 'lee', workspace_id: 'ws-2', role: 'member' },
      { id: 'm-gus-1', user_id: 'gus', workspace_id: 'ws-1', role: 'guest' },
    ],
    connected_account: [{ user_id: 'dana', provider: 'github', workspace_id: 'ws-2', created_at: '2026-11-01T00:00:00Z' }],
    action_github_pr: [],
    actions: [
      { id: 'a-pub', workspace_id: 'ws-1', team_id: 't-pub' },
      { id: 'a-priv', workspace_id: 'ws-1', team_id: 't-priv' },
    ],
    github_pull_request: [],
    notification: [],
  }
  h.visible = { 'ws-1:dana': ['t-pub'] }
  db = memoryDb(h.tables)
})

const PR = { number: 7, html_url: 'https://github.com/acme/app/pull/7', title: 'Fix the login', user: { id: 101, login: 'Dana' }, head: { sha: 'aaa' } }
const repo = { full_name: 'acme/app' }

describe('helpers', () => {
  it('reads mentions as GitHub writes them, not emails or code', () => {
    expect(mentionedLogins('Thanks @Lee and @dana-x! cc: @gus. Not a@b.com or `@x` or path/@y')).toEqual(['lee', 'dana-x', 'gus'])
    expect(snippet('a  \n b<!-- hidden -->', 140)).toBe('a b')
    expect(snippet('x'.repeat(200)).length).toBe(140)
  })
})

describe('placeFor', () => {
  it('prefers the workspace where the PR is linked to an action they can see, naming only those', async () => {
    h.tables.action_github_pr.push(
      { workspace_id: 'ws-1', action_id: 'a-pub', repo_full_name: 'acme/app', pr_number: 7 },
      { workspace_id: 'ws-1', action_id: 'a-priv', repo_full_name: 'acme/app', pr_number: 7 },
    )
    expect(await placeFor(db, 'dana', { repo: 'Acme/App', number: 7 })).toEqual({ workspaceId: 'ws-1', memberId: 'm-dana-1', actionIds: ['a-pub'] })
  })

  it('else their newest GitHub connection’s workspace, and never a guest seat', async () => {
    expect(await placeFor(db, 'dana', { repo: 'acme/app', number: 7 })).toEqual({ workspaceId: 'ws-2', memberId: 'm-dana-2', actionIds: [] })
    expect(await placeFor(db, 'gus', { repo: 'acme/app', number: 7 })).toBeNull()
  })

  it('a link only to a private team’s action they are not on does not place it there', async () => {
    h.tables.action_github_pr.push({ workspace_id: 'ws-1', action_id: 'a-priv', repo_full_name: 'acme/app', pr_number: 7 })
    expect((await placeFor(db, 'dana', { repo: 'acme/app', number: 7 }))?.workspaceId).toBe('ws-2')
  })
})

describe('review requested', () => {
  it('tells the reviewer, once per delivery', async () => {
    const payload = { action: 'review_requested', repository: repo, pull_request: { ...PR, user: { id: 102 } }, requested_reviewer: { id: 101 }, sender: { id: 102, login: 'lee' } }
    expect(await onReviewRequested(db, payload, 'd1')).toBe(1)
    expect(await onReviewRequested(db, payload, 'd1')).toBe(0)
    expect(h.tables.notification).toEqual([
      expect.objectContaining({
        recipient_id: 'm-dana-2',
        type: 'github_review_requested',
        title: 'lee asked for your review on acme/app#7',
        target_type: 'github_pr',
        metadata: expect.objectContaining({ repo: 'acme/app', number: 7, pr_url: PR.html_url, delivery_id: 'd1' }),
      }),
    ])
  })

  it('tells nobody for a team request, or a reviewer who is not one of ours', async () => {
    expect(await onReviewRequested(db, { repository: repo, pull_request: PR, requested_team: { id: 5 } }, 'd2')).toBe(0)
    expect(await onReviewRequested(db, { repository: repo, pull_request: PR, requested_reviewer: { id: 999 } }, 'd3')).toBe(0)
    expect(h.tables.notification).toEqual([])
  })
})

describe('comments', () => {
  it('a comment on Dana’s PR tells Dana and everyone it names, never the commenter', async () => {
    const payload = { action: 'created', repository: repo, issue: { ...PR, pull_request: {} }, comment: { body: 'Looks good @lee, and @Dana', user: { id: 102, login: 'lee' } } }
    expect(await onPrComment(db, 'issue_comment', payload, 'd4')).toBe(1)
    expect(h.tables.notification.map((n) => n.recipient_id)).toEqual(['m-dana-2'])
    expect(h.tables.notification[0]).toMatchObject({ type: 'github_pr_comment', title: 'lee commented on acme/app#7', body: 'Looks good @lee, and @Dana' })
  })

  it('a comment on an issue (not a pull request) tells nobody', async () => {
    expect(await onPrComment(db, 'issue_comment', { action: 'created', repository: repo, issue: PR, comment: { body: '@Dana', user: { id: 102 } } }, 'd5')).toBe(0)
  })

  it('a review: changes requested and approvals tell, a bare comment review does not', async () => {
    const review = (state: string, body: string | null) => ({ action: 'submitted', repository: repo, pull_request: PR, review: { state, body, user: { id: 102, login: 'lee' } } })
    expect(await onPrComment(db, 'pull_request_review', review('changes_requested', null), 'd6')).toBe(1)
    expect(await onPrComment(db, 'pull_request_review', review('approved', null), 'd7')).toBe(1)
    expect(await onPrComment(db, 'pull_request_review', review('commented', ''), 'd8')).toBe(0)
    expect(h.tables.notification.map((n) => n.title)).toEqual(['lee requested changes on acme/app#7', 'lee approved acme/app#7'])
  })

  it('a mention reaches someone named in any case, who isn’t the author', async () => {
    const payload = { action: 'created', repository: repo, issue: { ...PR, user: { id: 102 }, pull_request: {} }, comment: { body: 'ping @DANA', user: { id: 102, login: 'lee' } } }
    expect(await onPrComment(db, 'issue_comment', payload, 'd15')).toBe(1)
    expect(h.tables.notification.map((n) => n.recipient_id)).toEqual(['m-dana-2'])
  })

  it('a review comment that names a guest does not reach them', async () => {
    const payload = { action: 'created', repository: repo, pull_request: { ...PR, user: { id: 102 } }, comment: { body: 'see @gus', user: { id: 101, login: 'Dana' } } }
    expect(await onPrComment(db, 'pull_request_review_comment', payload, 'd9')).toBe(1)
    expect(h.tables.notification.map((n) => n.recipient_id)).toEqual(['m-lee-2'])
  })
})

describe('checks failing', () => {
  const suite = (conclusion: string, head = 'aaa') => ({ action: 'completed', repository: repo, check_suite: { conclusion, head_sha: head, pull_requests: [{ number: 7 }], app: { name: 'CI' } } })

  it('tells the author once per head commit, from the pull request kept earlier', async () => {
    await recordPull(db, { repository: { full_name: 'Acme/App' }, pull_request: PR })
    expect(h.tables.github_pull_request).toEqual([expect.objectContaining({ repo_full_name: 'acme/app', pr_number: 7, author_github_id: 101, head_sha: 'aaa' })])
    expect(await onChecksFailed(db, suite('failure'), 'd10')).toBe(1)
    // A re-run failing again on the same head, or a redelivery: no second notice.
    expect(await onChecksFailed(db, suite('failure'), 'd11')).toBe(0)
    expect(h.tables.notification).toEqual([expect.objectContaining({ recipient_id: 'm-dana-2', type: 'github_checks_failed', title: 'Checks failed on acme/app#7' })])
  })

  it('says nothing for a pass, an older head, or a pull request never seen', async () => {
    await recordPull(db, { repository: repo, pull_request: PR })
    expect(await onChecksFailed(db, suite('success'), 'd12')).toBe(0)
    expect(await onChecksFailed(db, suite('failure', 'old'), 'd13')).toBe(0)
    expect(await onChecksFailed(db, { ...suite('failure'), check_suite: { conclusion: 'failure', head_sha: 'aaa', pull_requests: [{ number: 99 }] } }, 'd14')).toBe(0)
    expect(h.tables.notification).toEqual([])
  })
})
