/** Companies and contacts as CSV, and a companies CSV brought in (679's fields). Made-up rows. */
import { describe, expect, it } from 'vitest'
import { companiesCsv, contactsCsv, mapCompanyHeaders, planCompanyImport } from '../crm-csv'
import { parseCsv } from '@/lib/crm/import/sources/spreadsheet'

const DEFS = [
  { key: 'tier', label: 'Tier', field_type: 'select' as const, options: ['Gold', 'Silver'] },
  { key: 'renewal', label: 'Renewal date', field_type: 'date' as const, options: [] },
  { key: 'arr_goal', label: 'ARR goal', field_type: 'currency' as const, options: [] },
]

describe('export', () => {
  it('writes stage, owner and revenue, custom fields by label, and defuses formulas', () => {
    const csv = companiesCsv(
      [
        {
          name: '=HYPERLINK("x")',
          domain: 'acme.example',
          stage: { name: 'Demo' },
          owner: [{ display_name: 'Alex Example' }],
          revenue: { amount: 120000, currency: 'EUR' },
          tags: ['b2b', 'eu'],
          custom_fields: { tier: 'Gold', renewal: '2027-01-31', arr_goal: { amount: 5000, currency: 'USD' } },
        },
      ],
      DEFS,
      {},
    )
    const [header, line] = csv.trim().split('\r\n')
    expect(header).toContain('Stage,Owner,Revenue,Revenue currency')
    expect(header.endsWith('Tier,Renewal date,ARR goal')).toBe(true)
    expect(line.startsWith(`"'=HYPERLINK(""x"")"`)).toBe(true)
    expect(line).toContain('Demo,Alex Example,120000,EUR')
    expect(line).toContain('b2b; eu')
    expect(line.endsWith('Gold,2027-01-31,5000 USD')).toBe(true)
  })

  it('writes a contact with its company', () => {
    const csv = contactsCsv([{ full_name: 'Pat Example', email: 'pat@acme.example', phone: '555-0101', company: { name: 'Acme Example', domain: 'acme.example' } }], [], {})
    expect(csv.split('\r\n')[1]).toBe('Pat Example,pat@acme.example,555-0101,,Acme Example,acme.example,,,,,')
  })
})

describe('import', () => {
  const ctx = {
    stages: [{ id: 's-demo', name: 'Demo', position: 0 }],
    members: [{ id: 'm-alex', display_name: 'Alex Example' }],
    defs: DEFS,
  }

  it('maps an export’s own headers back, and custom fields by label', () => {
    const map = mapCompanyHeaders(['Name', 'Stage', 'Owner', 'Revenue', 'Revenue currency', 'Tier', 'Notes'], DEFS)
    expect(map.map((m) => (m.kind === 'field' ? m.target : m.kind === 'custom' ? `custom:${m.key}` : null))).toEqual([
      'name', 'stage', 'owner', 'revenue', 'revenue_currency', 'custom:tier', null,
    ])
  })

  it('fills stage, owner, revenue and custom fields when the columns are there', () => {
    const sheet = parseCsv('Company,Domain,Stage,Owner,Revenue,Revenue currency,Tier,Employees\nAcme Example,https://www.acme.example/about,demo,alex example,120000,EUR,gold,75\n')
    const plan = planCompanyImport(sheet, ctx)
    expect(plan.warnings).toEqual([])
    expect(plan.companies[0]).toMatchObject({
      fields: { name: 'Acme Example', domain: 'acme.example', employee_count_range: '51-200' },
      stage_id: 's-demo',
      owner_member_id: 'm-alex',
      revenue: { amount: 120000, currency: 'EUR' },
      custom_fields: { tier: 'Gold' },
    })
  })

  it('says which cells it could not read, and skips a row with no name', () => {
    const plan = planCompanyImport(parseCsv('Name,Stage,Owner,Revenue\nGlobex Example,Partner,Nobody,lots\n,Demo,,\n'), ctx)
    expect(plan.companies).toHaveLength(1)
    expect(plan.companies[0].stage_id).toBeUndefined()
    expect(plan.warnings.map((w) => w.column)).toEqual(['Stage', 'Owner', 'Revenue'])
    expect(plan.skipped).toEqual([{ line: 3, reason: 'No name.' }])
  })

  it('needs a name column', () => {
    expect(planCompanyImport(parseCsv('Domain\nacme.example\n'), ctx).skipped[0].reason).toMatch(/No Name/)
  })
})
