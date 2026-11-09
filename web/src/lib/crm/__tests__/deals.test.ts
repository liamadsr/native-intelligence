import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { memoryDb } from '@/test/memory-db'
import {
  createDeal,
  describeChanges,
  diffDeal,
  findDeals,
  listDealEvents,
  matchStage,
  undoDealEvent,
  updateDeal,
  type DealStage,
} from '../deals'

// Made-up fixtures: Fernhill-style ids, example.com people.
const WS = '00000000-0000-4000-8000-000000000001'
const OTHER_WS = '00000000-0000-4000-8000-000000000002'
const P = '00000000-0000-4000-8000-0000000000a1'
const S = {
  lead: '00000000-0000-4000-8000-0000000000b1',
  qualified: '00000000-0000-4000-8000-0000000000b2',
  proposal: '00000000-0000-4000-8000-0000000000b3',
  won: '00000000-0000-4000-8000-0000000000b4',
  lost: '00000000-0000-4000-8000-0000000000b5',
}
const MEMBER = '00000000-0000-4000-8000-0000000000c1'
const USER = '00000000-0000-4000-8000-0000000000d1'
const COMPANY = '00000000-0000-4000-8000-0000000000e1'
const CONTACT_A = '00000000-0000-4000-8000-0000000000f1'
const CONTACT_B = '00000000-0000-4000-8000-0000000000f2'
const FOREIGN_CONTACT = '00000000-0000-4000-8000-0000000000f9'

function seed() {
  const stage = (id: string, name: string, position: number, kind: 'open' | 'won' | 'lost') => ({ id, workspace_id: WS, pipeline_id: P, name, position, kind, color: null })
  const tables: Record<string, Record<string, unknown>[]> = {
    deal_pipeline: [{ id: P, workspace_id: WS, name: 'Sales', is_default: true, position: 0 }],
    deal_stage: [stage(S.lead, 'Lead', 0, 'open'), stage(S.qualified, 'Qualified', 1, 'open'), stage(S.proposal, 'Proposal', 2, 'open'), stage(S.won, 'Won', 3, 'won'), stage(S.lost, 'Lost', 4, 'lost')],
    member: [{ id: MEMBER, workspace_id: WS, user_id: USER, display_name: 'Avery Example' }],
    company: [{ id: COMPANY, workspace_id: WS, name: 'Northwind Example' }],
    contact: [
      { id: CONTACT_A, workspace_id: WS, full_name: 'Dana Example', email: 'dana@example.com' },
      { id: CONTACT_B, workspace_id: WS, full_name: 'Sam Example', email: 'sam@example.com' },
      { id: FOREIGN_CONTACT, workspace_id: OTHER_WS, full_name: 'Elsewhere', email: 'x@example.com' },
    ],
    custom_field_definition: [
      { id: 'cf1', workspace_id: WS, entity_type: 'deal', key: 'tier', label: 'Tier', field_type: 'select', options: ['Gold', 'Silver'], position: 0 },
    ],
    deal: [],
    deal_event: [],
  }
  const db = memoryDb(tables) as SupabaseClient & { rpc: unknown }
  ;(db as unknown as { rpc: unknown }).rpc = async () => ({ data: P, error: null })
  return { db: db as SupabaseClient, tables }
}

const person = { userId: USER, source: 'person' as const }

describe('deals', () => {
  let clock = Date.parse('2026-11-08T12:00:00Z')
  beforeEach(() => {
    vi.useFakeTimers()
    clock = Date.parse('2026-11-08T12:00:00Z')
    vi.setSystemTime(clock)
  })
  afterEach(() => vi.useRealTimers())
  const tick = () => vi.setSystemTime((clock += 1000))

  it('matches a stage by name, prefix, id or what won/lost mean', () => {
    const stages = seed().tables.deal_stage as unknown as DealStage[]
    expect(matchStage(stages, 'proposal')?.id).toBe(S.proposal)
    expect(matchStage(stages, 'Qual')?.id).toBe(S.qualified)
    expect(matchStage(stages, S.lead)?.id).toBe(S.lead)
    expect(matchStage(stages, 'closed won')?.id).toBe(S.won)
    expect(matchStage(stages, 'signed')?.id).toBe(S.won)
    expect(matchStage(stages, 'dead')?.id).toBe(S.lost)
    expect(matchStage(stages, 'Negotiation')).toBeNull()
  })

  it('creates a deal in the first stage, owned by the person, and logs it', async () => {
    const { db, tables } = seed()
    const r = await createDeal(db, WS, { name: 'Website redesign', value: 12500, company_id: COMPANY, contact_ids: [CONTACT_A] }, person)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.deal).toMatchObject({ stage_id: S.lead, pipeline_id: P, owner_id: MEMBER, value: 12500, source: 'manual' })
    expect(tables.deal_event).toHaveLength(1)
    expect(tables.deal_event[0]).toMatchObject({ kind: 'created', source: 'person', deal_id: r.deal.id })
  })

  it("refuses references outside the workspace and stages that don't exist", async () => {
    const { db } = seed()
    const foreign = await createDeal(db, WS, { name: 'X', contact_ids: [FOREIGN_CONTACT] }, person)
    expect(foreign).toEqual({ ok: false, error: `Contact not found: ${FOREIGN_CONTACT}` })
    const badStage = await createDeal(db, WS, { name: 'X', stage: 'Negotiation' }, person)
    expect(badStage.ok).toBe(false)
    if (!badStage.ok) expect(badStage.error).toContain('Stages: Lead, Qualified, Proposal, Won, Lost')
    const badValue = await createDeal(db, WS, { name: 'X', value: -5 }, person)
    expect(badValue.ok).toBe(false)
    const badCurrency = await createDeal(db, WS, { name: 'X', currency: 'dollars' }, person)
    expect(badCurrency.ok).toBe(false)
  })

  it('updates only what changed, in one logged change; a no-op logs nothing', async () => {
    const { db, tables } = seed()
    const c = await createDeal(db, WS, { name: 'Renewal', value: 10000 }, person)
    if (!c.ok) throw new Error(c.error)
    tick()
    const u = await updateDeal(db, WS, c.deal.id, { value: 12500, stage: 'Proposal', custom_fields: { tier: 'gold' } }, { userId: USER, source: 'email', sourceRef: 'thread-1', reason: 'New quote in the reply' })
    if (!u.ok) throw new Error(u.error)
    expect(Object.keys(u.changes).sort()).toEqual(['custom_fields.tier', 'stage_id', 'value'])
    expect(u.deal.custom_fields).toEqual({ tier: 'Gold' })
    const ev = tables.deal_event.at(-1)!
    expect(ev).toMatchObject({ kind: 'updated', source: 'email', source_ref: 'thread-1', reason: 'New quote in the reply' })

    const same = await updateDeal(db, WS, c.deal.id, { value: 12500 }, person)
    expect(same.ok && Object.keys(same.changes)).toEqual([])
    expect(tables.deal_event).toHaveLength(2)
  })

  it('logs a stage-only change as a move, and adds contacts without dropping any', async () => {
    const { db, tables } = seed()
    const c = await createDeal(db, WS, { name: 'Pilot', contact_ids: [CONTACT_A] }, person)
    if (!c.ok) throw new Error(c.error)
    const m = await updateDeal(db, WS, c.deal.id, { stage: 'won' }, { userId: USER, source: 'agent' })
    expect(m.ok).toBe(true)
    expect(tables.deal_event.at(-1)).toMatchObject({ kind: 'moved' })
    const a = await updateDeal(db, WS, c.deal.id, { add_contact_ids: [CONTACT_B, CONTACT_A] }, person)
    if (!a.ok) throw new Error(a.error)
    expect(a.deal.contact_ids).toEqual([CONTACT_A, CONTACT_B])
  })

  it('undoes a change field by field, keeping fields that moved on since', async () => {
    const { db, tables } = seed()
    const c = await createDeal(db, WS, { name: 'Expansion', value: 5000 }, person)
    if (!c.ok) throw new Error(c.error)
    tick()
    const agent = await updateDeal(db, WS, c.deal.id, { value: 8000, stage: 'Won' }, { userId: USER, source: 'capture', reason: 'They said yes on the call' })
    if (!agent.ok) throw new Error(agent.error)
    tick()
    // The person changes the value again before undoing the agent's change.
    const later = await updateDeal(db, WS, c.deal.id, { value: 9000 }, person)
    if (!later.ok) throw new Error(later.error)
    tick()
    const undo = await undoDealEvent(db, WS, { dealId: c.deal.id, eventId: agent.eventId! }, person)
    expect(undo.ok).toBe(true)
    if (!undo.ok) return
    expect(undo.restored).toEqual(['stage_id'])
    expect(undo.kept).toEqual(['value'])
    expect(undo.deal.stage_id).toBe(S.lead)
    expect(undo.deal.value).toBe(9000)
    expect(tables.deal_event.find((e) => e.id === agent.eventId)?.undone_at).toBeTruthy()
    expect(tables.deal_event.at(-1)).toMatchObject({ kind: 'undo', source_ref: agent.eventId })
    // Undoing it twice is refused.
    const again = await undoDealEvent(db, WS, { dealId: c.deal.id, eventId: agent.eventId! }, person)
    expect(again).toEqual({ ok: false, error: 'That change was already undone.' })
  })

  it("undoes the latest change by default, never the deal's creation", async () => {
    const { db } = seed()
    const c = await createDeal(db, WS, { name: 'Audit', value: 100 }, person)
    if (!c.ok) throw new Error(c.error)
    const onlyCreated = await undoDealEvent(db, WS, { dealId: c.deal.id }, person)
    expect(onlyCreated.ok).toBe(false)
    tick()
    await updateDeal(db, WS, c.deal.id, { custom_fields: { tier: 'Silver' } }, person)
    tick()
    const undo = await undoDealEvent(db, WS, { dealId: c.deal.id }, person)
    expect(undo.ok && undo.deal.custom_fields).toEqual({})
  })

  it('finds deals by status, contact and name, and lists history newest first', async () => {
    const { db } = seed()
    const a = await createDeal(db, WS, { name: 'Alpha rollout', contact_ids: [CONTACT_A] }, person)
    tick()
    const b = await createDeal(db, WS, { name: 'Beta support', stage: 'Lost' }, person)
    if (!a.ok || !b.ok) throw new Error('seed')
    expect((await findDeals(db, WS, { status: 'lost' })).deals.map((d) => d.name)).toEqual(['Beta support'])
    expect((await findDeals(db, WS, { contact_id: CONTACT_A })).deals.map((d) => d.name)).toEqual(['Alpha rollout'])
    expect((await findDeals(db, WS, { search: 'beta' })).deals.map((d) => d.name)).toEqual(['Beta support'])
    expect((await findDeals(db, WS, { stage: 'Nope' })).deals).toEqual([])
    tick()
    await updateDeal(db, WS, a.deal.id, { value: 1 }, person)
    const events = await listDealEvents(db, WS, a.deal.id)
    expect(events.map((e) => e.kind)).toEqual(['updated', 'created'])
  })

  it('a deal in another workspace is not found', async () => {
    const { db } = seed()
    const c = await createDeal(db, WS, { name: 'Mine' }, person)
    if (!c.ok) throw new Error(c.error)
    expect(await updateDeal(db, OTHER_WS, c.deal.id, { value: 1 }, person)).toEqual({ ok: false, error: 'Deal not found' })
  })

  it('diffs custom fields one key at a time and says changes in words', () => {
    const changes = diffDeal({ stage_id: S.lead, custom_fields: { tier: 'Gold', a: 1 } }, { stage_id: S.won, custom_fields: { tier: 'Gold', b: 2 } })
    expect(Object.keys(changes).sort()).toEqual(['custom_fields.a', 'custom_fields.b', 'stage_id'])
    const pipelines = [{ id: P, name: 'Sales', is_default: true, position: 0, stages: seed().tables.deal_stage as unknown as DealStage[] }]
    expect(describeChanges({ stage_id: { from: S.lead, to: S.won } }, { pipelines })).toEqual(['stage: Lead → Won'])
    expect(describeChanges({ 'custom_fields.tier': { from: null, to: 'Gold' } }, { pipelines })).toEqual(['tier: none → Gold'])
  })
})
