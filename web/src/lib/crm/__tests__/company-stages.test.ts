/** A company's stage, owner and revenue (migration 679): the pure parts. Made-up values. */
import { describe, expect, it } from 'vitest'
import { cleanStageName, coerceRevenue, layoutCompanyStageGroups, NO_STAGE_LABEL, parseCompanyCrmFields, resolveStage } from '../company-stages'

const STAGES = [
  { id: 's-lead', name: 'Lead', position: 0 },
  { id: 's-demo', name: 'Demo', position: 1 },
  { id: 's-cust', name: 'Customer', position: 2 },
]

describe('stages', () => {
  it('resolves a stage by id or by name in any case; No stage clears; anything else is unknown', () => {
    expect(resolveStage(STAGES, 's-demo')?.name).toBe('Demo')
    expect(resolveStage(STAGES, 'customer')?.id).toBe('s-cust')
    expect(resolveStage(STAGES, null)).toBeNull()
    expect(resolveStage(STAGES, 'no stage')).toBeNull()
    expect(resolveStage(STAGES, 'Partner')).toBeUndefined()
  })

  it('cleans a stage name', () => {
    expect(cleanStageName('  Pilot   phase ')).toEqual({ ok: true, name: 'Pilot phase' })
    expect(cleanStageName('').ok).toBe(false)
    expect(cleanStageName('x'.repeat(61)).ok).toBe(false)
  })

  it('lays the groups out in stage order, empty stages too, No stage last', () => {
    const grouped = [
      { key: '__none__', label: 'No value', items: [{ id: 'c3' }] },
      { key: 's-cust', label: 's-cust', items: [{ id: 'c1' }] },
    ]
    const out = layoutCompanyStageGroups(grouped, STAGES)
    expect(out.map((g) => g.label)).toEqual(['Lead', 'Demo', 'Customer', NO_STAGE_LABEL])
    expect(out[2].items).toEqual([{ id: 'c1' }])
    expect(out[3].items).toEqual([{ id: 'c3' }])
    expect(layoutCompanyStageGroups<{ key: string; label: string; items: Record<string, unknown>[] }>([], STAGES, 'desc').map((g) => g.label)).toEqual(['Customer', 'Demo', 'Lead', NO_STAGE_LABEL])
  })

  it('keeps a group whose stage was deleted meanwhile', () => {
    const out = layoutCompanyStageGroups([{ key: 's-gone', label: 'Old', items: [{ id: 'c9' }] }], STAGES)
    expect(out.map((g) => g.key)).toEqual(['s-lead', 's-demo', 's-cust', 's-gone', '__none__'])
  })
})

describe('revenue', () => {
  it('takes a number, text, k/m shorthand or a value; empty clears', () => {
    expect(coerceRevenue(120000)).toEqual({ ok: true, value: { amount: 120000, currency: 'USD' } })
    expect(coerceRevenue('€1,200.50')).toEqual({ ok: true, value: { amount: 1200.5, currency: 'EUR' } })
    expect(coerceRevenue('2.5m GBP')).toEqual({ ok: true, value: { amount: 2500000, currency: 'GBP' } })
    expect(coerceRevenue('$120k')).toEqual({ ok: true, value: { amount: 120000, currency: 'USD' } })
    expect(coerceRevenue({ amount: 5, currency: 'jpy' })).toEqual({ ok: true, value: { amount: 5, currency: 'JPY' } })
    expect(coerceRevenue('')).toEqual({ ok: true, value: null })
    expect(coerceRevenue('lots').ok).toBe(false)
    expect(coerceRevenue({ amount: 5, currency: 'XX' }).ok).toBe(false)
  })
})

describe('parseCompanyCrmFields', () => {
  function db(memberInWorkspace: boolean) {
    return {
      from: (table: string) => {
        const q: Record<string, unknown> = {}
        q.select = () => q
        q.eq = () => q
        q.order = () => q
        q.maybeSingle = async () => ({ data: memberInWorkspace ? { id: 'm-1' } : null, error: null })
        q.then = (res: (v: unknown) => unknown) => res(table === 'company_stage' ? { data: STAGES, error: null } : { data: null, error: null })
        return q
      },
    }
  }
  const ID = '11111111-1111-4111-8111-111111111111'

  it('maps a stage name and checks the owner is a member here', async () => {
    const r = await parseCompanyCrmFields(db(true) as never, 'ws', { stage: 'demo', owner_member_id: ID, revenue: 10 })
    expect(r).toEqual({ ok: true, updates: { stage_id: 's-demo', owner_member_id: ID, revenue: { amount: 10, currency: 'USD' } } })
  })

  it('refuses an unknown stage (naming the stages) and an owner from elsewhere', async () => {
    const r = await parseCompanyCrmFields(db(true) as never, 'ws', { stage: 'Partner' })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toContain('Lead, Demo, Customer')
    expect((await parseCompanyCrmFields(db(false) as never, 'ws', { owner_member_id: ID })).ok).toBe(false)
  })

  it('sends back only the keys it was given', async () => {
    expect(await parseCompanyCrmFields(db(true) as never, 'ws', {})).toEqual({ ok: true, updates: {} })
  })
})
