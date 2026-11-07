/**
 * Contact (external CRM) assignees across the three action write sites.
 *
 *   create:action — `assignee_contact_id` is a real top-level column on the
 *                   insert (one source of truth), NOT a `context_data` key.
 *   update:action — a contact-only assignee sets the column, nulls the member
 *                   assignee and clears the `action_assignee` join rows.
 *   assign:action — a contact-only assignee succeeds (no "member ID required"
 *                   hard-fail); a member assignee still works and nulls the
 *                   contact column; only members get an `action_assignee` row.
 *
 * Stub mirrors the call-recorder in apply-engine-decision-contact-milestone.
 */
import { describe, it, expect } from 'vitest'
import { applyChange } from '../apply-engine'
import type { ProposedChange } from '../types'

type Call = { table: string; op: string; payload?: unknown; eqs: Record<string, unknown> }

/**
 * Chainable Supabase stub. Every mutation is recorded with its payload + eq
 * filters. Reads resolve empty/null so createAction skips team/status/identifier
 * resolution (team_id stays null) and updateAction's optional reads no-op.
 */
function makeStub() {
  const calls: Call[] = []

  function builder(table: string, op: string, payload?: unknown) {
    const eqs: Record<string, unknown> = {}
    const chain: Record<string, unknown> = {}
    const record = () => calls.push({ table, op, payload, eqs })
    chain.eq = (col: string, val: unknown) => {
      eqs[col] = val
      return chain
    }
    chain.is = () => chain
    chain.or = () => chain
    chain.order = () => chain
    chain.limit = () => chain
    chain.select = () => chain
    chain.single = async () => {
      if (op === 'insert') {
        record()
        return { data: { id: `new-${table}-1` }, error: null }
      }
      return { data: null, error: null }
    }
    // updateAction fences a proposal-supplied entity_id to the workspace:
    // every action id read here exists in this workspace, except 'act-foreign'.
    chain.maybeSingle = async () =>
      table === 'actions' && eqs.id && eqs.id !== 'act-foreign'
        ? { data: { id: eqs.id }, error: null }
        : { data: null, error: null }
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
    status_from: null,
    status_to: null,
    assignee_name: null,
    assignee_member_id: null,
    assignee_contact_id: null,
    team_id: null,
    project_id: null,
    labels: null,
    email_to_name: null,
    email_to_address: null,
    email_subject: null,
    email_context: null,
    extra: null,
    anchor_text: null,
    sort_order: 0,
    confidence: 0.9,
    trigger_quote: null,
    reasoning: null,
    stakes: null,
    open_questions: null,
    status: 'pending',
    applied_at: null,
    applied_by: null,
    result_entity_id: null,
    error_message: null,
    created_at: '',
    updated_at: '',
    ...overrides,
  } as ProposedChange
}

const CONTACT = 'contact-ext-1'
const MEMBER = 'member-1'

// ─── create:action ───────────────────────────────────────────────────────────

describe('create:action with a contact assignee', () => {
  it('writes assignee_contact_id as a top-level column, not in context_data', async () => {
    const { supabase, calls } = makeStub()
    const res = await applyChange(
      supabase,
      change({ assignee_contact_id: CONTACT, assignee_name: 'Priya Raman' }),
      'ws-1',
      MEMBER,
      'user-1',
    )
    expect(res.success).toBe(true)

    const insert = calls.find((c) => c.table === 'actions' && c.op === 'insert')
    expect(insert).toBeDefined()
    const payload = insert!.payload as Record<string, unknown>
    expect(payload.assignee_contact_id).toBe(CONTACT)
    expect(payload.assignee_id).toBeNull()
    const ctx = payload.context_data as Record<string, unknown>
    expect(ctx).not.toHaveProperty('assignee_contact_id')
    // original_owner stays — captures.ts reads it.
    expect(ctx.original_owner).toBe('Priya Raman')

    // Contacts never get an action_assignee join row.
    expect(calls.some((c) => c.table === 'action_assignee')).toBe(false)
  })

  it('prefers a member assignee and nulls the contact column', async () => {
    const { supabase, calls } = makeStub()
    const res = await applyChange(
      supabase,
      change({ assignee_member_id: MEMBER, assignee_contact_id: CONTACT }),
      'ws-1',
      MEMBER,
    )
    expect(res.success).toBe(true)
    const payload = calls.find((c) => c.table === 'actions' && c.op === 'insert')!
      .payload as Record<string, unknown>
    expect(payload.assignee_id).toBe(MEMBER)
    expect(payload.assignee_contact_id).toBeNull()
  })
})

// ─── update:action ───────────────────────────────────────────────────────────

describe('update:action with a contact-only assignee', () => {
  it('sets assignee_contact_id, nulls assignee_id and clears action_assignee', async () => {
    const { supabase, calls } = makeStub()
    const res = await applyChange(
      supabase,
      change({
        change_type: 'update',
        entity_id: 'act-1',
        title: null,
        assignee_contact_id: CONTACT,
      }),
      'ws-1',
      MEMBER,
    )
    expect(res).toMatchObject({ success: true, entity_id: 'act-1' })

    const upd = calls.find((c) => c.table === 'actions' && c.op === 'update')
    expect(upd).toBeDefined()
    expect(upd!.payload).toMatchObject({ assignee_contact_id: CONTACT, assignee_id: null })
    expect(upd!.eqs).toMatchObject({ id: 'act-1', workspace_id: 'ws-1' })

    const del = calls.find((c) => c.table === 'action_assignee' && c.op === 'delete')
    expect(del).toBeDefined()
    expect(del!.eqs.action_id).toBe('act-1')
    expect(calls.some((c) => c.table === 'action_assignee' && c.op === 'insert')).toBe(false)
  })

  it('refuses an entity_id outside the workspace before touching action_assignee', async () => {
    const { supabase, calls } = makeStub()
    const res = await applyChange(
      supabase,
      change({ change_type: 'update', entity_id: 'act-foreign', title: null, assignee_member_id: MEMBER }),
      'ws-1',
      MEMBER,
    )
    expect(res.success).toBe(false)
    expect(calls.some((c) => c.table === 'action_assignee')).toBe(false)
    expect(calls.some((c) => c.table === 'actions' && c.op === 'update')).toBe(false)
  })

  it('member assignee still wins and nulls the contact column', async () => {
    const { supabase, calls } = makeStub()
    const res = await applyChange(
      supabase,
      change({
        change_type: 'update',
        entity_id: 'act-1',
        title: null,
        assignee_member_id: MEMBER,
        assignee_contact_id: CONTACT,
      }),
      'ws-1',
      MEMBER,
    )
    expect(res.success).toBe(true)
    const upd = calls.find((c) => c.table === 'actions' && c.op === 'update')!
    expect(upd.payload).toMatchObject({ assignee_id: MEMBER, assignee_contact_id: null })
    expect(calls.some((c) => c.table === 'action_assignee' && c.op === 'insert')).toBe(true)
  })
})

// ─── assign:action ───────────────────────────────────────────────────────────

describe('assign:action', () => {
  it('succeeds with a contact-only assignee (no member ID required)', async () => {
    const { supabase, calls } = makeStub()
    const res = await applyChange(
      supabase,
      change({ change_type: 'assign', entity_id: 'act-1', assignee_contact_id: CONTACT }),
      'ws-1',
      MEMBER,
    )
    expect(res).toMatchObject({ success: true, entity_id: 'act-1' })

    const upd = calls.find((c) => c.table === 'actions' && c.op === 'update')!
    expect(upd.payload).toEqual({ assignee_id: null, assignee_contact_id: CONTACT })
    expect(upd.eqs).toMatchObject({ id: 'act-1', workspace_id: 'ws-1' })
    // No join row for a contact.
    expect(calls.some((c) => c.table === 'action_assignee')).toBe(false)
  })

  it('member assignee still works and nulls the contact column + upserts the join row', async () => {
    const { supabase, calls } = makeStub()
    const res = await applyChange(
      supabase,
      change({ change_type: 'assign', entity_id: 'act-1', assignee_member_id: MEMBER }),
      'ws-1',
      MEMBER,
    )
    expect(res).toMatchObject({ success: true, entity_id: 'act-1' })
    const upd = calls.find((c) => c.table === 'actions' && c.op === 'update')!
    expect(upd.payload).toEqual({ assignee_id: MEMBER, assignee_contact_id: null })
    const up = calls.find((c) => c.table === 'action_assignee' && c.op === 'upsert')
    expect(up).toBeDefined()
    expect(up!.payload).toEqual({ action_id: 'act-1', member_id: MEMBER })
  })

  it('fails clearly when neither member nor contact is set', async () => {
    const { supabase } = makeStub()
    const res = await applyChange(
      supabase,
      change({ change_type: 'assign', entity_id: 'act-1' }),
      'ws-1',
      MEMBER,
    )
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/member ID or contact ID required/i)
  })
})
