/**
 * delegation — the server half of `delegate_work` (Part 5 row 13): reading the
 * calls off a turn, the §3.2 checks and the child each passing call creates,
 * the refusals (and their ledger rows), the replay reuse by call id, the
 * dispatch after the park, the child-settled signal, and the result the tool
 * hands back to the model.
 *
 * Runs against the stateful fake (src/lib/work/__tests__/fake-supabase.ts), so
 * the child rows, the ledger linkage and the replay reuse are real reads of
 * what the first pass wrote.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { HandleMessageStreamEvent } from 'eve/client'
import { makeFakeSupabase, type FakeSupabase, type Row } from '@/lib/work/__tests__/fake-supabase'
import { resetAgentRunMirrorCaches } from '@/lib/work/agent-run-mirror'
import { workRunDispatchEventId } from '@/lib/work/start-work-item'
import {
  CHILD_SETTLED_EVENT,
  buildDelegationResult,
  delegationChildrenSettled,
  delegationKey,
  dispatchDelegatedChildren,
  emitChildSettled,
  extractDelegations,
  normalizeDelegationInput,
  planDelegations,
  renderDelegationTask,
  sweepSettledDelegationParks,
  type DelegationRequest,
} from '../delegation'

vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }))
vi.mock('@/lib/work/touch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/work/touch')>()),
  recordWorkTouches: vi.fn(async () => 1),
}))

const WS = 'ws-1'
const PARENT = 'run-parent'

function db(opts: { usage?: boolean | 'error'; settings?: unknown; noWorkspace?: boolean; parent?: Row; writer?: Row | null; researchers?: Row[] } = {}): FakeSupabase {
  const fake = makeFakeSupabase({
    defaults: { agent_run: { origin: 'user', origin_depth: 0 } },
    unique: { agent_run: ['fire_key'] },
    rpc: {
      check_ai_usage_limit: () =>
        opts.usage === 'error'
          ? { data: null, error: { message: 'boom' } }
          : { data: [{ allowed: opts.usage ?? true }], error: null },
    },
  })
  fake.seed('team', [{ id: 'public-team', workspace_id: WS, is_private: false }])
  fake.seed('member', [{ id: 'mem-1', workspace_id: WS, user_id: 'user-1' }])
  if (!opts.noWorkspace) {
    fake.seed('workspace', [
      { id: WS, settings: opts.settings === undefined ? { agent_autonomy: { mode: 'attempt' } } : opts.settings },
    ])
  }
  fake.seed('agent_run', [
    {
      id: PARENT,
      workspace_id: WS,
      kind: 'workspace',
      status: 'running',
      origin: 'user',
      origin_depth: 0,
      root_run_id: null,
      parent_run_id: null,
      triggered_by: 'user-1',
      ai_team_member_id: 'tm-writer',
      ...(opts.parent ?? {}),
    },
  ])
  const writer = opts.writer === undefined ? { id: 'tm-writer', workspace_id: WS, name: 'Quill', role: 'writer', can_delegate_to: ['researcher'] } : opts.writer
  fake.seed('ai_team_member', [
    ...(writer ? [writer] : []),
    ...(opts.researchers ?? [
      { id: 'tm-researcher', workspace_id: WS, name: 'Rory', role: 'researcher', autonomy: 'attempt', allowed_side_effects: ['read', 'internal-write'], created_at: '2026-09-01T00:00:00Z' },
    ]),
  ].map((row) => ({ team_id: 'public-team', is_system: false, ...row })))
  fake.seed('tracked_job', [
    { id: 'work-parent', workspace_id: WS, member_id: 'mem-1', kind: 'work_run', run_key: PARENT, agent_run_id: PARENT, status: 'running', depth: 0, parent_id: null, root_id: null, progress: {} },
  ])
  return fake
}

function req(overrides: Partial<DelegationRequest> = {}, input: Record<string, unknown> = {}): DelegationRequest {
  const raw = { role: 'researcher', brief: { task: 'Find the Acme per-seat price.', context: 'Renewal is due.', hand_back: 'A one-pager.' }, ...input }
  return {
    requestId: 'req-1',
    callId: 'call-1',
    approveOptionId: 'approve',
    denyOptionId: 'cancel',
    input: normalizeDelegationInput(raw),
    rawRole: String(raw.role ?? ''),
    ...overrides,
  }
}

const sb = (f: FakeSupabase) => f as unknown as SupabaseClient

beforeEach(() => {
  resetAgentRunMirrorCaches()
})

describe('normalizeDelegationInput', () => {
  it('reads the role, the brief, the expectation and the resources', () => {
    const got = normalizeDelegationInput({
      role: 'researcher',
      brief: { task: '  Find the price.  ', context: 'ctx', hand_back: 'doc' },
      expects: [{ type: 'document', min: 2 }],
      resources: [{ type: 'capture', id: 'cap-1' }, { type: 'document', id: 'doc-1', label: ' Brief ' }, { type: 'x' }, 'junk'],
    })
    expect(got).toEqual({
      role: 'researcher',
      task: 'Find the price.',
      context: 'ctx',
      handBack: 'doc',
      expects: [{ type: 'document', min: 2 }],
      resources: [
        { type: 'capture', id: 'cap-1', label: 'capture' },
        { type: 'document', id: 'doc-1', label: 'Brief' },
      ],
    })
  })

  it('is null with no valid role or no task', () => {
    expect(normalizeDelegationInput({ role: 'intern', brief: { task: 'x' } })).toBeNull()
    expect(normalizeDelegationInput({ role: 'researcher', brief: { task: '   ' } })).toBeNull()
    expect(normalizeDelegationInput({ role: 'researcher' })).toBeNull()
    expect(normalizeDelegationInput(null)).toBeNull()
  })

  it('clips a long task', () => {
    const got = normalizeDelegationInput({ role: 'researcher', brief: { task: 'a'.repeat(5000) } })
    expect(got?.task).toHaveLength(4000)
  })
})

describe('extractDelegations', () => {
  const ev = (requests: unknown[]) => ({ type: 'input.requested', data: { requests } }) as unknown as HandleMessageStreamEvent

  it('reads every delegate_work pause, with its call id and option ids, and skips other tools', () => {
    const got = extractDelegations([
      ev([
        {
          requestId: 'r1',
          action: { toolName: 'delegate_work', callId: 'c1', input: { role: 'researcher', brief: { task: 'T' } } },
          options: [{ id: 'approve' }, { id: 'deny' }],
        },
        { requestId: 'r2', action: { toolName: 'request_user_input', callId: 'c2', input: {} }, options: [] },
      ]),
      ev([{ requestId: 'r1', action: { toolName: 'delegate_work', callId: 'c1', input: {} } }]),
      ev([{ requestId: 'r3', action: { toolName: 'delegate_work', callId: 'c3', input: { role: 'boss', brief: { task: 'T' } } } }]),
    ])
    expect(got.map((d) => [d.requestId, d.callId, d.approveOptionId, d.denyOptionId, d.rawRole, d.input?.role ?? null])).toEqual([
      ['r1', 'c1', 'approve', 'deny', 'researcher', 'researcher'],
      ['r3', 'c3', 'approve', 'cancel', 'boss', null],
    ])
  })
})

describe('renderDelegationTask', () => {
  it('names who handed it over and carries the brief and the expected deliverables', () => {
    const input = normalizeDelegationInput({ role: 'researcher', brief: { task: 'Find it.', context: 'Why', hand_back: 'What' } })!
    const text = renderDelegationTask(input, { name: 'Quill', role: 'writer' })
    expect(text).toContain('Find it.')
    expect(text).toContain('Quill (Writer) handed this to you')
    expect(text).toContain('### Context from them\nWhy')
    expect(text).toContain('### What to hand back\nWhat')
    expect(text).toContain('Deliverables expected: 1 × document.')
  })
})

describe('planDelegations', () => {
  it('creates a queued child under the parent, routed to the role teammate, with its ledger row linked', async () => {
    const fake = db()
    const out = await planDelegations(sb(fake), { parentRunId: PARENT, workspaceId: WS, requests: [req()] })

    const child = fake.rows('agent_run').find((r) => r.parent_run_id === PARENT)!
    expect(child).toMatchObject({
      status: 'queued',
      kind: 'workspace',
      origin: 'delegation',
      origin_depth: 1,
      root_run_id: PARENT,
      ai_team_member_id: 'tm-researcher',
      triggered_by: 'user-1',
      fire_key: delegationKey(PARENT, 'call-1'),
      expects: [{ type: 'document', min: 1 }],
    })
    expect(child.action_id).toBeUndefined()
    expect(child.task_prompt).toContain('Quill (Writer) handed this to you')
    expect(out.childRunIds).toEqual([child.id])
    expect(out.park.kind).toBe('delegation')
    expect(out.park.children).toEqual([
      { requestId: 'req-1', callId: 'call-1', approveOptionId: 'approve', role: 'researcher', childRunId: child.id },
    ])
    const work = fake.rows('tracked_job').find((j) => j.agent_run_id === child.id)!
    expect(work).toMatchObject({ origin: 'delegation', parent_id: 'work-parent', root_id: 'work-parent', depth: 1 })
  })

  it('a child of a child keeps the ROOT run and nests one deeper', async () => {
    const fake = db({ parent: { origin_depth: 1, root_run_id: 'run-root', parent_run_id: 'run-root' } })
    await planDelegations(sb(fake), { parentRunId: PARENT, workspaceId: WS, requests: [req()] })
    const child = fake.rows('agent_run').find((r) => r.parent_run_id === PARENT)!
    expect(child).toMatchObject({ origin_depth: 2, root_run_id: 'run-root' })
  })

  it('carries the expectation the model asked for, else the role default', async () => {
    const fake = db()
    await planDelegations(sb(fake), {
      parentRunId: PARENT,
      workspaceId: WS,
      requests: [req({}, { expects: [{ type: 'document', min: 2 }] })],
    })
    expect(fake.rows('agent_run').find((r) => r.parent_run_id === PARENT)!.expects).toEqual([{ type: 'document', min: 2 }])
  })

  it('a replayed watch reuses the child it created for the same call and creates nothing', async () => {
    const fake = db()
    const first = await planDelegations(sb(fake), { parentRunId: PARENT, workspaceId: WS, requests: [req()] })
    const before = fake.rows('agent_run').length
    const jobs = fake.rows('tracked_job').length
    const again = await planDelegations(sb(fake), { parentRunId: PARENT, workspaceId: WS, requests: [req()] })
    expect(fake.rows('agent_run')).toHaveLength(before)
    expect(fake.rows('tracked_job')).toHaveLength(jobs)
    expect(again.childRunIds).toEqual(first.childRunIds)
    expect(again.park.children[0].childRunId).toBe(first.childRunIds[0])
  })

  it('a replay reuses the child even when the policy changed since (never refuses a handoff that is already running)', async () => {
    const fake = db()
    const first = await planDelegations(sb(fake), { parentRunId: PARENT, workspaceId: WS, requests: [req()] })
    fake.rows('workspace')[0].settings = { agent_autonomy: { mode: 'off' } }
    const again = await planDelegations(sb(fake), { parentRunId: PARENT, workspaceId: WS, requests: [req()] })
    expect(again.park.children[0]).toMatchObject({ childRunId: first.childRunIds[0] })
    expect(again.park.children[0].refused).toBeUndefined()
    expect(fake.rows('tracked_job').some((j) => j.run_key === delegationKey(PARENT, 'call-1'))).toBe(false)
  })

  it('a replayed watch reuses a refusal it recorded, with its code', async () => {
    const fake = db({ settings: { agent_autonomy: { mode: 'off' } } })
    await planDelegations(sb(fake), { parentRunId: PARENT, workspaceId: WS, requests: [req()] })
    // The workspace is switched back on: the recorded refusal still answers this call.
    fake.rows('workspace')[0].settings = { agent_autonomy: { mode: 'attempt' } }
    const jobs = fake.rows('tracked_job').length
    const again = await planDelegations(sb(fake), { parentRunId: PARENT, workspaceId: WS, requests: [req()] })
    expect(fake.rows('tracked_job')).toHaveLength(jobs)
    expect(again.childRunIds).toEqual([])
    expect(again.park.children[0].refused?.code).toBe('AUTONOMY_OFF')
  })

  it('records a refusal as a skipped ledger row under the parent, keyed by the call', async () => {
    const fake = db({ writer: { id: 'tm-writer', workspace_id: WS, name: 'Quill', role: 'writer', can_delegate_to: [] } })
    const out = await planDelegations(sb(fake), { parentRunId: PARENT, workspaceId: WS, requests: [req()] })
    expect(out.childRunIds).toEqual([])
    expect(out.park.children).toEqual([
      {
        requestId: 'req-1',
        callId: 'call-1',
        approveOptionId: 'approve',
        role: 'researcher',
        childRunId: null,
        refused: { code: 'DELEGATION_NOT_ALLOWED', reason: 'you are not allowed to hand work to that role' },
      },
    ])
    expect(fake.rows('agent_run').filter((r) => r.parent_run_id === PARENT)).toHaveLength(0)
    const row = fake.rows('tracked_job').find((j) => j.run_key === delegationKey(PARENT, 'call-1'))!
    expect(row).toMatchObject({
      status: 'skipped',
      origin: 'delegation',
      parent_id: 'work-parent',
      root_id: 'work-parent',
      depth: 1,
      progress: { delegation_refusal: { code: 'DELEGATION_NOT_ALLOWED' }, role: 'researcher' },
    })
    expect(row.agent_run_id ?? null).toBeNull()
  })

  const refusals: Array<[string, Parameters<typeof db>[0], Partial<DelegationRequest> | null, Record<string, unknown>, boolean?]> = [
    ['INVALID_BRIEF', {}, { input: null, rawRole: 'boss' }, {}],
    ['AUTONOMY_OFF', { settings: { agent_autonomy: { mode: 'off' } } }, {}, {}],
    ['POLICY_UNAVAILABLE', { noWorkspace: true }, {}, {}],
    ['DELEGATION_ROLE_UNSUPPORTED', { writer: { id: 'tm-writer', workspace_id: WS, name: 'Quill', role: 'writer', can_delegate_to: ['developer'] } }, {}, { role: 'developer' }],
    ['DELEGATION_DEPTH', { parent: { origin_depth: 2, root_run_id: 'run-root' } }, {}, {}],
    ['DELEGATION_NOT_ALLOWED', { writer: { id: 'tm-writer', workspace_id: WS, name: 'Quill', role: 'writer', can_delegate_to: [] } }, {}, {}],
    ['DELEGATION_NOT_ALLOWED', { writer: null }, {}, {}],
    ['NO_TEAMMATE_FOR_ROLE', { researchers: [] }, {}, {}],
    ['NO_TEAMMATE_FOR_ROLE', { researchers: [{ id: 'tm-r', workspace_id: WS, name: 'Rory', role: 'researcher', autonomy: 'off', created_at: '2026-09-01T00:00:00Z' }] }, {}, {}],
    ['TEAMMATE_CANNOT_DRAFT', { researchers: [{ id: 'tm-r', workspace_id: WS, name: 'Rory', role: 'researcher', autonomy: 'attempt', allowed_side_effects: ['read'], created_at: '2026-09-01T00:00:00Z' }] }, {}, {}],
    ['USAGE_LIMIT', { usage: false }, {}, {}],
    ['USAGE_LIMIT', { usage: 'error' }, {}, {}],
  ]
  it.each(refusals)('refuses %s and creates no child', async (code, setup, over, input) => {
    const fake = db(setup)
    const out = await planDelegations(sb(fake), { parentRunId: PARENT, workspaceId: WS, requests: [req(over ?? {}, input)] })
    expect(out.park.children[0].refused?.code).toBe(code)
    expect(out.childRunIds).toEqual([])
    expect(fake.rows('agent_run').filter((r) => r.parent_run_id === PARENT)).toHaveLength(0)
    expect(fake.rows('tracked_job').find((j) => j.run_key === delegationKey(PARENT, 'call-1'))?.status).toBe('skipped')
  })

  it('refuses ASK_FIRST when a question is pending in the same step', async () => {
    const fake = db()
    const out = await planDelegations(sb(fake), { parentRunId: PARENT, workspaceId: WS, requests: [req()], alongsideQuestion: true })
    expect(out.park.children[0].refused?.code).toBe('ASK_FIRST')
    expect(out.childRunIds).toEqual([])
  })

  it('counts the children it creates against the fan-out, within one batch', async () => {
    const fake = db()
    const requests = [1, 2, 3, 4].map((n) => req({ requestId: `req-${n}`, callId: `call-${n}` }))
    const out = await planDelegations(sb(fake), { parentRunId: PARENT, workspaceId: WS, requests })
    expect(out.childRunIds).toHaveLength(3)
    expect(out.park.children.map((c) => c.refused?.code ?? 'ok')).toEqual(['ok', 'ok', 'ok', 'DELEGATION_FAN_OUT'])
  })

  it('counts the runs already under the root against its budget', async () => {
    const fake = db({ parent: { origin_depth: 1, root_run_id: 'run-root' } })
    fake.seed('agent_run', [
      { id: 'a', workspace_id: WS, root_run_id: 'run-root', parent_run_id: 'run-root' },
      { id: 'b', workspace_id: WS, root_run_id: 'run-root', parent_run_id: 'run-root' },
      { id: 'c', workspace_id: WS, root_run_id: 'run-root', parent_run_id: 'run-root' },
    ])
    const out = await planDelegations(sb(fake), { parentRunId: PARENT, workspaceId: WS, requests: [req()] })
    expect(out.park.children[0].refused?.code).toBe('ROOT_BUDGET')
  })

  it('a failed child insert refuses that call only (CHILD_START_FAILED)', async () => {
    const fake = db()
    fake.failNextInsert('agent_run', { message: 'boom' })
    const out = await planDelegations(sb(fake), {
      parentRunId: PARENT,
      workspaceId: WS,
      requests: [req(), req({ requestId: 'req-2', callId: 'call-2' })],
    })
    expect(out.park.children.map((c) => c.refused?.code ?? 'ok')).toEqual(['CHILD_START_FAILED', 'ok'])
    expect(out.childRunIds).toHaveLength(1)
  })

  it('a parent it cannot read refuses every call (CHILD_START_FAILED)', async () => {
    const fake = db()
    const out = await planDelegations(sb(fake), { parentRunId: 'run-gone', workspaceId: WS, requests: [req()] })
    expect(out.park.children[0].refused?.code).toBe('CHILD_START_FAILED')
    expect(out.childRunIds).toEqual([])
  })
})

describe('dispatchDelegatedChildren', () => {
  it('sends each child its per-run dispatch event', async () => {
    const fake = db()
    const send = vi.fn(async () => undefined)
    await dispatchDelegatedChildren(sb(fake), { workspaceId: WS, childRunIds: ['c1', 'c2'] }, { send })
    expect(send.mock.calls.map((c) => (c as unknown as [{ id: string; name: string; data: Row }])[0])).toEqual([
      { id: workRunDispatchEventId('c1'), name: 'work/run.requested', data: { agent_run_id: 'c1', workspace_id: WS } },
      { id: workRunDispatchEventId('c2'), name: 'work/run.requested', data: { agent_run_id: 'c2', workspace_id: WS } },
    ])
  })

  it('fails a child it could not dispatch and tells the parent, so the parent is not left waiting', async () => {
    const fake = db()
    fake.seed('agent_run', [{ id: 'c1', workspace_id: WS, status: 'queued', parent_run_id: PARENT }])
    const send = vi.fn(async (p: { name: string }) => {
      if (p.name === 'work/run.requested') throw new Error('inngest down')
    })
    await dispatchDelegatedChildren(sb(fake), { workspaceId: WS, childRunIds: ['c1'] }, { send })
    expect(fake.rows('agent_run').find((r) => r.id === 'c1')).toMatchObject({ status: 'failed' })
    expect(send).toHaveBeenLastCalledWith({
      id: 'child-settled:c1',
      name: CHILD_SETTLED_EVENT,
      data: { agent_run_id: PARENT, child_run_id: 'c1', workspace_id: WS },
    })
  })

  it('leaves a child that already moved on alone', async () => {
    const fake = db()
    fake.seed('agent_run', [{ id: 'c1', workspace_id: WS, status: 'running', parent_run_id: PARENT }])
    const send = vi.fn(async () => {
      throw new Error('inngest down')
    })
    await dispatchDelegatedChildren(sb(fake), { workspaceId: WS, childRunIds: ['c1'] }, { send })
    expect(fake.rows('agent_run').find((r) => r.id === 'c1')?.status).toBe('running')
    expect(send).toHaveBeenCalledTimes(1)
  })
})

describe('emitChildSettled', () => {
  it('tells the parent, once per child', async () => {
    const fake = db()
    fake.seed('agent_run', [{ id: 'c1', workspace_id: WS, parent_run_id: PARENT }])
    const send = vi.fn(async () => undefined)
    await emitChildSettled(sb(fake), { childRunId: 'c1', workspaceId: WS }, { send })
    expect(send).toHaveBeenCalledWith({ id: 'child-settled:c1', name: CHILD_SETTLED_EVENT, data: { agent_run_id: PARENT, child_run_id: 'c1', workspace_id: WS } })
  })

  it('is a no-op for a run with no parent, and never throws', async () => {
    const fake = db()
    const send = vi.fn(async () => {
      throw new Error('down')
    })
    await emitChildSettled(sb(fake), { childRunId: PARENT, workspaceId: WS }, { send })
    expect(send).not.toHaveBeenCalled()
    fake.seed('agent_run', [{ id: 'c1', workspace_id: WS, parent_run_id: PARENT }])
    await expect(emitChildSettled(sb(fake), { childRunId: 'c1', workspaceId: WS }, { send })).resolves.toBeUndefined()
  })
})

describe('delegationChildrenSettled', () => {
  const park = (ids: Array<string | null>) => ({
    kind: 'delegation' as const,
    askedAt: 'now',
    children: ids.map((id, i) => ({ requestId: `r${i}`, callId: `c${i}`, approveOptionId: 'approve', role: 'researcher', childRunId: id })),
  })

  it('is true only when every child is terminal', async () => {
    const fake = db()
    fake.seed('agent_run', [
      { id: 'c1', workspace_id: WS, status: 'completed' },
      { id: 'c2', workspace_id: WS, status: 'running' },
      { id: 'c3', workspace_id: WS, status: 'canceled' },
    ])
    expect(await delegationChildrenSettled(sb(fake), park(['c1', 'c3']), WS)).toBe(true)
    expect(await delegationChildrenSettled(sb(fake), park(['c1', 'c2']), WS)).toBe(false)
    // A child it cannot see is not settled.
    expect(await delegationChildrenSettled(sb(fake), park(['c1', 'c9']), WS)).toBe(false)
  })

  it('is true for a park whose handoffs were all refused', async () => {
    expect(await delegationChildrenSettled(sb(db()), park([null, null]), WS)).toBe(true)
  })
})

describe('buildDelegationResult', () => {
  const key = delegationKey(PARENT, 'call-1')
  const childRow = (over: Row) => ({
    id: 'c1',
    workspace_id: WS,
    parent_run_id: PARENT,
    fire_key: key,
    teammate: { name: 'Rory', role: 'researcher' },
    expects: [{ type: 'document', min: 1 }],
    ...over,
  })

  it('a finished child: its summary, its deliverables and whether they meet what was asked', async () => {
    const fake = db()
    fake.seed('agent_run', [
      childRow({
        status: 'completed',
        result_summary: 'Found it.',
        deliverables: [
          { type: 'document', id: 'd1', label: 'Price' },
          { type: 'document', id: 'd2', label: 'Sources' },
        ],
      }),
    ])
    expect(await buildDelegationResult(sb(fake), { parentRunId: PARENT, workspaceId: WS, callId: 'call-1' })).toEqual({
      type: 'delegation_result',
      status: 'completed',
      role: 'researcher',
      header: 'Rory finished: 2 documents',
      child_run_id: 'c1',
      teammate: 'Rory',
      summary: 'Found it.',
      deliverables: [
        { type: 'document', id: 'd1', label: 'Price' },
        { type: 'document', id: 'd2', label: 'Sources' },
      ],
      expects_met: true,
      unmet: [],
    })
  })

  it('a finished child that fell short says what is missing', async () => {
    const fake = db()
    fake.seed('agent_run', [childRow({ status: 'completed', result_summary: 'Could not find it.', deliverables: [] })])
    const got = await buildDelegationResult(sb(fake), { parentRunId: PARENT, workspaceId: WS, callId: 'call-1' })
    expect(got).toMatchObject({ status: 'completed', header: 'Rory finished with a summary only', expects_met: false })
    expect(got.unmet).toHaveLength(1)
  })

  it('a failed or stopped child', async () => {
    const fake = db()
    fake.seed('agent_run', [childRow({ status: 'failed', error_message: 'model error' })])
    expect(await buildDelegationResult(sb(fake), { parentRunId: PARENT, workspaceId: WS, callId: 'call-1' })).toMatchObject({
      status: 'failed',
      header: 'Rory could not finish',
      summary: 'model error',
      expects_met: false,
    })
    fake.rows('agent_run').find((r) => r.id === 'c1')!.status = 'canceled'
    expect(await buildDelegationResult(sb(fake), { parentRunId: PARENT, workspaceId: WS, callId: 'call-1' })).toMatchObject({
      status: 'canceled',
      header: 'Rory was stopped',
    })
  })

  it('a child still running', async () => {
    const fake = db()
    fake.seed('agent_run', [childRow({ status: 'running' })])
    expect(await buildDelegationResult(sb(fake), { parentRunId: PARENT, workspaceId: WS, callId: 'call-1' })).toMatchObject({
      status: 'running',
      header: 'Rory is still working on it',
    })
  })

  it('never reads another parent’s child', async () => {
    const fake = db()
    fake.seed('agent_run', [childRow({ status: 'completed', parent_run_id: 'someone-else' })])
    expect((await buildDelegationResult(sb(fake), { parentRunId: PARENT, workspaceId: WS, callId: 'call-1' })).status).toBe('unknown')
  })

  it('a refused handoff: its code and reason', async () => {
    const fake = db({ usage: false })
    await planDelegations(sb(fake), { parentRunId: PARENT, workspaceId: WS, requests: [req()] })
    expect(await buildDelegationResult(sb(fake), { parentRunId: PARENT, workspaceId: WS, callId: 'call-1' })).toEqual({
      type: 'delegation_result',
      status: 'refused',
      role: 'researcher',
      header: 'Handoff to Researcher refused',
      refusal: { code: 'USAGE_LIMIT', reason: 'the workspace is at its plan limit' },
    })
  })

  it('no record at all', async () => {
    expect(await buildDelegationResult(sb(db()), { parentRunId: PARENT, workspaceId: WS, callId: 'nope' })).toEqual({
      type: 'delegation_result',
      status: 'unknown',
      role: '',
      header: 'No record of this handoff',
    })
  })
})

describe('sweepSettledDelegationParks — the backstop for a lost child-settled event', () => {
  const NOW = Date.parse('2026-09-29T00:00:00.000Z')
  const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString()
  const entry = (childRunId: string | null, i = 0) => ({ requestId: `r${i}`, callId: `c${i}`, approveOptionId: 'approve', role: 'researcher', childRunId })
  function parent(id: string, children: Array<string | null>, over: Row = {}) {
    return { id, workspace_id: WS, kind: 'workspace', status: 'needs_input', pending_input: { kind: 'delegation', askedAt: minutesAgo(60), children: children.map(entry) }, ...over }
  }

  it('nudges a parent whose children all settled past the grace period, once per tick', async () => {
    const fake = db()
    fake.seed('agent_run', [
      parent('p-stuck', ['k1', 'k2']),
      { id: 'k1', workspace_id: WS, status: 'completed', finished_at: minutesAgo(30) },
      { id: 'k2', workspace_id: WS, status: 'failed', finished_at: minutesAgo(20) },
    ])
    const send = vi.fn(async () => undefined)
    expect(await sweepSettledDelegationParks(sb(fake), NOW, { send })).toBe(1)
    expect(send).toHaveBeenCalledWith({
      id: `child-settled-sweep:p-stuck:${Math.floor(NOW / (15 * 60_000))}`,
      name: CHILD_SETTLED_EVENT,
      data: { agent_run_id: 'p-stuck', child_run_id: 'k2', workspace_id: WS },
    })
  })

  it('leaves alone a parent with a child still running, a child that only just settled, or no child at all', async () => {
    const fake = db()
    fake.seed('agent_run', [
      parent('p-running', ['k1']),
      { id: 'k1', workspace_id: WS, status: 'running', finished_at: null },
      parent('p-fresh', ['k2']),
      { id: 'k2', workspace_id: WS, status: 'completed', finished_at: minutesAgo(2) },
      parent('p-refused', [null]),
      parent('p-missing', ['k-gone']),
    ])
    const send = vi.fn(async () => undefined)
    expect(await sweepSettledDelegationParks(sb(fake), NOW, { send })).toBe(0)
    expect(send).not.toHaveBeenCalled()
  })

  it('never touches a question park, a run no longer parked, or another kind', async () => {
    const fake = db()
    fake.seed('agent_run', [
      { id: 'k1', workspace_id: WS, status: 'completed', finished_at: minutesAgo(60) },
      parent('p-question', ['k1'], { pending_input: { requestId: 'q', approveOptionId: 'a', denyOptionId: 'd', questions: [], askedAt: 'x' } }),
      parent('p-done', ['k1'], { status: 'completed' }),
      parent('p-coding', ['k1'], { kind: 'coding' }),
    ])
    const send = vi.fn(async () => undefined)
    expect(await sweepSettledDelegationParks(sb(fake), NOW, { send })).toBe(0)
  })

  it('a failed send is logged and the sweep goes on', async () => {
    const fake = db()
    fake.seed('agent_run', [
      parent('p1', ['k1']),
      parent('p2', ['k1']),
      { id: 'k1', workspace_id: WS, status: 'completed', finished_at: minutesAgo(60) },
    ])
    const send = vi.fn(async (p: { data: Record<string, unknown> }) => {
      if (p.data.agent_run_id === 'p1') throw new Error('down')
    })
    expect(await sweepSettledDelegationParks(sb(fake), NOW, { send })).toBe(1)
    expect(send).toHaveBeenCalledTimes(2)
  })
})

describe('delegation requester visibility', () => {
  it('a public Writer cannot hand work to a private Researcher, and selects a visible alternate', async () => {
    const fake = db({ parent: { origin: 'chat' }, researchers: [
      { id: 'private', team_id: 'private-team', workspace_id: WS, name: 'Secret Researcher', role: 'researcher', autonomy: 'attempt', allowed_side_effects: ['read', 'internal-write'], created_at: '2026-01-01' },
      { id: 'public', team_id: 'public-team', workspace_id: WS, name: 'Public Researcher', role: 'researcher', autonomy: 'attempt', allowed_side_effects: ['read', 'internal-write'], created_at: '2026-02-01' },
    ] })
    fake.seed('team', [{ id: 'public-team', workspace_id: WS, is_private: false }, { id: 'private-team', workspace_id: WS, is_private: true }])
    const plan = await planDelegations(sb(fake), { parentRunId: PARENT, workspaceId: WS, requests: [req()] })
    expect(plan.childRunIds).toHaveLength(1)
    expect(fake.rows('agent_run').find((r) => r.id === plan.childRunIds[0])?.ai_team_member_id).toBe('public')
    const publicIndex = fake.rows('ai_team_member').findIndex((r) => r.id === 'public')
    fake.rows('ai_team_member').splice(publicIndex, 1)
    const denied = await planDelegations(sb(fake), { parentRunId: PARENT, workspaceId: WS, requests: [req({ callId: 'second' })] })
    expect(denied.park.children[0].refused?.code).toBe('NO_TEAMMATE_FOR_ROLE')
  })
})

describe('handoff routing goes to a teammate that may draft (the chat admission RPC\'s filters)', () => {
  const holder = (id: string, created_at: string, extra: Row = {}) =>
    ({ id, workspace_id: WS, name: id, role: 'researcher', autonomy: 'attempt', allowed_side_effects: ['read', 'internal-write'], created_at, ...extra })

  it('skips an older read-only holder for a younger one that may draft', async () => {
    const fake = db({ researchers: [holder('reader', '2026-01-01', { allowed_side_effects: ['read'] }), holder('drafter', '2026-02-01', { autonomy: 'propose' })] })
    const plan = await planDelegations(sb(fake), { parentRunId: PARENT, workspaceId: WS, requests: [req()] })
    expect(fake.rows('agent_run').find((r) => r.id === plan.childRunIds[0])?.ai_team_member_id).toBe('drafter')
  })

  it('filters before the roster limit: 25 older holders that cannot draft do not hide one that can', async () => {
    const readers = Array.from({ length: 25 }, (_, i) => holder(`reader-${i}`, `2026-01-${String(i + 1).padStart(2, '0')}`, { allowed_side_effects: ['read'] }))
    const fake = db({ researchers: [...readers, holder('drafter', '2026-03-01')] })
    const plan = await planDelegations(sb(fake), { parentRunId: PARENT, workspaceId: WS, requests: [req()] })
    expect(fake.rows('agent_run').find((r) => r.id === plan.childRunIds[0])?.ai_team_member_id).toBe('drafter')
  })

  it('never routes to a system teammate', async () => {
    const fake = db({ researchers: [holder('system', '2026-01-01', { is_system: true })] })
    const plan = await planDelegations(sb(fake), { parentRunId: PARENT, workspaceId: WS, requests: [req()] })
    expect(plan.park.children[0].refused?.code).toBe('NO_TEAMMATE_FOR_ROLE')
  })
})

describe('a handoff inherits the delegating chat\'s bound (migration 299)', () => {
  const childOf = (fake: FakeSupabase) => fake.rows('agent_run').find((r) => r.parent_run_id === PARENT)!

  it('copies the parent\'s chat bound onto the child', async () => {
    const fake = db({ parent: { origin: 'chat', chat_ceiling: ['get_document', 'create_document'] } })
    await planDelegations(sb(fake), { parentRunId: PARENT, workspaceId: WS, requests: [req()] })
    expect(childOf(fake).chat_ceiling).toEqual(['create_document', 'get_document'])
  })

  it('carries it down a chain: a delegated parent with a bound passes it on', async () => {
    const fake = db({ parent: { origin: 'delegation', origin_depth: 1, root_run_id: 'run-root', chat_ceiling: ['create_document'] } })
    await planDelegations(sb(fake), { parentRunId: PARENT, workspaceId: WS, requests: [req()] })
    expect(childOf(fake).chat_ceiling).toEqual(['create_document'])
  })

  it('a chat parent with no recorded bound hands down an EMPTY one, never none', async () => {
    const fake = db({ parent: { origin: 'chat' } })
    await planDelegations(sb(fake), { parentRunId: PARENT, workspaceId: WS, requests: [req()] })
    expect(childOf(fake).chat_ceiling).toEqual([])
  })

  it('work that never came from chat gets no bound column at all', async () => {
    const fake = db()
    await planDelegations(sb(fake), { parentRunId: PARENT, workspaceId: WS, requests: [req()] })
    expect('chat_ceiling' in childOf(fake)).toBe(false)
  })
})
