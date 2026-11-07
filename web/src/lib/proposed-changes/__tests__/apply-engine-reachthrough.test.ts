import { describe, it, expect, vi } from 'vitest'
import {
  applyChange,
  updateAppliedEntity,
  deleteAppliedEntity,
} from '../apply-engine'
import type { ProposedChange } from '../types'

/**
 * A tiny chainable Supabase stub that records the last update/delete payload per
 * table. `.update()/.delete()` return a thenable that resolves { error: null }.
 */
function makeStub() {
  const calls: { table: string; op: string; payload?: unknown; eqs: Record<string, unknown> }[] = []
  function builder(table: string, op: string, payload?: unknown) {
    const eqs: Record<string, unknown> = {}
    const chain: Record<string, unknown> = {}
    const record = () => calls.push({ table, op, payload, eqs })
    chain.eq = (col: string, val: unknown) => {
      eqs[col] = val
      return chain
    }
    chain.maybeSingle = async () => ({ data: null, error: null })
    chain.select = () => chain
    chain.insert = async () => ({ error: null })
    // make the builder awaitable (terminal update/delete)
    chain.then = (resolve: (v: unknown) => unknown) => {
      record()
      return resolve({ error: null })
    }
    return chain
  }
  const supabase = {
    from: (table: string) => ({
      update: (payload: unknown) => builder(table, 'update', payload),
      delete: () => builder(table, 'delete'),
      select: () => builder(table, 'select'),
      insert: async () => ({ error: null }),
    }),
  }
  return { supabase: supabase as never, calls }
}

describe('updateAppliedEntity', () => {
  it('maps action fields to the actions table (due_date → due_at)', async () => {
    const { supabase, calls } = makeStub()
    const res = await updateAppliedEntity(supabase, 'action', 'act-1', 'ws-1', {
      title: 'New title',
      due_date: '2026-07-01',
      priority: 'high',
    })
    expect(res.success).toBe(true)
    const upd = calls.find((c) => c.table === 'actions' && c.op === 'update')
    expect(upd).toBeTruthy()
    // A bare day is written at noon UTC so every zone reads the same day.
    expect(upd!.payload).toMatchObject({ title: 'New title', due_at: '2026-07-01T12:00:00.000Z', priority: 'high' })
    expect(upd!.eqs).toMatchObject({ id: 'act-1', workspace_id: 'ws-1' })
  })

  it('maps decision title/description → content and does NOT scope by workspace_id', async () => {
    const { supabase, calls } = makeStub()
    const res = await updateAppliedEntity(supabase, 'decision', 'dec-1', 'ws-1', {
      title: 'We will ship Friday',
    })
    expect(res.success).toBe(true)
    const upd = calls.find((c) => c.table === 'decision' && c.op === 'update')
    expect(upd!.payload).toMatchObject({ content: 'We will ship Friday' })
    // decision has no workspace_id column → must be scoped by id only
    expect(upd!.eqs).toMatchObject({ id: 'dec-1' })
    expect(upd!.eqs.workspace_id).toBeUndefined()
  })

  it('refuses entity types it cannot edit in place', async () => {
    const { supabase } = makeStub()
    const res = await updateAppliedEntity(supabase, 'project', 'p-1', 'ws-1', { title: 'x' })
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/cannot edit applied project/i)
  })

  it('no-op (no supplied fields) succeeds without an update call', async () => {
    const { supabase, calls } = makeStub()
    const res = await updateAppliedEntity(supabase, 'action', 'act-1', 'ws-1', {})
    expect(res.success).toBe(true)
    expect(calls.find((c) => c.op === 'update')).toBeUndefined()
  })
})

/**
 * A richer stub for applyChange dispatch tests. Records inserts/updates/upserts
 * per table and feeds back canned reads so createAction/assignAction can run.
 * `actions` inserts resolve to a fixed id so we can assert the created entity.
 */
function makeDispatchStub() {
  const calls: { table: string; op: string; payload?: unknown; eqs: Record<string, unknown> }[] = []

  function reader(table: string) {
    // Canned single-row reads keyed by table, enough for createAction's lookups.
    const single = async () => {
      if (table === 'team') return { data: { id: 'team-1', issue_prefix: 'ENG', issue_counter: 0 }, error: null }
      if (table === 'workflow_state') return { data: { id: 'state-1' }, error: null }
      return { data: null, error: null }
    }
    return single
  }

  function builder(table: string, op: string, payload?: unknown) {
    const eqs: Record<string, unknown> = {}
    const chain: Record<string, unknown> = {}
    const record = () => calls.push({ table, op, payload, eqs })
    chain.eq = () => chain
    chain.order = () => chain
    chain.limit = () => chain
    chain.select = () => chain
    chain.single = reader(table)
    chain.maybeSingle = async () => ({ data: null, error: null })
    if (op === 'insert') {
      // actions insert must return an id (createAction selects it back)
      chain.single = async () => {
        record()
        return { data: { id: 'new-action-1' }, error: null }
      }
      // some inserts aren't selected back (action_assignee/action_label) — make
      // the insert itself awaitable too.
      chain.then = (resolve: (v: unknown) => unknown) => {
        record()
        return resolve({ error: null })
      }
    } else {
      chain.then = (resolve: (v: unknown) => unknown) => {
        record()
        return resolve({ error: null })
      }
    }
    return chain
  }

  const supabase = {
    from: (table: string) => ({
      update: (payload: unknown) => builder(table, 'update', payload),
      insert: (payload: unknown) => builder(table, 'insert', payload),
      upsert: (payload: unknown) => builder(table, 'upsert', payload),
      delete: () => builder(table, 'delete'),
      select: () => builder(table, 'select'),
    }),
  }
  return { supabase: supabase as never, calls }
}

function baseChange(overrides: Partial<ProposedChange>): ProposedChange {
  return {
    id: 'pc-1',
    workspace_id: 'ws-1',
    capture_id: 'cap-1',
    change_type: 'assign',
    entity_type: 'action',
    entity_id: null,
    display_text: 'Liam to prep URL structure',
    title: 'Prep URL structure',
    description: null,
    priority: 'high',
    due_date: null,
    status_to: null,
    assignee_name: 'Liam',
    assignee_member_id: 'mem-liam',
    assignee_contact_id: null,
    team_id: null,
    project_id: null,
    labels: null,
    confidence: 0.9,
    status: 'pending',
    sort_order: 0,
    ...overrides,
  } as ProposedChange
}

describe('applyChange — targetless assign normalization', () => {
  it('applies an assign:action with no entity_id as a create (inserts an action)', async () => {
    const { supabase, calls } = makeDispatchStub()
    const res = await applyChange(supabase, baseChange({ entity_id: null }), 'ws-1', 'mem-liam', 'user-1')

    expect(res.success).toBe(true)
    // It created a new action rather than failing "Entity ID required".
    expect(res.entity_id).toBe('new-action-1')
    expect(calls.find((c) => c.table === 'actions' && c.op === 'insert')).toBeTruthy()
    // And it reports the normalization so the caller can persist change_type.
    expect(res.applied_change_type).toBe('create')
  })

  it('does NOT normalize a valid assign:action (entity_id present) — updates assignee', async () => {
    const { supabase, calls } = makeDispatchStub()
    const res = await applyChange(
      supabase,
      baseChange({ entity_id: 'act-existing' }),
      'ws-1',
      'mem-liam',
      'user-1',
    )

    expect(res.success).toBe(true)
    // Re-pointed an existing action, no normalization reported.
    expect(res.applied_change_type).toBeUndefined()
    const upd = calls.find((c) => c.table === 'actions' && c.op === 'update')
    expect(upd).toBeTruthy()
    expect(upd!.payload).toMatchObject({ assignee_id: 'mem-liam' })
    // Did not create a new action.
    expect(calls.find((c) => c.table === 'actions' && c.op === 'insert')).toBeUndefined()
  })
})

describe('deleteAppliedEntity', () => {
  it('deletes the entity for a create proposal', async () => {
    const { supabase, calls } = makeStub()
    const res = await deleteAppliedEntity(supabase, 'create', 'action', 'act-1', 'ws-1')
    expect(res.success).toBe(true)
    expect(calls.find((c) => c.table === 'actions' && c.op === 'delete')).toBeTruthy()
  })

  it('REFUSES to delete a pre-existing entity from an update proposal', async () => {
    const { supabase, calls } = makeStub()
    const res = await deleteAppliedEntity(supabase, 'update', 'action', 'act-1', 'ws-1')
    expect(res.success).toBe(false)
    expect(res.code).toBe('NOT_CREATED_BY_PROPOSAL')
    // crucially, no delete was issued against actions
    expect(calls.find((c) => c.table === 'actions' && c.op === 'delete')).toBeUndefined()
  })

  it('REFUSES to delete from an assign proposal', async () => {
    const { supabase } = makeStub()
    const res = await deleteAppliedEntity(supabase, 'assign', 'action', 'act-1', 'ws-1')
    expect(res.success).toBe(false)
    expect(res.code).toBe('NOT_CREATED_BY_PROPOSAL')
  })
})

// milestone has no workspace_id column: the reach-through edit / delete must
// fence through the project and never filter milestone by workspace_id.
describe('applied milestones (fenced through the project)', () => {
  function milestoneStub(projectWorkspace: string) {
    const { supabase, calls } = makeStub()
    const from = (supabase as unknown as { from: (t: string) => Record<string, unknown> }).from
    const wrapped = {
      from: (table: string) => {
        const base = from(table)
        if (table !== 'milestone') return base
        return {
          ...base,
          select: () => {
            const chain: Record<string, unknown> = {}
            chain.eq = () => chain
            chain.maybeSingle = async () => ({
              data: { id: 'ms-1', project: { workspace_id: projectWorkspace } },
              error: null,
            })
            return chain
          },
        }
      },
    }
    return { supabase: wrapped as never, calls }
  }

  it('edits a milestone in this workspace without a workspace_id filter', async () => {
    const { supabase, calls } = milestoneStub('ws-1')
    const res = await updateAppliedEntity(supabase, 'milestone', 'ms-1', 'ws-1', { title: 'Beta' })
    expect(res.success).toBe(true)
    const upd = calls.find((c) => c.table === 'milestone' && c.op === 'update')
    expect(upd!.payload).toMatchObject({ name: 'Beta' })
    expect(upd!.eqs).toEqual({ id: 'ms-1' })
  })

  it('refuses to edit or delete a milestone whose project is in another workspace', async () => {
    const { supabase, calls } = milestoneStub('ws-OTHER')
    expect((await updateAppliedEntity(supabase, 'milestone', 'ms-1', 'ws-1', { title: 'x' })).success).toBe(false)
    expect((await deleteAppliedEntity(supabase, 'create', 'milestone', 'ms-1', 'ws-1')).success).toBe(false)
    expect(calls.filter((c) => c.table === 'milestone')).toEqual([])
  })

  it('deletes a milestone in this workspace without a workspace_id filter', async () => {
    const { supabase, calls } = milestoneStub('ws-1')
    const res = await deleteAppliedEntity(supabase, 'create', 'milestone', 'ms-1', 'ws-1')
    expect(res.success).toBe(true)
    const del = calls.find((c) => c.table === 'milestone' && c.op === 'delete')
    expect(del!.eqs).toEqual({ id: 'ms-1' })
  })
})
