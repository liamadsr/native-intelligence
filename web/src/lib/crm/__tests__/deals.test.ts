/**
 * Deals over pipeline tables (Tables, phase 7): a deal is a pipeline's row,
 * read as a Deal and written as one batch of row ops (apply_data_ops), so
 * its history and undo are the table's. Made-up fixtures only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const hidden = vi.hoisted(() => new Set<string>())
vi.mock('../contact-visibility', () => ({
  isCompanyVisibleTo: async (_db: unknown, id: string) => !hidden.has(id),
  filterVisibleCompanies: async (_db: unknown, _u: string, rows: Array<{ id: string }>) => rows.filter((r) => !hidden.has(r.id)),
  filterVisibleContacts: async (_db: unknown, _u: string, rows: Array<{ id: string }>) => rows.filter((r) => !hidden.has(r.id)),
}))

import {
  createDeal,
  createPipeline,
  dealsLinkedTo,
  describeChanges,
  findDeals,
  getDeal,
  listDealEvents,
  listPipelines,
  matchStage,
  rowToDeal,
  undoDealChange,
  updateDeal,
} from '../deals'
import { fakePipelineDb, pipelineRows } from './fake-pipeline-db'

const WS = '00000000-0000-4000-8000-000000000001'
const SALES = '00000000-0000-4000-8000-0000000000a1'
const PARTNERS = '00000000-0000-4000-8000-0000000000a2'
const MEMBER = '00000000-0000-4000-8000-0000000000c1'
const USER = '00000000-0000-4000-8000-0000000000d1'
const COMPANY = '00000000-0000-4000-8000-0000000000e1'
const OTHER_COMPANY = '00000000-0000-4000-8000-0000000000e2'
const CONTACT_A = '00000000-0000-4000-8000-0000000000f1'
const CONTACT_B = '00000000-0000-4000-8000-0000000000f2'

const actor = { userId: USER, source: 'agent' as const, reason: 'Dana wrote that they signed' }

function seed(opts: { valueRule?: boolean } = {}) {
  hidden.clear()
  const sales = pipelineRows({
    id: SALES,
    workspaceId: WS,
    name: 'Sales',
    isDefault: true,
    ...(opts.valueRule ? { valueRule: { key: 'stage', option: 'Won' } } : {}),
    extraColumns: [
      {
        id: 'tier',
        workspace_id: WS,
        entity_type: 'data_row',
        table_id: SALES,
        key: 'tier',
        label: 'Tier',
        field_type: 'select',
        options: ['Gold', 'Silver'],
        config: {},
        position: 7,
        deleted_at: null,
        system: false,
      },
    ],
  })
  const partners = pipelineRows({ id: PARTNERS, workspaceId: WS, name: 'Partnerships', position: 1, stages: [['Talking', 'open'], ['Signed', 'won']] })
  return fakePipelineDb({
    data_table: [sales.table, partners.table],
    custom_field_definition: [...sales.columns, ...partners.columns],
    data_row: [],
    data_change: [],
    member: [{ id: MEMBER, workspace_id: WS, user_id: USER, display_name: 'Avery Example', role: 'member' }],
    company: [
      { id: COMPANY, workspace_id: WS, name: 'Northwind Example' },
      { id: OTHER_COMPANY, workspace_id: WS, name: 'Hidden Example' },
    ],
    contact: [
      { id: CONTACT_A, workspace_id: WS, full_name: 'Dana Example', email: 'dana@example.com' },
      { id: CONTACT_B, workspace_id: WS, full_name: 'Sam Example', email: 'sam@example.com' },
    ],
    entity_link: [],
  })
}

let db: ReturnType<typeof seed>
beforeEach(() => {
  db = seed()
})

describe('pipelines', () => {
  it('lists the default first, with each stage and its outcome, making the default for the person', async () => {
    const pipelines = await listPipelines(db.client, WS, { viewer: USER })
    expect(pipelines.map((p) => p.name)).toEqual(['Sales', 'Partnerships'])
    expect(pipelines[0].stages.map((s) => `${s.name}:${s.kind}`)).toEqual(['Lead:open', 'Qualified:open', 'Proposal:open', 'Won:won', 'Lost:lost'])
    expect(db.rpcCalls[0]).toEqual({ name: 'ensure_default_pipeline', args: { p_workspace_id: WS, p_as_user: USER } })
  })

  it('leaves out the pipelines a fence says the person may not read', async () => {
    const pipelines = await listPipelines(db.client, WS, { readable: async (ids) => new Set(ids.filter((id) => id !== PARTNERS)) })
    expect(pipelines.map((p) => p.id)).toEqual([SALES])
  })

  it('matches a stage the way a person names it', async () => {
    const [sales] = await listPipelines(db.client, WS)
    expect(matchStage(sales.stages, 'won')?.name).toBe('Won')
    expect(matchStage(sales.stages, 'closed won')?.name).toBe('Won')
    expect(matchStage(sales.stages, 'prop')?.name).toBe('Proposal')
    expect(matchStage(sales.stages, 'nope')).toBeNull()
  })

  it('makes a new pipeline through create_pipeline, its stages cleaned', async () => {
    const made = await createPipeline(db.client, WS, { name: ' Renewals ', stages: [{ name: 'Due' }, { name: 'due' }, { name: 'Renewed', outcome: 'won' }] }, { userId: USER, source: 'person' })
    expect(made).toEqual({ ok: true, id: 'new-pipeline' })
    const call = db.rpcCalls.find((c) => c.name === 'create_pipeline')!
    expect(call.args).toMatchObject({ p_workspace_id: WS, p_name: 'Renewals', p_source: 'person', p_default: false, p_currency: 'USD' })
    expect(call.args.p_stages).toEqual([{ name: 'Due', outcome: 'open' }, { name: 'Renewed', outcome: 'won' }])
    expect((await createPipeline(db.client, WS, { name: '  ' }, { userId: USER, source: 'person' })).ok).toBe(false)
  })
})

describe('writing a deal', () => {
  it('creates one in the default pipeline’s first stage, owned by the person, in one logged batch', async () => {
    const r = await createDeal(db.client, WS, { name: 'Northwind website', value: 12500, company_id: COMPANY, contact_ids: [CONTACT_A] }, actor, { viewer: USER })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.deal).toMatchObject({ pipeline_id: SALES, name: 'Northwind website', stage: 'Lead', status: 'open', value: 12500, currency: 'USD', company_id: COMPANY, contact_ids: [CONTACT_A], owner_id: MEMBER })
    const row = db.rows.data_row[0]
    expect(row.custom_fields).toEqual({ stage: 'Lead', value: { amount: 12500, currency: 'USD' }, company: [COMPANY], contacts: [CONTACT_A], owner: MEMBER })
    const call = db.rpcCalls.find((c) => c.name === 'apply_data_ops')!
    expect(call.args).toMatchObject({ p_table_id: SALES, p_source: 'agent', p_reason: 'Dana wrote that they signed', p_as_user: USER })
    expect(call.args).not.toHaveProperty('p_source_ref')
    expect(r.eventId).toBe(db.rows.data_change[0].id)
  })

  it('keeps where a change came from (the email thread) on the change, and the history says it', async () => {
    const c = await createDeal(db.client, WS, { name: 'A' }, actor)
    if (!c.ok) throw new Error(c.error)
    await updateDeal(db.client, WS, c.deal.id, { stage: 'Won' }, { ...actor, source: 'email', sourceRef: 'thread-7' })
    expect(db.rpcCalls.filter((x) => x.name === 'apply_data_ops').at(-1)!.args).toMatchObject({ p_source: 'email', p_source_ref: 'thread-7' })
    const [latest] = await listDealEvents(db.client, WS, c.deal)
    expect(latest).toMatchObject({ kind: 'moved', source: 'email', source_ref: 'thread-7' })
  })

  it('creates in a named pipeline and stage', async () => {
    const r = await createDeal(db.client, WS, { name: 'Reseller', pipeline: 'partnerships', stage: 'signed' }, actor)
    expect(r.ok && r.deal).toMatchObject({ pipeline_id: PARTNERS, stage: 'Signed', status: 'won' })
  })

  it('refuses an unknown stage with the list, and a company the person can’t see', async () => {
    const bad = await createDeal(db.client, WS, { name: 'X', stage: 'Negotiation' }, actor)
    expect(bad).toEqual({ ok: false, error: 'No stage "Negotiation" in Sales. Stages: Lead, Qualified, Proposal, Won, Lost.' })
    hidden.add(OTHER_COMPANY)
    expect(await createDeal(db.client, WS, { name: 'X', company_id: OTHER_COMPANY }, actor, { viewer: USER })).toEqual({ ok: false, error: 'Company not found.' })
    expect(db.rows.data_row).toHaveLength(0)
  })

  it('updates only what changed, says it in words, and a write that changes nothing logs nothing', async () => {
    const c = await createDeal(db.client, WS, { name: 'Northwind website', value: 10000 }, actor)
    if (!c.ok) throw new Error(c.error)
    const u = await updateDeal(db.client, WS, c.deal.id, { value: 12500, stage: 'Proposal', custom_fields: { tier: 'gold' } }, actor)
    expect(u.ok).toBe(true)
    if (!u.ok) return
    expect(Object.keys(u.changes).sort()).toEqual(['stage', 'tier', 'value'])
    const [sales] = await listPipelines(db.client, WS)
    expect(describeChanges(u.changes, { columns: sales.columns })).toEqual(['value: $10,000 → $12,500', 'stage: Lead → Proposal', 'tier: none → Gold'])
    expect(u.deal.custom_fields).toEqual({ tier: 'Gold' })
    const same = await updateDeal(db.client, WS, c.deal.id, { value: 12500 }, actor)
    expect(same.ok && same.eventId).toBeNull()
    expect(db.rows.data_change).toHaveLength(2)
  })

  it('adds contacts, clears a value and keeps a deal in its pipeline', async () => {
    const c = await createDeal(db.client, WS, { name: 'A', value: 500, contact_ids: [CONTACT_A] }, actor)
    if (!c.ok) throw new Error(c.error)
    const u = await updateDeal(db.client, WS, c.deal.id, { add_contact_ids: [CONTACT_B], value: null }, actor)
    expect(u.ok && u.deal).toMatchObject({ contact_ids: [CONTACT_A, CONTACT_B], value: null })
    const moved = await updateDeal(db.client, WS, c.deal.id, { pipeline: 'Partnerships' }, actor)
    expect(moved).toEqual({ ok: false, error: 'A deal stays in its pipeline (Sales). Make a new deal in the other one instead.' })
  })

  it('a stage rule holds: Won needs a Value (required_when)', async () => {
    db = seed({ valueRule: true })
    const c = await createDeal(db.client, WS, { name: 'No value yet' }, actor)
    if (!c.ok) throw new Error(c.error)
    const won = await updateDeal(db.client, WS, c.deal.id, { stage: 'Won' }, actor)
    expect(won).toEqual({ ok: false, error: 'Value is needed when Stage is Won (row “No value yet”).' })
    const withValue = await updateDeal(db.client, WS, c.deal.id, { stage: 'Won', value: 900 }, actor)
    expect(withValue.ok && withValue.deal.status).toBe('won')
  })
})

describe('history and undo', () => {
  it('lists a deal’s changes as created, moved and updated, newest first', async () => {
    const c = await createDeal(db.client, WS, { name: 'A' }, actor)
    if (!c.ok) throw new Error(c.error)
    await updateDeal(db.client, WS, c.deal.id, { stage: 'Qualified' }, actor)
    await updateDeal(db.client, WS, c.deal.id, { value: 300 }, { ...actor, source: 'email' })
    const events = await listDealEvents(db.client, WS, c.deal)
    expect(events.map((e) => `${e.kind}:${e.source}`)).toEqual(['updated:email', 'moved:agent', 'created:agent'])
    expect(events[1].changes).toEqual({ stage: { from: 'Lead', to: 'Qualified' } })
  })

  it('takes back the latest change, refuses the creation, and keeps a field changed since', async () => {
    const c = await createDeal(db.client, WS, { name: 'A', value: 100 }, actor)
    if (!c.ok) throw new Error(c.error)
    expect(await undoDealChange(db.client, WS, { dealId: c.deal.id }, actor)).toEqual({
      ok: false,
      error: 'That change created the deal. Archive the deal instead if it should not exist.',
    })
    const moved = await updateDeal(db.client, WS, c.deal.id, { stage: 'Won', value: 900 }, actor)
    if (!moved.ok) throw new Error(moved.error)
    await updateDeal(db.client, WS, c.deal.id, { value: 950 }, actor)
    const undone = await undoDealChange(db.client, WS, { dealId: c.deal.id, changeId: moved.eventId! }, actor)
    expect(undone.ok).toBe(true)
    if (!undone.ok) return
    expect(undone.deal.stage).toBe('Lead')
    expect(undone.deal.value).toBe(950)
    expect(undone.kept.length).toBe(1)
    expect(db.rows.data_change.find((ch) => ch.id === moved.eventId)!.undone_at).not.toBeNull()
    expect(await undoDealChange(db.client, WS, { dealId: c.deal.id, changeId: moved.eventId! }, actor)).toEqual({ ok: false, error: 'That change was already undone.' })
  })

  it('reads a deal’s own changes by its row, past other rows’ newer ones', async () => {
    const a = await createDeal(db.client, WS, { name: 'A' }, actor)
    const b = await createDeal(db.client, WS, { name: 'B' }, actor)
    if (!a.ok || !b.ok) throw new Error('setup')
    for (let i = 1; i <= 5; i++) await updateDeal(db.client, WS, b.deal.id, { value: i }, actor)
    const events = await listDealEvents(db.client, WS, a.deal, 3)
    expect(events.map((e) => e.kind)).toEqual(['created'])
  })

  it('a change id from another deal is not this deal’s', async () => {
    const a = await createDeal(db.client, WS, { name: 'A' }, actor)
    const b = await createDeal(db.client, WS, { name: 'B' }, actor)
    if (!a.ok || !b.ok) throw new Error('setup')
    const ub = await updateDeal(db.client, WS, b.deal.id, { stage: 'Qualified' }, actor)
    expect(await undoDealChange(db.client, WS, { dealId: a.deal.id, changeId: ub.ok ? ub.eventId! : '' }, actor)).toEqual({ ok: false, error: 'Change not found' })
  })
})

describe('reading deals', () => {
  async function three() {
    const a = await createDeal(db.client, WS, { name: 'Northwind website', stage: 'Won', value: 1, company_id: COMPANY, contact_ids: [CONTACT_A] }, actor)
    const b = await createDeal(db.client, WS, { name: 'Tidewater brochure', contact_ids: [CONTACT_B] }, actor)
    const c = await createDeal(db.client, WS, { name: 'Reseller', pipeline: 'Partnerships' }, actor)
    if (!a.ok || !b.ok || !c.ok) throw new Error('setup')
    return { a: a.deal, b: b.deal, c: c.deal }
  }

  it('finds by status across pipelines, by stage, company, contact and name', async () => {
    const { a, b, c } = await three()
    const ids = async (input: Parameters<typeof findDeals>[2]) => (await findDeals(db.client, WS, input)).deals.map((d) => d.id).sort()
    expect(await ids({ status: 'won' })).toEqual([a.id])
    expect(await ids({ status: 'open' })).toEqual([b.id, c.id].sort())
    expect(await ids({ stage: 'Talking' })).toEqual([c.id])
    expect(await ids({ company_id: COMPANY })).toEqual([a.id])
    expect(await ids({ contact_id: CONTACT_B })).toEqual([b.id])
    expect(await ids({ search: 'tide' })).toEqual([b.id])
    expect(await ids({ pipeline: 'Sales' })).toEqual([a.id, b.id].sort())
  })

  it('reads one deal, and not a row of a table that is no pipeline', async () => {
    const { a } = await three()
    expect((await getDeal(db.client, WS, a.id))?.name).toBe('Northwind website')
    db.rows.data_row.push({ id: '00000000-0000-4000-8000-00000000aaaa', workspace_id: WS, table_id: 'some-table', title: 'Not a deal', custom_fields: {}, archived_at: null })
    expect(await getDeal(db.client, WS, '00000000-0000-4000-8000-00000000aaaa')).toBeNull()
  })

  it('a company’s and a contact’s deals come from their relation edges', async () => {
    const { a, b } = await three()
    db.rows.entity_link.push(
      { workspace_id: WS, relation: 'field_link', source_type: 'data_row', source_id: a.id, target_type: 'company', target_id: COMPANY },
      { workspace_id: WS, relation: 'field_link', source_type: 'data_row', source_id: b.id, target_type: 'contact', target_id: CONTACT_B },
      // An edge whose row no longer names it (another column linked it) shows nothing.
      { workspace_id: WS, relation: 'field_link', source_type: 'data_row', source_id: b.id, target_type: 'company', target_id: COMPANY },
    )
    expect((await dealsLinkedTo(db.client, WS, { kind: 'company', id: COMPANY })).deals.map((d) => d.id)).toEqual([a.id])
    expect((await dealsLinkedTo(db.client, WS, { kind: 'contact', id: CONTACT_B })).deals.map((d) => d.id)).toEqual([b.id])
  })

  it('reads a row’s values as a deal', () => {
    const deal = rowToDeal(
      {
        id: 'r1',
        table_id: SALES,
        title: 'T',
        custom_fields: { stage: 'Lost', value: { amount: 40, currency: 'EUR' }, company: [COMPANY], contacts: [CONTACT_A], owner: MEMBER, expected_close: '2026-12-01', notes: 'n', tier: 'Gold' },
        position: 1,
        archived_at: null,
        created_at: 'c',
        updated_at: 'u',
        closed_at: '2026-11-02T00:00:00Z',
      },
      pipelineRows({ id: SALES, workspaceId: WS, name: 'Sales' }) as never,
      WS,
    )
    expect(deal).toMatchObject({ stage: 'Lost', status: 'lost', value: 40, currency: 'EUR', company_id: COMPANY, contact_ids: [CONTACT_A], owner_id: MEMBER, expected_close_date: '2026-12-01', notes: 'n', custom_fields: { tier: 'Gold' }, closed_at: '2026-11-02T00:00:00Z' })
  })
})
