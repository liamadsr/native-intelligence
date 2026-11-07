import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { FlowWithSecrets } from '../types'
import type { Evaluation } from '@/lib/ai/decisions/contracts'
import { automationReconcile } from '@/lib/ai/decisions/tasks/automation-reconcile'

vi.mock('server-only', () => ({}))
const mocks = vi.hoisted(() => ({ decision: vi.fn(), visible: vi.fn() }))
vi.mock('@/lib/ai/decisions/run-decision', () => ({ runDecision: mocks.decision }))
vi.mock('@/lib/knowledge/claim-visibility', () => ({ excludePrivateSourcedClaims: mocks.visible }))
import { decideReconcileSkip, isDefaultReconciler } from '../reconcile-decision'

const flow = { id: 'flow', workspace_id: 'ws', created_by: 'user', enabled: true,
  seed_key: 'seed:reconcile', trigger_type: 'schedule', actions: [{ id: 'action', type: 'run_skill', enabled: true,
    condition: null, parent_id: null, config: { skill_id: 'recipe', mode: 'report' } }] } as FlowWithSecrets
const claim = { id: 'claim', text: 'The API uses JSON.', type: 'fact', updated_at: '2026-10-03T12:00:00Z' }
function database(options: { claims?: typeof claim[] | null; current?: typeof claim[] | null; error?: boolean; recipe?: boolean } = {}) {
  const calls: unknown[][] = []
  let reads = 0
  const db = { from(table: string) {
    calls.push(['from', table])
    const q = { select: () => q, eq: (...args: unknown[]) => { calls.push([table, ...args]); return q }, order: () => q,
      maybeSingle: async () => ({ data: options.recipe === false ? null : { id: 'recipe' }, error: null }),
      limit: async () => ({ data: reads++ === 0 ? ('claims' in options ? options.claims : [claim]) :
        ('current' in options ? options.current : options.claims ?? [claim]), error: options.error ? {} : null }),
    }
    return q
  } } as unknown as SupabaseClient
  return { db, calls }
}
beforeEach(() => {
  mocks.decision.mockReset().mockResolvedValue({ status: 'accepted', value: { runRequired: false }, inferenceId: 'decision' })
  mocks.visible.mockReset().mockImplementation(async (_db, _ws, claims) => claims)
})

describe('automatic reconciler gate', () => {
  it('skips only a confident absence after rechecking the complete, workspace-scoped snapshot', async () => {
    const { db, calls } = database()
    expect(await decideReconcileSkip(db, flow, 'fire')).toMatchObject({ inferenceId: 'decision' })
    expect(mocks.decision).toHaveBeenCalledWith('automation.reconcile_required', expect.objectContaining({ complete: true }),
      { userId: 'user', workspaceId: 'ws', runId: 'fire' })
    expect(calls.filter(call => call[0] === 'claim' && call[1] === 'workspace_id')).toEqual([
      ['claim', 'workspace_id', 'ws'], ['claim', 'workspace_id', 'ws'],
    ])
  })
  it('does not spend for empty knowledge or override known commitments', async () => {
    expect(await decideReconcileSkip(database({ claims: [] }).db, flow)).not.toBeNull()
    expect(await decideReconcileSkip(database({ claims: [{ ...claim, type: 'commitment' }] }).db, flow)).toBeNull()
    expect(mocks.decision).not.toHaveBeenCalled()
  })
  it.each([
    { trigger_type: 'calendar_event' }, { seed_key: 'seed:groom' }, { seed_key: null }, { enabled: false }, { created_by: '' },
  ])('leaves calendar, planner, custom and unrunnable flows alone: %j', async patch => {
    const { db, calls } = database()
    expect(await decideReconcileSkip(db, { ...flow, ...patch } as FlowWithSecrets)).toBeNull()
    expect(calls).toEqual([])
  })
  it('does not gate customized instructions, act mode, conditional or multiple actions', () => {
    for (const config of [{ skill_id: 'recipe', mode: 'report', instructions: 'Always report' },
      { skill_id: 'recipe', mode: 'act' }, { skill_id: 'recipe', mode: 'report', unexpected: true }]) {
      expect(isDefaultReconciler({ ...flow, actions: [{ ...flow.actions[0], config }] } as FlowWithSecrets)).toBe(false)
    }
    expect(isDefaultReconciler({ ...flow, actions: [...flow.actions, ...flow.actions] })).toBe(false)
    expect(isDefaultReconciler({ ...flow, actions: [{ ...flow.actions[0], parent_id: 'other' }] })).toBe(false)
  })
  it.each([{ error: true }, { claims: null }, { claims: Array.from({ length: 41 }, () => claim) }, { recipe: false }])(
    'keeps the run when the source is incomplete or not canonical: %j', async options => {
      expect(await decideReconcileSkip(database(options).db, flow)).toBeNull()
      expect(mocks.decision).not.toHaveBeenCalled()
    })
  it('never sends a partial/private visibility set to Jev', async () => {
    mocks.visible.mockResolvedValue([])
    expect(await decideReconcileSkip(database().db, flow)).toBeNull()
    expect(mocks.decision).not.toHaveBeenCalled()
  })
  it.each([{ status: 'escalate' }, { status: 'cancelled' }, { status: 'accepted', value: { runRequired: true } }])(
    'retains uncertain, unavailable and positive work: %j', async outcome => {
      mocks.decision.mockResolvedValue(outcome)
      expect(await decideReconcileSkip(database().db, flow)).toBeNull()
    })
  it('runs on classifier exceptions and changes made during inference', async () => {
    expect(await decideReconcileSkip(database({ current: [{ ...claim, updated_at: 'later' }] }).db, flow)).toBeNull()
    expect(await decideReconcileSkip(database({ current: [claim, { ...claim, id: 'new' }] }).db, flow)).toBeNull()
    mocks.decision.mockRejectedValue(new Error('provider failure'))
    expect(await decideReconcileSkip(database().db, flow)).toBeNull()
  })
})

describe('reconciliation decision acceptance', () => {
  const input = { complete: true, claims: [{ id: claim.id, text: claim.text, type: claim.type, updatedAt: claim.updated_at }] }
  const result = (choice: string, p = 0.99, confidence = 0.99) => ({
    answers: { required: { type: 'choice', choice, probabilities: {
      needed: 0, not_needed: 0, uncertain: 0, [choice === 'uncertain' ? 'needed' : 'uncertain']: 1 - p, [choice]: p,
    } } },
    providerMetadata: { typesafe: { confidence: { required: confidence } } },
  }) as unknown as Evaluation
  it('only suppresses on confident negatives with complete evidence', () => {
    expect(automationReconcile.accept(result('not_needed', 0.98), input)).toEqual({ runRequired: false })
    expect(automationReconcile.accept(result('not_needed', 0.979), input)).toBeNull()
    expect(automationReconcile.accept(result('needed', 0.9), input)).toEqual({ runRequired: true })
    expect(automationReconcile.prepare({ ...input, complete: false })).toBeNull()
    expect(automationReconcile.accept(result('not_needed'), { ...input, complete: false })).toBeNull()
    expect(automationReconcile.prepare({ ...input, claims: [{ ...input.claims[0], type: 'commitment' }] })).toBeNull()
  })
  it('keeps uncertainty, weak confidence, malformed choices and old boolean cache answers on the ordinary path', () => {
    for (const evaluation of [result('uncertain'), result('invented'), result('not_needed', 0.99, 0.79),
      result('not_needed', NaN), result('not_needed', 1.1), result('needed', 0.89),
      { ...result('not_needed'), providerMetadata: {} },
      { answers: { required: { type: 'boolean', probability: 0 } } } as unknown as Evaluation,
      { answers: {} } as Evaluation]) {
      expect(automationReconcile.accept(evaluation, input)).toBeNull()
    }
  })
  it('uses explicit choices, preserves claim evidence and invalidates the prior boolean cache version', () => {
    const prepared = automationReconcile.prepare(input)!
    expect(automationReconcile.version).toBe('automation-reconcile-v2')
    expect(JSON.parse(prepared.state)).toEqual(input)
    expect(prepared.questions.required).toMatchObject({ type: 'choice', criteria: {
      needed: expect.any(String), not_needed: expect.any(String), uncertain: expect.any(String),
    } })
    expect(prepared.questions.required.instructions).toContain('old, conditional')
    expect(prepared.questions.required.instructions).toContain('untrusted evidence')
  })
})
