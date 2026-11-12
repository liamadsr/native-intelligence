/**
 * The deal tools over pipeline tables (Tables, phase 7): the same names,
 * inputs and answers as before, now wrappers over row ops. Every write is
 * one apply_data_ops batch naming the person, with the `because` source and
 * reason; private pipelines are fenced; a pipeline reached only through a
 * grant changes only on the person's own attended turn. Made-up data only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ hiddenTables: new Set<string>(), grantOnly: new Set<string>(), rows: null as null | Record<string, Array<Record<string, unknown>>> }))

vi.mock('@/lib/knowledge/entity-fences', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/knowledge/entity-fences')>()
  return {
    ...real,
    visiblePrivateKindIds: async (_db: unknown, _kind: string, _user: string, ids: string[], _ws: string, opts: { grants?: boolean } = {}) =>
      new Set(ids.filter((id) => !state.hiddenTables.has(id) && (opts.grants !== false || !state.grantOnly.has(id)))),
  }
})
vi.mock('@/lib/crm/contact-visibility', () => ({
  isCompanyVisibleTo: async () => true,
  filterVisibleCompanies: async (_db: unknown, _u: string, rows: unknown[]) => rows,
  filterVisibleContacts: async (_db: unknown, _u: string, rows: unknown[]) => rows,
}))
vi.mock('../_shared', async (importOriginal) => {
  const real = await importOriginal<typeof import('../_shared')>()
  return {
    ...real,
    resolveCreateWorkspace: async () => ({ ok: true, workspaceId: WS, workspaceName: 'Fernhill Studio' }),
    resolveEntityWorkspace: async (_db: unknown, _u: string, table: string, id: string) =>
      table === 'data_row' && state.rows?.data_row.some((r) => r.id === id) ? { workspaceId: WS, crossWorkspace: false } : null,
  }
})

import { createDealTools, DEAL_TOOL_NAMES } from '../deals'
import { getToolDefinition } from '../../tool-registry'
import { withToolGuide, MAX_ADVERTISED_DESCRIPTION } from '../../tool-guides'
import { fakePipelineDb, pipelineRows } from '@/lib/crm/__tests__/fake-pipeline-db'

const WS = '00000000-0000-4000-8000-000000000001'
const SALES = '00000000-0000-4000-8000-0000000000a1'
const SECRET = '00000000-0000-4000-8000-0000000000a3'
const SHARED = '00000000-0000-4000-8000-0000000000a4'
const USER = '00000000-0000-4000-8000-0000000000d1'
const MEMBER = '00000000-0000-4000-8000-0000000000c1'
const COMPANY = '00000000-0000-4000-8000-0000000000e1'

type Exec = { execute: (input: unknown, ctx: unknown) => Promise<Record<string, unknown>> }

function seed() {
  state.hiddenTables = new Set([SECRET])
  state.grantOnly = new Set([SHARED])
  const sales = pipelineRows({ id: SALES, workspaceId: WS, name: 'Sales', isDefault: true })
  const secret = pipelineRows({ id: SECRET, workspaceId: WS, name: 'Hiring', position: 1, visibility: 'private' })
  const shared = pipelineRows({ id: SHARED, workspaceId: WS, name: 'Shared partners', position: 2, visibility: 'private' })
  const db = fakePipelineDb({
    data_table: [sales.table, secret.table, shared.table],
    custom_field_definition: [...sales.columns, ...secret.columns, ...shared.columns],
    data_row: [],
    data_change: [],
    member: [{ id: MEMBER, workspace_id: WS, user_id: USER, display_name: 'Avery Example', role: 'member' }],
    company: [{ id: COMPANY, workspace_id: WS, name: 'Northwind Example' }],
    contact: [],
    entity_link: [],
  })
  state.rows = db.rows
  return db
}

let db: ReturnType<typeof seed>
const tools = (opts: { editGrants?: boolean; omitGrants?: boolean } = {}) =>
  createDealTools(USER, db.client, WS, false, 'session', !!opts.editGrants, !!opts.omitGrants) as unknown as Record<string, Exec>
const run = (name: string, input: unknown, opts?: { editGrants?: boolean; omitGrants?: boolean }) => tools(opts)[name].execute(input, {})

beforeEach(() => {
  db = seed()
})

describe('the deal tools, registered', () => {
  const all = createDealTools('u1', {} as never, 'w1')

  it('each is registered in the CRM category with the right side effect', () => {
    expect(Object.keys(all).sort()).toEqual([...DEAL_TOOL_NAMES].sort())
    for (const name of DEAL_TOOL_NAMES) {
      const def = getToolDefinition(name)
      expect(def, name).toBeDefined()
      expect(def!.sideEffect, name).toBe(name === 'find_deals' || name === 'get_deal' ? 'read' : 'internal-write')
    }
  })

  it('no description is over what OpenAI takes', () => {
    for (const [name, t] of Object.entries(all)) {
      expect(withToolGuide(name, (t as { description?: string }).description ?? '').length, name).toBeLessThanOrEqual(MAX_ADVERTISED_DESCRIPTION)
    }
  })

  it('tells the agent to apply with undo, never to ask first', () => {
    const update = (all.update_deal as { description?: string }).description ?? ''
    expect(update).toContain('update it directly')
    expect(update).toContain('they can undo it')
    expect(update).toContain("Don't ask first")
  })

  it('custom fields still take deals', () => {
    expect((all.define_custom_field as { description?: string }).description).toContain('and deals')
    expect((all.set_custom_fields as { description?: string }).description).toContain('or deal')
  })
})

describe('the deal tools, over pipeline rows', () => {
  it('create_deal writes one batch naming the person, with the because source and reason', async () => {
    const r = await run('create_deal', { name: 'Northwind website', value: 12500, company_id: COMPANY, because: { source: 'email', ref: 'thread-1', reason: 'Dana asked for a quote' } })
    expect(r).toMatchObject({ success: true, message: 'Created deal "Northwind website" in Lead.' })
    expect(r.deal).toMatchObject({ name: 'Northwind website', pipeline: 'Sales', stage: 'Lead', status: 'open', value: 12500, value_label: '$12,500', company: 'Northwind Example' })
    const call = db.rpcCalls.find((c) => c.name === 'apply_data_ops')!
    expect(call.args).toMatchObject({ p_table_id: SALES, p_source: 'email', p_reason: 'Dana asked for a quote', p_as_user: USER })
    expect(db.rows.data_row[0].custom_fields).toMatchObject({ owner: MEMBER })
  })

  it('find_deals reads only the pipelines the person can see, and lists their stages', async () => {
    await run('create_deal', { name: 'Visible' })
    db.rows.data_row.push({ id: '00000000-0000-4000-8000-00000000bbbb', workspace_id: WS, table_id: SECRET, title: 'Secret hire', custom_fields: { stage: 'Lead' }, archived_at: null, updated_at: 'z' })
    const r = await run('find_deals', {})
    expect((r.deals as Array<{ name: string }>).map((d) => d.name)).toEqual(['Visible'])
    expect((r.pipelines as Array<{ pipeline: string }>).map((p) => p.pipeline)).toEqual(['Sales', 'Shared partners'])
    expect(await run('get_deal', { deal_id: '00000000-0000-4000-8000-00000000bbbb' })).toEqual({ success: false, error: 'Deal not found' })
  })

  it('update_deal, move_deal and get_deal: the change in words, its id, and the history', async () => {
    const c = await run('create_deal', { name: 'A', value: 100 })
    const id = (c.deal as { id: string }).id
    const u = await run('update_deal', { deal_id: id, value: 250, because: { source: 'meeting', reason: 'Raised on the call' } })
    expect(u).toMatchObject({ success: true, changed: ['value: $100 → $250'], message: 'Updated "A": value: $100 → $250. The person can undo it.' })
    const m = await run('move_deal', { deal_id: id, stage: 'won', because: { source: 'text', reason: 'Signed by text' } })
    expect(m).toMatchObject({ success: true, changed: ['stage: Lead → Won'] })
    expect(db.rpcCalls.filter((x) => x.name === 'apply_data_ops').map((x) => x.args.p_source)).toEqual(['agent', 'capture', 'sms'])
    const again = await run('move_deal', { deal_id: id, stage: 'Won' })
    expect(again).toMatchObject({ success: true, message: 'It was already there.' })
    const g = await run('get_deal', { deal_id: id })
    expect((g.history as Array<{ kind: string; what: string[]; source: string; reason: string | null }>).map((h) => [h.kind, h.what.join('; '), h.source, h.reason])).toEqual([
      ['moved', 'stage: Lead → Won', 'sms', 'Signed by text'],
      ['updated', 'value: $100 → $250', 'capture', 'Raised on the call'],
      ['created', '', 'agent', null],
    ])
  })

  it('undo_deal_change takes back the latest change', async () => {
    const c = await run('create_deal', { name: 'A' })
    const id = (c.deal as { id: string }).id
    await run('move_deal', { deal_id: id, stage: 'Proposal' })
    const u = await run('undo_deal_change', { deal_id: id })
    expect(u).toMatchObject({ success: true })
    expect(db.rows.data_row[0].custom_fields).toMatchObject({ stage: 'Lead' })
    expect(await run('undo_deal_change', { deal_id: id })).toMatchObject({ success: false })
  })

  it('a pipeline reached only through a grant changes only on the person’s own attended turn', async () => {
    db.rows.data_row.push({ id: '00000000-0000-4000-8000-00000000cccc', workspace_id: WS, table_id: SHARED, title: 'Shared deal', custom_fields: { stage: 'Lead' }, archived_at: null, created_at: 'a', updated_at: 'a' })
    expect(await run('move_deal', { deal_id: '00000000-0000-4000-8000-00000000cccc', stage: 'Won' })).toEqual({ success: false, error: 'You can view that deal but not change it here.' })
    expect(await run('move_deal', { deal_id: '00000000-0000-4000-8000-00000000cccc', stage: 'Won' }, { editGrants: true })).toMatchObject({ success: true })
    // A guest's turn: the shared pipeline is not there at all.
    expect(await run('get_deal', { deal_id: '00000000-0000-4000-8000-00000000cccc' }, { omitGrants: true })).toEqual({ success: false, error: 'Deal not found' })
  })

  it('define_custom_field for deals adds a column to each pipeline the person may change, once', async () => {
    const r = await run('define_custom_field', { entity_type: 'deal', label: 'Contract length', field_type: 'number' })
    expect(r).toMatchObject({ success: true, message: 'Added "Contract length" to deals.', field: { key: 'contract_length', field_type: 'number' } })
    const made = db.rows.custom_field_definition.filter((c) => c.label === 'Contract length').map((c) => c.table_id)
    expect(made).toEqual([SALES])
    expect(await run('define_custom_field', { entity_type: 'deal', label: 'Contract length', field_type: 'number' })).toMatchObject({ success: true, message: '"Contract length" already exists.' })
  })

  it('set_custom_fields on a deal is an undoable deal change, and lists the fields when a name is unknown', async () => {
    await run('define_custom_field', { entity_type: 'deal', label: 'Contract length', field_type: 'number' })
    const c = await run('create_deal', { name: 'A' })
    const id = (c.deal as { id: string }).id
    const s = await run('set_custom_fields', { entity_type: 'deal', id, values: { 'Contract length': 12 } })
    expect(s).toMatchObject({ success: true, custom_fields: { contract_length: 12 } })
    expect(typeof s.change_id).toBe('string')
    const bad = await run('set_custom_fields', { entity_type: 'deal', id, values: { Nope: 1 } })
    expect(bad).toMatchObject({ success: false, fields: [{ label: 'Contract length', field_type: 'number' }] })
  })
})
