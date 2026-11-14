/**
 * start-work-item — the Start body shared by the rail's Start route and the
 * auto-attempt gate (Sequence step 3). The route's own suite
 * (attention-items/__tests__/route.test.ts) pins a person's Start end to end;
 * this suite pins what only the gate uses: fire_key idempotency (reuse, the
 * lost insert race), the origin/teammate stamps on the run and its ledger row,
 * and the per-run dispatch event id.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { makeFakeSupabase, type FakeSupabase } from './fake-supabase'
import { launchWorkItem, planWorkItem, workRunDispatchEventId, type WorkItemPlan } from '../start-work-item'
import { resetAgentRunMirrorCaches } from '../agent-run-mirror'

vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }))
// A failed dispatch tells the person (work/notify.ts → createNotification, on its own service
// client): a no-op here, never the network.
vi.mock('@/lib/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/notifications')>()),
  createNotification: async () => {},
}))
const touchSpy = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => 1))
vi.mock('../touch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../touch')>()),
  recordWorkTouches: touchSpy,
}))

const PLAN: WorkItemPlan = { teamId: 'team-1', statusId: 'state-todo', resources: [{ type: 'capture', id: 'cap-1', label: 'Source capture' }] }

function db(): FakeSupabase {
  const fake = makeFakeSupabase({
    defaults: { actions: { identifier: 'GEN-7' }, agent_run: { origin: 'user', origin_depth: 0 } },
    unique: { agent_run: ['fire_key'] },
  })
  fake.seed('member', [{ id: 'mem-1', workspace_id: 'ws-1', user_id: 'user-1' }])
  return fake
}

const base = {
  workspaceId: 'ws-1',
  userId: 'user-1',
  memberId: 'mem-1',
  title: 'Research token exchange',
  task: 'Research the Okta-to-Salesforce token exchange flow and write a brief.',
  plan: PLAN,
}

let send: ReturnType<typeof vi.fn>
beforeEach(() => {
  resetAgentRunMirrorCaches()
  touchSpy.mockClear()
  send = vi.fn(async () => undefined)
})

describe('launchWorkItem', () => {
  it('a person\'s Start (no key, origin user): writes the row it always did — no fire_key/origin/teammate keys — and dispatches with the per-run event id', async () => {
    const fake = db()
    const out = await launchWorkItem(fake as unknown as SupabaseClient, fake as unknown as SupabaseClient, {
      ...base,
      attentionItemId: 'card-1',
      proposalId: null,
    }, { send })
    expect(out).toMatchObject({ ok: true, reused: false, identifier: 'GEN-7' })
    const run = fake.rows('agent_run')[0]
    expect(run).not.toHaveProperty('fire_key')
    expect(run).not.toHaveProperty('ai_team_member_id')
    expect(run.origin).toBe('user') // the column default, not written by the code
    expect((fake.rows('actions')[0].context_data as Record<string, unknown>)).toEqual({ work_run: true, attention_item_id: 'card-1' })
    expect(fake.rows('tracked_job')[0]).not.toHaveProperty('origin')
    expect(send).toHaveBeenCalledWith({
      id: workRunDispatchEventId(run.id as string),
      name: 'work/run.requested',
      data: { agent_run_id: run.id, workspace_id: 'ws-1' },
    })
  })

  it('an attempt (trackedAction false) files NO board action: stamps origin, teammate and fire_key on the run and ledger row, anchors to its capture, records the declared touch, and leaves the proposal pending', async () => {
    const fake = db()
    fake.seed('proposed_change', [{ id: 'p1', workspace_id: 'ws-1', status: 'pending' }])
    const out = await launchWorkItem(fake as unknown as SupabaseClient, fake as unknown as SupabaseClient, {
      ...base,
      proposalId: 'p1',
      fireKey: 'attempt:p1',
      origin: 'attempt',
      aiTeamMemberId: 'tm-researcher',
      trackedAction: false,
      sourceCaptureId: 'cap-1',
      flowId: 'flow-triage',
    }, { send })
    expect(out).toMatchObject({ ok: true, reused: false, actionId: null, identifier: null })
    // agent_run_has_origin: no action, so the run records the flow that started it.
    expect(fake.rows('agent_run')[0].flow_id).toBe('flow-triage')
    expect(fake.rows('actions')).toHaveLength(0)
    const run = fake.rows('agent_run')[0]
    expect(run).toMatchObject({ fire_key: 'attempt:p1', origin: 'attempt', ai_team_member_id: 'tm-researcher', triggered_by: 'user-1', action_id: null, attention_item_id: null })
    const job = fake.rows('tracked_job')[0]
    expect(job).toMatchObject({ origin: 'attempt', ai_team_member_id: 'tm-researcher', agent_run_id: run.id, status: 'queued' })
    expect(job.source).toEqual({ agent_run_id: run.id, capture_id: 'cap-1', entity_type: 'capture', entity_id: 'cap-1' })
    expect(touchSpy).toHaveBeenCalledWith(expect.anything(), [
      { workspaceId: 'ws-1', workItemId: job.id, agentRunId: run.id, entityType: 'capture', entityId: 'cap-1', verb: 'read', toolName: 'declared' },
    ])
    expect(fake.rows('proposed_change')[0].status).toBe('pending')
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('stores what the work must hand back on the run (agent_run.expects), and nothing when the card asks for nothing', async () => {
    const fake = db()
    await launchWorkItem(fake as unknown as SupabaseClient, fake as unknown as SupabaseClient, { ...base, expects: [{ type: 'document', min: 1 }] }, { send })
    expect(fake.rows('agent_run')[0].expects).toEqual([{ type: 'document', min: 1 }])
    const other = db()
    await launchWorkItem(other as unknown as SupabaseClient, other as unknown as SupabaseClient, { ...base, expects: [] }, { send })
    expect(other.rows('agent_run')[0].expects).toBeUndefined()
  })

  it('an attempt\'s dispatch failure marks the run failed and touches no action', async () => {
    const fake = db()
    send.mockRejectedValueOnce(new Error('inngest down'))
    const out = await launchWorkItem(fake as unknown as SupabaseClient, fake as unknown as SupabaseClient, { ...base, origin: 'attempt', trackedAction: false, flowId: 'flow-triage' }, { send })
    expect(out).toEqual({ ok: false, stage: 'dispatch', error: 'inngest down' })
    expect(fake.rows('agent_run')[0].status).toBe('failed')
    expect(fake.rows('actions')).toHaveLength(0)
  })

  it('no action AND no flow is refused before any write (agent_run_has_origin would reject the run)', async () => {
    const fake = db()
    const out = await launchWorkItem(fake as unknown as SupabaseClient, fake as unknown as SupabaseClient, { ...base, origin: 'attempt', trackedAction: false }, { send })
    expect(out).toMatchObject({ ok: false, stage: 'run' })
    expect(fake.rows('agent_run')).toHaveLength(0)
    expect(fake.rows('actions')).toHaveLength(0)
    expect(send).not.toHaveBeenCalled()
  })

  it('a person\'s Start with a backing proposal still files the action and applies the proposal to it', async () => {
    const fake = db()
    fake.seed('proposed_change', [{ id: 'p1', workspace_id: 'ws-1', status: 'pending' }])
    await launchWorkItem(fake as unknown as SupabaseClient, fake as unknown as SupabaseClient, { ...base, proposalId: 'p1' }, { send })
    expect(fake.rows('proposed_change')[0]).toMatchObject({ status: 'applied', result_entity_id: fake.rows('actions')[0].id, applied_by: 'mem-1' })
    expect(touchSpy).not.toHaveBeenCalled()
  })

  it('fire_key idempotency: a second launch with the same key REUSES the run — no second action, no second run — and re-dispatches a still-queued run under the same event id', async () => {
    const fake = db()
    const input = { ...base, fireKey: 'attempt:p1', origin: 'attempt' as const, aiTeamMemberId: 'tm-1' }
    const first = await launchWorkItem(fake as unknown as SupabaseClient, fake as unknown as SupabaseClient, input, { send })
    const second = await launchWorkItem(fake as unknown as SupabaseClient, fake as unknown as SupabaseClient, input, { send })
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(second).toMatchObject({ reused: true, agentRunId: first.agentRunId, actionId: first.actionId, identifier: 'GEN-7' })
    expect(fake.rows('actions')).toHaveLength(1)
    expect(fake.rows('agent_run')).toHaveLength(1)
    expect(fake.rows('tracked_job')).toHaveLength(1)
    const ids = send.mock.calls.map(([p]) => (p as { id: string }).id)
    expect(ids).toEqual([workRunDispatchEventId(first.agentRunId), workRunDispatchEventId(first.agentRunId)])
  })

  it('a reused run that already started is NOT re-dispatched', async () => {
    const fake = db()
    fake.seed('agent_run', [{ id: 'run-live', workspace_id: 'ws-1', action_id: 'act-9', status: 'running', fire_key: 'attempt:p1' }])
    const out = await launchWorkItem(fake as unknown as SupabaseClient, fake as unknown as SupabaseClient, { ...base, fireKey: 'attempt:p1', origin: 'attempt' }, { send })
    expect(out).toMatchObject({ ok: true, reused: true, agentRunId: 'run-live' })
    expect(send).not.toHaveBeenCalled()
    expect(fake.rows('actions')).toHaveLength(0)
  })

  it('the lost insert race (23505 on fire_key): deletes the action it just filed and reuses the winner', async () => {
    const fake = db()
    // The winner's row lands between this launch's pre-check and its insert.
    fake.failNextInsert('agent_run', { code: '23505', message: 'duplicate key value violates unique constraint' })
    const original = fake.from.bind(fake)
    let inserted = false
    ;(fake as { from: (t: string) => Record<string, unknown> }).from = (t: string) => {
      if (t === 'agent_run' && !inserted && fake.rows('actions').length === 1) {
        inserted = true
        fake.seed('agent_run', [{ id: 'run-winner', workspace_id: 'ws-1', action_id: 'act-winner', status: 'queued', fire_key: 'attempt:p1' }])
      }
      return original(t)
    }
    const out = await launchWorkItem(fake as unknown as SupabaseClient, fake as unknown as SupabaseClient, { ...base, fireKey: 'attempt:p1', origin: 'attempt' }, { send })
    expect(out).toMatchObject({ ok: true, reused: true, agentRunId: 'run-winner', actionId: 'act-winner' })
    expect(fake.rows('actions')).toHaveLength(0) // the loser's action is gone
  })

  it('a run-insert failure deletes the action and reports the stage; nothing is dispatched', async () => {
    const fake = db()
    fake.failNextInsert('agent_run', { message: 'boom' })
    const out = await launchWorkItem(fake as unknown as SupabaseClient, fake as unknown as SupabaseClient, base, { send })
    expect(out).toEqual({ ok: false, stage: 'run', error: 'boom' })
    expect(fake.rows('actions')).toHaveLength(0)
    expect(send).not.toHaveBeenCalled()
  })

  it('a dispatch failure marks the run failed and the action idle, and reports the stage', async () => {
    const fake = db()
    send.mockRejectedValueOnce(new Error('inngest down'))
    const out = await launchWorkItem(fake as unknown as SupabaseClient, fake as unknown as SupabaseClient, base, { send })
    expect(out).toEqual({ ok: false, stage: 'dispatch', error: 'inngest down' })
    expect(fake.rows('agent_run')[0].status).toBe('failed')
    expect(fake.rows('actions')[0].agent_run_status).toBe('idle')
  })
})

describe('launchWorkItem — existingActionId (a delegated action\'s Start, decision 9)', () => {
  function withAction(): FakeSupabase {
    // `project`: an update's select returns the columns it names, as PostgREST does.
    const fake = makeFakeSupabase({
      defaults: { agent_run: { origin: 'user', origin_depth: 0 } },
      unique: { agent_run: ['fire_key'] },
      project: true,
    })
    fake.seed('member', [{ id: 'mem-1', workspace_id: 'ws-1', user_id: 'user-1' }])
    fake.seed('actions', [{ id: 'act-9', workspace_id: 'ws-1', identifier: 'ENG-9', title: 'Write the brief', agent_run_status: 'idle' }])
    return fake
  }

  it('files no action: the run anchors to the existing one, which goes to starting, with the delegate on the run', async () => {
    const fake = withAction()
    const out = await launchWorkItem(fake as unknown as SupabaseClient, fake as unknown as SupabaseClient, {
      ...base,
      existingActionId: 'act-9',
      aiTeamMemberId: 'tm-writer',
    }, { send })
    expect(out).toMatchObject({ ok: true, reused: false, actionId: 'act-9', identifier: 'ENG-9' })
    expect(fake.rows('actions')).toHaveLength(1)
    expect(fake.rows('actions')[0].agent_run_status).toBe('starting')
    const run = fake.rows('agent_run')[0]
    expect(run).toMatchObject({ action_id: 'act-9', kind: 'workspace', ai_team_member_id: 'tm-writer' })
    expect(fake.rows('tracked_job')[0].source).toMatchObject({ action_id: 'act-9' })
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('an action outside the workspace is refused before any run is written', async () => {
    const fake = withAction()
    const out = await launchWorkItem(fake as unknown as SupabaseClient, fake as unknown as SupabaseClient, {
      ...base,
      workspaceId: 'ws-other',
      existingActionId: 'act-9',
    }, { send })
    expect(out).toMatchObject({ ok: false, stage: 'action' })
    expect(fake.rows('agent_run')).toHaveLength(0)
    expect(fake.rows('actions')[0].agent_run_status).toBe('idle')
  })

  it('a dispatch failure resets the existing action to idle and never deletes it', async () => {
    const fake = withAction()
    send.mockRejectedValueOnce(new Error('inngest down'))
    const out = await launchWorkItem(fake as unknown as SupabaseClient, fake as unknown as SupabaseClient, { ...base, existingActionId: 'act-9' }, { send })
    expect(out).toEqual({ ok: false, stage: 'dispatch', error: 'inngest down' })
    expect(fake.rows('actions')).toHaveLength(1)
    expect(fake.rows('actions')[0].agent_run_status).toBe('idle')
  })
})

describe('planWorkItem', () => {
  it('null when the workspace has no default state; otherwise team, state and the fenced resource snapshot', async () => {
    const fake = db()
    expect(await planWorkItem(fake as unknown as SupabaseClient, { workspaceId: 'ws-1', resources: [] })).toBeNull()
    fake.seed('team', [{ id: 'team-1', workspace_id: 'ws-1', created_at: '2026-01-01' }])
    fake.seed('workflow_state', [{ id: 'state-todo', team_id: 'team-1', is_default: true }])
    const plan = await planWorkItem(fake as unknown as SupabaseClient, {
      workspaceId: 'ws-1',
      resources: [{ type: 'nonsense', id: 'x', label: '  Keep the label  ' }],
    })
    expect(plan).toEqual({ teamId: 'team-1', statusId: 'state-todo', resources: [{ type: 'nonsense', label: 'Keep the label' }] })
  })
})
