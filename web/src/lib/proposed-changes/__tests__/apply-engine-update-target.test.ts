/**
 * Apply-engine tests for two live defects (observed 2026-07-01):
 *
 * 1. update:action proposals arrive with entity_id=null essentially always
 *    (the extractor never knows the UUID), and updateAction hard-failed every
 *    accept with "Entity ID required for action update". Now the engine
 *    resolves the target by fuzzy title match at apply time and only fails —
 *    with a structured code — when no unambiguous target exists.
 *
 * 2. createAction parked every accepted proposal in the team's first
 *    "unstarted" state (Todo). Workspaces hang automations off Todo (e.g. a
 *    Todo→coding-agent webhook), so accepted extractions sat one touch away
 *    from firing an agent. Now they default to the backlog state, an explicit
 *    status_to (name, case-insensitive) wins, and unstarted remains the
 *    fallback for teams without a backlog.
 *
 * 3. an accepted update:action that MOVED the status emitted nothing, so Flows
 *    (and the Asana status echo, which rides the same event) never fired for
 *    proposal applies — the third writer that bypassed emitStatusChange.
 *
 * 4. updateAppliedEntity — the reach-through edit of an ALREADY-applied
 *    proposal — was the fourth such writer, silently setting status_id with no
 *    emit at all.
 *
 * 5. the pre-write status snapshot ignored its own read error, so a transient
 *    read failure produced an emit claiming a transition out of "no status".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ProposedChange } from '../types'

const hoisted = vi.hoisted(() => ({ emitStatusChange: vi.fn() }))
vi.mock('@/lib/flows/emit-status-change', () => ({
  emitStatusChange: hoisted.emitStatusChange,
}))

const { applyChange, updateAppliedEntity } = await import('../apply-engine')

type Call = { table: string; op: string; payload?: unknown; eqs: Record<string, unknown> }

interface StubConfig {
  /** Rows the action-target resolver's pool query returns. */
  actions?: Array<Record<string, unknown>>
  /** Rows the team's workflow_state list query returns. */
  workflowStates?: Array<Record<string, unknown>>
  /** Makes every single-row `actions` read fail (transient DB failure). */
  actionReadError?: { message: string }
}

/**
 * Chainable stub covering both handlers under test: list reads on `actions` /
 * `workflow_state` resolve to configured rows, `team` single-reads return a
 * canned team, `actions` inserts return a fixed id, and every mutation is
 * recorded with its payload + eq filters.
 */
function makeStub(cfg: StubConfig = {}) {
  const calls: Call[] = []

  function builder(table: string, op: string, payload?: unknown) {
    const eqs: Record<string, unknown> = {}
    const chain: Record<string, unknown> = {}
    const record = () => calls.push({ table, op, payload, eqs })
    chain.eq = (col: string, val: unknown) => {
      eqs[col] = val
      return chain
    }
    chain.order = () => chain
    chain.limit = () => chain
    chain.select = () => chain
    chain.single = async () => {
      if (op === 'insert') {
        record()
        return { data: { id: 'new-action-1' }, error: null }
      }
      if (table === 'team') {
        return { data: { id: 'team-1', issue_prefix: 'ENG', issue_counter: 0 }, error: null }
      }
      return { data: null, error: null }
    }
    chain.maybeSingle = async () => {
      // updateAction reads the target action's current title (rename-vs-
      // reference check) and its current status_id — serve both from the
      // configured pool by id.
      if (table === 'actions') {
        if (cfg.actionReadError) return { data: null, error: cfg.actionReadError }
        const row = (cfg.actions ?? []).find((r) => r.id === eqs.id)
        return { data: row ?? null, error: null }
      }
      // updateAppliedEntity resolves ONE state by name (updateAction lists them).
      if (table === 'workflow_state') {
        const row = (cfg.workflowStates ?? []).find((s) => s.name === eqs.name)
        return { data: row ?? null, error: null }
      }
      return { data: null, error: null }
    }
    chain.then = (resolve: (v: unknown) => unknown) => {
      record()
      if (op === 'select' && table === 'actions') {
        return resolve({ data: cfg.actions ?? [], error: null })
      }
      if (op === 'select' && table === 'workflow_state') {
        return resolve({ data: cfg.workflowStates ?? [], error: null })
      }
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

function updateChange(overrides: Partial<ProposedChange> = {}): ProposedChange {
  return {
    id: 'pc-1',
    workspace_id: 'ws-1',
    capture_id: 'cap-1',
    change_type: 'update',
    entity_type: 'action',
    entity_id: null,
    display_text: 'Bump update API docs to urgent',
    title: 'Update API docs',
    description: null,
    priority: 'urgent',
    due_date: null,
    status_to: null,
    assignee_name: null,
    assignee_member_id: null,
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

const POOL_ACTION = {
  id: 'act-9',
  title: 'Update API docs',
  identifier: 'ENG-9',
  project_id: null,
  team_id: null,
  workflow_state: { category: 'started' },
}

describe('updateAction — apply-time target resolution', () => {
  it('resolves a null entity_id by title match and applies the update to it', async () => {
    const { supabase, calls } = makeStub({ actions: [POOL_ACTION] })
    const res = await applyChange(supabase, updateChange(), 'ws-1', 'mem-1', 'user-1')

    expect(res.success).toBe(true)
    expect(res.entity_id).toBe('act-9')

    const upd = calls.find((c) => c.table === 'actions' && c.op === 'update')
    expect(upd).toBeTruthy()
    expect(upd!.eqs).toMatchObject({ id: 'act-9', workspace_id: 'ws-1' })
    expect(upd!.payload).toMatchObject({ priority: 'urgent' })

    // The resolution is persisted back onto the proposal row.
    const persisted = calls.find(
      (c) => c.table === 'proposed_change' && c.op === 'update',
    )
    expect(persisted!.payload).toMatchObject({ entity_id: 'act-9' })
    expect(persisted!.eqs).toMatchObject({ id: 'pc-1' })
  })

  it('fails with UPDATE_TARGET_UNRESOLVED (not a hard error) when nothing matches', async () => {
    const { supabase, calls } = makeStub({ actions: [] })
    const res = await applyChange(supabase, updateChange(), 'ws-1', 'mem-1', 'user-1')

    expect(res.success).toBe(false)
    expect(res.code).toBe('UPDATE_TARGET_UNRESOLVED')
    expect(res.error).toMatch(/which action/i)
    // No blind mutation was attempted.
    expect(calls.find((c) => c.table === 'actions' && c.op === 'update')).toBeUndefined()
  })

  it('refuses to guess between two equally plausible targets', async () => {
    const { supabase, calls } = makeStub({
      actions: [
        { ...POOL_ACTION, id: 'b1', title: 'Update API docs for v1' },
        { ...POOL_ACTION, id: 'b2', title: 'Update API docs for v2' },
      ],
    })
    const res = await applyChange(supabase, updateChange(), 'ws-1', 'mem-1', 'user-1')

    expect(res.success).toBe(false)
    expect(res.code).toBe('UPDATE_TARGET_UNRESOLVED')
    expect(calls.find((c) => c.table === 'actions' && c.op === 'update')).toBeUndefined()
  })

  it('treats a title that references the target as a locator, not a rename', async () => {
    // The proposal's title matched an action whose real title carries more
    // detail — applying the paraphrase as a rename would destroy it.
    const { supabase, calls } = makeStub({
      actions: [{ ...POOL_ACTION, title: 'Update API docs for launch' }],
    })
    const res = await applyChange(supabase, updateChange(), 'ws-1', 'mem-1', 'user-1')

    expect(res.success).toBe(true)
    const upd = calls.find((c) => c.table === 'actions' && c.op === 'update')
    expect(upd!.payload).toMatchObject({ priority: 'urgent' })
    expect(upd!.payload).not.toHaveProperty('title')
  })

  it('still applies a genuine rename that does not reference the current title', async () => {
    const { supabase, calls } = makeStub({ actions: [POOL_ACTION] })
    const res = await applyChange(
      supabase,
      updateChange({ entity_id: 'act-9', title: 'Ship revised onboarding guide' }),
      'ws-1',
      'mem-1',
      'user-1',
    )

    expect(res.success).toBe(true)
    const upd = calls.find((c) => c.table === 'actions' && c.op === 'update')
    expect(upd!.payload).toMatchObject({ title: 'Ship revised onboarding guide' })
  })

  it('skips resolution entirely when entity_id is already set', async () => {
    const { supabase, calls } = makeStub({
      actions: [{ id: 'act-direct', title: 'Update API docs', identifier: 'ENG-1' }],
    })
    const res = await applyChange(
      supabase,
      updateChange({ entity_id: 'act-direct' }),
      'ws-1',
      'mem-1',
      'user-1',
    )

    expect(res.success).toBe(true)
    const upd = calls.find((c) => c.table === 'actions' && c.op === 'update')
    expect(upd!.eqs).toMatchObject({ id: 'act-direct' })
    // No pool query was needed.
    expect(calls.find((c) => c.table === 'actions' && c.op === 'select')).toBeUndefined()
  })
})

// ─── createAction — workflow state defaults ──────────────────────────────────

function createChange(overrides: Partial<ProposedChange> = {}): ProposedChange {
  return updateChange({
    change_type: 'create',
    entity_id: null,
    team_id: 'team-1',
    title: 'Follow up with vendor',
    display_text: 'Liam to follow up with vendor',
    priority: 'high',
    ...overrides,
  })
}

const TEAM_STATES = [
  { id: 'st-backlog', name: 'Backlog', category: 'backlog', sort_order: 0 },
  { id: 'st-todo', name: 'Todo', category: 'unstarted', sort_order: 1 },
  { id: 'st-progress', name: 'In Progress', category: 'started', sort_order: 2 },
  { id: 'st-done', name: 'Done', category: 'completed', sort_order: 3 },
]

function insertedAction(calls: Call[]): Record<string, unknown> {
  const ins = calls.find((c) => c.table === 'actions' && c.op === 'insert')
  expect(ins).toBeTruthy()
  return ins!.payload as Record<string, unknown>
}

describe('createAction — accepted proposals land in Backlog, not Todo', () => {
  it('defaults to the backlog-category state', async () => {
    const { supabase, calls } = makeStub({ workflowStates: TEAM_STATES })
    const res = await applyChange(supabase, createChange(), 'ws-1', 'mem-1', 'user-1')

    expect(res.success).toBe(true)
    expect(insertedAction(calls).status_id).toBe('st-backlog')
  })

  it('honors an explicit status_to by name, case-insensitively', async () => {
    const { supabase, calls } = makeStub({ workflowStates: TEAM_STATES })
    const res = await applyChange(
      supabase,
      createChange({ status_to: 'in progress' }),
      'ws-1',
      'mem-1',
      'user-1',
    )

    expect(res.success).toBe(true)
    expect(insertedAction(calls).status_id).toBe('st-progress')
  })

  it('falls back to first unstarted when the team has no backlog state', async () => {
    const { supabase, calls } = makeStub({
      workflowStates: TEAM_STATES.filter((s) => s.category !== 'backlog'),
    })
    const res = await applyChange(supabase, createChange(), 'ws-1', 'mem-1', 'user-1')

    expect(res.success).toBe(true)
    expect(insertedAction(calls).status_id).toBe('st-todo')
  })

  it('falls back to the default chain when status_to names no existing state', async () => {
    const { supabase, calls } = makeStub({ workflowStates: TEAM_STATES })
    const res = await applyChange(
      supabase,
      createChange({ status_to: 'Not A Real State' }),
      'ws-1',
      'mem-1',
      'user-1',
    )

    expect(res.success).toBe(true)
    expect(insertedAction(calls).status_id).toBe('st-backlog')
  })
})

/**
 * The status-change trigger is the single event every status writer funnels
 * through (GEN-112). updateAction was the last one that didn't — an accepted
 * "move it to Done" proposal wrote the status and fired nothing.
 */
describe('updateAction — emits the status-change trigger', () => {
  beforeEach(() => {
    hoisted.emitStatusChange.mockReset()
  })

  it('emits with the resolved from→to ids when the apply moved the status', async () => {
    const { supabase } = makeStub({
      actions: [{ ...POOL_ACTION, id: 'act-9', status_id: 'st-todo' }],
      workflowStates: TEAM_STATES,
    })

    const res = await applyChange(
      supabase,
      updateChange({ entity_id: 'act-9', title: null, status_to: 'Done', team_id: 'team-1' }),
      'ws-1',
      'mem-1',
      'user-1',
    )

    expect(res.success).toBe(true)
    expect(hoisted.emitStatusChange).toHaveBeenCalledTimes(1)
    expect(hoisted.emitStatusChange).toHaveBeenCalledWith({
      entityType: 'action',
      entityId: 'act-9',
      workspaceId: 'ws-1',
      teamId: 'team-1',
      fromStatusId: 'st-todo',
      toStatusId: 'st-done',
      // The auth.users id, NOT the workspace-scoped member id.
      actorUserId: 'user-1',
    })
  })

  it('does NOT emit when the apply changed no status', async () => {
    const { supabase } = makeStub({ actions: [POOL_ACTION], workflowStates: TEAM_STATES })
    const res = await applyChange(
      supabase,
      updateChange({ entity_id: 'act-9' }),
      'ws-1',
      'mem-1',
      'user-1',
    )

    expect(res.success).toBe(true)
    expect(hoisted.emitStatusChange).not.toHaveBeenCalled()
  })

  it('does NOT emit when status_to names no state on the team', async () => {
    const { supabase } = makeStub({
      actions: [{ ...POOL_ACTION, id: 'act-9', status_id: 'st-todo' }],
      workflowStates: TEAM_STATES,
    })
    const res = await applyChange(
      supabase,
      updateChange({
        entity_id: 'act-9',
        title: null,
        status_to: 'Not A Real State',
        team_id: 'team-1',
        priority: 'urgent',
      }),
      'ws-1',
      'mem-1',
      'user-1',
    )

    expect(res.success).toBe(true)
    expect(hoisted.emitStatusChange).not.toHaveBeenCalled()
  })

  it('does NOT emit when the caller supplied no userId to attribute', async () => {
    const { supabase } = makeStub({
      actions: [{ ...POOL_ACTION, id: 'act-9', status_id: 'st-todo' }],
      workflowStates: TEAM_STATES,
    })
    const res = await applyChange(
      supabase,
      updateChange({ entity_id: 'act-9', title: null, status_to: 'Done', team_id: 'team-1' }),
      'ws-1',
      'mem-1',
    )

    expect(res.success).toBe(true)
    expect(hoisted.emitStatusChange).not.toHaveBeenCalled()
  })

  /**
   * The snapshot read feeds `fromStatusId`. Swallowing its error defaults that
   * to null, which the emit reads as a genuine transition out of "no status" —
   * firing from-scoped Flows that should never have matched. A read failure is
   * a failed apply, exactly like a failed write.
   */
  it('FAILS the apply when the pre-write status snapshot read errors — no from:null emit', async () => {
    const { supabase, calls } = makeStub({
      actions: [{ ...POOL_ACTION, id: 'act-9', status_id: 'st-todo' }],
      workflowStates: TEAM_STATES,
      actionReadError: { message: 'read timeout' },
    })

    const res = await applyChange(
      supabase,
      updateChange({ entity_id: 'act-9', title: null, status_to: 'Done', team_id: 'team-1' }),
      'ws-1',
      'mem-1',
      'user-1',
    )

    expect(res.success).toBe(false)
    expect(res.error).toBe('read timeout')
    expect(hoisted.emitStatusChange).not.toHaveBeenCalled()
    // And the action itself was left alone.
    expect(calls.find((c) => c.table === 'actions' && c.op === 'update')).toBeUndefined()
  })
})

/**
 * The reach-through edit path (the proposal card's property pills after
 * auto-accept, and the live agent's edit_proposal on an applied proposal). It
 * writes actions.status_id directly and was the last status writer with no
 * emit — the same defect this changeset fixed in updateAction and the bulk route.
 */
describe('updateAppliedEntity — emits the status-change trigger', () => {
  beforeEach(() => {
    hoisted.emitStatusChange.mockReset()
  })

  it('emits with the resolved from→to ids when a reach-through edit moves the status', async () => {
    const { supabase, calls } = makeStub({
      actions: [{ ...POOL_ACTION, id: 'act-9', status_id: 'st-todo', team_id: 'team-1' }],
      workflowStates: TEAM_STATES,
    })

    const res = await updateAppliedEntity(
      supabase,
      'action',
      'act-9',
      'ws-1',
      { status_to: 'Done', team_id: 'team-1' },
      'user-1',
    )

    expect(res.success).toBe(true)
    const upd = calls.find((c) => c.table === 'actions' && c.op === 'update')
    expect(upd!.payload).toMatchObject({ status_id: 'st-done' })

    expect(hoisted.emitStatusChange).toHaveBeenCalledTimes(1)
    expect(hoisted.emitStatusChange).toHaveBeenCalledWith({
      entityType: 'action',
      entityId: 'act-9',
      workspaceId: 'ws-1',
      teamId: 'team-1',
      fromStatusId: 'st-todo',
      toStatusId: 'st-done',
      actorUserId: 'user-1',
    })
  })

  it('resolves the team from the action when the caller supplies none', async () => {
    const { supabase } = makeStub({
      actions: [{ ...POOL_ACTION, id: 'act-9', status_id: 'st-todo', team_id: 'team-7' }],
      workflowStates: TEAM_STATES,
    })

    await updateAppliedEntity(supabase, 'action', 'act-9', 'ws-1', { status_to: 'Done' }, 'user-1')

    expect(hoisted.emitStatusChange).toHaveBeenCalledWith(
      expect.objectContaining({ teamId: 'team-7', fromStatusId: 'st-todo' }),
    )
  })

  it('does NOT emit for an edit that changed no status', async () => {
    const { supabase } = makeStub({
      actions: [{ ...POOL_ACTION, id: 'act-9', status_id: 'st-todo', team_id: 'team-1' }],
      workflowStates: TEAM_STATES,
    })
    const res = await updateAppliedEntity(supabase, 'action', 'act-9', 'ws-1', {
      priority: 'urgent',
    })
    expect(res.success).toBe(true)
    expect(hoisted.emitStatusChange).not.toHaveBeenCalled()
  })

  it('does NOT emit when the caller supplied no userId to attribute', async () => {
    const { supabase } = makeStub({
      actions: [{ ...POOL_ACTION, id: 'act-9', status_id: 'st-todo', team_id: 'team-1' }],
      workflowStates: TEAM_STATES,
    })
    const res = await updateAppliedEntity(supabase, 'action', 'act-9', 'ws-1', {
      status_to: 'Done',
      team_id: 'team-1',
    })
    expect(res.success).toBe(true)
    expect(hoisted.emitStatusChange).not.toHaveBeenCalled()
  })

  it('FAILS the edit when the pre-write status snapshot read errors', async () => {
    const { supabase, calls } = makeStub({
      actions: [{ ...POOL_ACTION, id: 'act-9', status_id: 'st-todo', team_id: 'team-1' }],
      workflowStates: TEAM_STATES,
      actionReadError: { message: 'read timeout' },
    })
    const res = await updateAppliedEntity(
      supabase,
      'action',
      'act-9',
      'ws-1',
      { status_to: 'Done', team_id: 'team-1' },
      'user-1',
    )
    expect(res.success).toBe(false)
    expect(res.error).toBe('read timeout')
    expect(hoisted.emitStatusChange).not.toHaveBeenCalled()
    expect(calls.find((c) => c.table === 'actions' && c.op === 'update')).toBeUndefined()
  })
})

describe('applyChange — target-less assign of a non-action entity normalizes to create:action', () => {
  it('applies assign:contact with no entity_id as a created action and reports both rewrites', async () => {
    // Prod, capture 3261a80c: "Connect with Nikhil's son about cofounder
    // opportunity" was staged as assign:contact with entity_id=null and
    // dead-ended on "Unsupported: assign contact". It is a task for the
    // assignee — create the action and tell the caller to persist
    // change_type=create AND entity_type=action on the row.
    const { supabase, calls } = makeStub({ workflowStates: TEAM_STATES })
    const res = await applyChange(
      supabase,
      createChange({
        change_type: 'assign',
        entity_type: 'contact',
        entity_id: null,
        title: "Connect with Nikhil's son about cofounder opportunity",
        assignee_member_id: 'mem-1',
      }),
      'ws-1',
      'mem-1',
      'user-1',
    )

    expect(res.success).toBe(true)
    expect(res.entity_id).toBe('new-action-1')
    expect(res.applied_change_type).toBe('create')
    expect(res.applied_entity_type).toBe('action')
    expect(insertedAction(calls).title).toBe("Connect with Nikhil's son about cofounder opportunity")
  })

  it('reports only applied_change_type for a target-less assign:action (entity_type unchanged)', async () => {
    const { supabase } = makeStub({ workflowStates: TEAM_STATES })
    const res = await applyChange(
      supabase,
      createChange({ change_type: 'assign', entity_type: 'action', entity_id: null }),
      'ws-1',
      'mem-1',
      'user-1',
    )

    expect(res.success).toBe(true)
    expect(res.applied_change_type).toBe('create')
    expect(res.applied_entity_type).toBeUndefined()
  })

  it('still refuses a TARGETED assign:contact (a real row it cannot re-point)', async () => {
    const { supabase } = makeStub({ workflowStates: TEAM_STATES })
    const res = await applyChange(
      supabase,
      createChange({ change_type: 'assign', entity_type: 'contact', entity_id: 'contact-1' }),
      'ws-1',
      'mem-1',
      'user-1',
    )

    expect(res.success).toBe(false)
    expect(res.error).toBe('Unsupported change: assign:contact')
  })
})
