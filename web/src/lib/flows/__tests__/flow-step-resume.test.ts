/**
 * A parked run, and its card's answer (F4): the state is kept (server-only)
 * when the run parks or passes data; Accept carries the run on from the step
 * with its output, exactly once; Skip ends it cleanly with a note; an expired
 * card, the kill switch, or a loop that changed or was switched off while it
 * waited ends it, saying why.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }))

import { keepRunState, LOST_ANSWER_AFTER_MS, notifyFlowStepSettled, resumeParkedRun, RUN_STATE_KEEP_MS, settledStepResult, stepsHash, STUCK_RESUMING_AFTER_MS, sweepParkedRuns, type ParkedRunContext } from '../flow-step-resume'
import { fireRunId } from '../run-record'
import { waitingResult, type RunSkillExecutor } from '../runner'
import type { ActionResult, FlowAction, TriggerContext } from '../types'

const WS = 'ws-1'
const RUN = '33333333-3333-4333-8333-333333333333'
const SKILL = '11111111-1111-4111-8111-111111111111'
const CONN = '22222222-2222-4222-8222-222222222222'
const trigger: TriggerContext = { type: 'schedule', entity_type: null, from_status_id: null, to_status_id: null, fired_at: '2026-10-20T10:00:00Z' }
const node = (id: string, type: FlowAction['type'], parent: string | null, config: Record<string, unknown>): FlowAction =>
  ({ id, type, config, condition: null, parent_id: parent, enabled: true, bearer_token_encrypted: null }) as FlowAction
const actions = [
  node('queue', 'call_tool', null, { connection: CONN, tool: 'create_draft', input: { content: 'x', publish: true } }),
  node('note', 'run_skill', 'queue', { skill_id: SKILL, mode: 'report', instructions: 'Queued: {{steps.queue.output}}' }),
]
const parkedResult: ActionResult = {
  action_id: 'queue', condition_met: true, disabled: false, incomplete: false, skipped: false, status: 'pending',
  request_summary: null, response_status_code: null, response_body_preview: 'Waiting', error_message: null, duration_ms: 1,
  parked: { approval_id: 'appr-1', card_id: 'card-1', title: 'Post via Typefully' },
}

let db: FakeSupabase
const context = (): ParkedRunContext => ({
  trigger, entity: null, extras: { workspaceId: WS }, fire_id: 'fire-1', origin_depth: 1, steps_hash: stepsHash(actions, 'owner'), run_as_user_id: 'owner',
})

function seed(over: { flow?: Record<string, unknown>; approval?: Record<string, unknown> } = {}) {
  db.seed('flow', [{ id: 'flow-1', workspace_id: WS, name: 'Weekly', enabled: true, created_by: 'owner', actions, ...over.flow }])
  db.seed('flow_run', [{ id: RUN, flow_id: 'flow-1', status: 'pending', action_results: [parkedResult, waitingResult('note')] }])
  db.seed('flow_run_state', [{ flow_run_id: RUN, workspace_id: WS, flow_id: 'flow-1', step_outputs: {}, read_outside_text: false, status: 'parked', parked_action_id: 'queue', approval_id: 'appr-1', resume: context() }])
  db.seed('tool_approval', [{ id: 'appr-1', status: 'approved', result: { success: true, text: 'draft d_7 queued' }, context: {}, ...over.approval }])
}

const runSkill = vi.fn<RunSkillExecutor>(async (action, ctx) => ({
  status: 'success', request_summary: { method: 'SKILL', url: 's', header_names: [], body_byte_length: 0 }, response_status_code: 200,
  response_body_preview: 'ok', error_message: null, duration_ms: 1, step_output: `${action.id} saw ${JSON.stringify(ctx.steps)}`,
}))
const settle = vi.fn(async () => {})
const deps = (paused = false) => ({
  supabase: db as never,
  appBaseUrl: 'https://nativeintelligence.dev',
  executorsFor: () => ({ run_skill: runSkill }),
  ledger: { start: async () => ({ settle }) },
  paused: async () => paused,
})

beforeEach(() => {
  db = makeFakeSupabase()
  runSkill.mockClear()
  settle.mockClear()
})

describe('Accept carries the run on', () => {
  it('the step takes the call\'s output; the waiting step runs with it; the run settles', async () => {
    seed()
    const out = await resumeParkedRun(deps(), { approvalId: 'appr-1', flowRunId: RUN, outcome: 'approved' })
    expect(out).toEqual({ ok: true, status: 'success', carriedOn: true })
    expect(runSkill).toHaveBeenCalledOnce()
    const run = db.rows('flow_run')[0] as { status: string; action_results: ActionResult[] }
    expect(run.status).toBe('success')
    expect(run.action_results.map((r) => [r.action_id, r.status, !!r.waiting])).toEqual([['queue', 'success', false], ['note', 'success', false]])
    const state = db.rows('flow_run_state')[0] as { status: string; step_outputs: Record<string, { output: string }>; read_outside_text: boolean }
    expect(state.status).toBe('done')
    expect(state.step_outputs.queue.output).toBe('draft d_7 queued')
    expect(state.step_outputs.note.output).toContain('draft d_7 queued')
    expect(state.read_outside_text).toBe(true)
    expect(settle).toHaveBeenCalledOnce()
  })

  it('exactly once: a second answer finds nothing parked', async () => {
    seed()
    await resumeParkedRun(deps(), { approvalId: 'appr-1', flowRunId: RUN, outcome: 'approved' })
    const again = await resumeParkedRun(deps(), { approvalId: 'appr-1', flowRunId: RUN, outcome: 'approved' })
    expect(again).toEqual({ ok: false, reason: 'not_parked' })
    expect(runSkill).toHaveBeenCalledOnce()
  })

  it('a run not written yet asks for a retry; another approval\'s answer is ignored', async () => {
    expect(await resumeParkedRun(deps(), { approvalId: 'appr-1', flowRunId: RUN, outcome: 'approved' })).toEqual({ ok: false, reason: 'not_found_yet' })
    seed()
    expect(await resumeParkedRun(deps(), { approvalId: 'appr-other', flowRunId: RUN, outcome: 'approved' })).toEqual({ ok: false, reason: 'not_this_approval' })
  })
})

describe('the run ends, and says why', () => {
  it('Skip: the step is skipped, the rest is not run, the run is a clean success', async () => {
    seed({ approval: { status: 'denied', result: null } })
    const out = await resumeParkedRun(deps(), { approvalId: 'appr-1', flowRunId: RUN, outcome: 'denied' })
    expect(out).toEqual({ ok: true, status: 'success', carriedOn: false })
    expect(runSkill).not.toHaveBeenCalled()
    const results = (db.rows('flow_run')[0] as { action_results: ActionResult[] }).action_results
    expect(results[0].response_body_preview).toMatch(/you chose Skip/)
    expect(results[1]).toMatchObject({ skipped: true, waiting: false })
    expect(results[1].response_body_preview).toMatch(/Not run: the run ended at step queue/)
  })

  it('an expired card: failed, saying the 24 hours passed', async () => {
    seed({ approval: { status: 'expired', result: null } })
    const out = await resumeParkedRun(deps(), { approvalId: 'appr-1', flowRunId: RUN, outcome: 'expired' })
    expect(out).toMatchObject({ ok: true, status: 'failed' })
    expect((db.rows('flow_run')[0] as { action_results: ActionResult[] }).action_results[0].error_message).toMatch(/expired after 24 hours/)
  })

  it('the loop changed, was switched off, or the agent was paused while it waited: the call ran, the rest did not', async () => {
    for (const [label, over, paused, why] of [
      ['changed', { flow: { actions: [actions[0]] } }, false, /changed while this step waited/],
      ['off', { flow: { enabled: false } }, false, /switched off while this step waited/],
      ['paused', {}, true, /switched off for this workspace/],
    ] as const) {
      db = makeFakeSupabase()
      seed(over as never)
      const out = await resumeParkedRun(deps(paused), { approvalId: 'appr-1', flowRunId: RUN, outcome: 'approved' })
      expect(out, label).toMatchObject({ ok: true, carriedOn: false })
      const results = (db.rows('flow_run')[0] as { action_results: ActionResult[] }).action_results
      expect(results[0].status, label).toBe('success')
      expect(results[1].response_body_preview, label).toMatch(why)
    }
    expect(runSkill).not.toHaveBeenCalled()
  })
})

describe('keepRunState', () => {
  it('keeps a parked run\'s way back and links its card to the run', async () => {
    db.seed('attention_item', [{ id: 'card-1', source_flow_run_id: null }])
    await keepRunState(db as never, {
      flowRunId: RUN, flowId: 'flow-1', workspaceId: WS, actions, createdBy: 'owner',
      outcome: { step_outputs: {}, read_outside_text: false, parked: { action_id: 'queue', approval_id: 'appr-1', card_id: 'card-1', title: 't' } },
      context: { trigger, entity: null, extras: { workspaceId: WS }, fire_id: 'fire-1', origin_depth: 1, run_as_user_id: 'owner' },
    })
    expect(db.rows('flow_run_state')[0]).toMatchObject({ status: 'parked', approval_id: 'appr-1', parked_action_id: 'queue', resume: { steps_hash: stepsHash(actions, 'owner') } })
    expect(db.rows('attention_item')[0].source_flow_run_id).toBe(RUN)
  })

  it('writes nothing for a loop that passes no data and did not park (no cost)', async () => {
    await keepRunState(db as never, {
      flowRunId: RUN, flowId: 'flow-1', workspaceId: WS, actions: [node('a', 'run_skill', null, { skill_id: SKILL, mode: 'report' })], createdBy: 'owner',
      outcome: { step_outputs: { a: { output: 'x' } }, read_outside_text: false, parked: null },
      context: { trigger, entity: null, extras: {}, fire_id: null, origin_depth: 1, run_as_user_id: 'owner' },
    })
    expect(db.rows('flow_run_state')).toEqual([])
  })
})

describe('pieces', () => {
  it('a failed approved call settles the step failed but the run still carries on', () => {
    const r = settledStepResult(parkedResult, 'approved', { result: { success: false, error: 'rate limited for acme-secret-page' } })
    // The app's own error text never lands on flow_run (B1): a generic line.
    expect(r).toMatchObject({ carryOn: true, output: null, result: { status: 'failed', error_message: 'It ran after you approved it, but the app returned an error' } })
  })

  it('B1: an approved call\'s text is the step output, never on flow_run (readable by every member)', () => {
    const secret = 'Q3 pricing for Acme: $48k, renewal at risk'
    const r = settledStepResult(parkedResult, 'approved', { result: { success: true, text: secret } })
    expect(r.output).toBe(secret)
    expect(JSON.stringify(r.result)).not.toContain('Acme')
    expect(r.result.response_body_preview).toBe(`Ran after you approved it; ${secret.length} chars back`)
  })

  it('only a flow_step approval with a run is announced', async () => {
    const send = vi.fn(async () => {})
    await notifyFlowStepSettled({ id: 'a', door: 'chat' }, 'approved', send)
    await notifyFlowStepSettled({ id: 'a', door: 'flow_step' }, 'approved', send)
    await notifyFlowStepSettled({ id: 'a', door: 'flow_step', flow_run_id: RUN }, 'denied', send)
    expect(send).toHaveBeenCalledExactlyOnceWith({ name: 'flow/step.settled', data: { approval_id: 'a', flow_run_id: RUN, outcome: 'denied' } })
  })
})

describe('S2/S8: the sweep (nothing stays parked forever)', () => {
  const NOW = Date.parse('2026-10-21T12:00:00Z')
  const ago = (ms: number) => new Date(NOW - ms).toISOString()

  it('a parked run whose answer was lost is told again, its outcome from the approval\'s status; a fresh answer is left to its own event', async () => {
    db.seed('flow_run_state', [
      { flow_run_id: 'r-lost', status: 'parked', approval_id: 'a-lost', updated_at: ago(0) },
      { flow_run_id: 'r-fresh', status: 'parked', approval_id: 'a-fresh', updated_at: ago(0) },
      { flow_run_id: 'r-running', status: 'parked', approval_id: 'a-running', updated_at: ago(0) },
      { flow_run_id: 'r-ran', status: 'parked', approval_id: 'a-ran', updated_at: ago(0) },
      { flow_run_id: 'r-waiting', status: 'parked', approval_id: 'a-waiting', updated_at: ago(0) },
      { flow_run_id: 'r-gone', status: 'parked', approval_id: 'a-gone', updated_at: ago(26 * 60 * 60 * 1000) },
    ])
    const old = ago(LOST_ANSWER_AFTER_MS + 60_000)
    db.seed('tool_approval', [
      { id: 'a-lost', door: 'flow_step', status: 'denied', decided_at: old },
      { id: 'a-fresh', door: 'flow_step', status: 'denied', decided_at: ago(60_000) },
      // Approved long ago but its call hasn't finished: not lost yet.
      { id: 'a-running', door: 'flow_step', status: 'approved', decided_at: old, executed_at: null },
      { id: 'a-ran', door: 'flow_step', status: 'approved', decided_at: old, executed_at: old },
      { id: 'a-waiting', door: 'flow_step', status: 'pending', decided_at: null },
    ])
    const send = vi.fn(async () => {})
    const out = await sweepParkedRuns(db as never, { now: NOW, send })
    expect(send.mock.calls.map((c) => (c as unknown as [{ flowRunId: string; outcome: string }])[0])).toEqual([
      { approvalId: 'a-lost', flowRunId: 'r-lost', outcome: 'denied' },
      { approvalId: 'a-ran', flowRunId: 'r-ran', outcome: 'approved' },
      // Parked past any card's 24 h, its approval gone: ended, failed.
      { approvalId: 'a-gone', flowRunId: 'r-gone', outcome: 'failed' },
    ])
    expect(out.retold).toBe(3)
  })

  it('pending cards can\'t starve the pass: it reads from the settled side', async () => {
    db.seed('flow_run_state', [
      ...Array.from({ length: 150 }, (_, i) => ({ flow_run_id: `p-${i}`, status: 'parked', approval_id: `w-${i}`, updated_at: ago(0) })),
      { flow_run_id: 'r-lost', status: 'parked', approval_id: 'a-lost', updated_at: ago(0) },
    ])
    db.seed('tool_approval', [
      ...Array.from({ length: 150 }, (_, i) => ({ id: `w-${i}`, door: 'flow_step', status: 'pending', decided_at: null })),
      { id: 'a-lost', door: 'flow_step', status: 'expired', decided_at: ago(LOST_ANSWER_AFTER_MS + 60_000) },
    ])
    const send = vi.fn(async () => {})
    await sweepParkedRuns(db as never, { now: NOW, send })
    expect(send).toHaveBeenCalledExactlyOnceWith({ approvalId: 'a-lost', flowRunId: 'r-lost', outcome: 'expired' })
  })

  it('a resume that died after its claim is ended, failed, with a note on the steps that waited', async () => {
    db.seed('flow_run_state', [{ flow_run_id: RUN, status: 'resuming', updated_at: ago(STUCK_RESUMING_AFTER_MS + 60_000), resume: context() }])
    db.seed('flow_run', [{ id: RUN, flow_id: 'flow-1', status: 'pending', action_results: [parkedResult, waitingResult('note')] }])
    const out = await sweepParkedRuns(db as never, { now: NOW, send: async () => {} })
    expect(out.ended).toBe(1)
    const run = db.rows('flow_run')[0] as { status: string; action_results: ActionResult[] }
    expect(run.status).toBe('failed')
    expect(run.action_results.every((r) => !r.waiting && !r.parked)).toBe(true)
    expect(run.action_results[1].error_message).toMatch(/stopped while carrying on/)
    expect(db.rows('flow_run_state')[0]).toMatchObject({ status: 'done', resume: null })
  })

  it('finished state older than 7 days is purged; newer, parked or resuming is kept', async () => {
    db.seed('flow_run_state', [
      { flow_run_id: 'old', status: 'done', updated_at: ago(RUN_STATE_KEEP_MS + 60_000) },
      { flow_run_id: 'new', status: 'done', updated_at: ago(60_000) },
      { flow_run_id: 'parked', status: 'parked', approval_id: null, updated_at: ago(RUN_STATE_KEEP_MS + 60_000) },
    ])
    const out = await sweepParkedRuns(db as never, { now: NOW, send: async () => {} })
    expect(out.purged).toBe(1)
    expect(db.rows('flow_run_state').map((r) => r.flow_run_id)).toEqual(['new', 'parked'])
  })
})

describe('S3: a fire\'s run id is the same on a retry', () => {
  it('derives from the fire and the flow; another fire or flow differs; a v5 uuid', () => {
    const a = fireRunId('evt-1', 'flow-1')
    expect(fireRunId('evt-1', 'flow-1')).toBe(a)
    expect(fireRunId('evt-2', 'flow-1')).not.toBe(a)
    expect(fireRunId('evt-1', 'flow-2')).not.toBe(a)
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(fireRunId(null, 'flow-1')).not.toBe(fireRunId(null, 'flow-1'))
  })
})

describe('R1: a Test of a loop still off carries on after the yes', () => {
  it('a manual run resumes with the loop off; a fired one stops', async () => {
    seed({ flow: { enabled: false } })
    db.rows('flow_run_state')[0].resume = { ...context(), manual: true }
    const test = await resumeParkedRun(deps(), { approvalId: 'appr-1', flowRunId: RUN, outcome: 'approved' })
    expect(test).toEqual({ ok: true, status: 'success', carriedOn: true })
    db = makeFakeSupabase()
    seed({ flow: { enabled: false } })
    const fired = await resumeParkedRun(deps(), { approvalId: 'appr-1', flowRunId: RUN, outcome: 'approved' })
    expect(fired).toMatchObject({ ok: true, carriedOn: false })
  })
})
