/**
 * `assignee_ai_member_id` is fenced to the workspace at both apply-engine
 * writers (Sequence step 1). The FK only proves the teammate EXISTS; a
 * proposal (model- or extraction-authored, or a client edit riding in `extra`)
 * naming another workspace's teammate must not be applied.
 */
import { describe, it, expect } from 'vitest'
import { applyChange, updateAppliedEntity } from '../apply-engine'
import { FOREIGN_AI_MEMBER_ERROR } from '@/lib/workspace-fences'
import type { ProposedChange } from '../types'

type Call = { table: string; op: string; payload?: unknown; eqs: Record<string, unknown> }

/** Recording stub. `teammates` are the ai_team_member ids that exist IN ws-1. */
function makeStub(teammates: string[]) {
  const calls: Call[] = []
  function builder(table: string, op: string, payload?: unknown) {
    const eqs: Record<string, unknown> = {}
    const chain: Record<string, unknown> = {}
    const record = () => calls.push({ table, op, payload, eqs })
    chain.eq = (col: string, val: unknown) => ((eqs[col] = val), chain)
    chain.is = () => chain
    chain.or = () => chain
    chain.in = () => chain
    chain.order = () => chain
    chain.limit = () => chain
    chain.select = () => chain
    chain.single = async () => {
      if (op === 'insert' || op === 'update') {
        record()
        return { data: { id: `new-${table}-1`, ...(payload as object) }, error: null }
      }
      return { data: null, error: null }
    }
    chain.maybeSingle = async () => {
      if (table === 'ai_team_member' && eqs.workspace_id === 'ws-1' && teammates.includes(eqs.id as string)) {
        return { data: { id: eqs.id }, error: null }
      }
      return { data: null, error: null }
    }
    chain.then = (resolve: (v: unknown) => unknown) => {
      record()
      return resolve({ data: null, error: null })
    }
    return chain
  }
  const supabase = {
    from: (table: string) => ({
      select: (columns?: string) => builder(table, 'select', columns),
      insert: (payload: unknown) => builder(table, 'insert', payload),
      update: (payload: unknown) => builder(table, 'update', payload),
      upsert: (payload: unknown) => builder(table, 'upsert', payload),
      delete: () => builder(table, 'delete'),
    }),
  }
  return { supabase: supabase as never, calls }
}

function change(overrides: Partial<ProposedChange> = {}): ProposedChange {
  return {
    id: 'pc-1',
    workspace_id: 'ws-1',
    capture_id: 'cap-1',
    change_type: 'create',
    entity_type: 'action',
    entity_id: null,
    display_text: 'Send the revised SOW',
    title: 'Send the revised SOW',
    description: null,
    priority: null,
    due_date: null,
    assignee_name: null,
    assignee_member_id: null,
    assignee_contact_id: null,
    assignee_ai_member_id: null,
    status_to: null,
    team_id: null,
    project_id: null,
    labels: null,
    email_to_name: null,
    email_to_address: null,
    email_subject: null,
    email_context: null,
    confidence: 0.9,
    status: 'pending',
    source_quote: null,
    result_entity_id: null,
    extra: null,
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  } as ProposedChange
}

describe('createAction (via applyChange)', () => {
  it('refuses a teammate from another workspace — no action row is inserted', async () => {
    const { supabase, calls } = makeStub(['ai-here'])
    const res = await applyChange(supabase, change({ assignee_ai_member_id: 'ai-foreign' }), 'ws-1', 'mem-1')
    expect(res).toEqual({ success: false, error: FOREIGN_AI_MEMBER_ERROR })
    expect(calls.filter((c) => c.table === 'actions' && c.op === 'insert')).toEqual([])
  })

  it('refuses one smuggled in through extra as well', async () => {
    const { supabase, calls } = makeStub(['ai-here'])
    const res = await applyChange(supabase, change({ extra: { assignee_ai_member_id: 'ai-foreign' } }), 'ws-1', 'mem-1')
    expect(res.success).toBe(false)
    expect(calls.filter((c) => c.table === 'actions' && c.op === 'insert')).toEqual([])
  })

  it('applies a teammate that belongs to the workspace, as the delegate of the person applying it', async () => {
    const { supabase, calls } = makeStub(['ai-here'])
    const res = await applyChange(supabase, change({ assignee_ai_member_id: 'ai-here' }), 'ws-1', 'mem-1')
    expect(res.success).toBe(true)
    const insert = calls.find((c) => c.table === 'actions' && c.op === 'insert')
    // Decision 9: the agent is the delegate; the person stays responsible.
    expect(insert?.payload).toMatchObject({ assignee_ai_member_id: 'ai-here', assignee_id: 'mem-1' })
    const seat = calls.find((c) => c.table === 'action_assignee' && c.op === 'insert')
    expect(seat?.payload).toMatchObject({ member_id: 'mem-1' })
  })

  it('keeps the proposal’s own person beside the delegate', async () => {
    const { supabase, calls } = makeStub(['ai-here'])
    await applyChange(supabase, change({ assignee_ai_member_id: 'ai-here', assignee_member_id: 'mem-2' }), 'ws-1', 'mem-1')
    const insert = calls.find((c) => c.table === 'actions' && c.op === 'insert')
    expect(insert?.payload).toMatchObject({ assignee_ai_member_id: 'ai-here', assignee_id: 'mem-2' })
  })
})

describe('updateAppliedEntity', () => {
  it('refuses to re-point an applied action at a foreign teammate', async () => {
    const { supabase, calls } = makeStub(['ai-here'])
    const res = await updateAppliedEntity(supabase, 'action', 'a-1', 'ws-1', { assignee_ai_member_id: 'ai-foreign' })
    expect(res).toEqual({ success: false, error: FOREIGN_AI_MEMBER_ERROR })
    expect(calls.filter((c) => c.table === 'actions' && c.op === 'update')).toEqual([])
  })

  it('writes an in-workspace teammate and leaves the people (the delegate model)', async () => {
    const { supabase, calls } = makeStub(['ai-here'])
    const res = await updateAppliedEntity(supabase, 'action', 'a-1', 'ws-1', { assignee_ai_member_id: 'ai-here' })
    expect(res.success).toBe(true)
    const update = calls.find((c) => c.table === 'actions' && c.op === 'update')
    expect(update?.payload).toMatchObject({ assignee_ai_member_id: 'ai-here' })
    expect(update?.payload).not.toHaveProperty('assignee_id')
    expect(calls.filter((c) => c.table === 'action_assignee' && c.op === 'delete')).toEqual([])
  })

  it('assigning a person leaves the delegate agent', async () => {
    const { supabase, calls } = makeStub(['ai-here'])
    await updateAppliedEntity(supabase, 'action', 'a-1', 'ws-1', { assignee_member_id: 'mem-2' })
    const update = calls.find((c) => c.table === 'actions' && c.op === 'update')
    expect(update?.payload).toMatchObject({ assignee_id: 'mem-2' })
    expect(update?.payload).not.toHaveProperty('assignee_ai_member_id')
  })

  it('clearing the teammate (null) needs no fence', async () => {
    const { supabase } = makeStub([])
    const res = await updateAppliedEntity(supabase, 'action', 'a-1', 'ws-1', { assignee_ai_member_id: null })
    expect(res.success).toBe(true)
  })
})
