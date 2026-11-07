/**
 * Proactive draft PRs for small bugs (P10 F4): built but OFF. It runs only
 * with the recipe switched on AND run_agent dispatch on; then only a small,
 * clear bug, grounded on a call, within the daily cap, becomes an action and
 * a coding run. Everything else refuses (the verdict cards it as before).
 * The ceiling itself (a draft, reviewed) is pinned where the PR is made:
 * outcome-review.test.ts and coding-cases.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeDb, type FakeDb } from './fake-db'

vi.mock('@/lib/flows/run-agent', () => ({ RUN_AGENT_DISPATCH_ENABLED: false }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }))
vi.mock('@/lib/work/agent-run-mirror', () => ({ ensureWorkForAgentRun: vi.fn(async () => ({})) }))
vi.mock('@/lib/work/role-routing', () => ({
  resolveRoleTeammate: vi.fn(async () => ({ teammate: { id: 'dev-1' }, roster: [] })),
  ensureRoleTeammates: vi.fn(async () => ({ seeded: 0 })),
}))
const breaker = vi.hoisted(() => ({ roleBreakerState: vi.fn(async () => ({ open: false, window: 5 })) }))
vi.mock('@/lib/work/role-breaker', () => breaker)
vi.mock('@/lib/work/start-work-item', () => ({ planWorkItem: vi.fn(async () => ({ teamId: 'team-1', statusId: 'todo', resources: [] })) }))
const pre = vi.hoisted(() => ({ runCodingPrecheck: vi.fn() }))
vi.mock('../precheck', () => pre)

import { MAX_PROACTIVE_CODING_RUNS_PER_DAY, attemptCodingProposal, proactiveCodingRecipe } from '../proactive'
import { recipeFlow } from '@/lib/flows/recipes'
import type { AttemptCandidate } from '@/lib/work/auto-attempt'

const WS = 'ws-1'
const NOW = new Date('2026-10-20T12:00:00Z')

function recipeFlowRow(enabled: boolean) {
  const r = recipeFlow('small_bug_draft_prs')
  if (r instanceof Error) throw r
  return {
    id: 'flow-bugs',
    workspace_id: WS,
    created_by: 'user-1',
    enabled,
    trigger_type: 'capture_processed',
    actions: [{ id: 'bugs', type: 'run_agent', enabled: true, config: { agent_id: '', repo: '', instructions: '', use_triggering_action_context: true, attempt_small_bugs: true } }],
  }
}

function seed(over: { flows?: unknown[]; runsToday?: number } = {}): FakeDb {
  let db: FakeDb
  // migration 392's claim, mirrored: the fire key reuses, the cap counts today's proactive runs, the row is inserted.
  const claim = (a: Record<string, unknown>) => {
    const runs = db.tables.agent_run
    const hit = runs.find((r) => r.fire_key === a.p_fire_key && r.workspace_id === a.p_workspace_id)
    if (hit) return hit.id
    const today = runs.filter((r) => r.workspace_id === a.p_workspace_id && r.kind === 'coding' && r.origin === 'attempt' && !r.ci_fix_of_run_id && String(r.created_at) >= String(a.p_since))
    if (today.length >= Number(a.p_max)) return null
    const row = { id: `run-${runs.length + 1}`, workspace_id: a.p_workspace_id, kind: 'coding', status: 'queued', origin: 'attempt', origin_depth: 1, flow_id: a.p_flow_id, fire_key: a.p_fire_key, triggered_by: a.p_user_id, created_at: NOW.toISOString() }
    runs.push(row)
    return row.id
  }
  db = fakeDb(
    {
      flow: (over.flows ?? [recipeFlowRow(true)]) as never,
      projects: [{ id: 'proj-1', workspace_id: WS, name: 'App', github_repo: 'acme/app' }],
      user_oauth_tokens: [{ user_id: 'user-1', provider: 'github', capability: 'github', access_token: 'ghp_x' }],
      agent_run: Array.from({ length: over.runsToday ?? 0 }, (_, i) => ({ id: `old-${i}`, workspace_id: WS, kind: 'coding', origin: 'attempt', ci_fix_of_run_id: null, created_at: '2026-10-20T08:00:00Z' })),
      actions: [],
    },
    { check_ai_usage_limit: () => [{ allowed: true }], agent_run_claim_proactive_coding: (a) => claim(a) },
  )
  return db
}

const CANDIDATE: AttemptCandidate = {
  proposalId: 'prop-1',
  cardId: null,
  title: 'Export button double-submits',
  why: 'Dana said "the export button fires twice when you double click it"',
  payload: { role: 'developer', task: 'Make the export button ignore a second click while an export runs.' },
  confidence: 0.92,
}

function ctx(db: FakeDb) {
  return {
    supabase: db.client,
    workspaceId: WS,
    userId: 'user-1',
    memberId: 'm-1',
    mode: 'act' as const,
    fireDepth: 1,
    captureId: 'cap-1',
    flowId: 'triage-flow',
    minConfidence: 0.8,
    policy: { mode: 'attempt', attempt_min_confidence: null, max_attempts_per_capture: 2 } as never,
    now: NOW,
  }
}

const ground = vi.fn(async () => ({ captureId: 'cap-1', quote: 'the export button fires twice when you double click it' }))
const send = vi.fn(async () => ({}))
let repoPrivate = true
const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ private: repoPrivate }), { status: 200 }))
const ON = { ground, send, dispatchEnabled: true, now: NOW, fetchImpl: fetchImpl as never }

function smallBug(over: Record<string, unknown> = {}) {
  pre.runCodingPrecheck.mockResolvedValue({
    record: { verdict: 'actionable', questions: [], kind: 'bug', size: 'small', reason: 'One handler.', model: 'deepseek-v4-flash', at: NOW.toISOString(), ...over },
    criteria: ['A second click while exporting does nothing'],
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  repoPrivate = true
  breaker.roleBreakerState.mockResolvedValue({ open: false, window: 5 })
  smallBug()
})

describe('off unless switched on', () => {
  it('no recipe loop, or a loop switched off: off, and nothing else is read', async () => {
    for (const flows of [[], [recipeFlowRow(false)]]) {
      const db = seed({ flows })
      expect(await proactiveCodingRecipe(db.client, WS, 'user-1')).toBeNull()
      expect(await attemptCodingProposal(CANDIDATE, ctx(db), ON)).toEqual({ attempted: false, reason: 'recipe_off' })
      expect(ground).not.toHaveBeenCalled()
      expect(pre.runCodingPrecheck).not.toHaveBeenCalled()
    }
  })

  it('the recipe on but run_agent dispatch off on this server: off (the default)', async () => {
    const db = seed()
    expect(await attemptCodingProposal(CANDIDATE, ctx(db), { ground, send })).toEqual({ attempted: false, reason: 'dispatch_off' })
    expect(db.tables.agent_run).toHaveLength(0)
  })
})

describe('switched on', () => {
  it('a small, clear bug from a call becomes an action and an unattended coding run', async () => {
    const db = seed()
    const out = await attemptCodingProposal(CANDIDATE, ctx(db), ON)
    expect(out).toMatchObject({ attempted: true, reused: false, fireKey: 'attempt:prop-1', teammateId: 'dev-1' })
    // Filed as a suggestion: confirmed only when the person marks its draft PR ready.
    expect(db.tables.actions[0]).toMatchObject({ project_id: 'proj-1', assignee_ai_member_id: 'dev-1', source_capture_id: 'cap-1', title: CANDIDATE.title, confirmation: 'suggested' })
    const run = db.tables.agent_run[0]
    expect(run).toMatchObject({ kind: 'coding', origin: 'attempt', repo_full_name: 'acme/app', fire_key: 'attempt:prop-1', flow_id: 'flow-bugs', acceptance_criteria: ['A second click while exporting does nothing'] })
    expect((run.precheck as { verdict: string }).verdict).toBe('actionable')
    expect(send).toHaveBeenCalledWith({ name: 'agent/run.requested', data: { agent_run_id: run.id, workspace_id: WS } })
  })

  it('the run records the environment it starts in: the project’s, else the workspace default (migration 420)', async () => {
    const env = (id: string) => ({ id, kind: 'cloud', name: id, workspace_id: WS, shared: true, created_by: null, network_access: 'restricted', env_vars: null, setup_script: null, archived_at: null })
    const db = seed()
    db.tables.workspace = [{ id: WS, default_cloud_environment_id: 'env-default' }]
    db.tables.environment = [env('env-proj'), env('env-default')]
    db.tables.projects[0].environment_id = 'env-proj'
    await attemptCodingProposal(CANDIDATE, ctx(db), ON)
    expect(db.tables.agent_run[0].environment_id).toBe('env-proj')

    const bare = seed()
    bare.tables.workspace = [{ id: WS, default_cloud_environment_id: 'env-default' }]
    bare.tables.environment = [env('env-default')]
    await attemptCodingProposal(CANDIDATE, ctx(bare), ON)
    expect(bare.tables.agent_run[0].environment_id).toBe('env-default')
  })

  it('the same proposal again reuses its run', async () => {
    const db = seed()
    await attemptCodingProposal(CANDIDATE, ctx(db), ON)
    const again = await attemptCodingProposal(CANDIDATE, ctx(db), ON)
    expect(again).toMatchObject({ attempted: true, reused: true })
    expect(db.tables.agent_run).toHaveLength(1)
  })

  it.each([
    [{ verdict: 'needs_clarification' }, 'not_clear'],
    [{ kind: 'feature' }, 'not_a_bug'],
    [{ size: 'medium' }, 'not_small'],
    [{ failed: true }, 'precheck_failed'],
  ])('the pre-check %o keeps the card (%s), files nothing', async (over, reason) => {
    smallBug(over)
    const db = seed()
    expect(await attemptCodingProposal(CANDIDATE, ctx(db), ON)).toMatchObject({ attempted: false, reason })
    expect(db.tables.actions).toHaveLength(0)
    expect(db.tables.agent_run).toHaveLength(0)
  })

  it(`at most ${MAX_PROACTIVE_CODING_RUNS_PER_DAY} a day`, async () => {
    const db = seed({ runsToday: MAX_PROACTIVE_CODING_RUNS_PER_DAY })
    expect(await attemptCodingProposal(CANDIDATE, ctx(db), ON)).toMatchObject({ attempted: false, reason: 'coding_day_budget' })
  })

  it('ungrounded (no quote in a workspace-visible call) keeps the card', async () => {
    const db = seed()
    const out = await attemptCodingProposal(CANDIDATE, ctx(db), { ...ON, ground: async () => ({ refusal: { attempt: false, reason: 'ungrounded', detail: 'quote not found in the transcript' } }) })
    expect(out).toEqual({ attempted: false, reason: 'ungrounded', detail: 'quote not found in the transcript' })
  })

  it('a public repo: nothing (decision 2)', async () => {
    repoPrivate = false
    const db = seed()
    expect(await attemptCodingProposal(CANDIDATE, ctx(db), ON)).toMatchObject({ attempted: false, reason: 'public_repo' })
    expect(db.tables.agent_run).toHaveLength(0)
  })

  it('the Developer role’s circuit breaker open: nothing', async () => {
    breaker.roleBreakerState.mockResolvedValue({ open: true, window: 5 } as never)
    const db = seed()
    expect(await attemptCodingProposal(CANDIDATE, ctx(db), ON)).toMatchObject({ attempted: false, reason: 'breaker_open' })
  })

  it('the per-capture budget counts this call’s coding attempts', async () => {
    const db = seed()
    for (const id of ['a', 'b']) db.tables.agent_run.push({ id, workspace_id: WS, kind: 'coding', origin: 'attempt', resources: [{ type: 'capture', id: 'cap-1' }], created_at: '2026-10-19T08:00:00Z' })
    expect(await attemptCodingProposal(CANDIDATE, ctx(db), ON)).toMatchObject({ attempted: false, reason: 'capture_budget' })
  })

  it('a loop owned by someone else is not this person’s switch', async () => {
    const db = seed({ flows: [{ ...recipeFlowRow(true), created_by: 'user-2' }] })
    expect(await attemptCodingProposal(CANDIDATE, ctx(db), ON)).toEqual({ attempted: false, reason: 'recipe_off' })
  })

  it('two projects with a repo and none picked: no guess', async () => {
    const db = seed()
    db.tables.projects.push({ id: 'proj-2', workspace_id: WS, name: 'Site', github_repo: 'acme/site' })
    expect(await attemptCodingProposal(CANDIDATE, ctx(db), ON)).toMatchObject({ attempted: false, reason: 'no_repo' })
  })
})

describe('the recipe', () => {
  it('is a capture_processed loop whose one step is the marker, with an optional project', () => {
    expect(recipeFlow('small_bug_draft_prs', { project_id: '11111111-1111-4111-8111-111111111111' })).toMatchObject({
      trigger: { type: 'capture_processed' },
      actions: [{ type: 'run_agent', attempt_small_bugs: true, project_id: '11111111-1111-4111-8111-111111111111' }],
    })
    expect(recipeFlow('small_bug_draft_prs', { project_id: 'nope' })).toBeInstanceOf(Error)
  })
})
