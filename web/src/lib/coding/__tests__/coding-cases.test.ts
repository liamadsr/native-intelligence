/**
 * The deterministic cases for factory-grade coding runs (P10), server side,
 * no model call (the pre-check's and the reviewer's answers are stubbed; the
 * rules that act on them are real):
 *
 *   1. an unclear action ASKS instead of coding: the run parks before any
 *      sandbox, and a clear action goes on;
 *   2. the review loop stops at two: request_changes sends the coder back
 *      twice, a third request opens nothing, and a finish_run with no new
 *      commit doesn't spend a round;
 *   3. an unattended run only ever opens a DRAFT: every origin but a
 *      person's Start, and nothing at all when its review can't run;
 *   4. red CI is fixed only for someone who opted in: no ci_fix_loop, no fix
 *      run (and no card); with it, a fix run.
 *
 * The chat side ("open draft PRs for small bugs" builds the recipe, off) is
 * evals/chat-agent/evals/flows/draft-prs-recipe.eval.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeDb } from './fake-db'

const utility = vi.hoisted(() => ({ runUtilityTask: vi.fn() }))
vi.mock('@/lib/eve/utility/run-utility', () => utility)
vi.mock('@/lib/writing/review', () => ({ logRunUsage: vi.fn(async () => {}) }))
vi.mock('@/lib/work/agent-run-mirror', () => ({
  mirrorAgentRunStatus: vi.fn(async () => {}),
  ensureWorkForAgentRun: vi.fn(async () => ({})),
  resolveMemberId: vi.fn(async () => 'member-1'),
}))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }))

import { precheckBeforeSandbox } from '../precheck'
import { MAX_REVIEW_LOOPS, reviewBeforePr, decideGate, errorEntry } from '../review'
import { isUnattendedCodingRun, prCeilingFor } from '../unattended'
import { handleCiFailure } from '../ci-fix'

beforeEach(() => vi.clearAllMocks())

describe('case 1: an unclear action asks instead of coding', () => {
  const seed = () =>
    fakeDb({
      agent_run: [{ id: 'run-1', workspace_id: 'ws', kind: 'coding', status: 'queued', action_id: 'a', precheck: null, acceptance_criteria: [] }],
      actions: [{ id: 'a', workspace_id: 'ws', identifier: 'ENG-7', title: 'Fix the export', description: null, project: { github_repo: 'acme/app' } }],
    })
  const answer = (verdict: 'actionable' | 'needs_clarification') => ({
    object: {
      verdict,
      questions: [{ question: 'Which export: CSV or PDF?', options: [{ label: 'CSV' }, { label: 'PDF' }] }],
      acceptance_criteria: ['The chosen export finishes'],
      kind: 'bug',
      size: 'small',
      reason: 'Two exports exist.',
    },
    model: 'deepseek-v4-flash',
    usage: {},
  })

  it('unclear: parked on its questions, no session', async () => {
    const db = seed()
    utility.runUtilityTask.mockResolvedValue(answer('needs_clarification'))
    expect(await precheckBeforeSandbox(db.client, { agentRunId: 'run-1', workspaceId: 'ws', userId: 'u' })).toMatchObject({ parked: true })
    expect(db.tables.agent_run[0].status).toBe('needs_input')
  })

  it('clear: goes on to the sandbox', async () => {
    const db = seed()
    utility.runUtilityTask.mockResolvedValue(answer('actionable'))
    expect(await precheckBeforeSandbox(db.client, { agentRunId: 'run-1', workspaceId: 'ws', userId: 'u' })).toMatchObject({ parked: false })
    expect(db.tables.agent_run[0].status).toBe('queued')
  })
})

describe(`case 2: the review loop stops at ${MAX_REVIEW_LOOPS}`, () => {
  it('two rounds back to the coder, the third request opens nothing, an unchanged branch spends nothing', async () => {
    const db = fakeDb({
      agent_run: [{ id: 'run-1', workspace_id: 'ws', status: 'running', action_id: null, review_trail: [], acceptance_criteria: ['A second click does nothing'] }],
    })
    let sha = 'sha-1'
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ commits: [{ sha }], files: [{ filename: 'a.ts', patch: '+ x' }] }), { status: 200 }))
    utility.runUtilityTask.mockResolvedValue({
      object: { verdict: 'request_changes', summary: 'Not yet.', criteria: [{ index: 1, result: 'fail', evidence: 'No guard.' }], changes: [{ file: 'a.ts', issue: 'Add a guard', fix: 'Return early.' }] },
      model: 'deepseek-v4-flash',
      usage: {},
    })
    const args = { agentRunId: 'run-1', workspaceId: 'ws', userId: 'u', repoFullName: 'acme/app', githubToken: 't', base: 'main', head: 'dial8/eng-7-run1', unattended: false, fetchImpl: fetchImpl as never }

    const kinds: string[] = []
    for (const next of ['sha-1', 'sha-1', 'sha-2', 'sha-3']) {
      sha = next
      kinds.push((await reviewBeforePr(db.client, args)).kind)
    }
    expect(kinds).toEqual(['changes', 'changes', 'changes', 'stop'])
    // The repeat on sha-1 reused the first review: three model calls for four finish_runs.
    expect(utility.runUtilityTask).toHaveBeenCalledTimes(3)
  })
})

describe('case 3: an unattended run only ever opens a draft', () => {
  it('every origin but a person’s Start is unattended, and its ceiling is a draft', () => {
    for (const origin of ['attempt', 'loop', 'delegation', 'chat', null, undefined, 'something-new']) {
      expect(isUnattendedCodingRun({ origin })).toBe(true)
      expect(prCeilingFor({ origin })).toBe('draft')
    }
    expect(prCeilingFor({ origin: 'user' })).toBe('ready')
    expect(prCeilingFor(null)).toBe('draft')
  })

  it('fails closed: a row with a flow, a fire key or a parent run is unattended whatever its origin says', () => {
    for (const extra of [{ flow_id: 'f' }, { fire_key: 'attempt:x' }, { parent_run_id: 'p' }]) {
      expect(prCeilingFor({ origin: 'user', ...extra })).toBe('draft')
    }
  })

  it('a review that can’t run opens nothing for an unattended run', () => {
    const err = errorEntry(1, 'sha', 'timeout')
    expect(decideGate([err], err, { unattended: true, branch: 'b' }).kind).toBe('stop')
  })
})

describe('case 4: red CI is fixed only for someone who opted in', () => {
  const BRANCH = 'dial8/eng-7-abcd1234'
  function seed(withLoop: boolean) {
    return fakeDb(
      {
        agent_run: [{ id: 'pr-run', workspace_id: 'ws', kind: 'coding', status: 'pr_open', action_id: 'a', triggered_by: 'u', repo_full_name: 'acme/app', branch: BRANCH, base_branch: 'main', pr_url: 'https://github.com/acme/app/pull/3', ci_fix_of_run_id: null, ci_fix_trail: [], acceptance_criteria: [] }],
        actions: [{ id: 'a', workspace_id: 'ws', identifier: 'ENG-7', title: 'Fix the export' }],
        user_oauth_tokens: [{ user_id: 'u', provider: 'github', capability: 'github', access_token: 't' }],
        attention_item: [],
        flow: withLoop
          ? [{ id: 'f', workspace_id: 'ws', created_by: 'u', enabled: true, trigger_type: 'pr_status_changed', trigger_config: { repo_full_name: 'acme/app' }, actions: [{ type: 'run_agent', config: { fix_ci: true } }] }]
          : [],
      },
      { agent_run_claim_ci_fix: () => 'start', check_ai_usage_limit: () => [{ allowed: true }] },
    )
  }
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ state: 'open', head: { sha: 'sha-1', repo: { full_name: 'acme/app', private: true } }, base: { repo: { private: true } } }), { status: 200 }))
  const ev = { source: 'check_run' as const, repoFullName: 'acme/app', branch: BRANCH, headSha: 'sha-1', suiteId: null, app: 'github-actions', checks: [{ name: 'test', conclusion: 'failure' }] }

  it('no loop: nothing', async () => {
    const db = seed(false)
    expect(await handleCiFailure(db.client, ev, { fetchImpl: fetchImpl as never, send: vi.fn() })).toEqual({ handled: 'ignored', reason: 'ci_fix_loop_off' })
    expect(db.tables.agent_run).toHaveLength(1)
  })

  it('the loop on: a fix run', async () => {
    const db = seed(true)
    expect((await handleCiFailure(db.client, ev, { fetchImpl: fetchImpl as never, send: vi.fn(), newId: () => 'fix-1' })).handled).toBe('fix_started')
    expect(db.tables.agent_run.find((r) => r.id === 'fix-1')).toMatchObject({ ci_fix_of_run_id: 'pr-run', branch: `${BRANCH}-cifix-fix1` })
  })
})
