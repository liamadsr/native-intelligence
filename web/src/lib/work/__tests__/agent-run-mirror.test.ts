/**
 * agent_run → the work ledger (ACTIVITY-AND-REVIEW-DESIGN §5, the work-run and
 * coding-run producer rows).
 *
 * Against the stateful fake so the mirror's transitions are real state changes:
 * one row per run keyed by the run id (idempotent across processes), a log-tail
 * `[tool]` beat becomes a step, each agent_run settle lands as the matching
 * ledger status with the run's deliverables mapped to typed refs, and a run
 * with no row (pre-ledger, or no member to own it) is a silent no-op.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { makeFakeSupabase } from './fake-supabase'

// The mirror's transitions push through the recorder (work_needs_you / work_failed).
const hoisted = vi.hoisted(() => ({ createNotification: vi.fn(async () => {}) }))
vi.mock('@/lib/notifications', () => ({ createNotification: hoisted.createNotification }))
// The recorder wakes the agent router (and the home turn) through Inngest: mocked,
// so no test sends a real event (src/test/setup.ts fails any that slip through).
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn(async () => ({ ids: [] })) } }))
import {
  beatAgentRunWork,
  deliverablesFromAgentRun,
  ensureWorkForAgentRun,
  mirrorAgentRunStatus,
  resetAgentRunMirrorCaches,
} from '../agent-run-mirror'

const RUN = {
  id: 'run-1',
  workspace_id: 'w1',
  kind: 'workspace',
  status: 'queued',
  triggered_by: 'u1',
  task_prompt: '  Draft the Q3 recap for Dana\n\nInclude the pricing decision.',
  action_id: 'act-1',
}
const REF = { agentRunId: 'run-1', workspaceId: 'w1' }

function seeded() {
  const fake = makeFakeSupabase()
  fake.seed('member', [{ id: 'm1', workspace_id: 'w1', user_id: 'u1' }])
  return fake
}

beforeEach(() => {
  resetAgentRunMirrorCaches()
  hoisted.createNotification.mockClear()
})

// The row shape run_agent writes (run-agent-persona.test.ts): the only producer,
// dormant until RUN_AGENT_DISPATCH_ENABLED is on.
describe('a persona’s runs are attributed to its teammate (bots-v3 Phase 6)', () => {
  function withPersona() {
    const fake = seeded()
    fake.seed('team', [
      { id: 'team-open', workspace_id: 'w1', is_private: false },
      { id: 'team-locked', workspace_id: 'w1', is_private: true },
    ])
    fake.seed('ai_team_member', [
      // Oldest, but on a private team the run's user isn't on: it can't front their work.
      { id: 'coach-locked', workspace_id: 'w1', team_id: 'team-locked', agent_recipe_id: 'coach', is_system: false, created_at: '2026-01-01' },
      { id: 'coach-bot', workspace_id: 'w1', team_id: 'team-open', agent_recipe_id: 'coach', is_system: false, created_at: '2026-01-02' },
      { id: 'other', workspace_id: 'w1', team_id: 'team-open', agent_recipe_id: 'someone-else', is_system: false, created_at: '2026-01-03' },
    ])
    return fake
  }

  it('a run done as a persona alone (run_agent) names the persona’s teammate', async () => {
    const fake = withPersona()
    await ensureWorkForAgentRun(fake as never, { ...RUN, kind: 'coding', action_id: null, agent_recipe_id: 'coach' })
    expect(fake.rows('tracked_job')[0]).toMatchObject({ ai_team_member_id: 'coach-bot' })
  })

  it('a run’s own teammate wins, and a persona with no teammate names none', async () => {
    const fake = withPersona()
    await ensureWorkForAgentRun(fake as never, { ...RUN, id: 'r-own', ai_team_member_id: 'other', agent_recipe_id: 'coach' })
    await ensureWorkForAgentRun(fake as never, { ...RUN, id: 'r-none', agent_recipe_id: 'nobody' })
    expect(fake.rows('tracked_job').find((r) => r.agent_run_id === 'r-own')?.ai_team_member_id).toBe('other')
    expect(fake.rows('tracked_job').find((r) => r.agent_run_id === 'r-none')?.ai_team_member_id ?? null).toBeNull()
  })
})

describe('ensureWorkForAgentRun', () => {
  it('creates ONE queued work_run row keyed by the run id, titled from the task', async () => {
    const fake = seeded()
    const work = await ensureWorkForAgentRun(fake as never, RUN)
    expect(work.inert).toBe(false)
    const rows = fake.rows('tracked_job')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      kind: 'work_run',
      status: 'queued',
      actor: 'agent',
      member_id: 'm1',
      run_key: 'run-1',
      agent_run_id: 'run-1',
      title: 'Draft the Q3 recap for Dana',
      source: { agent_run_id: 'run-1', action_id: 'act-1' },
    })

    // Another process (a later beat, an outcome route) attaches the same row.
    resetAgentRunMirrorCaches()
    const again = await ensureWorkForAgentRun(fake as never, RUN)
    expect(again.id).toBe(work.id)
    expect(fake.rows('tracked_job')).toHaveLength(1)
  })

  it('prefers the action title, records coding runs as coding_run, and a started run as running', async () => {
    const fake = seeded()
    await ensureWorkForAgentRun(
      fake as never,
      { ...RUN, kind: 'coding', status: 'running' },
      { actionTitle: 'Fix the flaky sync test' },
    )
    expect(fake.rows('tracked_job')[0]).toMatchObject({
      kind: 'coding_run',
      status: 'running',
      title: 'Fix the flaky sync test',
    })
  })

  it('falls back to a generic title when the run carries no task text', async () => {
    const fake = seeded()
    await ensureWorkForAgentRun(fake as never, { ...RUN, task_prompt: null, kind: 'coding' })
    expect(fake.rows('tracked_job')[0].title).toBe('Coding run')
  })

  it('is inert (no row) when the triggering user has no member row to own it', async () => {
    const fake = makeFakeSupabase()
    const work = await ensureWorkForAgentRun(fake as never, RUN)
    expect(work.inert).toBe(true)
    expect(fake.rows('tracked_job')).toHaveLength(0)
  })
})

describe('chat delegation reaches Needs you', () => {
  it('attributes the queued run and its reviewable result to the teammate, retaining chat provenance', async () => {
    const fake = seeded()
    await ensureWorkForAgentRun(fake as never, { ...RUN, origin: 'chat', action_id: null, ai_team_member_id: 'researcher', chat_conversation_id: 'conversation' })
    await mirrorAgentRunStatus(fake as never, { agentRunId: RUN.id, workspaceId: RUN.workspace_id }, { status: 'completed', summary: 'Research ready', deliverables: [{ type: 'document', id: 'doc', label: 'Findings' }] })
    expect(fake.rows('tracked_job')[0]).toMatchObject({ status: 'needs_review', origin: 'chat', ai_team_member_id: 'researcher', source: { chat_conversation_id: 'conversation' }, deliverables: [{ type: 'document', id: 'doc', label: 'Findings' }] })
    expect(hoisted.createNotification).toHaveBeenCalled()
  })
})

describe('ensureWorkForAgentRun — a delegated child (row 13)', () => {
  it('nests the child under its parent run’s row, keeping the root', async () => {
    const fake = seeded()
    fake.seed('tracked_job', [
      { id: 'work-root', workspace_id: 'w1', member_id: 'm1', kind: 'work_run', run_key: 'run-root', agent_run_id: 'run-root', status: 'waiting_on_child', depth: 0, root_id: null },
      { id: 'work-mid', workspace_id: 'w1', member_id: 'm1', kind: 'work_run', run_key: 'run-mid', agent_run_id: 'run-mid', status: 'waiting_on_child', depth: 1, root_id: 'work-root', parent_id: 'work-root' },
    ])
    await ensureWorkForAgentRun(fake as never, { ...RUN, id: 'run-a', action_id: null, origin: 'delegation', parent_run_id: 'run-root' })
    await ensureWorkForAgentRun(fake as never, { ...RUN, id: 'run-b', action_id: null, origin: 'delegation', parent_run_id: 'run-mid' })
    const row = (id: string) => fake.rows('tracked_job').find((r) => r.agent_run_id === id)
    expect(row('run-a')).toMatchObject({ parent_id: 'work-root', root_id: 'work-root', depth: 1, origin: 'delegation' })
    expect(row('run-b')).toMatchObject({ parent_id: 'work-mid', root_id: 'work-root', depth: 2 })
  })

  it('a run with no parent row is a root', async () => {
    const fake = seeded()
    await ensureWorkForAgentRun(fake as never, { ...RUN, parent_run_id: 'run-gone' })
    // depth is the column default (0) when no linkage is written.
    expect(fake.rows('tracked_job')[0].depth ?? 0).toBe(0)
    expect(fake.rows('tracked_job')[0].parent_id ?? null).toBeNull()
    expect(fake.rows('tracked_job')[0].root_id ?? null).toBeNull()
  })

  it('waiting_on_child parks the row on the child', async () => {
    const fake = seeded()
    await ensureWorkForAgentRun(fake as never, { ...RUN, status: 'running' })
    await mirrorAgentRunStatus(fake as never, REF, { status: 'waiting_on_child', childWorkItemId: 'child-w', role: 'researcher', label: 'Researcher', count: 1 })
    expect(fake.rows('tracked_job')[0]).toMatchObject({ status: 'waiting_on_child', needs: { kind: 'child', work_item_id: 'child-w' } })
  })
})

describe('beatAgentRunWork', () => {
  it('turns a [tool] line into a step (queued → running); prose is only a keep-alive', async () => {
    const fake = seeded()
    await beatAgentRunWork(fake as never, RUN, '[tool] search_contacts, create_email_draft\n')
    const row = fake.rows('tracked_job')[0]
    expect(row.status).toBe('running')
    expect(row.current_step).toBe('Drafting a reply')
    expect(row.started_at).not.toBeNull()

    await beatAgentRunWork(fake as never, RUN, 'Looking over what Dana asked for…')
    expect(fake.rows('tracked_job')[0].current_step).toBe('Drafting a reply')
  })

  it('creates the row on the first beat of a run that predates the ledger', async () => {
    const fake = seeded()
    await beatAgentRunWork(fake as never, { ...RUN, status: 'running' }, '[tool] get_capture_transcript')
    expect(fake.rows('tracked_job')).toHaveLength(1)
    expect(fake.rows('tracked_job')[0]).toMatchObject({ status: 'running', current_step: 'Reading the capture' })
  })
})

describe('deliverablesFromAgentRun', () => {
  it('maps agent_run deliverables to typed refs, resolving entities through entity_type', () => {
    expect(
      deliverablesFromAgentRun([
        { type: 'email_draft', id: 'd1', label: 'Re: pricing' },
        { type: 'document', id: 'doc1', label: ' Q3 recap ' },
        { type: 'entity', id: 'c1', label: 'Dana Ortiz', entity_type: 'contact' },
        { type: 'entity', id: 'x1', label: 'Unknown thing', entity_type: 'widget' },
        { type: 'action', id: '', label: 'no id' },
        { type: 'action', id: 'a1', label: '' },
      ]),
    ).toEqual([
      { type: 'email_draft', id: 'd1', label: 'Re: pricing' },
      { type: 'document', id: 'doc1', label: 'Q3 recap' },
      { type: 'contact', id: 'c1', label: 'Dana Ortiz' },
      { type: 'action', id: 'a1', label: 'Deliverable' },
    ])
    expect(deliverablesFromAgentRun(null)).toEqual([])
  })
})

describe('mirrorAgentRunStatus', () => {
  it('parks on needs_input with the questions, then resumes to running', async () => {
    const fake = seeded()
    await beatAgentRunWork(fake as never, RUN, '[tool] read_email')
    await mirrorAgentRunStatus(fake as never, REF, {
      status: 'needs_input',
      questions: [{ id: 'q1', prompt: 'Which tone?' }],
    })
    expect(fake.rows('tracked_job')[0]).toMatchObject({
      status: 'needs_input',
      needs: { kind: 'input', questions: [{ id: 'q1', prompt: 'Which tone?' }] },
      current_step: 'Waiting on your answer',
    })
    // The park is the one "needs your input" push, targeting the item.
    expect(hoisted.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'work_needs_you',
        targetType: 'work_item',
        targetId: fake.rows('tracked_job')[0].id,
        body: 'Which tone?',
      }),
    )
    await mirrorAgentRunStatus(fake as never, REF, { status: 'running' })
    expect(fake.rows('tracked_job')[0]).toMatchObject({ status: 'running', needs: null })
  })

  it('completes into needs_review with the run deliverables — and a work run always waits on review', async () => {
    const fake = seeded()
    await ensureWorkForAgentRun(fake as never, RUN)
    await mirrorAgentRunStatus(fake as never, REF, {
      status: 'completed',
      summary: 'Drafted the recap',
      deliverables: [{ type: 'document', id: 'doc1', label: 'Q3 recap' }],
    })
    expect(fake.rows('tracked_job')[0]).toMatchObject({
      status: 'needs_review',
      result_summary: 'Drafted the recap',
      deliverables: [{ type: 'document', id: 'doc1', label: 'Q3 recap' }],
      needs: { kind: 'review', verb: 'review' },
      current_step: null,
    })
    expect(hoisted.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'work_needs_you', title: 'Draft the Q3 recap for Dana — ready to review' }),
    )

    // A work run's summary IS the deliverable when nothing else is.
    resetAgentRunMirrorCaches()
    const summaryOnly = seeded()
    await ensureWorkForAgentRun(summaryOnly as never, { ...RUN, id: 'run-2' })
    await mirrorAgentRunStatus(summaryOnly as never, { ...REF, agentRunId: 'run-2' }, { status: 'completed', summary: 'Nothing to do' })
    expect(summaryOnly.rows('tracked_job')[0]).toMatchObject({ status: 'needs_review', deliverables: [] })

    // A coding run that finished without a PR just ends, quietly.
    resetAgentRunMirrorCaches()
    hoisted.createNotification.mockClear()
    const coding = seeded()
    await ensureWorkForAgentRun(coding as never, { ...RUN, id: 'run-3', kind: 'coding' })
    await mirrorAgentRunStatus(coding as never, { ...REF, agentRunId: 'run-3' }, { status: 'completed', summary: 'No changes needed' })
    expect(coding.rows('tracked_job')[0]).toMatchObject({ status: 'done', needs: null, deliverables: [] })
    expect(hoisted.createNotification).not.toHaveBeenCalled()
  })

  it('pr_open lands as needs_review with the PR as the deliverable to approve', async () => {
    const fake = seeded()
    await ensureWorkForAgentRun(fake as never, { ...RUN, kind: 'coding' })
    await mirrorAgentRunStatus(fake as never, REF, {
      status: 'pr_open',
      prUrl: 'https://github.com/o/r/pull/7',
      summary: 'Opened a PR',
    })
    expect(fake.rows('tracked_job')[0]).toMatchObject({
      status: 'needs_review',
      deliverables: [{ type: 'pr', id: 'https://github.com/o/r/pull/7', label: 'Pull request' }],
      needs: { kind: 'review', verb: 'approve' },
    })
  })

  it('failed and canceled settle the row, and a settled row is never reopened', async () => {
    const fake = seeded()
    await ensureWorkForAgentRun(fake as never, RUN)
    await mirrorAgentRunStatus(fake as never, REF, { status: 'failed', error: 'No GitHub token' })
    expect(fake.rows('tracked_job')[0]).toMatchObject({ status: 'failed', error_message: 'No GitHub token' })

    // A late beat or cancel after the failure changes nothing.
    await beatAgentRunWork(fake as never, RUN, '[tool] read_email')
    await mirrorAgentRunStatus(fake as never, REF, { status: 'canceled' })
    expect(fake.rows('tracked_job')[0]).toMatchObject({ status: 'failed', current_step: null })

    resetAgentRunMirrorCaches()
    const other = seeded()
    await ensureWorkForAgentRun(other as never, { ...RUN, id: 'run-3' })
    await mirrorAgentRunStatus(other as never, { ...REF, agentRunId: 'run-3' }, { status: 'canceled' })
    expect(other.rows('tracked_job')[0]).toMatchObject({ status: 'canceled', error_message: 'Canceled by user' })
  })

  it('is a silent no-op for a run with no ledger row, and never throws on a broken client', async () => {
    const fake = makeFakeSupabase()
    await mirrorAgentRunStatus(fake as never, REF, { status: 'failed', error: 'x' })
    expect(fake.rows('tracked_job')).toHaveLength(0)

    const broken = { from: () => { throw new Error('db down') } }
    await expect(
      mirrorAgentRunStatus(broken as never, REF, { status: 'completed' }),
    ).resolves.toBeUndefined()
    await expect(beatAgentRunWork(broken as never, RUN, '[tool] x')).resolves.toBeUndefined()
  })
})
