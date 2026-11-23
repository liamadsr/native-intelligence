/**
 * The GitHub webhook fires pr_status_changed loops (F1): an opened PR fires
 * for the actions it was just linked to, a close / merge / reopen for every
 * action already linked to it, a push (synchronize) or an edit for none. The
 * same close / merge / reopen, from the repo's own people only, reaches the
 * agent as a pr.changed (docs/plans/now-file.md "PR updates"), and so does a
 * failing check the fix loop leaves (pr-changed.ts decides which).
 */
import crypto from 'crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  emitted: [] as Array<Record<string, unknown>>,
  links: [] as Array<{ id: string; workspace_id: string; action_id: string }>,
}))

vi.mock('@/lib/flows/emit-pr-status-change', () => ({
  emitPrStatusChange: async (args: Record<string, unknown>) => {
    h.emitted.push(args)
    return 0
  },
}))
vi.mock('@/lib/work/resolve', () => ({ resolveWorkForDeliverable: async () => {} }))
// The pull-request automation (docs/plans/github-reviews.md, phase 2) is its own module's tests (pr-automation.test.ts).
const auto = vi.hoisted(() => ({ pulls: [] as Array<Record<string, unknown>>, branches: [] as Array<Record<string, unknown>> }))
const notices = vi.hoisted(() => ({ calls: [] as Array<{ kind: string; event?: string; delivery: string | null }> }))
vi.mock('@/lib/github/pr-notices', () => ({
  recordPull: async () => {},
  onReviewRequested: async (_db: unknown, _p: unknown, delivery: string | null) => (notices.calls.push({ kind: 'review', delivery }), 1),
  onPrComment: async (_db: unknown, event: string, _p: unknown, delivery: string | null) => (notices.calls.push({ kind: 'comment', event, delivery }), 2),
  onChecksFailed: async (_db: unknown, _p: unknown, delivery: string | null) => (notices.calls.push({ kind: 'checks', delivery }), 0),
}))
vi.mock('@/lib/github/pr-automation', async (importOriginal) => ({
  pullEventFrom: (await importOriginal<typeof import('@/lib/github/pr-automation')>()).pullEventFrom,
  onPullRequest: async (_db: unknown, ev: Record<string, unknown>) => {
    auto.pulls.push(ev)
    return { linked: 0, moved: 0 }
  },
  onBranchCreated: async (_db: unknown, ev: Record<string, unknown>) => {
    auto.branches.push(ev)
    return 1
  },
}))
vi.mock('@/lib/actions/agent-finish', () => ({ completeActionsForMergedPr: async () => {} }))
const ci = vi.hoisted(() => ({ handled: [] as Array<Record<string, unknown>> }))
vi.mock('@/lib/coding/ci-fix', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/coding/ci-fix')>()),
  handleCiFailure: async (_db: unknown, ev: Record<string, unknown>) => {
    ci.handled.push(ev)
    return { handled: 'fix_started', fixRunId: 'fix-1', prRunId: 'pr-run' }
  },
}))
const pc = vi.hoisted(() => ({
  changes: [] as Array<{ change: Record<string, unknown>; opts: Record<string, unknown> }>,
  ci: [] as Array<{ ev: Record<string, unknown>; outcome: Record<string, unknown> }>,
}))
vi.mock('@/lib/agent-events/pr-changed', async (importOriginal) => ({
  prChangeFromPullRequest: (await importOriginal<typeof import('@/lib/agent-events/pr-changed')>()).prChangeFromPullRequest,
  recordPrChange: async (_db: unknown, change: Record<string, unknown>, opts: Record<string, unknown>) => {
    pc.changes.push({ change, opts })
    return 1
  },
  recordPrCiFailure: async (_db: unknown, ev: Record<string, unknown>, outcome: Record<string, unknown>) => {
    pc.ci.push({ ev, outcome })
    return 0
  },
}))
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {}
      Object.assign(chain, {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        update: () => chain,
        upsert: async () => ({ error: null }),
        then: (resolve: (v: unknown) => unknown) => {
          if (table === 'connected_account') return Promise.resolve({ data: [{ user_id: 'u', workspace_id: 'ws-1' }], error: null }).then(resolve)
          if (table === 'actions') return Promise.resolve({ data: [{ id: 'act-1', identifier: 'ENG-42' }], error: null }).then(resolve)
          if (table === 'action_github_pr') return Promise.resolve({ data: h.links, error: null }).then(resolve)
          return Promise.resolve({ data: [], error: null }).then(resolve)
        },
      })
      return chain
    },
  }),
}))

const SECRET = 'test-secret'
process.env.GITHUB_WEBHOOK_SECRET = SECRET

const { POST } = await import('../route')

function hook(action: string, pr: Record<string, unknown>, event = 'pull_request') {
  const body = JSON.stringify({
    action,
    pull_request: { number: 7, html_url: 'https://github.com/acme/web/pull/7', title: 'Fix ENG-42', draft: false, state: 'open', merged: false, head: { ref: 'fix' }, author_association: 'MEMBER', ...pr },
    repository: { full_name: 'acme/web' },
  })
  const sig = `sha256=${crypto.createHmac('sha256', SECRET).update(body).digest('hex')}`
  return new Request('https://nativeintelligence.test/api/webhooks/github', {
    method: 'POST',
    headers: { 'x-hub-signature-256': sig, 'x-github-event': event, 'x-github-delivery': 'del-1' },
    body,
  })
}

beforeEach(() => {
  h.emitted.length = 0
  h.links = [{ id: 'l-1', workspace_id: 'ws-1', action_id: 'act-1' }]
  pc.changes.length = 0
  pc.ci.length = 0
})

describe('pull_request events → pr_status_changed loops', () => {
  it('opened: fires for the actions it links, state open', async () => {
    const res = await POST(hook('opened', {}))
    expect(res.status).toBe(200)
    expect(h.emitted).toEqual([
      { links: [{ workspace_id: 'ws-1', action_id: 'act-1' }], repoFullName: 'acme/web', prNumber: 7, prState: 'open', deliveryId: 'del-1' },
    ])
  })

  it('closed and merged: state merged, for every linked action', async () => {
    await POST(hook('closed', { state: 'closed', merged: true }))
    expect(h.emitted).toEqual([expect.objectContaining({ prState: 'merged', links: h.links, deliveryId: 'del-1' })])
  })

  it('closed without merging: state closed; reopened: state open', async () => {
    await POST(hook('closed', { state: 'closed', merged: false }))
    await POST(hook('reopened', { state: 'open' }))
    expect(h.emitted.map((e) => e.prState)).toEqual(['closed', 'open'])
  })

  it("a PR from outside the repo's people (not OWNER, MEMBER or COLLABORATOR) fires nothing (F1 review)", async () => {
    for (const author_association of ['CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'FIRST_TIMER', 'NONE', undefined]) {
      await POST(hook('opened', { author_association }))
      await POST(hook('closed', { state: 'closed', merged: true, author_association }))
    }
    expect(h.emitted).toEqual([])
    for (const author_association of ['OWNER', 'COLLABORATOR']) await POST(hook('closed', { state: 'closed', merged: true, author_association }))
    expect(h.emitted).toHaveLength(2)
  })

  it('a push (synchronize) or an edit fires nothing', async () => {
    await POST(hook('synchronize', {}))
    await POST(hook('edited', {}))
    expect(h.emitted).toEqual([])
  })

  it('ready_for_review confirms the proactive run’s suggested action linked to the PR, and fires no loop (P10 F4)', async () => {
    const res = await POST(hook('ready_for_review', { draft: false }))
    expect(await res.json()).toEqual({ ok: true, confirmed: 1, automation: { linked: 0, moved: 0 } })
    expect(h.emitted).toEqual([])
  })

  it('a bad signature fires nothing', async () => {
    const req = hook('closed', { merged: true })
    const forged = new Request(req.url, { method: 'POST', headers: { 'x-hub-signature-256': 'sha256=00', 'x-github-event': 'pull_request' }, body: await req.text() })
    expect((await POST(forged)).status).toBe(401)
    expect(h.emitted).toEqual([])
  })
})

describe('pull_request events → the agent hears of the person’s own PRs (pr.changed)', () => {
  it('a merge, a close and a reopen each record one change, with the links the update returned', async () => {
    await POST(hook('closed', { state: 'closed', merged: true }))
    await POST(hook('closed', { state: 'closed', merged: false }))
    await POST(hook('reopened', { state: 'open' }))
    expect(pc.changes.map((c) => c.change.state)).toEqual(['merged', 'closed', 'reopened'])
    expect(pc.changes[0].change).toMatchObject({ repoFullName: 'acme/web', prNumber: 7, prUrl: 'https://github.com/acme/web/pull/7', pin: 'del-1', headBranch: 'fix' })
    expect(pc.changes[0].opts).toEqual({ links: h.links })
    // Never the PR's title or body.
    expect(JSON.stringify(pc.changes)).not.toContain('Fix ENG-42')
  })

  it("only from the repo's own people (the loops' author check)", async () => {
    for (const author_association of ['CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'FIRST_TIMER', 'NONE', undefined]) {
      await POST(hook('closed', { state: 'closed', merged: true, author_association }))
      await POST(hook('reopened', { state: 'open', author_association }))
    }
    expect(pc.changes).toEqual([])
  })

  it('nothing for an open, an edit, a push or a review request', async () => {
    for (const action of ['opened', 'edited', 'synchronize', 'ready_for_review']) await POST(hook(action, {}))
    expect(pc.changes).toEqual([])
  })
})

describe('check events → the CI fix loop (P10 F7)', () => {
  function checkHook(event: 'check_suite' | 'check_run', payload: Record<string, unknown>, sigOverride?: string) {
    const body = JSON.stringify({ action: 'completed', repository: { full_name: 'acme/web' }, ...payload })
    const sig = sigOverride ?? `sha256=${crypto.createHmac('sha256', SECRET).update(body).digest('hex')}`
    return new Request('https://nativeintelligence.test/api/webhooks/github', {
      method: 'POST',
      headers: { 'x-hub-signature-256': sig, 'x-github-event': event, 'x-github-delivery': 'del-2' },
      body,
    })
  }

  beforeEach(() => {
    ci.handled.length = 0
  })

  it('a failing check suite is handed to the fix loop', async () => {
    const res = await POST(checkHook('check_suite', { check_suite: { id: 5, conclusion: 'failure', head_branch: 'dial8/eng-42-abcd1234', head_sha: 'sha-1' } }))
    expect(await res.json()).toMatchObject({ ok: true, handled: 'fix_started' })
    expect(ci.handled).toEqual([expect.objectContaining({ source: 'check_suite', branch: 'dial8/eng-42-abcd1234', headSha: 'sha-1', suiteId: 5 })])
  })

  it('then to pr.changed with the loop’s outcome (it tells the agent only what the loop leaves), with the PRs GitHub matched', async () => {
    await POST(checkHook('check_suite', { check_suite: { id: 5, conclusion: 'failure', head_branch: 'dial8/eng-42-abcd1234', head_sha: 'sha-1', pull_requests: [{ number: 7 }, { number: 'x' }] } }))
    expect(pc.ci).toEqual([{ ev: expect.objectContaining({ headSha: 'sha-1', prNumbers: [7] }), outcome: { handled: 'fix_started', fixRunId: 'fix-1', prRunId: 'pr-run' } }])
    await POST(checkHook('check_suite', { check_suite: { id: 5, conclusion: 'success', head_branch: 'dial8/eng-42-abcd1234', head_sha: 'sha-1' } }))
    expect(pc.ci).toHaveLength(1)
  })

  it('a passing or still-running check is skipped without a lookup', async () => {
    await POST(checkHook('check_suite', { check_suite: { id: 5, conclusion: 'success', head_branch: 'dial8/eng-42-abcd1234', head_sha: 'sha-1' } }))
    await POST(checkHook('check_run', { action: 'created', check_run: { conclusion: null, head_sha: 'sha-1', check_suite: { head_branch: 'dial8/eng-42-abcd1234' } } }))
    expect(ci.handled).toEqual([])
  })

  it('a check event with a bad signature is refused like any other', async () => {
    const res = await POST(checkHook('check_suite', { check_suite: { id: 5, conclusion: 'failure', head_branch: 'dial8/x', head_sha: 's' } }, 'sha256=00'))
    expect(res.status).toBe(401)
    expect(ci.handled).toEqual([])
  })
})

describe('the pull-request automation (docs/plans/github-reviews.md, phase 2)', () => {
  function raw(event: string, payload: Record<string, unknown>, signed = true) {
    const body = JSON.stringify(payload)
    const sig = signed ? `sha256=${crypto.createHmac('sha256', SECRET).update(body).digest('hex')}` : 'sha256=bad'
    return new Request('https://nativeintelligence.test/api/webhooks/github', {
      method: 'POST',
      headers: { 'x-hub-signature-256': sig, 'x-github-event': event, 'x-github-delivery': 'del-2' },
      body,
    })
  }

  beforeEach(() => {
    auto.pulls.length = 0
    auto.branches.length = 0
  })

  it('hands a branch pushed to the automation, with GitHub’s id of the pusher', async () => {
    const res = await POST(raw('create', { ref_type: 'branch', ref: 'eng-42-fix', repository: { full_name: 'acme/web' }, sender: { id: 101 } }))
    expect(await res.json()).toEqual({ ok: true, moved: 1 })
    expect(auto.branches).toEqual([{ repoFullName: 'acme/web', branch: 'eng-42-fix', senderId: 101 }])
  })

  it('ignores a tag, and anything unsigned', async () => {
    await POST(raw('create', { ref_type: 'tag', ref: 'v1', repository: { full_name: 'acme/web' }, sender: { id: 101 } }))
    expect((await POST(raw('create', { ref_type: 'branch', ref: 'eng-42', repository: { full_name: 'acme/web' }, sender: { id: 101 } }, false))).status).toBe(401)
    expect(auto.branches).toEqual([])
  })

  it('hands every pull request event to the automation', async () => {
    await POST(hook('opened', {}))
    await POST(hook('closed', { state: 'closed', merged: true }))
    expect(auto.pulls.map((p) => p.action)).toEqual(['opened', 'closed'])
    expect(auto.pulls[1]).toMatchObject({ repoFullName: 'acme/web', number: 7, merged: true, authorAssociation: 'MEMBER' })
  })
})

describe('GitHub notices (docs/plans/github-reviews.md, phase 3)', () => {
  function raw(event: string, payload: Record<string, unknown>) {
    const body = JSON.stringify(payload)
    const sig = `sha256=${crypto.createHmac('sha256', SECRET).update(body).digest('hex')}`
    return new Request('https://nativeintelligence.test/api/webhooks/github', {
      method: 'POST',
      headers: { 'x-hub-signature-256': sig, 'x-github-event': event, 'x-github-delivery': 'del-3' },
      body,
    })
  }
  beforeEach(() => {
    notices.calls.length = 0
  })

  it('tells a review request, with the delivery id', async () => {
    const res = await POST(hook('review_requested', {}))
    expect(await res.json()).toMatchObject({ ok: true, told: 1 })
    expect(notices.calls).toEqual([{ kind: 'review', delivery: 'del-1' }])
  })

  it('hands comments, reviews and review comments to the notices', async () => {
    for (const e of ['issue_comment', 'pull_request_review', 'pull_request_review_comment']) {
      const res = await POST(raw(e, { action: 'created', repository: { full_name: 'acme/web' } }))
      expect(await res.json()).toEqual({ ok: true, told: 2 })
    }
    expect(notices.calls.map((c) => c.event)).toEqual(['issue_comment', 'pull_request_review', 'pull_request_review_comment'])
  })

  it('hands a check suite to the checks notice too', async () => {
    await POST(raw('check_suite', { action: 'completed', check_suite: { conclusion: 'success' }, repository: { full_name: 'acme/web' } }))
    expect(notices.calls).toEqual([{ kind: 'checks', delivery: 'del-3' }])
  })
})
