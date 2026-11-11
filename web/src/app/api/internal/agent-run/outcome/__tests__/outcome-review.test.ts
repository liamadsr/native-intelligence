/**
 * The outcome route with the reviewer in front of the PR (P10 F6), end to
 * end over an in-memory database, GitHub stubbed and the reviewer's model
 * call stubbed:
 *   - approve opens the PR with the verdict and each criterion in its body;
 *   - request_changes answers finish_run without settling (the coder goes
 *     back), twice; the third request settles the run failed, no PR;
 *   - reject settles failed and opens nothing;
 *   - a partial or failed review of a person's run opens a draft, labelled;
 *     a branch that moved after the review opens a draft with a note;
 *   - a CI fix run's approved commit fast-forwards the PR branch to exactly
 *     the reviewed sha and rewrites its review section; anything else
 *     reaches nothing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeDb, type FakeDb } from '@/lib/coding/__tests__/fake-db'

const SECRET = 'test-agent-run-secret-outcome-00'
const state = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => (state.db as { client: unknown }).client }))
const utility = vi.hoisted(() => ({ runUtilityTask: vi.fn() }))
vi.mock('@/lib/eve/utility/run-utility', () => utility)
vi.mock('@/lib/writing/review', () => ({ logRunUsage: vi.fn(async () => {}) }))
const mirror = vi.hoisted(() => ({ mirrorAgentRunStatus: vi.fn(async () => {}) }))
vi.mock('@/lib/work/agent-run-mirror', () => mirror)

import { POST } from '../route'
import { mintAgentRunToken, AGENT_RUN_SECRET_HEADER, AGENT_RUN_TOKEN_HEADER } from '@/lib/agent-run/agent-run-token'

const PATCH = '@@ -1 +1 @@\n-  button.disabled = false\n+  button.disabled = exporting'
let headSha = 'sha-1'
let branchAt: string | null = null
let bigDiff = false
let refMoveOk = true
let prCreates: Array<{ body: string; draft?: boolean }> = []
let refPatches: Array<{ url: string; body: { sha: string; force: boolean } }> = []
let bodyPatches: string[] = []

function seed(over: Record<string, unknown> = {}): FakeDb {
  return fakeDb({
    agent_run: [
      {
        id: 'run-1',
        workspace_id: 'ws-1',
        status: 'running',
        action_id: 'act-1',
        triggered_by: 'user-1',
        origin: 'user',
        repo_full_name: 'acme/app',
        branch: 'dial8/eng-42-run-1',
        base_branch: 'main',
        pr_url: null,
        review_trail: [],
        acceptance_criteria: ['The export button is disabled while an export runs'],
        ...over,
      },
    ],
    actions: [{ id: 'act-1', workspace_id: 'ws-1', identifier: 'ENG-42', title: 'Export double-submits', description: null }],
    user_oauth_tokens: [{ user_id: 'user-1', provider: 'github', capability: 'github', access_token: 'ghp_x' }],
    action_github_pr: [],
  })
}

function req(body: unknown) {
  process.env.AGENT_RUN_INTERNAL_SECRET = SECRET
  const token = mintAgentRunToken({ agentRunId: 'run-1', workspaceId: 'ws-1', userId: 'user-1' })
  return new Request('http://localhost/api/internal/agent-run/outcome', {
    method: 'POST',
    headers: { 'content-type': 'application/json', [AGENT_RUN_SECRET_HEADER]: SECRET, [AGENT_RUN_TOKEN_HEADER]: token },
    body: JSON.stringify(body),
  })
}

const PR_OPEN = {
  result: 'pr_open',
  summary: 'Disabled the button during export.',
  pr: { title: 'ENG-42: disable export while running', body: 'Coder summary.', head: 'dial8/eng-42-run-1', base: 'main' },
}

function review(verdict: 'approve' | 'request_changes' | 'reject', pass = verdict === 'approve') {
  utility.runUtilityTask.mockResolvedValueOnce({
    object: {
      verdict,
      summary: verdict === 'approve' ? 'Does what the item asks.' : 'The button stays enabled on error.',
      criteria: [{ index: 1, result: pass ? 'pass' : 'fail', evidence: pass ? 'button.disabled = exporting' : 'Nothing re-enables it on failure.' }],
      changes: verdict === 'request_changes' ? [{ file: 'src/export.ts', issue: 'Re-enable on error', fix: 'Use finally.' }] : [],
    },
    model: 'deepseek-v4-flash',
    usage: {},
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  headSha = 'sha-1'
  branchAt = null
  bigDiff = false
  refMoveOk = true
  prCreates = []
  refPatches = []
  bodyPatches = []
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/compare/')) {
      const files = [{ filename: 'src/export.ts', additions: 1, deletions: 1, patch: PATCH }]
      if (bigDiff) files.push({ filename: 'src/big.ts', additions: 5000, deletions: 0, patch: `+${'x'.repeat(70_000)}` })
      return new Response(JSON.stringify({ commits: [{ sha: headSha }], files }), { status: 200 })
    }
    if (url.includes('/git/ref/heads/')) {
      return new Response(JSON.stringify({ object: { sha: branchAt ?? headSha } }), { status: 200 })
    }
    if (url.includes('/git/refs/heads/') && init?.method === 'PATCH') {
      refPatches.push({ url, body: JSON.parse(String(init.body)) })
      return new Response('{}', { status: refMoveOk ? 200 : 422 })
    }
    if (url.endsWith('/pulls/7') && init?.method === 'PATCH') {
      bodyPatches.push(JSON.parse(String(init.body)).body)
      return new Response('{}', { status: 200 })
    }
    if (url.endsWith('/pulls/7')) {
      return new Response(JSON.stringify({ body: 'Coder summary.\n\n---\n### Review\n**Approved** at `sha-0` by the old review.' }), { status: 200 })
    }
    if (url.endsWith('/pulls') && init?.method === 'POST') {
      prCreates.push(JSON.parse(String(init.body)))
      return new Response(JSON.stringify({ html_url: 'https://github.com/acme/app/pull/7', number: 7 }), { status: 201 })
    }
    return new Response('{}', { status: 404 })
  }) as never
})

describe('outcome route: the review gate', () => {
  it('approve opens the PR with the verdict and each criterion in its body', async () => {
    const db = seed()
    state.db = db
    review('approve')
    const res = await POST(req(PR_OPEN))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json).toMatchObject({ ok: true, prUrl: 'https://github.com/acme/app/pull/7' })
    expect(prCreates).toHaveLength(1)
    expect(prCreates[0].body).toContain('Coder summary.')
    expect(prCreates[0].body).toContain('### Review')
    expect(prCreates[0].body).toContain('✅ The export button is disabled while an export runs')
    expect(db.tables.agent_run[0].status).toBe('pr_open')
  })

  it('a person’s run opens a ready PR; a run nobody started opens a DRAFT, always (P10 F4)', async () => {
    state.db = seed()
    review('approve')
    await POST(req(PR_OPEN))
    expect(prCreates[0].draft).toBeUndefined()

    prCreates = []
    for (const origin of ['attempt', 'loop', 'delegation', null]) {
      state.db = seed({ origin })
      review('approve')
      await POST(req(PR_OPEN))
    }
    expect(prCreates).toHaveLength(4)
    for (const pr of prCreates) {
      expect(pr.draft).toBe(true)
      expect(pr.body).toMatch(/^> Draft: opened by a run nobody started by hand/)
    }
  })

  it('an unattended run whose review can’t run opens nothing', async () => {
    const db = seed({ origin: 'attempt' })
    state.db = db
    utility.runUtilityTask.mockRejectedValueOnce(new Error('timeout'))
    const json = await (await POST(req(PR_OPEN))).json()
    expect(json).toMatchObject({ reviewStopped: true })
    expect(prCreates).toHaveLength(0)
    expect(db.tables.agent_run[0].status).toBe('failed')
  })

  it('request_changes sends the coder back twice, then stops without a PR', async () => {
    const db = seed()
    state.db = db
    for (const sha of ['sha-1', 'sha-2']) {
      headSha = sha
      review('request_changes')
      const res = await POST(req(PR_OPEN))
      const json = await res.json()
      expect(json).toMatchObject({ ok: false, settled: false, changesRequested: true })
      expect(json.message).toContain('Re-enable on error')
      expect(db.tables.agent_run[0].status).toBe('running')
    }
    headSha = 'sha-3'
    review('request_changes')
    const res = await POST(req(PR_OPEN))
    const json = await res.json()
    expect(json).toMatchObject({ ok: true, reviewStopped: true, prUrl: null })
    expect(prCreates).toHaveLength(0)
    expect(db.tables.agent_run[0].status).toBe('failed')
    expect(String(db.tables.agent_run[0].error_message)).toContain('after 2 rounds')
    expect((db.tables.agent_run[0].review_trail as unknown[]).length).toBe(3)
  })

  it('reject settles the run failed and opens nothing', async () => {
    const db = seed()
    state.db = db
    review('reject')
    const json = await (await POST(req(PR_OPEN))).json()
    expect(json).toMatchObject({ reviewStopped: true })
    expect(prCreates).toHaveLength(0)
    expect(db.tables.agent_run[0].status).toBe('failed')
  })
})

describe('outcome route: partial, failed and outdated reviews', () => {
  it('a person’s run whose diff was cut opens a draft labelled partially reviewed', async () => {
    state.db = seed()
    bigDiff = true
    review('approve')
    await POST(req(PR_OPEN))
    expect(prCreates).toHaveLength(1)
    expect(prCreates[0].draft).toBe(true)
    expect(prCreates[0].body).toContain('**Partially reviewed**')
  })

  it('an unattended run whose diff was cut opens nothing, and settles quietly', async () => {
    const db = seed({ origin: 'attempt' })
    state.db = db
    bigDiff = true
    review('approve')
    const json = await (await POST(req(PR_OPEN))).json()
    expect(json).toMatchObject({ reviewStopped: true })
    expect(prCreates).toHaveLength(0)
    expect(mirror.mirrorAgentRunStatus).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ status: 'failed', quiet: true }))
  })

  it('a person’s run whose review could not run opens a draft marked not reviewed', async () => {
    state.db = seed()
    utility.runUtilityTask.mockRejectedValueOnce(new Error('timeout'))
    await POST(req(PR_OPEN))
    expect(prCreates[0].draft).toBe(true)
    expect(prCreates[0].body).toContain('**Not reviewed**')
  })

  it('a branch that moved after the review opens a draft with a "commits after review" note', async () => {
    state.db = seed()
    review('approve')
    branchAt = 'sha-9-pushed-later'
    await POST(req(PR_OPEN))
    expect(prCreates[0].draft).toBe(true)
    expect(prCreates[0].body).toMatch(/^> Commits after review/)
  })

  it('a person’s stopped run is told (no quiet flag)', async () => {
    state.db = seed()
    review('reject')
    await POST(req(PR_OPEN))
    expect(mirror.mirrorAgentRunStatus).toHaveBeenCalledWith(expect.anything(), expect.anything(), { status: 'failed', error: expect.stringContaining('dial8/eng-42-run-1') })
  })
})

describe('outcome route: a CI fix run reaches its PR only on approve', () => {
  const SIDE = 'dial8/eng-42-run-1-cifix-abcd1234'
  function seedFix(): FakeDb {
    const db = seed({ id: 'run-1', origin: 'attempt', branch: SIDE, ci_fix_of_run_id: 'pr-run', ci_failure: { head_sha: 'red-1', pr_url: 'https://github.com/acme/app/pull/7', checks: [] } })
    db.tables.agent_run.push({ id: 'pr-run', workspace_id: 'ws-1', status: 'pr_open', branch: 'dial8/eng-42-run-1', pr_url: 'https://github.com/acme/app/pull/7' })
    return db
  }
  const FIX_OPEN = { ...PR_OPEN, pr: { ...PR_OPEN.pr, head: SIDE } }

  it('approve: the PR branch moves to exactly the reviewed commit (no force), its review section is replaced, no new PR', async () => {
    const db = seedFix()
    state.db = db
    headSha = 'fix-sha-2'
    review('approve')
    const json = await (await POST(req(FIX_OPEN))).json()
    expect(json).toMatchObject({ ok: true, prUrl: 'https://github.com/acme/app/pull/7' })
    expect(prCreates).toHaveLength(0)
    expect(refPatches).toEqual([{ url: 'https://api.github.com/repos/acme/app/git/refs/heads/dial8/eng-42-run-1', body: { sha: 'fix-sha-2', force: false } }])
    expect(bodyPatches).toHaveLength(1)
    expect(bodyPatches[0]).toContain('Coder summary.')
    expect(bodyPatches[0]).toContain('**Approved** at `fix-sha-2`')
    expect(bodyPatches[0]).not.toContain('sha-0')
    expect(db.tables.action_github_pr).toHaveLength(0)
  })

  it.each([['reject'], ['request_changes x3']])('%s: nothing reaches the PR', async (kind) => {
    const db = seedFix()
    state.db = db
    if (kind === 'reject') {
      review('reject')
      await POST(req(FIX_OPEN))
    } else {
      for (const sha of ['a', 'b', 'c']) {
        headSha = sha
        review('request_changes')
        await POST(req(FIX_OPEN))
      }
    }
    expect(refPatches).toHaveLength(0)
    expect(bodyPatches).toHaveLength(0)
    expect(db.tables.agent_run[0].status).toBe('failed')
  })

  it('a PR that moved since (GitHub refuses the fast-forward): nothing reaches it, the run says so', async () => {
    const db = seedFix()
    state.db = db
    refMoveOk = false
    review('approve')
    const json = await (await POST(req(FIX_OPEN))).json()
    expect(json).toMatchObject({ reviewStopped: true })
    expect(json.message).toContain('Nothing reached the pull request')
    expect(bodyPatches).toHaveLength(0)
  })

  it('a fix run that finishes without a PR result reaches nothing', async () => {
    const db = seedFix()
    state.db = db
    await POST(req({ result: 'completed', summary: 'Could not reproduce.' }))
    expect(refPatches).toHaveLength(0)
    expect(utility.runUtilityTask).not.toHaveBeenCalled()
  })
})
